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

type Statement = {
  deposits: number; withdrawals: number; adjustments: number;
  realNet: number; realVolume: number; realTrades: number;
  realBalance: number; demoBalance: number; netVsDeposits: number;
  derived: { deposits: number; withdrawals: number; trades: number; netVsDeposits: number };
  override: { reason: string; updatedAt: string; fields: string[] | null } | null;
};

type AccountDetail = {
  user: Account;
  statement: Statement | null;
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
  statementEdits: Array<{
    id: string; deposits: string | number | null; withdrawals: string | number | null;
    trades: number | null; net_vs_deposits: string | number | null;
    reason: string; created_at: string;
  }>;
};

const day = (iso: string): string => new Date(iso).toLocaleDateString('en-KE', {
  day: 'numeric', month: 'short', year: 'numeric',
});

/* ------------------------------------------------------- balance adjuster */
function BalanceEditor({ user, statement, onDone }: {
  user: Account;
  statement: Statement | null;
  onDone: (notice: string) => Promise<void>;
}): JSX.Element {
  const [mode, setMode] = useState<'real' | 'demo'>('real');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const value = Number(amount);
  const current = mode === 'real' ? user.realBalance : user.demoBalance;
  const after = current + (Number.isFinite(value) ? value : 0);
  const valid = Number.isFinite(value) && value !== 0 && reason.trim().length >= 3 && after >= 0;

  const touch = (fn: () => void) => { fn(); setConfirming(false); setError(null); };

  const apply = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const res = await call<{ before: number; after: number; mode: string }>(
        '/admin/users/' + user.id + '/balance',
        { amount: value, mode, reason: reason.trim() }
      );
      setAmount(''); setReason(''); setConfirming(false);
      await onDone(user.username + ': ' + res.mode + ' balance ' + ksh(res.before) + ' to ' + ksh(res.after));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not adjust the balance.');
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>Credit or debit the balance</h2>
      {error && <div className="err">{error}</div>}
      <div className="adjust">
        <div className="row">
          <label>
            Account
            <select value={mode} onChange={(e) => touch(() => setMode(e.target.value as 'real' | 'demo'))}>
              <option value="real">Live — {ksh(user.realBalance)}</option>
              <option value="demo">Demo — {ksh(user.demoBalance)}</option>
            </select>
          </label>
          <label>
            Amount (negative to debit)
            <input
              type="number"
              value={amount}
              onChange={(e) => touch(() => setAmount(e.target.value))}
              placeholder="e.g. 2000 or -500"
            />
          </label>
        </div>
        <label>
          Reason (stored against the adjustment)
          <input
            value={reason}
            onChange={(e) => touch(() => setReason(e.target.value))}
            placeholder="e.g. M-Pesa deposit received but never recorded"
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
              {value > 0 ? 'to' : 'from'} <b>{user.username}</b> on the{' '}
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
        {statement && mode === 'real' && (
          <p className="note nomargin">
            A credit here also adds a line to the trader&rsquo;s own statement, so they can see it.
          </p>
        )}
      </div>
    </section>
  );
}

