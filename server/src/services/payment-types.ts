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
  /**
   * `message` is shown to the trader. `detail` is what actually went wrong, for
   * the log and the transaction record.
   *
   * The two are separated because the provider's own wording is written for
   * whoever runs the integration, not for a customer: "Insufficient service
   * token balance to cover B2C fee" tells an operator exactly what to top up
   * and tells a trader nothing except that something is broken. Putting the
   * raw text on screen also invites the reading that the trader's own money is
   * missing, when a failed payout is refunded in full.
   */
  constructor(
    public code: string,
    message: string,
    public status = 502,
    public detail: string | null = null
  ) {
    super(message);
  }
}
