/**
 * The shape every payment provider is normalised to.
 *
 * Kept apart from any one adapter so a second provider does not have to import
 * the first just to describe a transaction — and so switching providers is a
 * config change rather than an edit to the wallet.
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

export type WebhookHint = {
  kind: TxKind;
  reference: string;
  providerId: string;
  status: ProviderStatus;
  receipt: string | null;
  resultCode: string | null;
  resultDesc: string | null;
};

export class PaymentError extends Error {
  constructor(public code: string, message: string, public status = 502) {
    super(message);
  }
}
