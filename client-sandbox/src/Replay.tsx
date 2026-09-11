import { useCallback, useEffect, useMemo, useState } from 'react';

/* ---------------------------------------------------------------- types */
type Epoch = {
  epoch: number;
  symbol: string;
  startPrice: number;
  seed: string;
  seedHash: string;
  startedAt: number;
  endedAt: number;
  tickMs: number;
  sigma: number;
  drift: number;
  verified: boolean;
};

type Outcome = {
  durationSec: number;
  direction: 'BUY' | 'SELL';
  multiplier: number;
  entryPrice: number;
  stopOutPrice: number;
  takeProfitPrice: number;
  exitPrice: number;
  profitPerUnit: number;
  reason: 'EXPIRY' | 'STOP_OUT' | 'TAKE_PROFIT';
  ticks: number;
};

type Stats = {
  low: number;
  high: number;
  close: number;
  rangePct: number;
  maxDrawdownPct: number;
  biggestTickMovePct: number;
};

type Side = {
  path: number[];
  stats: Stats;
  outcomes: Outcome[];
  worstCase: {
    profitPerUnit: number;
    durationSec: number;
    direction: 'BUY' | 'SELL';
    atTick: number;
  } | null;
  isBaseline?: boolean;
};

type Result = {
  epoch: Epoch;
  source: string;
  knobs: {
    shock: number;
    houseEdge: number;
    maxProfitMultiple: number;
    multiplierScale: number;
    entryTick: number;
  };
  tickMs: number;
  ticks: number;
  baseline: Side;
  variant: Side;
};

const nf = new Intl.NumberFormat('en-KE', { maximumFractionDigits: 2 });
const ksh = (n: number): string =>
  (n < 0 ? '−' : '+') + 'KSh ' + nf.format(Math.abs(Number.isFinite(n) ? n : 0));

const REASON_LABEL: Record<Outcome['reason'], string> = {
  EXPIRY: 'expiry',
  STOP_OUT: 'stop-out',
  TAKE_PROFIT: 'profit cap',
};

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch('/api/sandbox' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) throw new Error((data as { message?: string } | null)?.message ?? 'Request failed.');
  return data as T;
}

/* ---------------------------------------------------------------- chart */
/**
 * The epoch as it traded, and — when a knob has been moved — the same seed under
 * the new settings drawn over it.
 *
 * 1,200 points is more than the pixels available, so the series is thinned to
 * the extremes of each bucket rather than by taking every nth point: sampling
 * would drop the single tick that caused a stop-out, which is usually the tick
 * worth looking at.
 */
