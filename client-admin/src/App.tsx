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
  const [tab, setTab] = useState<'book' | 'accounts'>('book');
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

  // The overview polls every 15s; there is no reason to keep hitting it while
  // the operator is working on an account.
  useEffect(() => {
    if (tab !== 'book') return;
    void load();
    const id = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(id);
  }, [load, tab]);

  return (
    <>
      <header className="top">
        <div className="top-brand">
          Fpesa <span>Operations</span>
        </div>
        <div className="top-right">
          {tab === 'book' && at && (
            <span className="top-at">updated {at.toLocaleTimeString('en-KE')}</span>
          )}
          {tab === 'book' && (
            <button className="btn ghost" onClick={() => void load()}>Refresh</button>
          )}
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
        <nav className="tabs">
          <button aria-pressed={tab === 'book'} onClick={() => setTab('book')}>The book</button>
          <button aria-pressed={tab === 'accounts'} onClick={() => setTab('accounts')}>Accounts</button>
        </nav>

        {tab === 'accounts' && <Accounts />}

        {tab === 'book' && error && <div className="err">{error}</div>}
        {tab === 'book' && !d && !error && <div className="muted">Loading…</div>}

        {tab === 'book' && d && (
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


/* -------------------------------------------------------------- accounts */
type Account = {
  id: string; username: string; phone: string;
  demoBalance: number; realBalance: number;
  isAdmin: boolean; isActive: boolean; createdAt: string; lastSeenAt: string;
};

type AccountDetail = {
  user: Account;
  statement: Record<string, string | number> | null;
  transactions: Array<{
    id: string; kind: string; amount: string | number; status: string;
    reference: string; mpesa_receipt: string | null; result_code: string | null;
    result_desc: string | null; created_at: string;
  }>;
  adjustments: Array<{
    id: string; account_mode: string; amount: string | number;
    balance_before: string | number; balance_after: string | number;
    reason: string; created_at: string;
  }>;
};

/**
 * Account lookup and manual balance correction.
 *
 * The reason this screen exists is failed deposits: the STK push succeeds on
 * the customer's phone, the callback never lands, and the money is real but the
 * balance is not. Someone has to be able to put it right.
 *
 * The reason it looks like this — reason mandatory, a confirmation step before
 * it fires, every past adjustment listed underneath — is that the same button
 * can mint balance out of nothing. Making the trail unavoidable is what
 * separates an operations tool from an unaudited key to the float.
 */
function Accounts(): JSX.Element {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Account[] | null>(null);
  const [detail, setDetail] = useState<AccountDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [mode, setMode] = useState<'real' | 'demo'>('real');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);

  const search = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (q.trim().length < 2) {
      setError('Enter at least two characters.');
      return;
    }
    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await call<{ users: Account[] }>('/admin/users?q=' + encodeURIComponent(q.trim()));
      setResults(res.users);
      setDetail(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed.');
    } finally {
      setBusy(false);
    }
  };

  const open = async (id: string): Promise<void> => {
    setBusy(true); setError(null);
    try {
      setDetail(await call<AccountDetail>('/admin/users/' + id));
      setAmount(''); setReason(''); setConfirming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the account.');
    } finally {
      setBusy(false);
    }
  };

  const value = Number(amount);
  const target = detail?.user;
  const current = target ? (mode === 'real' ? target.realBalance : target.demoBalance) : 0;
  const after = current + (Number.isFinite(value) ? value : 0);
  const valid = Boolean(target) && Number.isFinite(value) && value !== 0 &&
    reason.trim().length >= 3 && after >= 0;

  const apply = async (): Promise<void> => {
    if (!target || !valid) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await call<{ before: number; after: number; mode: string }>(
        '/admin/users/' + target.id + '/balance',
        { amount: value, mode, reason: reason.trim() }
      );
      setNotice(
        target.username + ': ' + res.mode + ' balance ' + ksh(res.before) +
        ' to ' + ksh(res.after)
      );
      setAmount(''); setReason(''); setConfirming(false);
      await open(target.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not adjust the balance.');
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section>
        <h2>Find an account</h2>
        <form className="search" onSubmit={(e) => void search(e)}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Username or phone number"
            aria-label="Search accounts"
          />
          <button className="btn" type="submit" disabled={busy}>Search</button>
        </form>

        {error && <div className="err">{error}</div>}
        {notice && <div className="ok">{notice}</div>}

        {results && results.length === 0 && <p className="muted">No accounts matched.</p>}
        {results && results.length > 0 && (
          <div className="tw">
            <table>
              <thead>
                <tr><th>Username</th><th>Phone</th><th>Live</th><th>Demo</th><th /></tr>
              </thead>
              <tbody>
                {results.map((u) => (
                  <tr key={u.id}>
                    <td>{u.username}{u.isAdmin && <span className="pill">admin</span>}</td>
                    <td>{u.phone}</td>
                    <td>{ksh(u.realBalance)}</td>
                    <td>{ksh(u.demoBalance)}</td>
                    <td>
                      <button className="btn ghost sm" onClick={() => void open(u.id)}>Open</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {target && detail && (
        <>
          <section>
            <h2>{target.username}</h2>
            <div className="grid">
              <Stat k="Live balance" v={ksh(target.realBalance)} />
              <Stat k="Demo balance" v={ksh(target.demoBalance)} />
              <Stat k="Deposited" v={ksh(Number(detail.statement?.deposits ?? 0))} />
              <Stat k="Withdrawn" v={ksh(Number(detail.statement?.withdrawals ?? 0))} />
            </div>
            <p className="note nomargin">
              {target.phone} · joined {new Date(target.createdAt).toLocaleDateString('en-KE')} ·
              last seen {ago(target.lastSeenAt)} ago
            </p>
          </section>

          <section>
            <h2>Adjust balance</h2>
            <div className="adjust">
              <div className="row">
                <label>
                  Account
                  <select
                    value={mode}
                    onChange={(e) => { setMode(e.target.value as 'real' | 'demo'); setConfirming(false); }}
                  >
                    <option value="real">Live</option>
                    <option value="demo">Demo</option>
                  </select>
                </label>
                <label>
                  Amount (negative to debit)
                  <input
                    type="number"
                    value={amount}
                    onChange={(e) => { setAmount(e.target.value); setConfirming(false); }}
                    placeholder="e.g. 2000 or -500"
                  />
                </label>
              </div>
              <label>
                Reason (stored against the adjustment)
                <input
                  value={reason}
                  onChange={(e) => { setReason(e.target.value); setConfirming(false); }}
                  placeholder="e.g. STK push debited but the callback never arrived"
                />
              </label>

              {Number.isFinite(value) && value !== 0 && (
                <p className={'preview' + (after < 0 ? ' bad' : '')}>
                  {mode === 'real' ? 'Live' : 'Demo'} balance {ksh(current)} to <b>{ksh(after)}</b>
                  {after < 0 && ' — a debit cannot take the balance below zero.'}
                </p>
              )}

              {!confirming ? (
                <button className="btn" disabled={!valid || busy} onClick={() => setConfirming(true)}>
                  Review adjustment
                </button>
              ) : (
                <div className="confirm">
                  <p>
                    {value > 0 ? 'Credit' : 'Debit'} <b>{ksh(Math.abs(value))}</b>{' '}
                    {value > 0 ? 'to' : 'from'} <b>{target.username}</b> on the{' '}
                    {mode === 'real' ? 'live' : 'demo'} balance. This is recorded against your
                    account{mode === 'real' ? ' and appears in their own statement.' : '.'}
                  </p>
                  <div className="row">
                    <button className="btn" disabled={busy} onClick={() => void apply()}>
                      {busy ? 'Applying…' : 'Confirm'}
                    </button>
                    <button className="btn ghost" disabled={busy} onClick={() => setConfirming(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>

          <section>
            <h2>Money movements</h2>
            <div className="tw">
              <table>
                <thead>
                  <tr><th>When</th><th>Kind</th><th>Amount</th><th>Status</th><th>Reference</th></tr>
                </thead>
                <tbody>
                  {detail.transactions.length === 0 && (
                    <tr><td colSpan={5} className="muted">Nothing yet.</td></tr>
                  )}
                  {detail.transactions.map((t) => (
                    <tr key={t.id}>
                      <td>{ago(t.created_at)} ago</td>
                      <td>{t.kind === 'ADJUSTMENT' ? 'Manual ' + (t.result_code ?? '') : t.kind}</td>
                      <td>{ksh(Number(t.amount))}</td>
                      <td>{t.status}</td>
                      <td className="ref">{t.mpesa_receipt ?? t.reference}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {detail.adjustments.length > 0 && (
            <section>
              <h2>Manual adjustments on this account</h2>
              <div className="tw">
                <table>
                  <thead>
                    <tr><th>When</th><th>Account</th><th>Amount</th><th>Balance</th><th>Reason</th></tr>
                  </thead>
                  <tbody>
                    {detail.adjustments.map((a) => (
                      <tr key={a.id}>
                        <td>{ago(a.created_at)} ago</td>
                        <td>{a.account_mode}</td>
                        <td className={Number(a.amount) >= 0 ? 'up' : 'down'}>
                          {Number(a.amount) >= 0 ? '+' : '−'}{ksh(Math.abs(Number(a.amount)))}
                        </td>
                        <td>{ksh(Number(a.balance_before))} to {ksh(Number(a.balance_after))}</td>
                        <td>{a.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
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
