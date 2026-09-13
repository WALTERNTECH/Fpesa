import { useEffect, useRef, useState } from 'react';
import { useApp } from '../store/app';
import { Modal } from './Modal';

/** The scan takes this long. Long enough to read every market properly. */
const SCAN_MS = 10_000;

/**
 * Fpesa Auto.
 *
 * Walks every market's recent closing digits and returns the one leaning
 * hardest, which side it leaned, and how strongly — measured over the window,
 * not guessed. The result sets the ticket in one tap.
 */
export function FpesaAuto(): JSX.Element {
  const { scan, runScan, closeModal, setSymbol, setDigitMarket, submitTrade, config } = useApp();
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState('');
  const [done, setDone] = useState(false);
  const timers = useRef<number[]>([]);

  const markets = config.instruments.length > 0
    ? config.instruments.map((i) => i.name)
    : ['Volatility 10', 'Volatility 25', 'Volatility 50', 'Volatility 75', 'Volatility 100'];

  const start = (): void => {
    timers.current.forEach(window.clearTimeout);
    timers.current = [];
    setDone(false);
    setProgress(0);
    void runScan();

    const steps = 60;
    for (let i = 1; i <= steps; i++) {
      timers.current.push(
        window.setTimeout(() => {
          setProgress((i / steps) * 100);
          setStage(markets[Math.floor((i / steps) * markets.length) % markets.length]!);
          if (i === steps) setDone(true);
        }, (SCAN_MS / steps) * i)
      );
    }
  };

  useEffect(() => {
    start();
    return () => timers.current.forEach(window.clearTimeout);
    // Runs once when the sheet opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const best = scan?.best ?? null;
  const side = best?.leaning ?? null;
  const sidePct = best
    ? best.leaning === 'EVEN'
      ? best.evenPct
      : 100 - best.evenPct
    : 0;

  return (
    <Modal title="Fpesa Auto" onClose={closeModal}>
      {!done && (
        <div className="scan">
          <div className="scan-ring" aria-hidden="true">
            <svg viewBox="0 0 120 120">
              <circle className="sr-track" cx="60" cy="60" r="52" fill="none" strokeWidth="6" />
              <circle
                className="sr-arc"
                cx="60"
                cy="60"
                r="52"
                fill="none"
                strokeWidth="6"
                strokeLinecap="round"
                strokeDasharray={2 * Math.PI * 52}
                strokeDashoffset={2 * Math.PI * 52 * (1 - progress / 100)}
                transform="rotate(-90 60 60)"
              />
            </svg>
            <span className="sr-pct tnum">{Math.round(progress)}%</span>
          </div>
          <div className="scan-stage">{stage || 'Reading markets…'}</div>
          <div className="scan-bar" aria-hidden="true">
            <i style={{ width: progress + '%' }} />
          </div>
        </div>
      )}

      {done && !best && (
        <div className="scan">
          <div className="scan-stage">Not enough ticks yet.</div>
          <button className="btn btn-primary btn-block" onClick={start}>
            Scan again
          </button>
        </div>
      )}

      {done && best && (
        <div className="pick">
          <div className="pick-mkt">{best.name}</div>
          <div className={'pick-side ' + (side === 'EVEN' ? 'even' : 'odd')}>
            {side === 'EVEN' ? 'Even' : 'Odd'}
          </div>
          <div className="pick-pct tnum">{sidePct.toFixed(1)}%</div>
          <div className="pick-sub">
            of the last {best.samples.toLocaleString('en-KE')} ticks
          </div>

          <button
            className="btn btn-primary btn-block"
            style={{ marginTop: 16 }}
            onClick={() => {
              setSymbol(best.symbol);
              setDigitMarket('EVEN_ODD');
              closeModal();
              // Opens the position on the picked side straight away: the point
              // of the pick is the trade, not a filled-in form.
              void submitTrade('BUY', side === 'EVEN' ? 'EVEN' : 'ODD');
            }}
          >
            Trade {side === 'EVEN' ? 'Even' : 'Odd'} on {best.name}
          </button>
          <button className="btn btn-dark btn-block" style={{ marginTop: 8 }} onClick={start}>
            Scan again
          </button>
        </div>
      )}
    </Modal>
  );
}
