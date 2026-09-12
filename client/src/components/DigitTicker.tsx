import { useMemo } from 'react';
import { useApp } from '../store/app';

/** How many recent digits to show as a running strip. */
const STRIP = 18;

/**
 * The last-digit ticker.
 *
 * On an Over/Under ticket the price level is incidental — what decides the
 * trade is the final digit — so this is the instrument the trader is really
 * watching, and it sits directly under the chart where the price would be read.
 *
 * Two readings, because they answer different questions. The strip is what just
 * happened, newest on the right. The bars are how the digits have landed over
 * the window so far, which is the only way to see that they land evenly.
 *
 * It says how many ticks it has counted rather than implying a fixed sample.
 * The window fills as the session runs, and a distribution over forty ticks is
 * not the same claim as one over a thousand.
 */
export function DigitTicker(): JSX.Element | null {
  const { digitHistory, config, instrument } = useApp();

  const { counts, max, total, recent } = useMemo(() => {
    const c = new Array(10).fill(0) as number[];
    for (const d of digitHistory) c[d] = (c[d] ?? 0) + 1;
    return {
      counts: c,
      max: Math.max(1, ...c),
      total: digitHistory.length,
      recent: digitHistory.slice(-STRIP),
    };
  }, [digitHistory]);

  if (!config.digitsEnabled) return null;

  const latest = recent.length > 0 ? recent[recent.length - 1] : null;

  return (
    <div className="card digits-card">
      <div className="card-head">
        <div className="section-title">
          <span className="dot" />
          Last digit
        </div>
        <span className="eyebrow">
          {total > 0
            ? total.toLocaleString('en-KE') + ' ticks' +
              (instrument ? ' · ' + instrument.precision + 'dp' : '')
            : 'waiting for ticks'}
        </span>
      </div>

      <div className="card-body digits-body">
        {/* What just happened, newest on the right. */}
        <div className="digit-strip" aria-label="Recent last digits">
          {recent.length === 0 && <span className="digit-wait">Collecting ticks…</span>}
          {recent.map((d, i) => (
            <span
              key={digitHistory.length - recent.length + i}
              className={'ds' + (i === recent.length - 1 ? ' now' : '')}
            >
              {d}
            </span>
          ))}
        </div>

        {/* How they have landed. Even bars are the product working. */}
        <div className="digit-bars" aria-label="Digit distribution">
          {counts.map((n, d) => {
            const pct = total > 0 ? (n / total) * 100 : 0;
            return (
              <div key={d} className={'db' + (latest === d ? ' now' : '')}>
                <span className="db-pct tnum">{total > 0 ? pct.toFixed(1) : '—'}</span>
                <div className="db-track">
                  <i style={{ height: Math.round((n / max) * 100) + '%' }} />
                </div>
                <span className="db-d tnum">{d}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
