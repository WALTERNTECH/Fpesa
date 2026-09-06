import { useCallback, useEffect, useState, type FormEvent } from 'react';

/* ---------------------------------------------------------------- types */
type Overview = {
  users: {
    total: number; funded: number; activeToday: number;
    liability: number; turnoverOutstanding: number;
  };
  cash: { deposits: number; withdrawals: number; pending: number; netCash: number };
  real: {
    trades: number; volume: number; netToTraders: number; houseMargin: number;
    marginPct: number; won: number; lost: number; stoppedOut: number;
    winRate: number; disbursedPct: number;
  };
  demo: { trades: number; volume: number };
  recentTrades: Array<{
    settled_at: string; direction: string; stake: number; profit: number;
    status: string; close_reason: string | null; duration_sec: number; multiplier: number;
  }>;
  desk: {
    open: boolean; ratio: number; cap: number; reopenAt: number;
    armed: boolean; minBase: number;
  };
  instrument: {
    symbol: string; name: string; mode: string; price: number; changePct: number;
    provablyFair: boolean; epoch: number | null; commitment: string | null;
    params: { tickMs: number; epochMs: number; sigma: number; drift: number } | null;
  };
  settings: {
    houseEdge: number; turnoverMultiple: number; dailyPayoutCap: number;
    maxProfitMultiple: number; minStake: number; maxStake: number;
  };
  distribution: Array<{
    duration: number; multiplier: number; oneSigmaPct: number; oneSigmaPrice: number;
    oneSigmaStakePct: number; stopOutMovePct: number; stopOutOdds: number;
  }> | null;
  upstream?: { ok: boolean; url: string };
};

/* --------------------------------------------------------------- helpers */
const kes = new Intl.NumberFormat('en-KE', { maximumFractionDigits: 0 });
const ksh = (n: number): string => 'KSh ' + kes.format(Number.isFinite(n) ? n : 0);

