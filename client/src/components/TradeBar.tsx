import { useApp } from '../store/app';
import { ksh, durationLabel } from '../lib/format';

/**
 * Phone-only action bar pinned to the bottom of the viewport.
 *
 * A 5-second expiry is unplaceable if the buttons sit a scroll away from the
 * chart: by the time you scroll down to Buy, the candle you were reading is
 * gone. Keeping the actions pinned means the chart and the buttons are on
 * screen at the same time, which is the whole point of a seconds-long trade.
 * Above 1024px the panel sits beside the chart already, so the bar is hidden.
 */
export function TradeBar(): JSX.Element {
  const {
    user, stake, duration, config, accountMode, balance,
    tradeBusy, canTrade, openModal, desk, setAccountMode,
    autoRunCount, run, startAuto, autoBusy,
  } = useApp();

  if (!user) {
    return (
      <div className="trade-bar">
        <button className="btn btn-primary btn-block" onClick={() => openModal('login')}>
          Log in to trade
        </button>
      </div>
    );
  }

  // The desk closes when the day's payouts run ahead of target and reopens by
  // itself as the book recovers, so this state comes and goes mid-session.
  if (accountMode === 'real' && !desk.open) {
    return (
      <div className="trade-bar closed">
        <div className="desk-note">
          <strong>Live trading paused</strong>
          <span>Reopens automatically · demo still open</span>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => setAccountMode('demo')}>
          Demo
        </button>
      </div>
    );
  }

  const lowBalance = balance < config.minStake;

  if (lowBalance && accountMode === 'real') {
    return (
      <div className="trade-bar">
        <button className="btn btn-primary btn-block" onClick={() => openModal('deposit')}>
          Deposit to trade
        </button>
      </div>
    );
  }

  return (
    <div className="trade-bar">
      <button
        className="ticket"
        onClick={() => document.querySelector('.trade-panel')?.scrollIntoView({ block: 'center' })}
        aria-label="Change trade amount and duration"
      >
        {/* The account mode is already on the header button, so the chip only
            carries what changes per trade — amount and expiry. */}
        <span className="amt tnum">{ksh(Number(stake) || 0, true)}</span>
        {/* Not ".dur" — that class is the duration *button* in the panel grid,
            and reusing it here inherited a border and a 46px min-height. */}
        <span className="exp tnum">{durationLabel(duration)}</span>
      </button>

      {/* The pinned bar now carries one action: open the whole batch. Manual
          Buy and Sell stay in the panel below for anyone choosing their own
          side. */}
      <button
        className="bar-auto"
        disabled={autoBusy || tradeBusy !== null || !canTrade}
        onClick={() => void startAuto()}
      >
        <span className="ba-main">{autoBusy ? 'Opening…' : 'Fpesa Auto'}</span>
        <span className="ba-sub">
          {run && run.status === 'RUNNING'
            ? 'Position ' + Math.min(run.completedCount + 1, run.totalCount) +
              ' of ' + run.totalCount
            : autoRunCount + ' positions · ' + ksh(Number(stake) * autoRunCount || 0, true)}
        </span>
      </button>

    </div>
  );
}
