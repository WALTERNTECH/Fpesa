import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useApp } from '../store/app';
import { usd } from '../lib/format';
import type { HistoryResponse, Trade } from '../lib/types';

type Period = 'day' | 'month' | 'all';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local YYYY-MM-DD. Deliberately not toISOString, which shifts to UTC. */
function dayKey(d: Date): string {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function monthKey(d: Date): string {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1);
}

/**
 * The window the server is asked for.
 *
 * Both ends are local wall-clock times converted to instants, so "3 September"
 * means the trader's 3 September rather than a UTC day that starts at 3am for
 * them.
 */
function windowFor(period: Period, day: string, month: string): { from?: string; to?: string } {
  if (period === 'day') {
    const [y, m, d] = day.split('-').map(Number);
    if (!y || !m || !d) return {};
    return {
      from: new Date(y, m - 1, d, 0, 0, 0, 0).toISOString(),
      to: new Date(y, m - 1, d, 23, 59, 59, 999).toISOString(),
    };
  }
  if (period === 'month') {
    const [y, m] = month.split('-').map(Number);
    if (!y || !m) return {};
    return {
      from: new Date(y, m - 1, 1, 0, 0, 0, 0).toISOString(),
      to: new Date(y, m, 0, 23, 59, 59, 999).toISOString(),
    };
  }
  return {};
}

function dayLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y!, m! - 1, d!);
  const today = dayKey(new Date());
  const yesterday = dayKey(new Date(Date.now() - 86_400_000));
  if (key === today) return 'Today';
  if (key === yesterday) return 'Yesterday';
  return date.toLocaleDateString('en-KE', { weekday: 'short', day: 'numeric', month: 'short' });
}

