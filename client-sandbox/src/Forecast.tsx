import { useCallback, useEffect, useMemo, useState } from 'react';

type Odds = {
  entry: number;
  stopOut: number;
  takeProfit: number;
  stopOutProbability: number;
  takeProfitProbability: number;
  finishesUpProbability: number;
  expectedPerUnit: number;
};

type Horizon = {
  durationSec: number;
  centre: number;
  sdPct: number;
  band68: { low: number; high: number };
  band95: { low: number; high: number };
  multiplier: number;
  BUY: Odds;
  SELL: Odds;
};

type Fc = {
  symbol: string;
  spot: number;
  sigma: number;
  note: string;
  horizons: Horizon[];
};

type Audit = {
  symbol: string;
  epochs: number;
  ticks: number;
  from: number;
  to: number;
  returns: { meanPct: number; sdPct: number };
  autocorrelation: Array<{ lag: number; rho: number; se: number; significant: boolean }>;
  varianceRatio: Array<{ k: number; vr: number; z: number; consistentWithRandomWalk: boolean }>;
  signPersistence: {
    upAfterUp: number;
    upAfterDown: number;
    samples: number;
    edgePct: number;
    significant: boolean;
  };
  strategies: Array<{
    name: string;
    durationSec: number;
    trades: number;
    winRate: number;
    netPerUnitStaked: number;
  }>;
  tests: number;
  flags: number;
  expectedByChance: number;
  verdict: string;
};

const nf = new Intl.NumberFormat('en-KE', { maximumFractionDigits: 4 });

async function get<T>(path: string): Promise<T> {
  const res = await fetch('/api/sandbox' + path, { credentials: 'same-origin' });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) throw new Error((data as { message?: string } | null)?.message ?? 'Request failed.');
  return data as T;
}

/**
 * The forecast cone.
 *
 * The centre line is flat and that is the result, not a missing feature: for a
 * driftless walk the conditional expectation at every horizon is spot. What the
 * picture carries is the width — how far the distribution opens up with time,
 * and where the stop-out sits inside it.
 */
function Cone({ fc }: { fc: Fc }): JSX.Element {
  const W = 900;
  const H = 260;
  const PAD = 10;

  const bounds = useMemo(() => {
    const last = fc.horizons[fc.horizons.length - 1]!;
    const lo = Math.min(last.band95.low, last.BUY.stopOut, last.SELL.takeProfit);
    const hi = Math.max(last.band95.high, last.SELL.stopOut, last.BUY.takeProfit);
    const span = hi - lo || Math.max(hi * 0.0001, 0.01);
    return { lo: lo - span * 0.08, hi: hi + span * 0.08 };
  }, [fc]);

  const maxT = fc.horizons[fc.horizons.length - 1]!.durationSec;
  const x = (t: number): number => PAD + (t / maxT) * (W - PAD * 2);
  const y = (v: number): number =>
    PAD + (1 - (v - bounds.lo) / (bounds.hi - bounds.lo)) * (H - PAD * 2);

  const band = (pick: (h: Horizon) => { low: number; high: number }): string => {
    const ups = fc.horizons.map((h) => x(h.durationSec) + ',' + y(pick(h).high));
    const downs = fc.horizons
      .slice()
      .reverse()
      .map((h) => x(h.durationSec) + ',' + y(pick(h).low));
    return [x(0) + ',' + y(fc.spot), ...ups, ...downs, x(0) + ',' + y(fc.spot)].join(' ');
  };

  return (
    <div className="chart-wrap">
      <svg viewBox={'0 0 ' + W + ' ' + H} className="chart" preserveAspectRatio="none">
        <polygon points={band((h) => h.band95)} className="cone95" />
        <polygon points={band((h) => h.band68)} className="cone68" />
        {/* Flat, because that is the forecast. */}
        <line x1={x(0)} x2={x(maxT)} y1={y(fc.spot)} y2={y(fc.spot)} className="cone-centre" />
        <polyline
          points={fc.horizons.map((h) => x(h.durationSec) + ',' + y(h.BUY.stopOut)).join(' ')}
          className="lv lv-so"
        />
        <polyline
          points={fc.horizons.map((h) => x(h.durationSec) + ',' + y(h.SELL.stopOut)).join(' ')}
          className="lv lv-so"
        />
      </svg>
      <div className="chart-legend">
        <span><i className="sw sw-centre" /> best estimate (= spot)</span>
        <span><i className="sw sw-68" /> 68% of outcomes</span>
        <span><i className="sw sw-95" /> 95% of outcomes</span>
        <span><i className="sw sw-so" /> stop-out, both sides</span>
      </div>
    </div>
  );
}

