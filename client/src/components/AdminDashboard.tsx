import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { ksh, timeAgo } from '../lib/format';
import { IconClose, IconRefresh } from './Icons';

type Overview = {
  users: { total: number; funded: number; activeToday: number; liability: number; turnoverOutstanding: number };
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
  desk: { open: boolean; ratio: number; cap: number; reopenAt: number; armed: boolean; minBase: number };
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
};

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }): JSX.Element {
  return (
    <div className="ad-stat">
      <div className="ad-stat-k">{label}</div>
      <div className={'ad-stat-v tnum' + (tone ? ' ' + tone : '')}>{value}</div>
    </div>
  );
}

export function AdminDashboard({ onClose }: { onClose: () => void }): JSX.Element {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    try {
      setData(await api.get<Overview>('/admin/overview'));
      setError(null);
    } catch {
      setError('Could not load the overview.');
    }
  };

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div className="ad-overlay" role="dialog" aria-modal="true" aria-label="Operator dashboard">
      <div className="ad-panel">
        <div className="ad-head">
          <div>
            <h2>Operator dashboard</h2>
            <p>Today, Nairobi time · refreshes every 15s</p>
          </div>
          <div className="ad-head-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => void load()}>
              <IconRefresh size={15} />
            </button>
            <button className="modal-close" onClick={onClose} aria-label="Close">
              <IconClose size={18} />
            </button>
          </div>
        </div>

        <div className="ad-body">
          {error && <div className="panel-error">{error}</div>}
          {!data && !error && <div className="empty">Loading…</div>}

          {data && (
            <>
              <section className="ad-section">
                <h3>The book today</h3>
                <div className="ad-grid">
                  <Stat label="Deposits in" value={ksh(data.cash.deposits, true)} />
                  <Stat label="Withdrawals out" value={ksh(data.cash.withdrawals, true)} />
                  <Stat
                    label="Net cash"
                    value={ksh(data.cash.netCash, true)}
                    tone={data.cash.netCash >= 0 ? 'up' : 'down'}
                  />
                  <Stat
                    label="Disbursed"
                    value={data.real.disbursedPct.toFixed(1) + '%'}
                    tone={data.real.disbursedPct <= data.settings.dailyPayoutCap * 100 ? 'up' : 'down'}
                  />
                  <Stat
                    label="House margin"
                    value={ksh(data.real.houseMargin, true)}
                    tone={data.real.houseMargin >= 0 ? 'up' : 'down'}
                  />
                  <Stat label="Margin on volume" value={data.real.marginPct.toFixed(2) + '%'} />
                  <Stat label="Pending transfers" value={String(data.cash.pending)} />
                  <Stat label="Owed to traders" value={ksh(data.users.liability, true)} />
                </div>
                <p className="ad-note">
                  Target is {(data.settings.dailyPayoutCap * 100).toFixed(0)}% disbursed, from a{' '}
                  {(data.settings.houseEdge * 100).toFixed(0)}% edge over {data.settings.turnoverMultiple}×
                  turnover. Margin on volume converging near the edge means the model is behaving.
                </p>
              </section>

              <section className="ad-section">
                <h3>Desk</h3>
                <div className="ad-grid">
                  <Stat
                    label="Live trading"
                    value={data.desk.open ? 'Open' : 'Paused'}
                    tone={data.desk.open ? 'up' : 'down'}
                  />
                  <Stat label="Payout ratio" value={(data.desk.ratio * 100).toFixed(1) + '%'} />
                  <Stat label="Closes at" value={(data.desk.cap * 100).toFixed(0) + '%'} />
                  <Stat label="Reopens at" value={(data.desk.reopenAt * 100).toFixed(0) + '%'} />
                </div>
                {!data.desk.armed && (
                  <p className="ad-note">
                    Cap inactive — the day needs {ksh(data.desk.minBase, true)} of deposits before
                    the ratio means anything.
                  </p>
                )}
              </section>

              <section className="ad-section">
                <h3>Trading</h3>
                <div className="ad-grid">
                  <Stat label="Live trades" value={String(data.real.trades)} />
                  <Stat label="Live volume" value={ksh(data.real.volume, true)} />
                  <Stat label="Trader win rate" value={data.real.winRate.toFixed(1) + '%'} />
                  <Stat label="Stopped out" value={String(data.real.stoppedOut)} />
                  <Stat label="Demo trades" value={String(data.demo.trades)} />
                  <Stat label="Traders" value={String(data.users.total)} />
                  <Stat label="Funded" value={String(data.users.funded)} />
                  <Stat label="Active today" value={String(data.users.activeToday)} />
                </div>
              </section>

              {data.distribution && (
                <section className="ad-section">
                  <h3>How the instrument behaves</h3>
                  <p className="ad-note" style={{ marginTop: 0, marginBottom: 10 }}>
                    {data.instrument.symbol} · {data.instrument.name} · sigma{' '}
                    {data.instrument.params?.sigma} · drift {data.instrument.params?.drift} · epoch{' '}
                    {data.instrument.epoch}
                  </p>
                  <div className="ad-table-wrap">
                    <table className="ad-table">
                      <thead>
                        <tr>
                          <th>Duration</th>
                          <th>Multiplier</th>
                          <th>Typical move</th>
                          <th>= of stake</th>
                          <th>Wipe-out move</th>
                          <th>Wipe-out odds</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.distribution.map((d) => (
                          <tr key={d.duration}>
                            <td>{d.duration}s</td>
                            <td className="tnum">×{d.multiplier.toLocaleString('en-KE')}</td>
                            <td className="tnum">
                              {d.oneSigmaPct.toFixed(3)}% ({d.oneSigmaPrice})
                            </td>
                            <td className="tnum">{d.oneSigmaStakePct.toFixed(0)}%</td>
                            <td className="tnum">{d.stopOutMovePct.toFixed(3)}%</td>
                            <td className="tnum">{d.stopOutOdds.toFixed(2)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="ad-note">
                    This is the forecast the operator gets: the distribution, not individual
                    outcomes. Roughly two thirds of positions land inside the typical move. The
                    engine is deterministic and every closed epoch is replayable from its published
                    seed — which is also why no future price appears on this page.
                  </p>
                </section>
              )}

              <section className="ad-section">
                <h3>Recent live trades</h3>
                <div className="ad-table-wrap">
                  <table className="ad-table">
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Side</th>
                        <th>Stake</th>
                        <th>Result</th>
                        <th>Closed by</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recentTrades.length === 0 && (
                        <tr>
                          <td colSpan={5} style={{ color: 'var(--subtle)' }}>
                            No live trades settled yet.
                          </td>
                        </tr>
                      )}
                      {data.recentTrades.map((t, i) => (
                        <tr key={i}>
                          <td>{timeAgo(t.settled_at)}</td>
                          <td>{t.direction}</td>
                          <td className="tnum">{ksh(Number(t.stake), true)}</td>
                          <td className={'tnum ' + (Number(t.profit) >= 0 ? 'up' : 'down')}>
                            {Number(t.profit) >= 0 ? '+' : '−'}
                            {ksh(Math.abs(Number(t.profit)), true)}
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
        </div>
      </div>
    </div>
  );
}
