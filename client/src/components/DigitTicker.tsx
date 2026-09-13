import { useMemo } from 'react';
import { useApp } from '../store/app';

const R = 16;
const C = 2 * Math.PI * R;

/**
 * The digit track.
 *
 * One marker walks the row rather than ten markers taking turns lighting up.
 * A single thing moving is what makes the market look alive — ten things
 * blinking reads as a dashboard, and a marker that never moves off the first
 * digit reads as broken.
 *
 * The marker slides on a transform, so it travels the distance between two
 * digits instead of jumping, and the ring it lands in flares as it arrives.
 * One step is a cell plus the grid gap, which puts the arrow dead centre on
 * its digit at either end of the row.
 */
export function DigitTicker(): JSX.Element | null {
  const { digitHistory, config } = useApp();
  // Changes on every tick, so the arriving ring remounts its flare and replays.
  const beat = digitHistory.length;

  const { pct, total, latest, hi, lo } = useMemo(() => {
    const counts = new Array(10).fill(0) as number[];
    for (const d of digitHistory) counts[d] = (counts[d] ?? 0) + 1;
    const n = digitHistory.length;
    const p = counts.map((c) => (n > 0 ? (c / n) * 100 : 0));
    return {
      pct: p,
      total: n,
      latest: n > 0 ? digitHistory[n - 1]! : -1,
      hi: n > 0 ? p.indexOf(Math.max(...p)) : -1,
      lo: n > 0 ? p.indexOf(Math.min(...p)) : -1,
    };
  }, [digitHistory]);

  if (!config.digitsEnabled) return null;

  // One step is the width of a cell (which is the marker's own width, so
  // 100%) plus the 2px grid gap between cells.
  const step = Math.max(0, latest);

  return (
    <div className="track">
      <div className="track-row" aria-label="Last digit">
        {pct.map((p, d) => {
          const filled = Math.max(0, Math.min(1, p / 10));
          const tone = d === hi ? ' hi' : d === lo ? ' lo' : '';
          const now = d === latest ? ' now' : '';
          return (
            <div key={d} className={'cell' + tone + now}>
              <svg viewBox="0 0 36 36" aria-hidden="true">
                <circle className="c-track" cx="18" cy="18" r={R} fill="none" strokeWidth="2.5" />
                <circle
                  className="c-arc"
                  cx="18"
                  cy="18"
                  r={R}
                  fill="none"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeDasharray={C}
                  strokeDashoffset={C * (1 - filled)}
                  transform="rotate(-90 18 18)"
                />
              </svg>
              {d === latest && <span key={beat} className="c-flare" aria-hidden="true" />}
              <span className="c-d tnum">{d}</span>
              <span className="c-p tnum">{total > 0 ? p.toFixed(1) : '—'}</span>
            </div>
          );
        })}

        {/* One marker, moving. It rides above the row and slides to the digit
            the market just touched; the head re-drops on every tick so a
            repeated digit still shows movement. */}
        <span
          className={'marker' + (latest >= 0 ? ' live' : '')}
          style={{ transform: 'translateX(calc(' + step + ' * (100% + 2px)))' }}
          aria-hidden="true"
        >
          <i key={beat} />
        </span>
      </div>
    </div>
  );
}