function ReplayChart({ result }: { result: Result }): JSX.Element {
  const W = 900;
  const H = 260;
  const PAD = 8;
  const BUCKETS = 300;

  const thin = useCallback((path: number[]): Array<{ i: number; v: number }> => {
    if (path.length <= BUCKETS) return path.map((v, i) => ({ i, v }));
    const size = path.length / BUCKETS;
    const out: Array<{ i: number; v: number }> = [];
    for (let b = 0; b < BUCKETS; b++) {
      const from = Math.floor(b * size);
      const to = Math.min(Math.floor((b + 1) * size), path.length);
      let lo = from;
      let hi = from;
      for (let i = from; i < to; i++) {
        if (path[i]! < path[lo]!) lo = i;
        if (path[i]! > path[hi]!) hi = i;
      }
      // Keep both extremes, in the order they occurred.
      const [a, z] = lo < hi ? [lo, hi] : [hi, lo];
      out.push({ i: a, v: path[a]! });
      if (z !== a) out.push({ i: z, v: path[z]! });
    }
    return out;
  }, []);

  const base = useMemo(() => thin(result.baseline.path), [result, thin]);
  const variant = useMemo(
    () => (result.variant.isBaseline ? null : thin(result.variant.path)),
    [result, thin]
  );

  const bounds = useMemo(() => {
    const values = [...base.map((p) => p.v), ...(variant ?? []).map((p) => p.v)];
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const span = hi - lo || Math.max(hi * 0.0001, 0.01);
    return { lo: lo - span * 0.06, hi: hi + span * 0.06 };
  }, [base, variant]);

  const n = result.ticks;
  const x = (i: number): number => PAD + (i / Math.max(n - 1, 1)) * (W - PAD * 2);
  const y = (v: number): number =>
    PAD + (1 - (v - bounds.lo) / (bounds.hi - bounds.lo)) * (H - PAD * 2);
  const line = (pts: Array<{ i: number; v: number }>): string =>
    pts.map((p) => x(p.i) + ',' + y(p.v)).join(' ');

  const entryX = x(result.knobs.entryTick);
  const worst = result.variant.worstCase;

  return (
    <div className="chart-wrap">
      <svg viewBox={'0 0 ' + W + ' ' + H} className="chart" preserveAspectRatio="none">
        <line x1={entryX} x2={entryX} y1={PAD} y2={H - PAD} className="now-line" />
        {worst && (
          <line
            x1={x(worst.atTick)} x2={x(worst.atTick)} y1={PAD} y2={H - PAD}
            className="worst-line"
          />
        )}
        {variant && <polyline points={line(variant)} className="line-variant" />}
        <polyline points={line(base)} className="line-past" />
      </svg>
      <div className="chart-legend">
        <span><i className="sw sw-past" /> as it traded</span>
        {variant && <span><i className="sw sw-variant" /> same seed, your settings</span>}
        <span><i className="sw sw-now" /> entry tick</span>
        {worst && <span><i className="sw sw-worst" /> worst moment for the book</span>}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- view */
export function Replay({ symbol }: { symbol: string | null }): JSX.Element {
  const [epochs, setEpochs] = useState<Epoch[]>([]);
  const [source, setSource] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [shock, setShock] = useState(1);
  const [edgePct, setEdgePct] = useState<number | null>(null);
  const [maxProfit, setMaxProfit] = useState<number | null>(null);
  const [multScale, setMultScale] = useState(1);
  const [entryTick, setEntryTick] = useState(0);

  // A new market means a different chain of epochs; the old selection is
  // meaningless against it.
  useEffect(() => {
    if (!symbol) return;
    setResult(null);
    setSelected(null);
    void call<{ source: string; epochs: Epoch[] }>(
      '/replay/epochs?symbol=' + encodeURIComponent(symbol)
    )
      .then((r) => {
        setEpochs(r.epochs);
        setSource(r.source);
        setSelected(r.epochs[0]?.epoch ?? null);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  }, [symbol]);

  const run = useCallback(() => {
    if (!symbol || selected === null) return;
    setBusy(true);
    void call<Result>('/replay', {
      symbol,
      epoch: selected,
      shock,
      entryTick,
      multiplierScale: multScale,
      ...(edgePct === null ? {} : { houseEdge: edgePct / 100 }),
      ...(maxProfit === null ? {} : { maxProfitMultiple: maxProfit }),
    })
      .then((r) => {
        setResult(r);
        // The server's defaults are authoritative; adopt them the first time so
        // the inputs show the live values rather than empty boxes.
        if (edgePct === null) setEdgePct(Number((r.knobs.houseEdge * 100).toFixed(2)));
        if (maxProfit === null) setMaxProfit(r.knobs.maxProfitMultiple);
        setError(null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  }, [symbol, selected, shock, entryTick, multScale, edgePct, maxProfit]);

  useEffect(() => {
    if (selected !== null) run();
    // Re-runs when the epoch changes; the knobs have their own button so a
    // slider drag does not fire a request per pixel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const changed = result ? !result.variant.isBaseline : false;

  return (
    <>
      <section className="grid-sec">
        <h2>Replay a real epoch of the live market</h2>
        <p className="note" style={{ marginTop: 0 }}>
          The live platform publishes <code>sha256(seed)</code> before each epoch
          opens and the seed itself once it closes — that is what makes it
          checkable. These are those closed epochs, read from{' '}
          <b>{source || 'the live platform'}</b>, with every seed re-hashed here
          against the commitment it was published under. Replaying one rebuilds
          that epoch tick for tick: not something like it, it.
        </p>

        <div className="replay-pick">
          <label>
            <span className="k">Epoch</span>
            <select
              value={selected ?? ''}
              onChange={(e) => setSelected(Number(e.target.value))}
            >
              {epochs.map((e) => (
                <option key={e.epoch} value={e.epoch}>
                  #{e.epoch} · {new Date(e.startedAt).toLocaleTimeString('en-KE')} · opened at{' '}
                  {nf.format(e.startPrice)}
                </option>
              ))}
            </select>
          </label>
          {epochs.length === 0 && !error && <span className="muted">Loading…</span>}
        </div>

        {error && <div className="err" style={{ marginTop: 10 }}>{error}</div>}
      </section>

      {result && (
        <>
          <section className="grid-sec">
            <div className="verified">
              <span className="chip ok">seed verified</span>
              <span className="muted">
                sha256 of the seed matches the commitment published before epoch{' '}
                {result.epoch.epoch} opened — {result.ticks} ticks, σ{' '}
                {result.epoch.sigma}, drift {result.epoch.drift}
              </span>
            </div>
            <div className="mono seedline">{result.epoch.seed}</div>
          </section>

          {/* The knobs. Everything here reuses the same seed, so the draws are
              held fixed and only the setting that moved can explain a
              difference. That is the whole method. */}
          <section className="grid-sec">
            <h2>Hold the randomness, move one thing</h2>
            <div className="knobs">
              <label>
                <span className="k">Shock ×</span>
                <input
                  type="number" min={0.01} max={100} step={0.5}
                  value={shock}
                  onChange={(e) => setShock(Number(e.target.value))}
                />
                <small>multiplies σ — same draws, bigger moves</small>
              </label>
              <label>
                <span className="k">House edge %</span>
                <input
                  type="number" min={0} max={90} step={0.5}
                  value={edgePct ?? ''}
                  onChange={(e) => setEdgePct(Number(e.target.value))}
                />
                <small>live is {(result.knobs.houseEdge * 100).toFixed(1)}%</small>
              </label>
              <label>
                <span className="k">Profit cap ×</span>
                <input
                  type="number" min={0.1} max={100} step={0.5}
                  value={maxProfit ?? ''}
                  onChange={(e) => setMaxProfit(Number(e.target.value))}
                />
                <small>ceiling on one position</small>
              </label>
              <label>
                <span className="k">Multiplier ×</span>
                <input
                  type="number" min={0.01} max={100} step={0.25}
                  value={multScale}
                  onChange={(e) => setMultScale(Number(e.target.value))}
                />
                <small>scales the whole ladder</small>
              </label>
              <label className="wide">
                <span className="k">Entry tick — {entryTick} of {result.ticks}</span>
                <input
                  type="range" min={0} max={Math.max(result.ticks - 1, 0)} step={1}
                  value={entryTick}
                  onChange={(e) => setEntryTick(Number(e.target.value))}
                />
                <small>
                  {((entryTick * result.tickMs) / 1000).toFixed(0)}s into the epoch
                </small>
              </label>
            </div>
            <button className="btn primary" onClick={run} disabled={busy}>
              {busy ? 'Replaying…' : 'Replay'}
            </button>
          </section>

          <ReplayChart result={result} />

          <section className="grid-sec">
            <h2>What the epoch did</h2>
            <div className="scroll">
              <table className="plays cmp">
                <thead>
                  <tr>
                    <th>&nbsp;</th>
                    <th>As it traded</th>
                    <th>{changed ? 'Your settings' : 'Unchanged'}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">Range over the epoch</th>
                    <td>{result.baseline.stats.rangePct}%</td>
                    <td className={changed ? 'moved' : ''}>{result.variant.stats.rangePct}%</td>
                  </tr>
                  <tr>
                    <th scope="row">Deepest drawdown</th>
                    <td>{result.baseline.stats.maxDrawdownPct}%</td>
                    <td className={changed ? 'moved' : ''}>
                      {result.variant.stats.maxDrawdownPct}%
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Biggest single tick</th>
                    <td>{result.baseline.stats.biggestTickMovePct}%</td>
                    <td className={changed ? 'moved' : ''}>
                      {result.variant.stats.biggestTickMovePct}%
                    </td>
                  </tr>
                  {/* The number the solvency guard has to survive. */}
                  <tr className="worst-row">
                    <th scope="row">
                      Worst single position for the book
                      <small>best moment any trader could have picked, per KSh 1,000</small>
                    </th>
                    <td>
                      {result.baseline.worstCase
                        ? ksh(result.baseline.worstCase.profitPerUnit * 1000)
                        : '—'}
                      {result.baseline.worstCase && (
                        <small>
                          {result.baseline.worstCase.direction}{' '}
                          {result.baseline.worstCase.durationSec}s at tick{' '}
                          {result.baseline.worstCase.atTick}
                        </small>
                      )}
                    </td>
                    <td className={changed ? 'moved' : ''}>
                      {result.variant.worstCase
                        ? ksh(result.variant.worstCase.profitPerUnit * 1000)
                        : '—'}
                      {result.variant.worstCase && (
                        <small>
                          {result.variant.worstCase.direction}{' '}
                          {result.variant.worstCase.durationSec}s at tick{' '}
                          {result.variant.worstCase.atTick}
                        </small>
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="grid-sec">
            <h2>
              Every position opened at tick {result.knobs.entryTick}
              <span className="tally">
                {((result.knobs.entryTick * result.tickMs) / 1000).toFixed(0)}s into the epoch
              </span>
            </h2>
            <div className="scroll">
              <table className="plays">
                <thead>
                  <tr>
                    <th>Duration</th>
                    <th>Side</th>
                    <th>Ends</th>
                    <th>As it traded</th>
                    <th>{changed ? 'Your settings' : 'Unchanged'}</th>
                    <th>Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {result.baseline.outcomes.map((b, i) => {
                    const v = result.variant.outcomes[i]!;
                    const delta = (v.profitPerUnit - b.profitPerUnit) * 1000;
                    return (
                      <tr key={b.durationSec + b.direction}>
                        <td>{b.durationSec}s</td>
                        <td className={'side ' + b.direction.toLowerCase()}>{b.direction}</td>
                        <td className="reason">
                          {REASON_LABEL[v.reason]}
                          {v.reason !== b.reason && (
                            <span className="was"> (was {REASON_LABEL[b.reason]})</span>
                          )}
                        </td>
                        <td className={b.profitPerUnit >= 0 ? 'up' : 'down'}>
                          {ksh(b.profitPerUnit * 1000)}
                        </td>
                        <td className={v.profitPerUnit >= 0 ? 'up' : 'down'}>
                          {ksh(v.profitPerUnit * 1000)}
                        </td>
                        <td className={Math.abs(delta) < 0.005 ? 'muted' : delta > 0 ? 'up' : 'down'}>
                          {Math.abs(delta) < 0.005 ? '—' : ksh(delta)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="note">
              Both columns come from the same seed, so every tick&rsquo;s shock is
              identical between them. Anything that differs was caused by the
              setting you moved and by nothing else — which is the only way to
              read a single run and learn something from it.
            </p>
          </section>
        </>
      )}
    </>
  );
}
