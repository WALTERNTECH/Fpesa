import { useApp } from '../store/app';

/**
 * The overlay between tapping Fpesa Auto and the first position opening.
 *
 * What it shows is a real measurement, not a loading animation with words on
 * it. Before placing anything the client asks the server for the current state
 * of all five markets: volatility actually observed over the last minute, and
 * from it the probability that a position of the chosen length is stopped out
 * before it expires. The market with the lowest figure is where the batch goes.
 *
 * Every instrument is *designed* to put the stop-out the same distance away, so
 * on paper they are interchangeable. Realised volatility wanders around that
 * design figure minute to minute, which is why at any given moment one of them
 * genuinely is a better place to put this ticket — and why this is worth
 * computing rather than guessing.
 *
 * It chooses where to stand. It does not choose which way to face: the series
 * is driftless and every tick is an independent draw, so no reading of the past
 * moves the odds on the next one. Side stays a coin flip, and the panel says so.
 */
export function AutoRunSpinner(): JSX.Element | null {
  const { autoBusy, autoScan, autoStage, duration, autoRunCount } = useApp();

  if (!autoBusy) return null;

  const ranked = autoScan?.markets ?? [];
  const best = autoScan?.best ?? null;
  const measured = ranked.filter((m) => m.stopOutOdds !== null);

  return (
    <div className="auto-veil" role="status" aria-live="polite">
      <div className="auto-card">
        <div className="auto-ring" aria-hidden="true">
          <svg viewBox="0 0 48 48" width="48" height="48">
            <circle className="ar-track" cx="24" cy="24" r="20" />
            <circle className="ar-arc" cx="24" cy="24" r="20" />
          </svg>
          <span className="ar-sym">{best ? best.replace('FPX', '') : '···'}</span>
        </div>

        <div className="auto-title">
          {autoStage === 'scanning'
            ? 'Scanning the markets'
            : autoStage === 'chosen'
              ? 'Best fit for ' + duration + 's'
              : 'Opening your positions'}
        </div>

        {/* The measurement itself. Bars are relative stop-out risk across the
            five markets at this duration — shorter is safer, and the shortest
            is the one that gets traded. */}
        {measured.length > 0 && (
          <ul className="auto-scan">
            {measured.map((m) => {
              const odds = (m.stopOutOdds ?? 0) * 100;
              const worst = Math.max(...measured.map((x) => (x.stopOutOdds ?? 0) * 100), 0.01);
              return (
                <li key={m.symbol} className={m.symbol === best ? 'pick' : ''}>
                  <span className="as-sym">{m.symbol}</span>
                  <span className="as-bar" aria-hidden="true">
                    <i style={{ width: Math.max(4, (odds / worst) * 100) + '%' }} />
                  </span>
                  <span className="as-val tnum">{odds.toFixed(1)}%</span>
                </li>
              );
            })}
          </ul>
        )}

        <div className="auto-foot">
          {autoStage === 'scanning' && 'Measuring volatility over the last minute'}
          {autoStage === 'chosen' && best &&
            best + ' has the lowest stop-out risk right now'}
          {autoStage === 'placing' &&
            'Placing ' + autoRunCount + ' positions on ' + (best ?? 'the chosen market')}
        </div>
      </div>
    </div>
  );
}
