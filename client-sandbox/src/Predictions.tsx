import { useCallback, useEffect, useState } from 'react';

type Play = {
  durationSec: number;
  direction: 'BUY' | 'SELL';
  profitPerUnit: number;
  reason: 'EXPIRY' | 'STOP_OUT' | 'TAKE_PROFIT';
  ticks: number;
};

type Market = {
  symbol: string;
  name: string;
  volatility: number;
  price: number;
  tickMs: number;
  next: number[];
  horizons: Array<{ durationSec: number; price: number; movePct: number }>;
  best: Play | null;
};

type Board = {
  ts: number;
  markets: Market[];
  durations: number[];
  houseEdge: number;
  maxProfitMultiple: number;
};

const nf = new Intl.NumberFormat('en-KE', { maximumFractionDigits: 3 });

async function get<T>(path: string): Promise<T> {
  const res = await fetch('/api/sandbox' + path, { credentials: 'same-origin' });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) throw new Error((data as { message?: string } | null)?.message ?? 'Request failed.');
  return data as T;
}

/** The next 40 ticks as a sparkline — ten seconds of what has not happened yet. */
function Spark({ values }: { values: number[] }): JSX.Element {
  const W = 120;
  const H = 30;
  if (values.length < 2) return <svg viewBox={`0 0 ${W} ${H}`} className="spark" />;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || Math.max(hi * 1e-6, 0.01);
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * W;
      const y = H - ((v - lo) / span) * (H - 4) - 2;
      return x.toFixed(1) + ',' + y.toFixed(1);
    })
    .join(' ');
  const rising = values[values.length - 1]! >= values[0]!;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="spark" preserveAspectRatio="none">
      <polyline points={pts} className={rising ? 'spark-up' : 'spark-down'} />
    </svg>
  );
}

type Pinned = {
  symbol: string;
  pinnedAt: number;
  /** Predicted price for each future tick, keyed by the ms it will occur. */
  predicted: Array<{ at: number; price: number }>;
};

/**
 * Pin a prediction and watch it come true, or not.
 *
 * The columns on the board above are recomputed from a moving "now", so reading
 * "+5s" and then glancing back five seconds later compares two different ticks
 * and shows a small mismatch that is not a prediction error. This removes that
 * confusion entirely: it freezes the predicted price for specific *timestamps*,
 * then matches each one against the tick that actually arrived at that instant.
 *
 * Nothing is graded on approximation. A row counts only if the two prices are
 * identical.
 */