function ago(iso: string): string {
  const s = Math.max(Math.floor((Date.now() - Date.parse(iso)) / 1000), 0);
  if (!Number.isFinite(s)) return '';
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch('/api' + path, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  if (!res.ok) {
    const e = parsed as { message?: string } | null;
    throw new Error(e?.message ?? 'Request failed (' + res.status + ')');
  }
  return parsed as T;
}

/* ----------------------------------------------------------------- login */
function Login({ onIn }: { onIn: () => void }): JSX.Element {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call('/auth/login', { username, password });
      onIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <form className="gate-card" onSubmit={(e) => void submit(e)}>
        <div className="gate-brand">
          Fpesa <span>Operations</span>
        </div>
        <p className="gate-sub">Operator access only.</p>
        {error && <div className="err">{error}</div>}
        <label htmlFor="u">Username</label>
        <input id="u" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        <label htmlFor="p">Password</label>
        <input id="p" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------- dashboard */
function Stat({ k, v, tone }: { k: string; v: string; tone?: 'up' | 'down' }): JSX.Element {
  return (
    <div className="stat">
      <div className="stat-k">{k}</div>
      <div className={'stat-v' + (tone ? ' ' + tone : '')}>{v}</div>
    </div>
  );
}

function Dashboard({ onOut }: { onOut: () => void }): JSX.Element {
  const [d, setD] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      setD(await call<Overview>('/admin/overview'));
      setAt(new Date());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load.');
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(id);
  }, [load]);

  return (
    <>
      <header className="top">
        <div className="top-brand">
          Fpesa <span>Operations</span>
        </div>
        <div className="top-right">
          {at && <span className="top-at">updated {at.toLocaleTimeString('en-KE')}</span>}
          <button className="btn ghost" onClick={() => void load()}>Refresh</button>
          <button
            className="btn ghost"
            onClick={() => {
              void call('/auth/logout', {}).finally(onOut);
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="wrap">
        {error && <div className="err">{error}</div>}
        {!d && !error && <div className="muted">Loading…</div>}

        {d && (
          <>
            {d.upstream && !d.upstream.ok && (
              <div className="warn">
                Cannot reach the trading service at {d.upstream.url} — instrument and desk
                figures below are unavailable. Book figures come from the database and are
                still accurate.
              </div>
            )}

            <section>
              <h2>The book today</h2>
              <div className="grid">
                <Stat k="Deposits in" v={ksh(d.cash.deposits)} />
                <Stat k="Withdrawals out" v={ksh(d.cash.withdrawals)} />
                <Stat k="Net cash" v={ksh(d.cash.netCash)} tone={d.cash.netCash >= 0 ? 'up' : 'down'} />
                <Stat
                  k="Disbursed"
                  v={d.real.disbursedPct.toFixed(1) + '%'}
                  tone={d.real.disbursedPct <= d.settings.dailyPayoutCap * 100 ? 'up' : 'down'}
                />
                <Stat k="House margin" v={ksh(d.real.houseMargin)} tone={d.real.houseMargin >= 0 ? 'up' : 'down'} />
                <Stat k="Margin on volume" v={d.real.marginPct.toFixed(2) + '%'} />
                <Stat k="Pending transfers" v={String(d.cash.pending)} />
                <Stat k="Owed to traders" v={ksh(d.users.liability)} />
              </div>
              <p className="note">
                Target {(d.settings.dailyPayoutCap * 100).toFixed(0)}% disbursed, from a{' '}
                {(d.settings.houseEdge * 100).toFixed(0)}% edge over {d.settings.turnoverMultiple}×
                turnover. <b>Margin on volume</b> settling near {(d.settings.houseEdge * 100).toFixed(0)}%
                is the sign the model is behaving; a drift there shows up long before the bank balance does.
              </p>
            </section>

            <section>
              <h2>Desk</h2>
              <div className="grid">
                <Stat k="Live trading" v={d.desk.open ? 'Open' : 'Paused'} tone={d.desk.open ? 'up' : 'down'} />
                <Stat k="Payout ratio" v={(d.desk.ratio * 100).toFixed(1) + '%'} />
                <Stat k="Closes at" v={(d.desk.cap * 100).toFixed(0) + '%'} />
                <Stat k="Reopens at" v={(d.desk.reopenAt * 100).toFixed(0) + '%'} />
              </div>
              {!d.desk.armed && (
                <p className="note">
                  Cap inactive — the day needs {ksh(d.desk.minBase)} of deposits before the ratio
                  means anything.
                </p>
              )}
            </section>

            <section>
              <h2>Trading &amp; traders</h2>
              <div className="grid">
                <Stat k="Live trades" v={String(d.real.trades)} />
                <Stat k="Live volume" v={ksh(d.real.volume)} />
                <Stat k="Trader win rate" v={d.real.winRate.toFixed(1) + '%'} />
                <Stat k="Stopped out" v={String(d.real.stoppedOut)} />
                <Stat k="Demo trades" v={String(d.demo.trades)} />
                <Stat k="Registered" v={String(d.users.total)} />
                <Stat k="Funded" v={String(d.users.funded)} />
                <Stat k="Active today" v={String(d.users.activeToday)} />
              </div>
              <p className="note">
                Outstanding turnover across all accounts: {ksh(d.users.turnoverOutstanding)} — the
                trading still owed before those balances can be withdrawn.
              </p>
            </section>

            {d.distribution && (
              <section>
                <h2>How the instrument behaves</h2>
                <p className="note nomargin">
                  {d.instrument.symbol} · {d.instrument.name} · price {d.instrument.price} ·
                  sigma {d.instrument.params?.sigma} · drift {d.instrument.params?.drift} ·
                  epoch {d.instrument.epoch}
                </p>
                <div className="tw">
                  <table>
                    <thead>
                      <tr>
                        <th>Duration</th><th>Multiplier</th><th>Typical move</th>
                        <th>= of stake</th><th>Wipe-out move</th><th>Wipe-out odds</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.distribution.map((r) => (
                        <tr key={r.duration}>
                          <td>{r.duration}s</td>
                          <td>×{r.multiplier.toLocaleString('en-KE')}</td>
                          <td>{r.oneSigmaPct.toFixed(3)}% ({r.oneSigmaPrice})</td>
                          <td>{r.oneSigmaStakePct.toFixed(0)}%</td>
                          <td>{r.stopOutMovePct.toFixed(3)}%</td>
                          <td>{r.stopOutOdds.toFixed(2)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="note">
                  This is the forecast: the distribution, not individual outcomes. Roughly two
                  thirds of positions land inside the typical move. The engine is deterministic and
                  every closed epoch replays from its published seed — which is also why no future
                  price appears here. If this screen could show the next tick, the published
                  fairness proof would be worthless the day anyone noticed.
                </p>
              </section>
            )}

            <section>
              <h2>Recent live trades</h2>
              <div className="tw">
                <table>
                  <thead>
                    <tr><th>When</th><th>Side</th><th>Stake</th><th>Result</th><th>Closed by</th></tr>
                  </thead>
                  <tbody>
                    {d.recentTrades.length === 0 && (
                      <tr><td colSpan={5} className="muted">No live trades settled yet.</td></tr>
                    )}
                    {d.recentTrades.map((t, i) => (
                      <tr key={i}>
                        <td>{ago(t.settled_at)} ago</td>
                        <td>{t.direction}</td>
                        <td>{ksh(Number(t.stake))}</td>
                        <td className={Number(t.profit) >= 0 ? 'up' : 'down'}>
                          {Number(t.profit) >= 0 ? '+' : '−'}{ksh(Math.abs(Number(t.profit)))}
                        </td>
                        <td>{t.close_reason ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </main>
    </>
  );
}

/* ------------------------------------------------------------------ app */
export function App(): JSX.Element {
  const [state, setState] = useState<'checking' | 'out' | 'in'>('checking');

  const check = useCallback(async () => {
    try {
      const me = await call<{ user: { isAdmin: boolean } | null }>('/auth/me');
      setState(me.user?.isAdmin ? 'in' : 'out');
    } catch {
      setState('out');
    }
  }, []);

  useEffect(() => { void check(); }, [check]);

  if (state === 'checking') return <div className="gate"><div className="muted">…</div></div>;
  if (state === 'out') return <Login onIn={() => void check()} />;
  return <Dashboard onOut={() => setState('out')} />;
}
