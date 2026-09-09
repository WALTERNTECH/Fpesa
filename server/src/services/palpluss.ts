import { env } from '../env.js';
import {
  PaymentError,
  type ProviderStatus,
  type ProviderTxn,
  type TxKind,
  type WebhookHint,
} from './payment-types.js';

/**
 * Palpluss M-Pesa adapter.
 *
 * Contract per https://docs.palpluss.com
 *   auth     Authorization: Basic <API key>
 *   collect  POST /v1/payments/stk
 *   payout   POST /v1/b2c/payouts
 *   status   GET  /v1/transactions/{id}
 *   balance  GET  /v1/wallets/balance
 *
 * ## Two things their documentation is ambiguous about
 *
 * **Auth encoding.** Their authentication guide is explicit —
 * `Basic <base64(API_KEY:)>`, a trailing colon for the empty password — while
 * the API reference shows a bare `Basic YOUR_API_KEY`. The guide wins and is
 * the default; the fallback below survives the other one being right after all,
 * because a payment integration that cannot authenticate at 2am is worse than a
 * small shim.
 *
 * **Path prefixes.** The endpoint pages document `/v1/...` while their
 * machine-readable index lists `/api/...`. Both are overridable by environment
 * variable so a wrong guess is a config change, not a deploy.
 *
 * ## What is missing, and what covers it
 *
 * Palpluss webhooks carry no signature and no shared secret — nothing in the
 * body proves it came from them. A callback is therefore treated as a hint that
 * something changed, never as evidence: handleProviderCallback re-reads the
 * transaction from this API before any balance moves, and refuses to credit a
 * claimed success it cannot confirm. The secret path token keeps the URL itself
 * hard to find; the re-read is what makes forging one useless.
 */

/**
 * The host only — every path below carries its own /v1.
 *
 * A base URL that already ended in /v1 produced /v1/v1/payments/stk and a 404
 * on every single payment, so the version segment is stripped here rather than
 * trusted. Configuration that can silently break all deposits should not be
 * possible to get wrong in the obvious way.
 */
const BASE = () =>
  (env.palpluss.baseUrl || 'https://api.palpluss.com')
    .replace(/\/+$/, '')
    .replace(/\/v\d+$/, '');

/**
 * Pulls a readable message out of their error envelope.
 *
 * The shape is { success, error: { message, code, details } } and `message` is
 * a string for routing failures but an array of validation strings for a bad
 * body. Reading the top level instead produced "[object Object]" on screen,
 * which told the trader nothing and told us nothing either — the real cause was
 * only visible in the server log.
 */
function errorText(parsed: unknown, status: number): { message: string; code: string } {
  const body = parsed as
    | { error?: { message?: unknown; code?: string }; message?: unknown; code?: string }
    | null;
  const err = body?.error ?? body ?? {};
  const raw = (err as { message?: unknown }).message ?? (body as { message?: unknown })?.message;

  const message = Array.isArray(raw)
    ? raw.filter((x) => typeof x === 'string').join('; ')
    : typeof raw === 'string'
      ? raw
      : 'Payment provider returned ' + status;

  const code =
    (err as { code?: string }).code ?? (body as { code?: string })?.code ?? '';
  return { message, code };
}

/**
 * Which encoding the API accepted. Starts at the documented one and only moves
 * if that is rejected.
 */
let authMode: 'raw' | 'basic' | null = null;

function authHeader(mode: 'raw' | 'basic'): string {
  const key = env.palpluss.apiKey;
  return mode === 'raw'
    ? 'Basic ' + key
    : 'Basic ' + Buffer.from(key + ':').toString('base64');
}

type Method = 'GET' | 'POST';