function clockOf(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

/**
 * Every figure stored here is shillings; the statement reads in dollars, so the
 * converter has to come from the component rather than being baked in.
 */
function signedUsd(kes: number, toUsd: (n: number) => number): string {
  return (kes >= 0 ? '+' : '−') + usd(toUsd(Math.abs(kes)));
}

/**
 * The trader's own record.
 *
 * Everything here is theirs and only theirs — this is a statement, not a
 * leaderboard. It answers the two questions a record has to answer: what
 * happened on each trade, and where the account stands against what has been
 * paid into it.
 */
export function TradeHistory(): JSX.Element {
  const { user, accountMode, openModal, instruments, toUsd } = useApp();

  const signed = (kes: number): string => signedUsd(kes, toUsd);
  const money = (kes: number): string => usd(toUsd(kes));

  const now = new Date();
  const [period, setPeriod] = useState<Period>('month');
  const [day, setDay] = useState(dayKey(now));
  const [month, setMonth] = useState(monthKey(now));
  const [symbol, setSymbol] = useState('');
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) {
      setData(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { from, to } = windowFor(period, day, month);
      const params = new URLSearchParams({ mode: accountMode });
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      if (symbol) params.set('symbol', symbol);
      setData(await api.get<HistoryResponse>('/trades/history?' + params.toString()));
    } catch {
      setError('Could not load your history.');
    } finally {
      setLoading(false);
    }
  }, [user, accountMode, period, day, month, symbol]);

  useEffect(() => {
    void load();
  }, [load]);

  // Group by the day a position *closed*: that is the day its money moved.
  const groups = useMemo(() => {
    const map = new Map<string, Trade[]>();
    for (const t of data?.trades ?? []) {
      const key = dayKey(new Date(t.settledAt ?? t.openedAt));
      const bucket = map.get(key);
      if (bucket) bucket.push(t);
      else map.set(key, [t]);
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [data]);

  if (!user) {
    return (
      <section className="card history" id="history">
        <div className="card-head">
          <div className="section-title">
            <span className="dot" />
            Trading history
          </div>
        </div>
        <div className="card-body empty-state">
          <p>Your trades, results and running totals are recorded here.</p>
          <button className="btn btn-primary" onClick={() => openModal('login')}>
            Log in to view
          </button>
        </div>
      </section>
    );
  }

  const w = data?.window;
  const life = data?.lifetime;

  return (
    <section className="card history" id="history">
      <div className="card-head">
        <div className="section-title">
          <span className="dot" />
          Trading history
        </div>
        <span className="eyebrow">{accountMode === 'demo' ? 'Demo' : 'Live'}</span>
      </div>

      <div className="card-body">
        {/* ------------------------------------------------------- summary */}
        <div className="hist-tiles">
          <div className="ht">
            <span className="k">Net profit / loss</span>
            <span className={'v tnum ' + ((w?.netProfit ?? 0) >= 0 ? 'up' : 'down')}>
              {w ? signed(w.netProfit) : '—'}
            </span>
          </div>
          <div className="ht">
            <span className="k">Trades</span>
            <span className="v tnum">{w?.trades ?? 0}</span>
          </div>
          <div className="ht">
            <span className="k">Won / lost</span>
            <span className="v tnum">
              {w ? w.wins + ' / ' + w.losses : '—'}
            </span>
          </div>
          <div className="ht">
            <span className="k">Win rate</span>
            <span className="v tnum">{w ? w.winRate.toFixed(1) + '%' : '—'}</span>
          </div>
          <div className="ht">
            <span className="k">Staked</span>
            <span className="v tnum">{w ? money(w.volume) : '—'}</span>
          </div>
          <div className="ht">
            <span className="k">Best / worst</span>
            <span className="v tnum small">
              {w ? signed(w.best) + ' / ' + signed(w.worst) : '—'}
            </span>
          </div>
        </div>

        {/* -------------------------------------------------------- filters */}
        <div className="hist-filters">
          <div className="seg compact" role="group" aria-label="Period">
            <button aria-pressed={period === 'day'} onClick={() => setPeriod('day')}>
              Day
            </button>
            <button aria-pressed={period === 'month'} onClick={() => setPeriod('month')}>
              Month
            </button>
            <button aria-pressed={period === 'all'} onClick={() => setPeriod('all')}>
              All
            </button>
          </div>

          {period === 'day' && (
            <input
              type="date"
              className="hist-input"
              value={day}
              max={dayKey(new Date())}
              onChange={(e) => setDay(e.target.value)}
              aria-label="Day"
            />
          )}
          {period === 'month' && (
            <input
              type="month"
              className="hist-input"
              value={month}
              max={monthKey(new Date())}
              onChange={(e) => setMonth(e.target.value)}
              aria-label="Month"
            />
          )}

          <select
            className="hist-input"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            aria-label="Market"
          >
            <option value="">All markets</option>
            {instruments.map((i) => (
              <option key={i.symbol} value={i.symbol}>
                {i.symbol}
              </option>
            ))}
          </select>
        </div>

        {/* --------------------------------------------------------- ledger */}
        {loading && <div className="hist-note">Loading…</div>}
        {error && <div className="hist-note error">{error}</div>}
        {!loading && !error && groups.length === 0 && (
          <div className="hist-note">No trades closed in this period.</div>
        )}

        <div className="hist-days">
          {groups.map(([key, rows]) => {
            const dayNet = rows.reduce((sum, t) => sum + (t.profit ?? 0), 0);
            return (
              <div className="hist-day" key={key}>
                <div className="hd-head">
                  <span className="hd-date">{dayLabel(key)}</span>
                  <span className="hd-meta">
                    {rows.length} trade{rows.length === 1 ? '' : 's'}
                  </span>
                  <span className={'hd-net tnum ' + (dayNet >= 0 ? 'up' : 'down')}>
                    {signed(dayNet)}
                  </span>
                </div>

                <div className="hd-rows">
                  {rows.map((t) => {
                    const profit = t.profit ?? 0;
                    const won = t.status === 'WON';
                    const lost = t.status === 'LOST';
                    return (
                      <div className="hr" key={t.id}>
                        <span className="hr-time tnum">{clockOf(t.settledAt)}</span>
                        <span className={'hr-side ' + (t.direction === 'BUY' ? 'buy' : 'sell')}>
                          {t.direction}
                        </span>
                        <span className="hr-mkt">
                          <span className="s">{t.symbol}</span>
                          <span className="d">{t.durationSec}s</span>
                        </span>
                        <span className="hr-px tnum">
                          {t.entryPrice}
                          <span className="arrow">→</span>
                          {t.exitPrice ?? '—'}
                        </span>
                        <span className="hr-stake tnum">{money(t.stake)}</span>
                        <span
                          className={
                            'hr-pnl tnum ' + (won ? 'up' : lost ? 'down' : 'flat')
                          }
                        >
                          {signed(profit)}
                          {t.closeReason === 'STOP_OUT' && <em title="Stopped out">SO</em>}
                          {t.closeReason === 'TAKE_PROFIT' && <em title="Max profit">TP</em>}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* ------------------------------------------------------- lifetime */}
        {accountMode === 'real' && life && (
          <div className="hist-life">
            <div className="hl-title">Lifetime, live account</div>
            <div className="hl-grid">
              <div>
                <span className="k">Deposited</span>
                <span className="v tnum">{money(life.deposits)}</span>
              </div>
              <div>
                <span className="k">Withdrawn</span>
                <span className="v tnum">{money(life.withdrawals)}</span>
              </div>
              <div>
                <span className="k">Balance now</span>
                <span className="v tnum">{money(life.balance)}</span>
              </div>
              <div>
                <span className="k">Trades</span>
                <span className="v tnum">{life.trades}</span>
              </div>
            </div>
            <div className="hl-bottom">
              <span className="k">Against everything paid in</span>
              <span className={'v tnum ' + (life.netVsDeposits >= 0 ? 'up' : 'down')}>
                {signed(life.netVsDeposits)}
              </span>
            </div>
            {life.adjustments !== 0 && (
              <div className="hl-note">
                Includes {signed(life.adjustments)} in manual adjustments made by support.
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
