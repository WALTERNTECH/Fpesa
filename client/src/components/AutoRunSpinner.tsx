import { useEffect, useState } from 'react';
import { useApp } from '../store/app';

/**
 * The overlay shown between tapping Fpesa Auto and the first position opening.
 *
 * The four lines below are the four things the server actually does in that
 * moment: it refuses to quote until the feed has a real price behind it, reads
 * that price and marks the disclosed spread onto it, computes the stop-out and
 * take-profit levels the position will close itself at, then writes the trade
 * inside a locked balance transaction.
 *
 * What it does not say is that the market is being analysed, because it is not.
 * The instrument is a driftless walk and the side is a coin flip — there is
 * nothing in the series to read, and a screen that told a trader otherwise
 * would be selling them a reason that does not exist. These lines are the real
 * work, and they take exactly as long as the real work takes.
 */
const STEPS = [
  'Checking the market feed',
  'Pricing ',            // completed with the instrument's symbol
  'Setting exit levels',
  'Opening position 1',
];

export function AutoRunSpinner(): JSX.Element | null {
  const { autoBusy, symbol, autoRunCount } = useApp();
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!autoBusy) {
      setStep(0);
      return;
    }
    // Advances while the request is in flight and stops on the last line rather
    // than looping, so the overlay never implies more work than is happening.
    const id = window.setInterval(() => {
      setStep((s) => Math.min(s + 1, STEPS.length - 1));
    }, 190);
    return () => window.clearInterval(id);
  }, [autoBusy]);

  if (!autoBusy) return null;

  return (
    <div className="auto-veil" role="status" aria-live="polite">
      <div className="auto-card">
        <div className="auto-ring" aria-hidden="true">
          <svg viewBox="0 0 48 48" width="48" height="48">
            <circle className="ar-track" cx="24" cy="24" r="20" />
            <circle className="ar-arc" cx="24" cy="24" r="20" />
          </svg>
          <span className="ar-sym">{symbol.replace('FPX', '')}</span>
        </div>

        <div className="auto-title">Placing your trades</div>

        <ul className="auto-steps">
          {STEPS.map((label, i) => (
            <li
              key={label}
              className={i < step ? 'done' : i === step ? 'now' : 'next'}
            >
              <span className="dot" aria-hidden="true" />
              {label}
              {i === 1 && symbol}
              {i === 3 && ' of ' + autoRunCount}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
