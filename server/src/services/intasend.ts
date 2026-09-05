import { env } from '../env.js';

/**
 * IntaSend M-Pesa adapter.
 *
 * Contract per https://developers.intasend.com
 *   auth       Authorization: Bearer <ISSecretKey_...>
 *   collect    POST /api/v1/payment/mpesa-stk-push/
 *   collect ?  POST /api/v1/payment/status/            { invoice_id }
 *   payout     POST /api/v1/send-money/initiate/       provider MPESA-B2C
 *   payout ?   POST /api/v1/send-money/status/         { tracking_id }
 *
 * Collections and payouts report state through different endpoints and with
 * different vocabularies, so both are normalised to one shape here and the
 * rest of the server never has to care which side a transaction came from.
 */

export type ProviderStatus = 'PENDING' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'EXPIRED';
export type TxKind = 'DEPOSIT' | 'WITHDRAWAL';

export type ProviderTxn = {
  providerId: string;
  status: ProviderStatus;
  amount: number;
  reference: string;
  receipt: string | null;
  resultCode: string | null;
  resultDesc: string | null;
};

export class PaymentError extends Error {
  constructor(public code: string, message: string, public status = 502) {
    super(message);
  }
}

/** Collection invoice states. PARTIAL and RETRY stay pending — never credit. */
function mapInvoiceState(state: string): ProviderStatus {
  switch (state.toUpperCase()) {
    case 'COMPLETE':
      return 'SUCCESS';
    case 'FAILED':
      return 'FAILED';
    case 'CANCELED':
    case 'CANCELLED':
      return 'CANCELLED';
    default:
      return 'PENDING';
  }
}

/** Per-transaction payout states from the send-money side. */
function mapPayoutState(status: string): ProviderStatus {
  const s = status.toLowerCase();
  if (s.startsWith('success') || s === 'completed') return 'SUCCESS';
  if (s.startsWith('fail')) return 'FAILED';
  if (s.startsWith('cancel')) return 'CANCELLED';
  return 'PENDING';
}

