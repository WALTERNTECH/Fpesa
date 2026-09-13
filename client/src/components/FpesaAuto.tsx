import { useEffect } from 'react';
import { useApp } from '../store/app';
import { Modal } from './Modal';

/**
 * Fpesa Auto.
 *
 * Scans every market's recent closing digits and reports which one has leaned
 * furthest from an even split, by how much, and over how many ticks.
 *
 * What it will not do is tell a trader which side is going to land. The digit
 * stream is independent and uniform — measured, not assumed — so a run of Odd
 * says exactly nothing about the next tick, the same way a run of heads says
 * nothing about the next toss. Any number here presented as "quality" or
 * "confidence in this trade" would be inventing an edge nobody has, and a
 * trader would stake real money against it.
 *
 * So the confidence it reports is confidence that the LEAN IS REAL rather than
 * ordinary noise, which on a fair feed almost always answers "this is noise".
 * That is the true answer, and a trader who can see a streak is noise is better
 * served than one handed a number that implies it is not.
 */
export function FpesaAuto(): JSX.Element {
  const { scan, scanBusy, runScan, closeModal, setSymbol, setDigitMarket, symbol } = useApp();

  useEffect(() => {
    if (!scan) void runScan();
  }, [scan, runScan]);

  const best = scan?.best ?? null;

  return (
    <Modal
      title="Fpesa Auto"
      subtitle="Reads every market's recent digits"
      onClose={closeModal}
    >
      <button className="btn btn-primary btn-block" disabled={scanBusy} onClick={() => void runScan()}>
        {scanBusy ? 'Scanning…' : scan ? 'Scan again' : 'Scan markets'}
      </button>

      {scan && scan.markets.length === 0 && (
        <p className="pass-note">Not enough ticks measured yet. Try again in a moment.</p>
      )}

      {best && (
        <>
          <div className="auto-best">
            <div className="ab-head">
              <span className="ab-k">Biggest lean right now</span>
              <span className={'ab-tag' + (best.unusual ? ' hot' : '')}>
                {best.unusual ? 'unusual' : 'normal variation'}
              </span>
            </div>
            <div className="ab-market">{best.name}</div>
            <div className="ab-split">
              <span className={'ab-side' + (best.leaning === 'EVEN' ? ' on' : '')}>
                Even {best.evenPct.toFixed(1)}%
              </span>
              <span className={'ab-side' + (best.leaning === 'ODD' ? ' on' : '')}>
                Odd {(100 - best.evenPct).toFixed(1)}%
              </span>
            </div>
            <div className="ab-meta">
              {best.evenCount.toLocaleString('en-KE')} even ·{' '}
              {best.oddCount.toLocaleString('en-KE')} odd · {best.samples.toLocaleString('en-KE')} ticks
            </div>
            <div className="ab-meta">
              Chance alone produces a lean this big{' '}
              <b>{best.chanceAlonePct.toFixed(1)}%</b> of the time
            </div>

            {best.symbol !== symbol && (
              <button
                className="btn btn-dark btn-block"
                style={{ marginTop: 10 }}
                onClick={() => {
                  setSymbol(best.symbol);
                  setDigitMarket('EVEN_ODD');
                  closeModal();
                }}
              >
                Switch to {best.name}
              </button>
            )}
          </div>

          <table className="auto-table">
            <tbody>
              {scan!.markets.map((m) => (
                <tr key={m.symbol} className={m.symbol === symbol ? 'on' : ''}>
                  <td>{m.symbol}</td>
                  <td className="tnum">{m.evenPct.toFixed(1)}% even</td>
                  <td className="tnum">{m.samples.toLocaleString('en-KE')}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Travels with the numbers rather than living in a help page. */}
          <p className="pass-note">{scan!.note}</p>
        </>
      )}
    </Modal>
  );
}
