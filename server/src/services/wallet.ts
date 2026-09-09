import { randomBytes } from 'node:crypto';
import { env } from '../env.js';
import { db, pgErrorCode } from '../lib/db.js';
import { hub } from '../realtime/hub.js';
import { maskUsername } from './trading.js';
import {
  PROVIDER,
  PaymentError,
  getStatus,
  initiateB2CPayout,
  initiateStkPush,
  setMockSettlementHandler,
  type ProviderStatus,
  type TxKind,
} from './payments.js';

export type TxRow = {
  id: string;
  user_id: string;
  kind: 'DEPOSIT' | 'WITHDRAWAL';
  amount: string | number;
  status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'EXPIRED';
  phone: string;
  provider_txn_id: string | null;
  reference: string;
  mpesa_receipt: string | null;
  result_desc: string | null;
  created_at: string;
  updated_at: string;
};

export type PublicTx = {
  id: string;
  kind: 'DEPOSIT' | 'WITHDRAWAL';
  amount: number;
  status: TxRow['status'];
  phone: string;
  reference: string;
  mpesaReceipt: string | null;
  message: string | null;
  createdAt: string;
  updatedAt: string;
};

export function toPublicTx(row: TxRow): PublicTx {
  return {
    id: row.id,
    kind: row.kind,
    amount: Number(row.amount),
    status: row.status,
    phone: row.phone,
    reference: row.reference,
    mpesaReceipt: row.mpesa_receipt,
    message: row.result_desc,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class WalletError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

/**
 * Eleven characters, deliberately.
 *
 * M-Pesa caps the account reference at twelve, and an over-long value is
 * rejected by Safaricom rather than by the provider — which surfaces as a
 * mysterious failed payment instead of a validation error. The old
 * "FP-D-XXXXXXXXXXXX" form was seventeen.
 */
function reference(kind: 'D' | 'W'): string {
  return kind + randomBytes(5).toString('hex').toUpperCase();
}

function callbackUrl(): string {
  if (!env.publicUrl) {
    throw new WalletError(
      'CALLBACK_UNCONFIGURED',
      'Payments are not fully configured yet. Please contact support.',
      503
    );
  }
  return env.publicUrl + '/api/webhooks/' + PROVIDER + '/' + env.webhookToken;
}

/** Both are configurable; 0 removes our own ceiling. See env.ts. */
const MAX_DEPOSIT = env.maxDeposit;
const MAX_WITHDRAWAL = env.maxWithdrawal;

// --------------------------------------------------------------- deposits
export async function startDeposit(user: {
  id: string;
  phone: string;
  username: string;
}, amount: number, payFrom?: string): Promise<PublicTx> {
  // The prompt can go to any M-Pesa number — someone paying from a second line
  // or a family member's phone is ordinary. The number used is recorded on the
  // transaction, so the statement shows where the money actually came from
  // rather than where it was assumed to come from.
  const phone = payFrom || user.phone;
  const value = Math.round(amount);
  if (!Number.isFinite(value) || value < env.minDeposit) {
    throw new WalletError(
      'AMOUNT_TOO_LOW',
      'Minimum deposit is KSh ' + env.minDeposit + '.'
    );
  }
  if (MAX_DEPOSIT > 0 && value > MAX_DEPOSIT) {
    throw new WalletError(
      'AMOUNT_TOO_HIGH',
      'Maximum single deposit is KSh ' + MAX_DEPOSIT.toLocaleString('en-KE') + '.'
    );
  }

  const ref = reference('D');
  // Fail before charging anyone if the callback address is not configured.
  // Palpluss requires it on every STK request; IntaSend reads its own from
  // their dashboard, but a deposit either way is worthless without a route
  // back for the result.
  callbackUrl();

  const { data, error } = await db
    .from('transactions')
    .insert({
      user_id: user.id,
      kind: 'DEPOSIT',
      amount: value,
      phone,
      reference: ref,
      status: 'PENDING',
    })
    .select('*')
    .single();

  if (error || !data) {
    console.error('[wallet] could not record deposit:', error?.message);
    throw new WalletError('DEPOSIT_FAILED', 'Could not start the deposit.', 500);
  }
  const row = data as TxRow;

  try {
    const provider = await initiateStkPush({
      phone,
      amount: value,
      reference: ref,
      callbackUrl: callbackUrl(),
    });
    await db
      .from('transactions')
      .update({ provider_txn_id: provider.providerId, updated_at: new Date().toISOString() })
      .eq('id', row.id);
    return toPublicTx({ ...row, provider_txn_id: provider.providerId });
  } catch (err) {
    // The STK request never reached M-Pesa, so close the record out rather
    // than leaving a phantom PENDING deposit on the user's history.
    await db
      .from('transactions')
      .update({
        status: 'FAILED',
        result_desc: err instanceof Error ? err.message : 'Request failed',
        updated_at: new Date().toISOString(),
      })
      .eq('id', row.id);
    if (err instanceof PaymentError) throw new WalletError(err.code, err.message, err.status);
    throw new WalletError('DEPOSIT_FAILED', 'Could not send the M-Pesa prompt.', 502);
  }
}

// ------------------------------------------------------------ withdrawals
export async function startWithdrawal(user: {
  id: string;
  phone: string;
  username: string;
}, amount: number, payTo?: string): Promise<PublicTx> {
  /**
   * Payouts may be sent to a number other than the registered one.
   *
   * Worth being clear-eyed about: this is the control that normally stops a
   * stolen session draining an account to a stranger's phone, and sending
   * elsewhere is also the classic laundering route. It is allowed because the
   * operator asked for it, and every payout records the destination, so an
   * account paying out to a number that is not its own is at least visible
   * afterwards rather than invisible.
   */
  const phone = payTo || user.phone;
  const value = Math.round(amount);
  if (!Number.isFinite(value) || value < env.minWithdrawal) {
    throw new WalletError(
      'AMOUNT_TOO_LOW',
      'Minimum withdrawal is KSh ' + env.minWithdrawal + '.'
    );
  }
  if (MAX_WITHDRAWAL > 0 && value > MAX_WITHDRAWAL) {
    throw new WalletError(
      'AMOUNT_TOO_HIGH',
      'Maximum single withdrawal is KSh ' + MAX_WITHDRAWAL.toLocaleString('en-KE') + '.'
    );
  }

  const ref = reference('W');
  const url = callbackUrl();

  // Reserve first: the balance is debited inside the same transaction that
  // creates the payout record, so the funds cannot be traded while in flight.
  const { data, error } = await db.rpc('fpesa_reserve_withdrawal', {
    p_user: user.id,
    p_amount: value,
    p_phone: phone,
    p_reference: ref,
  });

  if (error) {
    const code = pgErrorCode(error.message);
    if (code === 'INSUFFICIENT_FUNDS') {
      throw new WalletError('INSUFFICIENT_FUNDS', 'Your balance is lower than that amount.');
    }
    if (code === 'WITHDRAWAL_IN_FLIGHT') {
      throw new WalletError(
        'WITHDRAWAL_IN_FLIGHT',
        'You already have a withdrawal being processed. Wait for it to finish.'
      );
    }
    if (code === 'TURNOVER_NOT_MET') {
      // The function appends the shortfall to the code, so the trader is told
      // exactly how much trading is left rather than just being refused.
      const short = Number(/TURNOVER_NOT_MET:([0-9.]+)/.exec(error.message)?.[1] ?? 0);
      throw new WalletError(
        'TURNOVER_NOT_MET',
        'You have KSh ' + short.toLocaleString('en-KE', { minimumFractionDigits: 2 }) +
          ' of trading left before this deposit can be withdrawn.'
      );
    }
    console.error('[wallet] reserve failed:', error.message);
    throw new WalletError('WITHDRAWAL_FAILED', 'Could not start the withdrawal.', 500);
  }

  const reserved = data as { transaction: TxRow; balance: string | number };
  const row = reserved.transaction;

  try {
    if (phone !== user.phone) {
      console.log(
        '[wallet] payout for ' + user.username + ' going to ' + phone +
        ', not the registered ' + user.phone
      );
    }
    const provider = await initiateB2CPayout({
      phone,
      amount: value,
      reference: ref,
      description: 'Fpesa withdrawal',
      callbackUrl: url,
      name: user.username,
    });
    await db
      .from('transactions')
      .update({ provider_txn_id: provider.providerId, updated_at: new Date().toISOString() })
      .eq('id', row.id);

    hub.toUser(user.id, { type: 'balance', realBalance: Number(reserved.balance) });
    return toPublicTx({ ...row, provider_txn_id: provider.providerId });
  } catch (err) {
    // Payout never left our side — hand the money straight back.
    await finaliseTransaction(ref, 'FAILED', null, null, 'Payout could not be sent');
    if (err instanceof PaymentError) throw new WalletError(err.code, err.message, err.status);
    throw new WalletError('WITHDRAWAL_FAILED', 'Could not send the payout.', 502);
  }
}

// ------------------------------------------------------- settle either kind
export async function finaliseTransaction(
  ref: string,
  status: ProviderStatus,
  receipt: string | null,
  resultCode: string | null,
  resultDesc: string | null,
  providerId: string | null = null
): Promise<void> {
  if (status === 'PENDING') return;

  const { data: existing } = await db
    .from('transactions')
    .select('id, kind, user_id, amount, status')
    .eq('reference', ref)
    .maybeSingle();
  if (!existing) {
    console.warn('[wallet] callback for unknown reference ' + ref);
    return;
  }
  const tx = existing as { id: string; kind: 'DEPOSIT' | 'WITHDRAWAL'; user_id: string; amount: string | number; status: string };
  if (tx.status !== 'PENDING') return;

  const fn = tx.kind === 'DEPOSIT' ? 'fpesa_apply_deposit' : 'fpesa_settle_withdrawal';
  const args: Record<string, unknown> =
    tx.kind === 'DEPOSIT'
      ? {
          p_reference: ref,
          p_status: status,
          p_receipt: receipt,
          p_result_code: resultCode,
          p_result_desc: resultDesc,
          p_provider_id: providerId,
          p_turnover_multiple: env.turnoverMultiple,
        }
      : {
          p_reference: ref,
          p_status: status,
          p_receipt: receipt,
          p_result_code: resultCode,
          p_result_desc: resultDesc,
        };

  const { data, error } = await db.rpc(fn, args);
  if (error) {
    console.error('[wallet] ' + fn + ' failed for ' + ref + ':', error.message);
    return;
  }

  const result = data as { balance: string | number; duplicate?: boolean };
  if (result.duplicate) return;

  const balance = Number(result.balance);
  hub.toUser(tx.user_id, { type: 'balance', realBalance: balance });

  if (status === 'SUCCESS') {
    const { data: u } = await db.from('users').select('username').eq('id', tx.user_id).maybeSingle();
    const username = (u as { username?: string } | null)?.username;
    if (username) {
      hub.broadcast({
        type: 'feed',
        kind: tx.kind,
        username: maskUsername(username),
        amount: Number(tx.amount),
        createdAt: new Date().toISOString(),
      });
    }
  }
}

/**
 * Applies a provider callback. The webhook body is treated purely as a hint —
 * the real status is read back from IntaSend before any balance changes, so a
 * forged callback cannot credit an account even if the challenge string leaks.
 */
export async function handleProviderCallback(payload: {
  kind: TxKind;
  reference: string;
  providerId: string | null;
  status: ProviderStatus;
  receipt: string | null;
  resultCode: string | null;
  resultDesc: string | null;
}): Promise<void> {
  let status = payload.status;
  let receipt = payload.receipt;
  let resultCode = payload.resultCode;
  let resultDesc = payload.resultDesc;

  if (payload.providerId && !env.paymentsMock) {
    const confirmed = await getStatus(payload.kind, payload.providerId);
    if (confirmed) {
      status = confirmed.status;
      receipt = confirmed.receipt ?? receipt;
      resultCode = confirmed.resultCode ?? resultCode;
      resultDesc = confirmed.resultDesc ?? resultDesc;
    } else if (status === 'SUCCESS') {
      // Could not verify a claimed success — do not credit on the webhook alone.
      // The reconciliation sweep will settle it once the provider answers.
      console.warn('[wallet] unverified SUCCESS callback for ' + payload.reference + '; deferring');
      return;
    }
  }

  await finaliseTransaction(
    payload.reference,
    status,
    receipt,
    resultCode,
    resultDesc,
    payload.providerId
  );
}

/**
 * Webhooks get lost. Every minute, any deposit or payout still pending after
 * two minutes is reconciled directly against IntaSend, and anything still
 * unresolved after 15 minutes is expired (refunding reserved payouts).
 */
export function startReconciliation(): void {
  const sweep = async (): Promise<void> => {
    const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const { data } = await db
      .from('transactions')
      .select('id, reference, provider_txn_id, created_at, kind')
      .eq('status', 'PENDING')
      .lt('created_at', cutoff)
      .limit(25);

    for (const row of (data ?? []) as Array<{
      reference: string;
      provider_txn_id: string | null;
      created_at: string;
      kind: TxKind;
    }>) {
      const ageMs = Date.now() - Date.parse(row.created_at);
      if (row.provider_txn_id) {
        const confirmed = await getStatus(row.kind, row.provider_txn_id);
        if (confirmed && confirmed.status !== 'PENDING') {
          await finaliseTransaction(
            row.reference,
            confirmed.status,
            confirmed.receipt,
            confirmed.resultCode,
            confirmed.resultDesc
          );
          continue;
        }
      }
      if (ageMs > 15 * 60 * 1000) {
        await finaliseTransaction(row.reference, 'EXPIRED', null, null, 'Timed out with no response');
      }
    }
  };

  setInterval(() => void sweep().catch((e) => console.error('[wallet] sweep:', e)), 60_000);
  void sweep().catch(() => undefined);

  // In mock mode the simulator drives settlement directly.
  setMockSettlementHandler((_kind, ref, status, receipt) => {
    void finaliseTransaction(ref, status, receipt, '0', 'Mock settlement');
  });
}
