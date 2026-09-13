import { useMemo } from 'react';
import { useApp } from '../store/app';
import { usd, durationLabel } from '../lib/format';
import { DigitTicker } from './DigitTicker';
import { OpenPositions } from './OpenPositions';
import { IconArrowDown, IconArrowUp } from './Icons';

/** The preset stakes on the ticket, in dollars. */
const PRESETS = [1, 5, 10, 25, 50, 100];

/**
 * The ticket, in the order a trade is actually decided: how long, how much,
 * what the digits are doing, then the two buttons. Nothing sits after the
 * buttons — anything else a trader needs is in the header menu or the bottom
 * bar.
 */
export function TradePanel(): JSX.Element {
  const {
    user, config, accountMode, openModal,
    stake, setStake, duration, setDuration,
    tradeBusy, tradeError, setTradeError, stakeIssue, canTrade, submitTrade, desk,
    stakeCeiling, toUsd,
    digit, setDigit, digitsQuote, digitMarket, setDigitMarket,
  } = useApp();

  const isDigits = config.digitsEnabled;
  const isEvenOdd = digitMarket === 'EVEN_ODD';

  const stakeAmount = Number(stake);
  const validStake = Number.isFinite(stakeAmount) ? stakeAmount : 0;
  const ceilingUsd = Math.floor(toUsd(stakeCeiling));

  const presets = useMemo(
    () => PRESETS.filter((v) => v >= config.minStakeUsd && v <= ceilingUsd),
    [config.minStakeUsd, ceilingUsd]
  );

  const stepStake = (by: number): void => {
    const next = Math.min(Math.max(validStake + by, config.minStakeUsd), ceilingUsd);
    setStake(String(Math.round(next * 100) / 100));
    setTradeError(null);
  };

  const left = isEvenOdd
    ? digitsQuote?.even ?? null
    : digitsQuote?.over.find((t) => t.digit === digit) ?? null;
  const right = isEvenOdd
    ? digitsQuote?.odd ?? null
    : digitsQuote?.under.find((t) => t.digit === digit) ?? null;

  const deskClosed = accountMode === 'real' && !desk.open;
  const inlineError = tradeError ?? stakeIssue;
  const blocked = tradeBusy !== null || deskClosed || (Boolean(user) && !canTrade);

  return (
    <div className="ticket">
      {isDigits && (
        <div className="mkt-tabs" role="group" aria-label="Market">
          <button aria-pressed={isEvenOdd} onClick={() => setDigitMarket('EVEN_ODD')}>
            Even / Odd
          </button>
          <button aria-pressed={!isEvenOdd} onClick={() => setDigitMarket('OVER_UNDER')}>
            Over / Under
          </button>
        </div>
      )}

      <div className="row2">
        <div className="fld">
          <span className="fld-k">Duration</span>
          <div className="dur-grid" role="group" aria-label="Duration">
            {config.durations.map((seconds) => (
              <button
                key={seconds}
                type="button"
                className="dur"
                aria-pressed={duration === seconds}
                onClick={() => setDuration(seconds)}
              >
                {durationLabel(seconds)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="fld">
        <span className="fld-k">Stake</span>
        <div className={'stake-row' + (stakeIssue ? ' invalid' : '')}>
          <button
            type="button"
            className="stake-step"
            aria-label="Decrease stake"
            disabled={validStake <= config.minStakeUsd}
            onClick={() => stepStake(-1)}
          >
            −
          </button>
          <div className="stake-input">
            <span className="cur">$</span>
            <input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={stake}
              onChange={(e) => {
                setStake(e.target.value.replace(/[^0-9.]/g, ''));
                setTradeError(null);
              }}
              aria-label="Stake in US dollars"
            />
          </div>
          <button
            type="button"
            className="stake-step"
            aria-label="Increase stake"
            disabled={validStake >= ceilingUsd}
            onClick={() => stepStake(1)}
          >
            +
          </button>
        </div>
        <div className="preset-row">
          {presets.map((v) => (
            <button
              key={v}
              type="button"
              className="preset"
              aria-pressed={validStake === v}
              onClick={() => {
                setStake(String(v));
                setTradeError(null);
              }}
            >
              ${v}
            </button>
          ))}
        </div>
      </div>

      {/* The digits, immediately above the buttons that settle against them. */}
      <DigitTicker />

      {isDigits && !isEvenOdd && (
        <div className="fld">
          <span className="fld-k">Last digit</span>
          <div className="digit-grid" role="group" aria-label="Digit">
            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
              <button
                key={d}
                type="button"
                className="digit"
                aria-pressed={digit === d}
                onClick={() => setDigit(d)}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
      )}

      {deskClosed && <div className="panel-error">{desk.reason ?? 'Live trading is paused.'}</div>}
      {inlineError && <div className="panel-error">{inlineError}</div>}

      {!user ? (
        <button className="btn btn-primary btn-block" onClick={() => openModal('login')}>
          Log in to trade
        </button>
      ) : isDigits ? (
        <div className="ou-actions">
          <button
            className="ou buy"
            disabled={blocked || !left}
            onClick={() => void submitTrade('BUY', isEvenOdd ? 'EVEN' : 'OVER')}
          >
            <span className="ou-main">{isEvenOdd ? 'Even' : 'Over ' + digit}</span>
            <span className="ou-pay tnum">
              {tradeBusy ? 'Placing…' : left ? usd(validStake * left.payoutRate) : '—'}
            </span>
            <small>{left ? left.payoutPctOfStake.toFixed(1) + '%' : ''}</small>
          </button>
          <button
            className="ou sell"
            disabled={blocked || !right}
            onClick={() => void submitTrade('BUY', isEvenOdd ? 'ODD' : 'UNDER')}
          >
            <span className="ou-main">{isEvenOdd ? 'Odd' : 'Under ' + digit}</span>
            <span className="ou-pay tnum">
              {tradeBusy ? 'Placing…' : right ? usd(validStake * right.payoutRate) : '—'}
            </span>
            <small>{right ? right.payoutPctOfStake.toFixed(1) + '%' : ''}</small>
          </button>
        </div>
      ) : (
        <div className="trade-actions">
          <button className="trade-btn buy" disabled={blocked} onClick={() => void submitTrade('BUY')}>
            <IconArrowUp size={17} />
            {tradeBusy === 'BUY' ? 'Placing…' : 'Buy'}
          </button>
          <button className="trade-btn sell" disabled={blocked} onClick={() => void submitTrade('SELL')}>
            <IconArrowDown size={17} />
            {tradeBusy === 'SELL' ? 'Placing…' : 'Sell'}
          </button>
        </div>
      )}

      <OpenPositions />
    </div>
  );
}