export function Forecast({ symbol }: { symbol: string | null }): JSX.Element {
  const [fc, setFc] = useState<Fc | null>(null);
  const [audit, setAudit] = useState<Audit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!symbol) return;
    setBusy(true);
    void get<Fc>('/forecast?symbol=' + encodeURIComponent(symbol))
      .then((r) => {
        setFc(r);
        setError(null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  }, [symbol]);

  const runAudit = useCallback(() => {
    if (!symbol) return;
    setBusy(true);
    setAudit(null);
    void get<Audit>('/forecast/audit?symbol=' + encodeURIComponent(symbol))
      .then((r) => {
        setAudit(r);
        setError(null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  }, [symbol]);

  useEffect(() => {
    setAudit(null);
    load();
  }, [symbol, load]);

  return (
    <>
      <section className="grid-sec">
        <h2>Forecast — {fc?.symbol ?? symbol}</h2>
        <p className="note" style={{ marginTop: 0 }}>
          {fc?.note ??
            'The best estimate of a driftless walk at any horizon is its current value.'}
        </p>
        <button className="btn primary" onClick={load} disabled={busy}>
          {busy ? 'Working…' : 'Refresh from live'}
        </button>
        {error && <div className="err" style={{ marginTop: 10 }}>{error}</div>}
      </section>

      {fc && (
        <>
          <Cone fc={fc} />

          <section className="grid-sec">
            <h2>
              Where price will be
              <span className="tally">spot {nf.format(fc.spot)} · σ {fc.sigma}</span>
            </h2>
            <div className="scroll">
              <table className="plays">
                <thead>
                  <tr>
                    <th>Horizon</th>
                    <th>Best estimate</th>
                    <th>68% range</th>
                    <th>95% range</th>
                    <th>Stop-out odds</th>
                    <th>Profit-cap odds</th>
                    <th>Expected result</th>
                  </tr>
                </thead>
                <tbody>
                  {fc.horizons.map((h) => (
                    <tr key={h.durationSec}>
                      <td>{h.durationSec}s</td>
                      <td>{nf.format(h.centre)}</td>
                      <td>{nf.format(h.band68.low)} – {nf.format(h.band68.high)}</td>
                      <td>{nf.format(h.band95.low)} – {nf.format(h.band95.high)}</td>
                      <td className="down">{h.BUY.stopOutProbability}%</td>
                      <td className="muted">
                        {h.BUY.takeProfitProbability < 0.001
                          ? '~0'
                          : h.BUY.takeProfitProbability + '%'}
                      </td>
                      <td className="down">{(h.BUY.expectedPerUnit * 100).toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="note">
              The expected result is the disclosed spread, identical at every
              horizon and on both sides — which is what &ldquo;no edge in
              direction&rdquo; means arithmetically. Note the profit-cap column:
              at {fc.horizons[0]!.multiplier.toLocaleString('en-KE')}× the cap
              sits far enough away that reaching it is a seven-sigma move, so the{' '}
              <b>3× cap is effectively unreachable in normal conditions</b> — yet
              the solvency guard has to reserve the full 3× for every open
              position, which is what limits how many the book can carry.
            </p>
          </section>

          <section className="grid-sec">
            <h2>
              Is there anything to forecast?
              {audit && (
                <span className={'chip ' + (audit.flags > audit.expectedByChance + 2 ? 'off' : 'ok')}>
                  {audit.flags} flags / {audit.tests} tests · {audit.expectedByChance} expected
                </span>
              )}
            </h2>
            <p className="note" style={{ marginTop: 0 }}>
              This does not assert the answer. It pulls the live market&rsquo;s
              real published history — every tick rebuilt from a seed production
              released after its epoch closed — and tests it for structure.
            </p>
            <button className="btn primary" onClick={runAudit} disabled={busy}>
              {busy ? 'Measuring…' : 'Audit the real history'}
            </button>

            {audit && (
              <>
                <p className="note">
                  {audit.epochs} epochs · {audit.ticks.toLocaleString('en-KE')} actual
                  ticks · {new Date(audit.from).toLocaleTimeString('en-KE')} to{' '}
                  {new Date(audit.to).toLocaleTimeString('en-KE')}
                </p>
                <div className="scroll">
                  <table className="plays">
                    <thead>
                      <tr>
                        <th>Test</th>
                        <th>Result</th>
                        <th>Bound</th>
                        <th>&nbsp;</th>
                      </tr>
                    </thead>
                    <tbody>
                      {audit.autocorrelation.map((a) => (
                        <tr key={'ac' + a.lag}>
                          <td>Autocorrelation, lag {a.lag}</td>
                          <td>{a.rho}</td>
                          <td className="muted">±{(1.96 * a.se).toFixed(5)}</td>
                          <td className={a.significant ? 'down' : 'up'}>
                            {a.significant ? 'flagged' : 'no signal'}
                          </td>
                        </tr>
                      ))}
                      {audit.varianceRatio.map((v) => (
                        <tr key={'vr' + v.k}>
                          <td>Variance ratio, k={v.k}</td>
                          <td>{v.vr}</td>
                          <td className="muted">z {v.z}</td>
                          <td className={v.consistentWithRandomWalk ? 'up' : 'down'}>
                            {v.consistentWithRandomWalk ? 'random walk' : 'flagged'}
                          </td>
                        </tr>
                      ))}
                      <tr>
                        <td>Up tick predicts up tick</td>
                        <td>
                          {audit.signPersistence.upAfterUp}% vs{' '}
                          {audit.signPersistence.upAfterDown}%
                        </td>
                        <td className="muted">{audit.signPersistence.edgePct} pts</td>
                        <td className={audit.signPersistence.significant ? 'down' : 'up'}>
                          {audit.signPersistence.significant ? 'flagged' : 'no signal'}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <h2 style={{ marginTop: 18 }}>Strategies, back-tested after the spread</h2>
                <div className="scroll">
                  <table className="plays">
                    <thead>
                      <tr>
                        <th>Strategy</th>
                        <th>Duration</th>
                        <th>Trades</th>
                        <th>Win rate</th>
                        <th>Net per 1 staked</th>
                      </tr>
                    </thead>
                    <tbody>
                      {audit.strategies.map((s) => (
                        <tr key={s.name + s.durationSec}>
                          <td>{s.name}</td>
                          <td>{s.durationSec}s</td>
                          <td>{s.trades.toLocaleString('en-KE')}</td>
                          <td>{s.winRate}%</td>
                          <td className={s.netPerUnitStaked >= 0 ? 'up' : 'down'}>
                            {s.netPerUnitStaked}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="note">{audit.verdict}</p>
              </>
            )}
          </section>
        </>
      )}
    </>
  );
}