function ProveIt({ symbol }: { symbol: string }): JSX.Element {
  const [pinned, setPinned] = useState<Pinned | null>(null);
  const [actual, setActual] = useState<Map<number, number>>(new Map());
  const [busy, setBusy] = useState(false);

  const pin = useCallback(() => {
    setBusy(true);
    setActual(new Map());
    void get<{ future: Array<{ at: number; price: number }> }>(
      '/oracle?symbol=' + encodeURIComponent(symbol)
    )
      .then((o) => {
        setPinned({
          symbol,
          pinnedAt: Date.now(),
          // Forty ticks is ten seconds — long enough to be convincing, short
          // enough to sit and watch.
          predicted: o.future.slice(0, 40),
        });
      })
      .finally(() => setBusy(false));
  }, [symbol]);

  // Collect the ticks as they actually happen, joined on their own timestamps.
  useEffect(() => {
    if (!pinned) return;
    const last = pinned.predicted[pinned.predicted.length - 1]?.at ?? 0;
    const id = window.setInterval(() => {
      void get<{ recent: Array<{ at: number; price: number }> }>(
        '/oracle?symbol=' + encodeURIComponent(pinned.symbol)
      ).then((o) => {
        setActual((prev) => {
          const next = new Map(prev);
          for (const t of o.recent) next.set(t.at, t.price);
          return next;
        });
      });
      if (Date.now() > last + 1500) window.clearInterval(id);
    }, 500);
    return () => window.clearInterval(id);
  }, [pinned]);

  const rows = pinned?.predicted ?? [];
  const settled = rows.filter((r) => actual.has(r.at));
  const matched = settled.filter((r) => actual.get(r.at) === r.price);

  return (
    <section className="card" style={{ marginTop: 16 }}>
      <div className="card-head">
        <h2>Prove it — {symbol}</h2>
        {settled.length > 0 && (
          <span className={'chip ' + (matched.length === settled.length ? 'ok' : 'off')}>
            {matched.length} of {settled.length} exact
          </span>
        )}
      </div>
      <div className="card-body">
        <p className="note" style={{ marginTop: 0 }}>
          Freezes the next ten seconds of predicted prices, each tied to the
          millisecond it is due, then checks every one against the tick that
          actually arrives. A row passes only on an exact match.
        </p>
        <button className="btn primary" onClick={pin} disabled={busy}>
          {busy ? 'Pinning…' : 'Pin the next 10 seconds'}
        </button>

        {pinned && (
          <div className="scroll" style={{ marginTop: 12 }}>
            <table className="pred prove">
              <thead>
                <tr>
                  <th>Due at</th>
                  <th>Predicted</th>
                  <th>Actually happened</th>
                  <th>&nbsp;</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const got = actual.get(r.at);
                  const waiting = got === undefined;
                  return (
                    <tr key={r.at}>
                      <td className="tnum">
                        {new Date(r.at).toLocaleTimeString('en-KE')}
                        <small className="muted">.{String(r.at % 1000).padStart(3, '0')}</small>
                      </td>
                      <td className="tnum strong">{nf.format(r.price)}</td>
                      <td className="tnum">{waiting ? <span className="muted">…</span> : nf.format(got)}</td>
                      <td>
                        {waiting ? (
                          <span className="muted">waiting</span>
                        ) : got === r.price ? (
                          <span className="up">exact</span>
                        ) : (
                          <span className="down">off by {Math.abs(got - r.price).toFixed(2)}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * The operator board: every market's next prices at once.
 *
 * This is the sandbox's own five markets, generated by this process from seeds
 * it made at boot. It predicts them exactly, which is the point of having it —
 * and which is also why the same screen could not exist against a market this
 * process does not generate.
 */
export function Predictions(): JSX.Element {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBoard(await get<Board>('/admin/predictions'));
  }, []);

  useEffect(() => {
    let alive = true;
    const run = (): void => {
      void load()
        .then(() => alive && setError(null))
        .catch((err: Error) => alive && setError(err.message));
    };
    run();
    const id = window.setInterval(run, 500);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [load]);

  if (error) return <div className="err">{error}</div>;
  if (!board) return <div className="muted">Loading…</div>;
  const first = board.markets[0]?.symbol ?? null;

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>Next prices — all markets</h2>
          <span className="eyebrow">updating live</span>
        </div>
        <div className="card-body">
          <div className="scroll">
            <table className="pred">
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Now</th>
                  <th>Next 10s</th>
                  {board.durations.map((d) => <th key={d}>+{d}s</th>)}
                  <th>Best position</th>
                </tr>
              </thead>
              <tbody>
                {board.markets.map((m) => (
                  <tr key={m.symbol}>
                    <th scope="row">
                      <span className="pm-sym">{m.symbol}</span>
                      <span className="pm-name">V{m.volatility}</span>
                    </th>
                    <td className="tnum strong">{nf.format(m.price)}</td>
                    <td className="spark-cell"><Spark values={m.next} /></td>
                    {m.horizons.map((h) => (
                      <td key={h.durationSec} className="tnum">
                        <span className={h.movePct >= 0 ? 'up' : 'down'}>
                          {nf.format(h.price)}
                        </span>
                        <small className={h.movePct >= 0 ? 'up' : 'down'}>
                          {h.movePct >= 0 ? '+' : ''}{h.movePct}%
                        </small>
                      </td>
                    ))}
                    <td>
                      {m.best ? (
                        <div className="pm-best">
                          <span className={'side ' + m.best.direction.toLowerCase()}>
                            {m.best.direction}
                          </span>
                          <span className="tnum">{m.best.durationSec}s</span>
                          <b className={m.best.profitPerUnit >= 0 ? 'up' : 'down'}>
                            {m.best.profitPerUnit >= 0 ? '+' : '−'}
                            {Math.abs(m.best.profitPerUnit * 1000).toFixed(0)}
                          </b>
                          <small>per 1,000</small>
                        </div>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="note">
            Prices to the right of &ldquo;Now&rdquo; have not happened yet. They
            are computed from each market&rsquo;s seed, which this process
            generated when it started, so they are exact.
            <br />
            One thing to know before you check them by eye: these columns are
            recomputed from a moving &ldquo;now&rdquo; every half second, so
            reading <b>+5s</b> and glancing back five seconds later compares two
            different ticks and will look slightly off. That is the clock, not
            the prediction. Use <b>Prove it</b> below, which pins each price to
            the exact millisecond it is due.
          </p>
          <p className="note">
            <b>These are this demo&rsquo;s markets, not fpesa.markets.</b> Same
            code, different random numbers. The live platform&rsquo;s seed is not
            published while an epoch is running and nothing here can reach it, so
            no screen anywhere can do this for the real market.
          </p>
        </div>
      </section>
      {first && <ProveIt symbol={first} />}
    </>
  );
}