async function attempt<T>(
  method: Method,
  path: string,
  body: unknown,
  mode: 'raw' | 'basic'
): Promise<{ ok: boolean; status: number; parsed: T | null; text: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  let res: Response;
  try {
    res = await fetch(BASE() + path, {
      method,
      signal: ctrl.signal,
      headers: {
        Authorization: authHeader(mode),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new PaymentError(
      aborted ? 'PAYMENTS_TIMEOUT' : 'PAYMENTS_UNREACHABLE',
      'Could not reach M-Pesa right now. Please try again in a moment.'
    );
  }
  clearTimeout(timer);

  const text = await res.text();
  let parsed: T | null = null;
  try {
    parsed = text ? (JSON.parse(text) as T) : null;
  } catch {
    parsed = null;
  }
  return { ok: res.ok, status: res.status, parsed, text };
}

async function call<T>(method: Method, path: string, body?: unknown): Promise<T> {
  if (!env.palpluss.apiKey) {
    throw new PaymentError(
      'PAYMENTS_UNCONFIGURED',
      'Mobile money is not configured yet. Please contact support.',
      503
    );
  }

  const first = authMode ?? 'basic';
  let out = await attempt<T>(method, path, body, first);

  // Their docs describe two different encodings of the same header. If the one
  // we tried is rejected as unauthorised, the other is worth exactly one try.
  if (out.status === 401 && authMode === null) {
    const other = first === 'raw' ? 'basic' : 'raw';
    const retry = await attempt<T>(method, path, body, other);
    if (retry.status !== 401) {
      authMode = other;
      console.log('[palpluss] authenticating with the "' + other + '" key encoding');
      out = retry;
    }
  } else if (out.ok && authMode === null) {
    authMode = first;
  }

  if (!out.ok) {
    const { message, code } = errorText(out.parsed, out.status);
    console.error('[palpluss] ' + method + ' ' + path + ' -> ' + out.status + ' ' + out.text.slice(0, 400));

    // These are operator problems, not trader problems, so they are worth
    // saying plainly in the log rather than only as a generic failure.
    if (code === 'INSUFFICIENT_SERVICE_BALANCE' || out.status === 402) {
      console.error('[palpluss] service wallet is empty — top it up in the console');
    }
    if (out.status === 409) {
      console.error('[palpluss] B2C wallet has insufficient funds for this payout');
    }
    if (out.status === 403) {
      console.error('[palpluss] account not verified or inactive');
    }

    throw new PaymentError(
      'PAYMENTS_REJECTED',
      message,
      out.status === 400 ? 400 : 502
    );
  }
  return out.parsed as T;
}

/** Their terminal states map straight onto ours. */
function mapStatus(raw: string): ProviderStatus {
  switch (String(raw).toUpperCase()) {
    case 'SUCCESS':
      return 'SUCCESS';
    case 'FAILED':
      return 'FAILED';
    case 'CANCELLED':
    case 'CANCELED':
      return 'CANCELLED';
    case 'EXPIRED':
      return 'EXPIRED';
    default:
      return 'PENDING';
  }
}

// --------------------------------------------------------------- mock mode
type MockHandler = (
  kind: TxKind,
  reference: string,
  status: ProviderStatus,
  receipt: string
) => void;
let mockHandler: MockHandler | null = null;
export function setMockSettlementHandler(fn: MockHandler): void {
  mockHandler = fn;
}

function mockTxn(kind: TxKind, reference: string, amount: number): ProviderTxn {
  const id = 'mock_' + Math.random().toString(36).slice(2, 12);
  setTimeout(() => {
    const receipt = 'M' + Math.random().toString(36).slice(2, 10).toUpperCase();
    mockHandler?.(kind, reference, 'SUCCESS', receipt);
  }, 6000);
  return {
    providerId: id,
    status: 'PENDING',
    amount,
    reference,
    receipt: null,
    resultCode: null,
    resultDesc: 'Mock request accepted',
  };
}

// ------------------------------------------------------------------ shapes
type TxnBody = {
  transactionId?: string;
  id?: string;
  status?: string;
  amount?: number | string;
  phone?: string;
  accountReference?: string;
  reference?: string;
  external_reference?: string;
  mpesa_receipt?: string | null;
  mpesaReceipt?: string | null;
  resultCode?: string | null;
  result_code?: string | null;
  resultDescription?: string | null;
  result_desc?: string | null;
  type?: string;
};

type Envelope<T> = { success?: boolean; data?: T; requestId?: string };

function toTxn(d: TxnBody, fallbackReference: string, fallbackAmount = 0): ProviderTxn {
  return {
    providerId: String(d.transactionId ?? d.id ?? ''),
    status: mapStatus(String(d.status ?? 'PENDING')),
    amount: Number(d.amount ?? fallbackAmount),
    reference: String(
      d.accountReference ?? d.reference ?? d.external_reference ?? fallbackReference
    ),
    receipt: d.mpesa_receipt ?? d.mpesaReceipt ?? null,
    resultCode: d.resultCode ?? d.result_code ?? null,
    resultDesc: d.resultDescription ?? d.result_desc ?? null,
  };
}

// ------------------------------------------------------------- collections
export async function initiateStkPush(params: {
  phone: string;
  amount: number;
  reference: string;
  callbackUrl: string;
}): Promise<ProviderTxn> {
  if (env.paymentsMock) return mockTxn('DEPOSIT', params.reference, params.amount);

  const res = await call<Envelope<TxnBody>>('POST', env.palpluss.stkPath, {
    amount: params.amount,
    phone: params.phone,
    // Hard limits: 12 characters here, 13 on the description. Our references
    // are generated to fit, but truncate defensively — an over-long value is
    // rejected by Safaricom, not by Palpluss, which makes it look like a
    // random M-Pesa failure rather than a validation problem.
    accountReference: params.reference.slice(0, 12),
    transactionDesc: 'Fpesa deposit',
    callbackUrl: params.callbackUrl,
  });

  return toTxn(res.data ?? {}, params.reference, params.amount);
}

// ----------------------------------------------------------------- payouts
export async function initiateB2CPayout(params: {
  phone: string;
  amount: number;
  reference: string;
  description: string;
  callbackUrl: string;
  name: string;
}): Promise<ProviderTxn> {
  if (env.paymentsMock) return mockTxn('WITHDRAWAL', params.reference, params.amount);

  const res = await call<Envelope<TxnBody>>('POST', env.palpluss.b2cPath, {
    amount: params.amount,
    phone: params.phone,
    reference: params.reference,
    currency: 'KES',
    description: params.description,
    callbackUrl: params.callbackUrl,
  });

  return toTxn(res.data ?? {}, params.reference, params.amount);
}

/**
 * Authoritative status read. Both sides share one endpoint here, so the kind is
 * accepted only to match the adapter contract.
 */
export async function getStatus(_kind: TxKind, providerId: string): Promise<ProviderTxn | null> {
  if (env.paymentsMock) return null;
  try {
    const res = await call<Envelope<TxnBody>>(
      'GET',
      env.palpluss.txnPath.replace('{id}', encodeURIComponent(providerId))
    );
    const data = res.data ?? (res as unknown as TxnBody);
    if (!data || !(data.status ?? data.id ?? data.transactionId)) return null;
    return toTxn(data, '');
  } catch (err) {
    console.error('[palpluss] status read failed:', (err as Error).message);
    return null;
  }
}

/**
 * The balance of the payout wallet.
 *
 * This is the number the solvency guard actually wants: the operator float is
 * meant to describe money that can really be paid out, and a hand-typed figure
 * drifts the moment anyone moves funds. Returns null if the endpoint is
 * unavailable, and the caller keeps using the figure set in the console.
 */
export async function walletBalance(): Promise<number | null> {
  if (env.paymentsMock || !env.palpluss.apiKey) return null;
  try {
    const res = await call<Envelope<Record<string, unknown>>>('GET', env.palpluss.balancePath);
    const d = (res.data ?? res) as Record<string, unknown>;
    // Their field naming is not pinned down in the docs, so accept the
    // plausible spellings rather than silently reporting zero.
    for (const key of ['b2cBalance', 'b2c_balance', 'available', 'availableBalance', 'balance']) {
      const v = d[key];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string' && Number.isFinite(Number(v))) return Number(v);
    }
    console.warn('[palpluss] balance response had no recognised amount field');
    return null;
  } catch (err) {
    console.error('[palpluss] balance read failed:', (err as Error).message);
    return null;
  }
}


// ---------------------------------------------------------------- webhooks
/**
 * Reads a callback into a hint.
 *
 * `transaction.id` is the idempotency key their documentation asks callers to
 * use, and it is also what we re-query on — so a delivery without one is
 * useless to us regardless of what else it claims.
 */
export function parseWebhook(body: Record<string, unknown>): WebhookHint | null {
  const t = body.transaction as Record<string, unknown> | undefined;
  if (!t || typeof t !== 'object') return null;

  const id = t.id ?? t.transactionId;
  if (!id) return null;

  const kind: TxKind = String(t.type ?? '').toUpperCase() === 'B2C' ? 'WITHDRAWAL' : 'DEPOSIT';

  return {
    kind,
    reference: String(t.external_reference ?? t.reference ?? t.accountReference ?? ''),
    providerId: String(id),
    status: mapStatus(String(t.status ?? 'PENDING')),
    receipt: (t.mpesa_receipt as string | undefined) ?? null,
    resultCode: (t.result_code as string | undefined) ?? null,
    resultDesc: (t.result_desc as string | undefined) ?? null,
  };
}

/**
 * Palpluss signs nothing and echoes no shared secret, so there is no body-level
 * check to make. Saying so here rather than inventing a check keeps the real
 * protection visible: the secret path token, and the mandatory re-read in
 * handleProviderCallback before a single shilling moves.
 */
export function challengeMatches(_body: Record<string, unknown>): boolean {
  return true;
}
