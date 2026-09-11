import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useApp } from '../store/app';

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
 * The trading pass, on the ticket.
 *
 * What is being sold is a win rate, so that is what it says: 39 positions in a
 * hundred win at the standard spread, 47 at the pass rate. Quoting "3% instead
 * of 11%" would be accurate and mean nothing to most people.
 *
 * What it deliberately does not say is that the pass makes anyone profitable.
 * It does not — the expected result is still negative at any spread above zero,
 * and a pass bought on a small balance costs more over its life than it saves.
 * It buys more trades and more wins, which is a real thing to want and a
 * different claim. The line at the bottom says so rather than leaving it to be
 * discovered.
 */
export function PassCard(): JSX.Element | null {
  const { user, refreshUser } = useApp();
  const [view, setView] = useState<PassView | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!user) return;
    void api.get<PassView>('/trades/pass').then(setView).catch(() => undefined);
  }, [user]);

  useEffect(load, [load]);

  if (!user || !view || view.plans.length === 0) return null;

  const buy = (plan: Plan): void => {
    setBusy(plan.code);
    setError(null);
    setNotice(null);
    void api
      .post<{ label: string; winRate: number; balance: number }>('/trades/pass', {
        plan: plan.code,
      })
      .then(async (r) => {
        setNotice(
          r.label + ' active — you now win about ' + r.winRate + ' trades in 100 instead of ' +
          view.normalWinRate + '.'
        );
        setOpen(false);
        // The session carries the new rate, and every ticket is priced from it.
        await refreshUser();
        load();
      })
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : 'Could not buy that pass.')
      )
      .finally(() => setBusy(null));
  };

  // While one is running the ticket already shows the rate, so this becomes a
  // quiet extend rather than a pitch.
  const running = view.active !== null;
  const cheapest = view.plans.reduce((a, b) => (b.price < a.price ? b : a));

  return (
    <div className={'pass-card' + (running ? ' running' : '')}>
      <button className="pass-head" onClick={() => setOpen((v) => !v)}>
        <span className="pass-title">
          {running ? 'Extend your pass' : 'Trading pass'}
        </span>
        <span className="pass-sub">
          {running
            ? 'Add more time at ' + ((view.active!.edge ?? 0) * 100).toFixed(0) + '%'
            : 'Win ~' + view.plans[0]!.winRate + ' in 100 instead of ' +
              view.normalWinRate + ' · from KSh ' + cheapest.price}
        </span>
        <span className="pass-chev">{open ? '▾' : '▸'}</span>
      </button>

      {notice && <div className="pass-notice">{notice}</div>}
      {error && <div className="pass-error">{error}</div>}

      {open && (
        <div className="pass-body">
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
                <small>
                  {busy === p.code ? 'Buying…' : 'win ~' + p.winRate + ' in 100'}
                </small>
              </button>
            ))}
          </div>
          <p className="pass-note">
            The pass lowers what each trade costs you to open, from{' '}
            {(view.normalEdge * 100).toFixed(0)}% of your stake to{' '}
            {(view.plans[0]!.edge * 100).toFixed(0)}%. That means more of your
            trades finish in profit and your balance lasts longer.
            {' '}
            <b>It does not make trading profitable</b> — the odds stay against
            you on every single trade, and on a small balance a pass can cost
            more than it saves. It buys you more trades and more wins, not a
            better outcome.
          </p>
        </div>
      )}
    </div>
  );
}
