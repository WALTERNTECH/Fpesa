import { useMemo } from 'react';
import { useApp } from '../store/app';
import { usd, durationLabel } from '../lib/format';
import { OpenPositions } from './OpenPositions';
import { IconArrowDown, IconArrowUp } from './Icons';

/** The preset stakes on the ticket, in dollars. */
const PRESETS = [1, 5, 10, 25, 50, 100];

export function TradePanel(): JSX.Element {
  const {
    user, config, accountMode, setAccountMode, balance, openModal,
    stake, setStake, duration, setDuration,
    tradeBusy, tradeError, setTradeError, stakeIssue, canTrade, submitTrade, desk,
    symbol, multiplier, stakeCeiling, toUsd,
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

  // Both sides of whichever market is up, priced by the server.
  const left = isEvenOdd
    ? digitsQuote?.even ?? null
    : digitsQuote?.over.find((t) => t.digit === digit) ?? null;
  const right = isEvenOdd
    ? digitsQuote?.odd ?? null
    : digitsQuote?.under.find((t) => t.digit === digit) ?? null;

  const deskClosed = accountMode === 'real' && !desk.open;
  const inlineError = tradeError ?? stakeIssue;
  const blocked = tradeBusy !== null || deskClosed || (Boolean(user) && !canTrade);

  const place = (pick: 'EVEN' | 'ODD' | 'OVER' | 'UNDER'): void => {
    void submitTrade('BUY', pick);
  };

  return (
    <div className="trade-panel">
      <div className="card">
        <div className="card-body">
          {isDigits && (
            <div className="mkt-tabs" role="group" aria-label="Market">
              <button
                aria-pressed={isEvenOdd}
                onClick={() => setDigitMarket('EVEN_ODD')}
              >
                Even / Odd
              </button>
              <button
                aria-pressed={!isEvenOdd}
                onClick={() => setDigitMarket('OVER_UNDER')}
              >
                Over / Under
              </button>
            </div>
          )}

          <div className="acct-switch" role="group" aria-label="Account type">
            <button onClick={() => setAccountMode('demo')} aria-pressed={accountMode === 'demo'}>
              Demo
            </button>
            <button
              className="real"
              onClick={() => setAccountMode('real')}
              aria-pressed={accountMode === 'real'}
            >
              Live
            </button>
          </div>

          <div className="balance-row">
            <div>
              <div className="label">
                {accountMode === 'demo' ? 'Practice balance' : 'Tradeable balance'}
              </div>
              <div className="value tnum">{usd(user ? toUsd(balance) : 0)}</div>
            </div>
            <span className="tag">{accountMode === 'demo' ? 'Demo' : 'Live'}</span>
          </div>

          <div className="field">
            <div className="field-label">
              <span>Duration</span>
              <span className="hint">Settles automatically</span>
            </div>
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

          <div className="field">
            <div className="field-label">
              <span>Stake</span>
              <span className="hint">
                {usd(config.minStakeUsd)} – {usd(ceilingUsd)}
              </span>
            </div>
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

          {/* Over/Under needs a digit; Even/Odd does not — both halves carry the
              same odds, so there is nothing to pick. */}
          {isDigits && !isEvenOdd && (
            <div className="field">
              <div className="field-label">
                <span>Last digit</span>
                <span className="hint">Rarer digit pays more</span>
              </div>
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

          {isDigits ? (
            <div className="ou-actions">
              <button
                className="ou buy"
                disabled={blocked || !left}
                onClick={() => place(isEvenOdd ? 'EVEN' : 'OVER')}
              >
                <span className="ou-main">{isEvenOdd ? 'Even' : 'Over ' + digit}</span>
                <span className="ou-pay tnum">
                  {tradeBusy
                    ? 'Placing…'
                    : left
                    ? usd(validStake * left.payoutRate)
                    : 'not offered'}
                </span>
                <small>{left ? left.payoutPctOfStake.toFixed(1) + '% payout' : '—'}</small>
              </button>
              <button
                className="ou sell"
                disabled={blocked || !right}
                onClick={() => place(isEvenOdd ? 'ODD' : 'UNDER')}
              >
                <span className="ou-main">{isEvenOdd ? 'Odd' : 'Under ' + digit}</span>
                <span className="ou-pay tnum">
                  {tradeBusy
                    ? 'Placing…'
                    : right
                    ? usd(validStake * right.payoutRate)
                    : 'not offered'}
                </span>
                <small>{right ? right.payoutPctOfStake.toFixed(1) + '% payout' : '—'}</small>
              </button>
            </div>
          ) : (
            <div className="trade-actions">
              <button className="trade-btn buy" disabled={blocked} onClick={() => void submitTrade('BUY')}>
                <IconArrowUp size={17} />
                {tradeBusy === 'BUY' ? 'Placing…' : 'Buy'}
                <small>Price goes up</small>
              </button>
              <button className="trade-btn sell" disabled={blocked} onClick={() => void submitTrade('SELL')}>
                <IconArrowDown size={17} />
                {tradeBusy === 'SELL' ? 'Placing…' : 'Sell'}
                <small>Price goes down</small>
              </button>
            </div>
          )}

          {/* One line. A loss is the whole stake, and winning half the time at
              a payout under 100% is still a losing expectation — which is the
              part a trader has to be told rather than left to work out. */}
          {isDigits && (left ?? right) && (
            <p className="digital-note">
              A loss costs the whole {usd(validStake)}. Each trade costs{' '}
              {Math.abs((left ?? right)!.expectedPctOfStake).toFixed(0)}% of stake on average.
            </p>
          )}

          {deskClosed && (
            <div className="panel-error">{desk.reason ?? 'Live trading is paused.'}</div>
          )}
          {inlineError && <div className="panel-error">{inlineError}</div>}

          {!user && (
            <button
              className="btn btn-dark btn-block trade-login"
              onClick={() => openModal('login')}
            >
              Log in to trade
            </button>
          )}
          {user && accountMode === 'real' && balance < config.minStake && (
            <button
              className="btn btn-primary btn-block"
              style={{ marginTop: 12 }}
              onClick={() => openModal('deposit')}
            >
              Deposit
            </button>
          )}

          {!isDigits && (
            <div className="eyebrow" style={{ marginTop: 10 }}>
              {symbol} · ×{multiplier.toLocaleString('en-KE')}
            </div>
          )}
        </div>
      </div>

      <OpenPositions />
    </div>
  );
}
