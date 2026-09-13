import { useMemo } from 'react';
import { useApp } from '../store/app';

const R = 17;
const C = 2 * Math.PI * R;

/**
 * The digit ring.
 *
 * On a digit market the price level is incidental — what settles the trade is
 * the final digit — so this is the instrument the trader is actually reading,
 * and it sits directly under the chart where the price would be.
 *
 * Each digit is a ring whose arc is that digit's share of the window, so an
 * even spread reads as ten matching rings at a glance. The digit the market
 * just touched lights up and carries the pointer. Most and least frequent are
 * tinted, because those are the two a trader looks for.
 *
 * The count is stated rather than implied: a spread over forty ticks is not the
 * claim two thousand would be, and rings drawn from forty ticks look far more
 * meaningful than they are.
 */
export function DigitTicker(): JSX.Element | null {
  const { digitHistory, config } = useApp();
  // Changes on every tick, so the ring that just landed remounts its pulse and
  // replays the animation rather than only playing it the first time.
  const beat = digitHistory.length;

  const { pct, total, latest, hi, lo } = useMemo(() => {
    const counts = new Array(10).fill(0) as number[];
    for (const d of digitHistory) counts[d] = (counts[d] ?? 0) + 1;
    const n = digitHistory.length;
    const p = counts.map((c) => (n > 0 ? (c / n) * 100 : 0));
    let hiD = -1;
    let loD = -1;
    if (n > 0) {
      hiD = p.indexOf(Math.max(...p));
      loD = p.indexOf(Math.min(...p));
    }
    return {
      pct: p,
      total: n,
      latest: n > 0 ? digitHistory[n - 1]! : -1,
      hi: hiD,
      lo: loD,
    };
  }, [digitHistory]);

  if (!config.digitsEnabled) return null;

  return (
    <div className="ring-card">
      <div className="ring-row" aria-label="Last digit distribution">
        {pct.map((p, d) => {
          // Scaled against a tenth, so an even market sits at a full ring.
          const filled = Math.max(0, Math.min(1, p / 10));
          const tone = d === hi ? ' hi' : d === lo ? ' lo' : '';
          const now = d === latest ? ' now' : '';
          return (
            <div key={d} className={'ring' + tone + now}>
              <svg viewBox="0 0 40 40" aria-hidden="true">
                <circle className="r-track" cx="20" cy="20" r={R} fill="none" strokeWidth="3" />
                <circle
                  className="r-arc"
                  cx="20"
                  cy="20"
                  r={R}
                  fill="none"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={C}
                  strokeDashoffset={C * (1 - filled)}
                  transform="rotate(-90 20 20)"
                />
              </svg>
              {/* Keyed on the tick, so each touch restarts the flare. */}
              {d === latest && <span key={beat} className="r-flare" aria-hidden="true" />}
              <span className="r-d tnum">{d}</span>
              <span className="r-p tnum">{total > 0 ? p.toFixed(1) : '—'}</span>
              <span className="r-mark" aria-hidden="true" />
            </div>
          );
        })}
      </div>
    </div>
  );
}
