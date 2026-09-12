import { useApp } from '../store/app';
import { usd, durationLabel } from '../lib/format';
import { IconArrowDown, IconArrowUp } from './Icons';

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
    submitTrade, tradeType,
  } = useApp();

  const isDigits =
    config.digitsEnabled && (tradeType === 'DIGITS_OVER' || tradeType === 'DIGITS_UNDER');

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
        <span className="amt tnum">{usd(Number(stake) || 0)}</span>
        {/* Not ".dur" — that class is the duration *button* in the panel grid,
            and reusing it here inherited a border and a 46px min-height. */}
        <span className="exp tnum">{durationLabel(duration)}</span>
      </button>

      {/* Over/Under is decided by the digit, not by a side, so the bar offers
          the one action the ticket actually has. */}
      {isDigits ? (
        <div className="bar-sides">
          <button
            className="bar-side buy"
            style={{ gridColumn: '1 / -1' }}
            disabled={tradeBusy !== null || !canTrade}
            onClick={() => void submitTrade('BUY')}
          >
            {tradeBusy ? 'Placing…' : 'Trade'}
          </button>
        </div>
      ) : (
      <div className="bar-sides">
        <button
          className="bar-side buy"
          disabled={tradeBusy !== null || !canTrade}
          onClick={() => void submitTrade('BUY')}
        >
          <IconArrowUp size={16} />
          {tradeBusy === 'BUY' ? 'Placing…' : 'Buy'}
        </button>
        <button
          className="bar-side sell"
          disabled={tradeBusy !== null || !canTrade}
          onClick={() => void submitTrade('SELL')}
        >
          <IconArrowDown size={16} />
          {tradeBusy === 'SELL' ? 'Placing…' : 'Sell'}
        </button>
      </div>
      )}
    </div>
  );
}
