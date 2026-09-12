import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useApp } from '../store/app';
import { Modal } from './Modal';

type Plan = {
  code: string;
  label: string;
  price: number;
  hours: number;
  edge: number;
  winRate: number;
};

type PassView = {
  normalEdge: number;
  normalWinRate: number;
  active: { code: string | null; edge: number | null; validUntil: string; winRate: number } | null;
  plans: Plan[];
};

/**
 * The trading pass.
 *
 * Lives in the account menu rather than on the ticket. On the ticket it was a
 * pitch sitting between the trader and the Buy button on every single visit;
 * here it is something they go and get when they want it.
 *
 * What is being sold is a win rate, so that is what it says: 39 positions in a
 * hundred win at the standard spread, 47 at the pass rate. Quoting "3% instead
 * of 11%" would be accurate and mean nothing to most people.
 *
 * What it deliberately does not say is that the pass makes anyone profitable.
 * It does not — the expected result is still negative at any spread above zero,
 * and a pass bought on a small balance costs more over its life than it saves.
 * It buys more trades and more wins, which is a real thing to want and a
 * different claim.
 */
export function PassModal(): JSX.Element | null {
  const { user, refreshUser, closeModal, openModal } = useApp();
  const [view, setView] = useState<PassView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shortfall, setShortfall] = useState(false);

  const load = useCallback(() => {
    if (!user) return;
    void api.get<PassView>('/trades/pass').then(setView).catch(() => undefined);
  }, [user]);

  useEffect(load, [load]);

  if (!user) return null;

  const buy = (plan: Plan): void => {
    setBusy(plan.code);
    setError(null);
    setShortfall(false);
    void api
      .post<{ label: string; winRate: number }>('/trades/pass', { plan: plan.code })
      .then(async () => {
        // The session carries the new rate, and every ticket is priced from it.
        await refreshUser();
        closeModal();
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError) {
          setError(err.message);
          // A pass is paid from the balance, so the way out of this is a
          // deposit — offered as a button rather than left as an error.
          setShortfall(err.code === 'INSUFFICIENT_FUNDS');
        } else {
          setError('Could not buy that pass.');
        }
      })
      .finally(() => setBusy(null));
  };

  const running = view?.active ?? null;

  return (
    <Modal
      title={running ? 'Extend your pass' : 'Trading pass'}
      subtitle={
        view
          ? running
            ? 'Running at ' + ((running.edge ?? 0) * 100).toFixed(0) + '% — add more time'
            : 'Win about ' + (view.plans[0]?.winRate ?? 0) + ' trades in 100 instead of ' +
              view.normalWinRate
          : undefined
      }
      onClose={closeModal}
    >
      {!view && <p className="pass-note">Loading…</p>}

      {view && view.plans.length === 0 && (
        <p className="pass-note">No passes are on offer right now.</p>
      )}

      {view && view.plans.length > 0 && (
        <>
          <div className="pass-plans">
            {view.plans.map((p) => (
              <button
                key={p.code}
                className="pass-plan"
                disabled={busy !== null}
                onClick={() => buy(p)}
              >
                <b>{p.label}</b>
                <span className="pass-price">KSh {p.price.toLocaleString('en-KE')}</span>
                <small>{busy === p.code ? 'Buying…' : 'win ~' + p.winRate + ' in 100'}</small>
              </button>
            ))}
          </div>

          {error && <div className="pass-error">{error}</div>}
          {shortfall && (
            <button
              className="btn btn-primary btn-block"
              style={{ marginTop: 10 }}
              onClick={() => openModal('deposit')}
            >
              Deposit
            </button>
          )}

          {/* One correction, not four restatements of it. The pass sells a win
              rate, so the only thing that has to be said back is that a better
              win rate is not the same as making money. */}
          <p className="pass-note">
            Cuts your cost to open from {(view.normalEdge * 100).toFixed(0)}% of stake to{' '}
            {(view.plans[0]!.edge * 100).toFixed(0)}%, so more trades finish in profit and
            your balance lasts longer. It buys more trades and more wins —{' '}
            <b>not a winning strategy</b>.
          </p>
        </>
      )}
    </Modal>
  );
}
