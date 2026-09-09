import { env } from '../env.js';
import * as palpluss from './palpluss.js';
import * as intasend from './intasend.js';
import type { ProviderTxn, TxKind, WebhookHint } from './payment-types.js';

export {
  PaymentError,
  type ProviderStatus,
  type ProviderTxn,
  type TxKind,
  type WebhookHint,
} from './payment-types.js';

/**
 * The payment provider, chosen by configuration.
 *
 * Both adapters normalise to the same shape, so nothing downstream — the
 * wallet, the webhook route, the reconciliation sweep — knows or cares which
 * one is live. Switching is `PAYMENTS_PROVIDER`, not a code change, which
 * matters because the choice of provider here has already changed twice and the
 * platform should not have to be rewritten when it changes again.
 */
export const PROVIDER = (env.paymentsProvider === 'intasend' ? 'intasend' : 'palpluss') as
  | 'palpluss'
  | 'intasend';

const active = PROVIDER === 'intasend' ? intasend : palpluss;

export function setMockSettlementHandler(
  fn: (kind: TxKind, reference: string, status: ProviderTxn['status'], receipt: string) => void
): void {
  // Both adapters carry their own mock handler; wire whichever is live.
  active.setMockSettlementHandler(fn);
}

export function initiateStkPush(params: {
  phone: string;
  amount: number;
  reference: string;
  callbackUrl: string;
}): Promise<ProviderTxn> {
  // IntaSend takes no per-request callback — its webhook is set in their
  // dashboard — so the extra field is simply ignored on that path.
  return active.initiateStkPush(params);
}

export function initiateB2CPayout(params: {
  phone: string;
  amount: number;
  reference: string;
  description: string;
  callbackUrl: string;
  name: string;
}): Promise<ProviderTxn> {
  return active.initiateB2CPayout(params);
}

export function getStatus(kind: TxKind, providerId: string): Promise<ProviderTxn | null> {
  return active.getStatus(kind, providerId);
}

export function parseWebhook(body: Record<string, unknown>): WebhookHint | null {
  return active.parseWebhook(body);
}

export function challengeMatches(body: Record<string, unknown>): boolean {
  return active.challengeMatches(body);
}

/**
 * The payout wallet's balance, when the provider will tell us.
 *
 * Only Palpluss exposes this. Where it is available it is a better source for
 * the operator float than a number typed into the console, because it cannot go
 * stale when money moves.
 */
export function walletBalance(): Promise<number | null> {
  return PROVIDER === 'palpluss' ? palpluss.walletBalance() : Promise.resolve(null);
}
