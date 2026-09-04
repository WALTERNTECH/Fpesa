import { env } from '../env.js';

/**
 * Palpluss M-Pesa adapter.
 *
 * Contract per https://docs.palpluss.com
 *   auth      Authorization: Basic base64(API_KEY + ":")
 *   collect   POST /payments/stk
 *   payout    POST /b2c/payouts
 *   lookup    GET  /transactions/{id}
 *
 * Webhook bodies are never trusted on their own — callers re-read the
 * transaction through `getTransaction` before money moves.
 */

export type PalplussStatus = 'PENDING' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'EXPIRED';

export type PalplussTransaction = {
  transactionId: string;
  status: PalplussStatus;
  amount: number;
  phone: string;
  reference: string;
  mpesaReceipt: string | null;
  resultCode: string | null;
  resultDescription: string | null;
};

export class PaymentError extends Error {
  constructor(public code: string, message: string, public status = 502) {
    super(message);
  }
}

function authHeader(): string {
  return 'Basic ' + Buffer.from(env.palpluss.apiKey + ':').toString('base64');
}

async function call<T>(path: string, init: RequestInit): Promise<T> {
  if (!env.palpluss.apiKey) {
    throw new PaymentError(
      'PAYMENTS_UNCONFIGURED',
      'Mobile money is not configured yet. Please contact support.',
      503
    );
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  let res: Response;
  try {
    res = await fetch(env.palpluss.baseUrl + path, {
      ...init,
      signal: ctrl.signal,
      headers: {
        Authorization: authHeader(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
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
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!res.ok) {
    const message =
      (body as { message?: string; error?: string } | null)?.message ??
      (body as { error?: string } | null)?.error ??
      'Payment provider returned ' + res.status;
    console.error('[palpluss] ' + path + ' -> ' + res.status + ' ' + text.slice(0, 400));
    throw new PaymentError('PAYMENTS_REJECTED', message, res.status === 400 ? 400 : 502);
  }

  return body as T;
}

type Envelope<T> = { success: boolean; data: T; requestId?: string };

type RawTransaction = {
  transactionId?: string;
  id?: string;
  status?: string;
  amount?: number | string;
  phone?: string;
  phone_number?: string;
  accountReference?: string;
  reference?: string;
  external_reference?: string;
  mpesaReceipt?: string;
  mpesa_receipt?: string;
  resultCode?: string;
  result_code?: string;
  resultDescription?: string;
  result_desc?: string;
};

/** Palpluss mixes camelCase (REST) and snake_case (webhooks); accept both. */
export function normaliseTransaction(raw: RawTransaction): PalplussTransaction {
  const status = String(raw.status ?? 'PENDING').toUpperCase();
  return {
    transactionId: raw.transactionId ?? raw.id ?? '',
    status: (['PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(status)
      ? status
      : 'PENDING') as PalplussStatus,
    amount: Number(raw.amount ?? 0),
    phone: raw.phone ?? raw.phone_number ?? '',
    reference: raw.accountReference ?? raw.reference ?? raw.external_reference ?? '',
    mpesaReceipt: raw.mpesaReceipt ?? raw.mpesa_receipt ?? null,
    resultCode: raw.resultCode ?? raw.result_code ?? null,
    resultDescription: raw.resultDescription ?? raw.result_desc ?? null,
  };
}

// --------------------------------------------------------------- mock mode
// Lets the deposit/withdraw journey be exercised end to end before live keys
// are provisioned. Enabled with PAYMENTS_MOCK=true.
type MockHandler = (reference: string, status: PalplussStatus, receipt: string) => void;
let mockHandler: MockHandler | null = null;
export function setMockSettlementHandler(fn: MockHandler): void {
  mockHandler = fn;
}

function mockTransaction(reference: string, amount: number, phone: string): PalplussTransaction {
  const id = 'mock_' + Math.random().toString(36).slice(2, 12);
  setTimeout(() => {
    const receipt = 'M' + Math.random().toString(36).slice(2, 10).toUpperCase();
    mockHandler?.(reference, 'SUCCESS', receipt);
  }, 6000);
  return {
    transactionId: id,
    status: 'PENDING',
    amount,
    phone,
    reference,
    mpesaReceipt: null,
    resultCode: null,
    resultDescription: 'Mock STK request accepted',
  };
}

// ------------------------------------------------------------------- API
export async function initiateStkPush(params: {
  phone: string;
  amount: number;
  reference: string;
  description: string;
  callbackUrl: string;
}): Promise<PalplussTransaction> {
  if (env.paymentsMock) {
    return mockTransaction(params.reference, params.amount, params.phone);
  }
  const body: Record<string, unknown> = {
    amount: params.amount,
    phone: params.phone,
    accountReference: params.reference,
    transactionDesc: params.description,
    callbackUrl: params.callbackUrl,
  };
  if (env.palpluss.channelId) body.channelId = env.palpluss.channelId;

  const res = await call<Envelope<RawTransaction>>('/payments/stk', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return normaliseTransaction(res.data ?? {});
}

export async function initiateB2CPayout(params: {
  phone: string;
  amount: number;
  reference: string;
  description: string;
  callbackUrl: string;
}): Promise<PalplussTransaction> {
  if (env.paymentsMock) {
    return mockTransaction(params.reference, params.amount, params.phone);
  }
  const res = await call<Envelope<RawTransaction>>('/b2c/payouts', {
    method: 'POST',
    body: JSON.stringify({
      amount: params.amount,
      phone: params.phone,
      reference: params.reference,
      description: params.description,
      callbackUrl: params.callbackUrl,
    }),
  });
  return normaliseTransaction(res.data ?? {});
}

/** Authoritative status read. Used to confirm a webhook before crediting. */
export async function getTransaction(transactionId: string): Promise<PalplussTransaction | null> {
  if (env.paymentsMock) return null;
  try {
    const res = await call<Envelope<RawTransaction>>(
      '/transactions/' + encodeURIComponent(transactionId),
      { method: 'GET' }
    );
    return normaliseTransaction(res.data ?? {});
  } catch (err) {
    console.error('[palpluss] status lookup failed:', (err as Error).message);
    return null;
  }
}