/* --------------------------------------------------- lifetime figure editor */
function StatementEditor({ user, statement, onDone }: {
  user: Account;
  statement: Statement;
  onDone: (notice: string) => Promise<void>;
}): JSX.Element {
  const asText = (n: number | null | undefined): string =>
    n === null || n === undefined ? '' : String(n);

  const ov = statement.override;
  const has = (f: string): boolean => Boolean(ov && ov.fields && ov.fields.includes(f));

  // Pre-filled only where a correction is already in force. An empty box means
  // "use what the records say", which is also how a correction is undone.
  const [deposits, setDeposits] = useState(has('deposits') ? asText(statement.deposits) : '');
  const [withdrawals, setWithdrawals] = useState(has('withdrawals') ? asText(statement.withdrawals) : '');
  const [trades, setTrades] = useState(has('trades') ? asText(statement.realTrades) : '');
  const [net, setNet] = useState(has('netVsDeposits') ? asText(statement.netVsDeposits) : '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (clear: boolean): Promise<void> => {
    setBusy(true); setError(null);
    try {
      await call<{ statement: Statement }>('/admin/users/' + user.id + '/statement', {
        deposits: clear ? '' : deposits,
        withdrawals: clear ? '' : withdrawals,
        trades: clear ? '' : trades,
        netVsDeposits: clear ? '' : net,
        reason: reason.trim() || (clear ? 'Reset to the recorded figures' : ''),
      });
      if (clear) { setDeposits(''); setWithdrawals(''); setTrades(''); setNet(''); }
      setReason('');
      await onDone(clear
        ? user.username + ': lifetime figures reset to the records'
        : user.username + ': lifetime figures updated');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the correction.');
    } finally {
      setBusy(false);
    }
  };

  const d = statement.derived;

  return (
    <section>
      <h2>Lifetime figures</h2>
      {error && <div className="err">{error}</div>}

      <div className="adjust">
        <div className="row">
          <label>
            Deposited
            <input type="number" value={deposits} onChange={(e) => setDeposits(e.target.value)}
              placeholder={'records say ' + d.deposits} />
          </label>
          <label>
            Withdrawn
            <input type="number" value={withdrawals} onChange={(e) => setWithdrawals(e.target.value)}
              placeholder={'records say ' + d.withdrawals} />
          </label>
        </div>
        <div className="row">
          <label>
            Trades
            <input type="number" value={trades} onChange={(e) => setTrades(e.target.value)}
              placeholder={'records say ' + d.trades} />
          </label>
          <label>
            Against everything paid in
            <input type="number" value={net} onChange={(e) => setNet(e.target.value)}
              placeholder={'works out to ' + d.netVsDeposits} />
          </label>
        </div>
        <label>
          Reason (stored against the correction)
          <input value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. two M-Pesa deposits in July were never recorded" />
        </label>

        <p className="note nomargin">
          Leave a box empty to use what the records say. <b>Balance now</b> is not here on
          purpose — it is money the trader can stake, so it moves through the credit and
          debit above.
        </p>

        <div className="row">
          <button className="btn" disabled={busy || reason.trim().length < 3} onClick={() => void save(false)}>
            {busy ? 'Saving…' : 'Save figures'}
          </button>
          {ov && (
            <button className="btn ghost" disabled={busy} onClick={() => void save(true)}>
              Reset to records
            </button>
          )}
        </div>

        {ov && (
          <p className="preview">
            Currently corrected: <b>{(ov.fields ?? []).join(', ') || 'none'}</b> — {ov.reason}{' '}
            ({ago(ov.updatedAt)} ago)
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * Accounts: the register, and the tools to correct an account.
 *
 * The list loads on its own rather than waiting for a search. An operator
 * usually arrives here without a name in hand — "who signed up today", or the
 * account that just called about a deposit that never landed — and a search box
 * with nothing behind it answers neither.
 *
 * Both editors below can move real money or restate a financial record, so both
 * demand a reason, show the before and after, and are logged. That trail is the
 * difference between an operations tool and an unaudited key to the float.
 */
function Accounts(): JSX.Element {
  const [q, setQ] = useState('');
  const [users, setUsers] = useState<Account[] | null>(null);
  const [total, setTotal] = useState(0);
  const [detail, setDetail] = useState<AccountDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const list = useCallback(async (term: string) => {
    setBusy(true); setError(null);
    try {
      const res = await call<{ users: Account[]; total: number }>(
        '/admin/users' + (term.trim() ? '?q=' + encodeURIComponent(term.trim()) : '')
      );
      setUsers(res.users);
      setTotal(res.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load accounts.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void list(''); }, [list]);

  // Typing filters the register; an empty box shows all of it again.
  useEffect(() => {
    const id = window.setTimeout(() => void list(q), q ? 300 : 0);
    return () => window.clearTimeout(id);
  }, [q, list]);

  const open = useCallback(async (id: string) => {
    setBusy(true); setError(null);
    try {
      setDetail(await call<AccountDetail>('/admin/users/' + id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the account.');
    } finally {
      setBusy(false);
    }
  }, []);

  const afterChange = useCallback(async (message: string) => {
    setNotice(message);
    if (detail) await open(detail.user.id);
    await list(q);
  }, [detail, open, list, q]);

  const target = detail?.user;

  return (
    <>
      <section>
        <div className="acct-head">
          <h2>Accounts{users ? ' · ' + total : ''}</h2>
          <input
            className="acct-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by username or phone"
            aria-label="Filter accounts"
          />
        </div>

        {error && <div className="err">{error}</div>}
        {notice && <div className="ok">{notice}</div>}

        {!users && !error && <p className="muted">Loading accounts…</p>}
        {users && busy && <p className="muted">Refreshing…</p>}
        {users && !busy && users.length === 0 && <p className="muted">No accounts matched.</p>}

        {users && users.length > 0 && (
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Username</th><th>Phone</th><th>Live balance</th>
                  <th>Demo</th><th>Joined</th><th>Last seen</th><th />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className={target && target.id === u.id ? 'is-open' : undefined}>
                    <td>{u.username}{u.isAdmin && <span className="pill">admin</span>}</td>
                    <td>{u.phone}</td>
                    <td className={u.realBalance > 0 ? 'up' : undefined}>{ksh(u.realBalance)}</td>
                    <td className="muted">{ksh(u.demoBalance)}</td>
                    <td>{day(u.createdAt)}</td>
                    <td className="muted">{ago(u.lastSeenAt)} ago</td>
                    <td>
                      <button className="btn ghost sm" disabled={busy} onClick={() => void open(u.id)}>
                        {target && target.id === u.id ? 'Open' : 'Edit'}
                      </button>
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
            <h2>
              {target.username}
              <button className="btn ghost sm close" onClick={() => setDetail(null)}>Close</button>
            </h2>
            <div className="grid">
              <Stat k="Live balance" v={ksh(target.realBalance)} />
              <Stat k="Demo balance" v={ksh(target.demoBalance)} />
              <Stat k="Deposited" v={ksh(Number(detail.statement?.deposits ?? 0))} />
              <Stat k="Withdrawn" v={ksh(Number(detail.statement?.withdrawals ?? 0))} />
              <Stat k="Trades" v={String(detail.statement?.realTrades ?? 0)} />
              <Stat
                k="Against paid in"
                v={ksh(Number(detail.statement?.netVsDeposits ?? 0))}
                tone={Number(detail.statement?.netVsDeposits ?? 0) >= 0 ? 'up' : 'down'}
              />
            </div>
            <p className="note nomargin">
              {target.phone} · joined {day(target.createdAt)} · last seen {ago(target.lastSeenAt)} ago
            </p>
          </section>

          <BalanceEditor user={target} statement={detail.statement} onDone={afterChange} />

          {detail.statement && (
            <StatementEditor user={target} statement={detail.statement} onDone={afterChange} />
          )}

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
              <h2>Balance adjustments</h2>
              <div className="tw">
                <table>
                  <thead>
                    <tr><th>When</th><th>Account</th><th>Amount</th><th>Balance</th><th>Reason</th></tr>
                  </thead>
                  <tbody>
                    {detail.adjustments.map((x) => (
                      <tr key={x.id}>
                        <td>{ago(x.created_at)} ago</td>
                        <td>{x.account_mode}</td>
                        <td className={Number(x.amount) >= 0 ? 'up' : 'down'}>
                          {Number(x.amount) >= 0 ? '+' : '−'}{ksh(Math.abs(Number(x.amount)))}
                        </td>
                        <td>{ksh(Number(x.balance_before))} to {ksh(Number(x.balance_after))}</td>
                        <td>{x.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {detail.statementEdits.length > 0 && (
            <section>
              <h2>Lifetime figure corrections</h2>
              <div className="tw">
                <table>
                  <thead>
                    <tr>
                      <th>When</th><th>Deposited</th><th>Withdrawn</th>
                      <th>Trades</th><th>Against paid in</th><th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.statementEdits.map((x) => {
                      const cell = (v: string | number | null): string =>
                        v === null ? 'records' : String(v);
                      return (
                        <tr key={x.id}>
                          <td>{ago(x.created_at)} ago</td>
                          <td>{cell(x.deposits)}</td>
                          <td>{cell(x.withdrawals)}</td>
                          <td>{cell(x.trades)}</td>
                          <td>{cell(x.net_vs_deposits)}</td>
                          <td>{x.reason}</td>
                        </tr>
                      );
                    })}
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
