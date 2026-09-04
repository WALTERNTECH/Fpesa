import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useApp } from '../store/app';
import { api, ApiError } from '../lib/api';
import { ksh, displayPhone } from '../lib/format';
import { Modal } from './Modal';
import type { Transaction } from '../lib/types';

type Kind = 'deposit' | 'withdraw';
type Stage = 'form' | 'waiting' | 'done';

const QUICK = [100, 500, 1000, 2500, 5000, 10000];

export function WalletModal({ kind }: { kind: Kind }): JSX.Element {
  const { closeModal, user, config, refreshUser, pushToast } = useApp();
  const isDeposit = kind === 'deposit';

  const [amount, setAmount] = useState('');
  const [stage, setStage] = useState<Stage>('form');
  const [error, setError] = useState<string | null>(null);
  const [txn, setTxn] = useState<Transaction | null>(null);
  const pollRef = useRef<number | null>(null);
  const deadlineRef = useRef(0);

  const minimum = isDeposit ? config.minDeposit : config.minWithdrawal;
  const value = Number(amount);
  const available = user?.realBalance ?? 0;

  const validationError = (): string | null => {
    if (amount === '') return null;
    if (!Number.isFinite(value) || value <= 0) return 'Enter a valid amount.';
    if (value < minimum) return 'Minimum is ' + ksh(minimum, true) + '.';
    if (!isDeposit && value > available) return 'You only have ' + ksh(available) + ' available.';
    return null;
  };

  const stopPolling = (): void => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => stopPolling, []);

  // Watch the transaction until the provider resolves it, or we give up
  // waiting. The record itself is still reconciled server-side either way.
  const startPolling = (id: string): void => {
    deadlineRef.current = Date.now() + 2 * 60 * 1000;
    pollRef.current = window.setInterval(() => {
      void (async () => {
        try {
          const res = await api.get<{ transaction: Transaction }>('/wallet/transactions/' + id);
          const tx = res.transaction;
          setTxn(tx);

          if (tx.status !== 'PENDING') {
            stopPolling();
            setStage('done');
            await refreshUser();
            if (tx.status === 'SUCCESS') {
              pushToast({
                tone: 'win',
                icon: '✓',
                title: (isDeposit ? 'Deposit' : 'Withdrawal') + ' complete',
                detail: ksh(tx.amount) + (tx.mpesaReceipt ? ' · ' + tx.mpesaReceipt : ''),
              });
            }
            return;
          }

          if (Date.now() > deadlineRef.current) {
            stopPolling();
            setStage('done');
          }
        } catch {
          // Keep polling; a dropped request is not a failed transaction.
        }
      })();
    }, 2500);
  };

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const problem = validationError();
    if (problem || amount === '') {
      setError(problem ?? 'Enter an amount.');
      return;
    }

    setError(null);
    setStage('waiting');
    try {
      const res = await api.post<{ transaction: Transaction }>(
        isDeposit ? '/wallet/deposit' : '/wallet/withdraw',
        { amount: value }
      );
      setTxn(res.transaction);
      startPolling(res.transaction.id);
      if (!isDeposit) await refreshUser();
    } catch (err) {
      setStage('form');
      setError(err instanceof ApiError ? err.message : 'Could not complete the request.');
    }
  };

  const title = isDeposit ? 'Deposit via M-Pesa' : 'Withdraw to M-Pesa';
  const inlineError = error ?? validationError();

  return (
    <Modal
      title={title}
      subtitle={
        user ? 'To ' + displayPhone(user.phone) + ' — your registered number.' : undefined
      }
      onClose={() => {
        stopPolling();
        closeModal();
      }}
    >
      {stage === 'form' && (
        <form onSubmit={(e) => void submit(e)} noValidate>
          {inlineError && <div className="form-error">{inlineError}</div>}

          {!isDeposit && (
            <div className="payout-row" style={{ marginBottom: 16 }}>
              <span className="k">Available to withdraw</span>
              <span className="v tnum" style={{ color: 'var(--ink)' }}>
                {ksh(available)}
              </span>
            </div>
          )}

          <div className="form-field">
            <label htmlFor="wallet-amount">Amount</label>
            <div className="input-prefix">
              <span className="pfx">KSh</span>
              <input
                id="wallet-amount"
                className={'input' + (inlineError ? ' invalid' : '')}
                type="number"
                inputMode="numeric"
                value={amount}
                min={minimum}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setError(null);
                }}
                placeholder={String(minimum)}
                required
              />
            </div>
            <div className="field-error" style={{ color: 'var(--subtle)' }}>
              Minimum {ksh(minimum, true)}.
            </div>
          </div>

          <div className="chip-row" style={{ marginBottom: 18 }}>
            {QUICK.filter((v) => v >= minimum)
              .slice(0, 4)
              .map((v) => (
                <button
                  key={v}
                  type="button"
                  className="chip"
                  onClick={() => {
                    setAmount(String(v));
                    setError(null);
                  }}
                >
                  {v >= 1000 ? v / 1000 + 'K' : v}
                </button>
              ))}
          </div>

          <button className="btn btn-primary btn-lg btn-block" type="submit">
            {isDeposit ? 'Send M-Pesa request' : 'Withdraw now'}
          </button>

          <p className="form-note">
            {isDeposit
              ? 'You will get an STK push on your phone. Enter your M-Pesa PIN to confirm.'
              : 'Payouts are sent straight to your registered M-Pesa number.'}
          </p>
        </form>
      )}

      {stage === 'waiting' && (
        <div className="stk-wait">
          <div className="stk-ring" />
          <div className="t">
            {isDeposit ? 'Check your phone' : 'Sending your payout'}
          </div>
          <p className="d">
            {isDeposit
              ? 'Enter your M-Pesa PIN on the prompt to deposit ' + ksh(value) + '.'
              : 'Transferring ' + ksh(value) + ' to ' + displayPhone(user?.phone ?? '') + '.'}
          </p>
          {txn && (
            <p className="form-note" style={{ marginTop: 16 }}>
              Reference {txn.reference}
            </p>
          )}
        </div>
      )}

      {stage === 'done' && txn && (
        <div className="stk-done">
          <div className={'stk-badge ' + (txn.status === 'SUCCESS' ? 'ok' : 'bad')}>
            {txn.status === 'SUCCESS' ? '✓' : txn.status === 'PENDING' ? '⏳' : '✕'}
          </div>
          <div className="t" style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>
            {txn.status === 'SUCCESS'
              ? (isDeposit ? 'Deposit received' : 'Withdrawal sent')
              : txn.status === 'PENDING'
                ? 'Still processing'
                : (isDeposit ? 'Deposit not completed' : 'Withdrawal failed')}
          </div>
          <p className="d" style={{ color: 'var(--muted)' }}>
            {txn.status === 'SUCCESS'
              ? ksh(txn.amount) +
                (txn.mpesaReceipt ? ' · M-Pesa ref ' + txn.mpesaReceipt : '')
              : txn.status === 'PENDING'
                ? 'This is taking longer than usual. We will update your balance the moment M-Pesa confirms.'
                : txn.message ??
                  (isDeposit
                    ? 'The request was cancelled or timed out. No money left your account.'
                    : 'The payout could not be sent. Your balance has been restored.')}
          </p>
          <button
            className="btn btn-primary btn-lg btn-block"
            style={{ marginTop: 20 }}
            onClick={() => {
              stopPolling();
              closeModal();
            }}
          >
            Done
          </button>
        </div>
      )}
    </Modal>
  );
}