async function call<T>(path: string, body: unknown): Promise<T> {
  if (!env.intasend.secretKey) {
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
    res = await fetch(env.intasend.baseUrl + path, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: 'Bearer ' + env.intasend.secretKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
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
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    const b = parsed as { detail?: string; errors?: Array<{ detail?: string }> } | null;
    const message =
      b?.errors?.[0]?.detail ?? b?.detail ?? 'Payment provider returned ' + res.status;
    console.error('[intasend] ' + path + ' -> ' + res.status + ' ' + text.slice(0, 400));
    throw new PaymentError('PAYMENTS_REJECTED', message, res.status === 400 ? 400 : 502);
  }
  return parsed as T;
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

// ------------------------------------------------------------- collections
type StkResponse = {
  id?: string;
  invoice?: {
    invoice_id?: string;
    state?: string;
    value?: number | string;
    mpesa_reference?: string | null;
    failed_reason?: string | null;
    failed_code?: string | null;
  };
};

export async function initiateStkPush(params: {
  phone: string;
  amount: number;
  reference: string;
}): Promise<ProviderTxn> {
  if (env.paymentsMock) return mockTxn('DEPOSIT', params.reference, params.amount);

  // IntaSend has no per-request callback for STK — the webhook URL is set once
  // in the dashboard, which is why api_ref carries our own reference through.
  const res = await call<StkResponse>('/api/v1/payment/mpesa-stk-push/', {
    amount: params.amount,
    phone_number: params.phone,
    api_ref: params.reference,
  });

  const invoice = res.invoice ?? {};
  return {
    providerId: invoice.invoice_id ?? res.id ?? '',
    status: mapInvoiceState(String(invoice.state ?? 'PENDING')),
    amount: Number(invoice.value ?? params.amount),
    reference: params.reference,
    receipt: invoice.mpesa_reference ?? null,
    resultCode: invoice.failed_code ?? null,
    resultDesc: invoice.failed_reason ?? null,
  };
}

async function collectionStatus(invoiceId: string): Promise<ProviderTxn | null> {
  try {
    const res = await call<StkResponse & { invoice?: { api_ref?: string } }>(
      '/api/v1/payment/status/',
      { invoice_id: invoiceId }
    );
    const invoice = res.invoice ?? {};
    return {
      providerId: invoice.invoice_id ?? invoiceId,
      status: mapInvoiceState(String(invoice.state ?? 'PENDING')),
      amount: Number(invoice.value ?? 0),
      reference: invoice.api_ref ?? '',
      receipt: invoice.mpesa_reference ?? null,
      resultCode: invoice.failed_code ?? null,
      resultDesc: invoice.failed_reason ?? null,
    };
  } catch (err) {
    console.error('[intasend] collection status failed:', (err as Error).message);
    return null;
  }
}

// ----------------------------------------------------------------- payouts
type SendMoneyResponse = {
  tracking_id?: string;
  batch_reference?: string;
  status?: string;
  status_code?: string;
  transactions?: Array<{
    transaction_id?: string;
    status?: string;
    status_code?: string;
    status_description?: string;
    amount?: string | number;
    account?: string;
  }>;
};

export async function initiateB2CPayout(params: {
  phone: string;
  amount: number;
  reference: string;
  description: string;
  callbackUrl: string;
  name: string;
}): Promise<ProviderTxn> {
  if (env.paymentsMock) return mockTxn('WITHDRAWAL', params.reference, params.amount);

  // requires_approval NO makes this a single call; with YES every payout would
  // need a second approve request or a human clicking in the dashboard.
  const res = await call<SendMoneyResponse>('/api/v1/send-money/initiate/', {
    currency: 'KES',
    provider: 'MPESA-B2C',
    requires_approval: 'NO',
    callback_url: params.callbackUrl,
    batch_reference: params.reference,
    transactions: [
      {
        name: params.name,
        account: params.phone,
        amount: String(params.amount),
        narrative: params.description,
      },
    ],
  });

  const first = res.transactions?.[0];
  return {
    providerId: res.tracking_id ?? '',
    status: mapPayoutState(String(first?.status ?? res.status ?? 'PENDING')),
    amount: Number(first?.amount ?? params.amount),
    reference: params.reference,
    receipt: first?.transaction_id ?? null,
    resultCode: first?.status_code ?? res.status_code ?? null,
    resultDesc: first?.status_description ?? null,
  };
}

async function payoutStatus(trackingId: string): Promise<ProviderTxn | null> {
  try {
    const res = await call<SendMoneyResponse>('/api/v1/send-money/status/', {
      tracking_id: trackingId,
    });
    const first = res.transactions?.[0];
    // The batch can read "Completed" while a leg inside it failed, so the
    // per-transaction status wins whenever there is one.
    const status = first?.status
      ? mapPayoutState(first.status)
      : mapPayoutState(String(res.status ?? 'PENDING'));
    return {
      providerId: res.tracking_id ?? trackingId,
      status,
      amount: Number(first?.amount ?? 0),
      reference: res.batch_reference ?? '',
      receipt: first?.transaction_id ?? null,
      resultCode: first?.status_code ?? res.status_code ?? null,
      resultDesc: first?.status_description ?? null,
    };
  } catch (err) {
    console.error('[intasend] payout status failed:', (err as Error).message);
    return null;
  }
}

/** Authoritative status read, used before any balance moves. */
export function getStatus(kind: TxKind, providerId: string): Promise<ProviderTxn | null> {
  if (env.paymentsMock) return Promise.resolve(null);
  return kind === 'DEPOSIT' ? collectionStatus(providerId) : payoutStatus(providerId);
}

// ---------------------------------------------------------------- webhooks
export type WebhookHint = {
  kind: TxKind;
  reference: string;
  providerId: string;
  status: ProviderStatus;
  receipt: string | null;
  resultCode: string | null;
  resultDesc: string | null;
};

/**
 * Reads either webhook shape into one hint. Collections arrive with an
 * invoice_id and api_ref; payouts arrive with a tracking_id, a batch_reference
 * and a transactions array.
 */
export function parseWebhook(body: Record<string, unknown>): WebhookHint | null {
  if (typeof body.invoice_id === 'string') {
    return {
      kind: 'DEPOSIT',
      reference: String(body.api_ref ?? ''),
      providerId: String(body.invoice_id),
      status: mapInvoiceState(String(body.state ?? 'PENDING')),
      receipt: (body.mpesa_reference as string | undefined) ?? null,
      resultCode: (body.failed_code as string | undefined) ?? null,
      resultDesc: (body.failed_reason as string | undefined) ?? null,
    };
  }

  if (typeof body.tracking_id === 'string') {
    const txns = (body.transactions as Array<Record<string, unknown>> | undefined) ?? [];
    const first = txns[0];
    return {
      kind: 'WITHDRAWAL',
      reference: String(body.batch_reference ?? ''),
      providerId: String(body.tracking_id),
      status: first?.status
        ? mapPayoutState(String(first.status))
        : mapPayoutState(String(body.status ?? 'PENDING')),
      receipt: (first?.transaction_id as string | undefined) ?? null,
      resultCode: (first?.status_code as string | undefined) ??
        (body.status_code as string | undefined) ?? null,
      resultDesc: (first?.status_description as string | undefined) ?? null,
    };
  }

  return null;
}

/**
 * IntaSend does not sign webhooks. Instead you set a challenge string in the
 * dashboard and it is echoed in every delivery, so a body without the expected
 * challenge is not from IntaSend.
 */
export function challengeMatches(body: Record<string, unknown>): boolean {
  const expected = env.intasend.webhookChallenge;
  if (!expected) return false;
  return body.challenge === expected;
}
