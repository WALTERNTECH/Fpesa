import { useMemo } from 'react';
import { useApp } from '../store/app';
import { usd, durationLabel } from '../lib/format';
import { OpenPositions } from './OpenPositions';
import { IconArrowDown, IconArrowUp } from './Icons';

export function TradePanel(): JSX.Element {
  const {
    user, config, accountMode, setAccountMode, balance, openModal,
    stake, setStake, duration, setDuration,
    tradeBusy, tradeError, setTradeError, stakeIssue, canTrade, submitTrade, desk,
    run, startAuto, autoBusy, symbol, multiplier, stakeCeiling, toUsd, autoRunCount,
    digit, setDigit, digitsQuote,
  } = useApp();

  // Over/Under is the product. Everything else is the older ticket, kept for
  // as long as the scaled market is still offered.
  const isDigits = config.digitsEnabled;

  const stakeAmount = Number(stake);
  const validStake = Number.isFinite(stakeAmount) ? stakeAmount : 0;
  const ceilingUsd = Math.floor(toUsd(stakeCeiling));

  const maxProfit = validStake * config.maxProfitMultiple;
  const wipeoutMovePct = useMemo(() => (1 / multiplier) * 100, [multiplier]);
  const effectiveEdge = user?.promoEdge ?? config.houseEdge;
  const onPromo = user?.promoEdge != null && user.promoEdge < config.houseEdge;
  const spreadCost = validStake * effectiveEdge;

  const quickAmounts = useMemo(() => {
    const options = [config.minStakeUsd, 5, 25, ceilingUsd];
    return Array.from(
      new Set(options.filter((v) => v >= config.minStakeUsd && v <= ceilingUsd))
    ).sort((a, b) => a - b);
  }, [config.minStakeUsd, ceilingUsd]);

  /* Deriv's stake stepper. A round step rather than a percentage: a trader
     nudging a $1 ticket wants $2, not $1.10. */
  const stepStake = (by: number): void => {
    const next = Math.min(Math.max(validStake + by, config.minStakeUsd), ceilingUsd);
    setStake(String(Math.round(next * 100) / 100));
    setTradeError(null);
  };

  // Both sides of the picked digit, priced. Over 9 and Under 0 never win and
  // are not quoted, so the matching button simply has nothing to offer.
  const overTicket = digitsQuote?.over.find((t) => t.digit === digit) ?? null;
  const underTicket = digitsQuote?.under.find((t) => t.digit === digit) ?? null;

  const deskClosed = accountMode === 'real' && !desk.open;
  const inlineError = tradeError ?? stakeIssue;
  const blocked = tradeBusy !== null || deskClosed || (Boolean(user) && !canTrade);

  return (
    <div className="trade-panel">
      <div className="card">
        <div className="card-head">
          <div className="section-title">
            <span className="dot" />
            Trade {symbol}
          </div>
          {!isDigits && (
            <span className="eyebrow">×{multiplier.toLocaleString('en-KE')}</span>
          )}
        </div>

        <div className="card-body">
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
            <div className="dur-grid" role="group" aria-label="Trade duration">
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
            {/* Stepper either side of the amount, so the common adjustment is a
                tap rather than a keyboard on a phone. */}
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
            <div className="chip-row">
              {quickAmounts.map((value) => (
                <button
                  key={value}
                  type="button"
                  className="chip"
                  onClick={() => {
                    setStake(String(value));
                    setTradeError(null);
                  }}
                >
                  {value >= 1000 ? '$' + (value / 1000).toFixed(0) + 'K' : '$' + value}
                </button>
              ))}
            </div>
          </div>

          {isDigits ? (
            <>
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

              {/* Two buttons, not a toggle and a trade button. The side IS the
                  trade, and each carries the payout it would pay, because that
                  is the number the choice turns on. Over 9 and Under 0 can
                  never win, so at those digits one side has nothing to sell. */}
              <div className="ou-actions">
                <button
                  className="ou buy"
                  disabled={blocked || !overTicket}
                  onClick={() => void submitTrade('BUY', 'OVER')}
                >
                  <span className="ou-main">
                    <IconArrowUp size={16} />
                    Over {digit}
                  </span>
                  <span className="ou-pay tnum">
                    {tradeBusy
                      ? 'Placing…'
                      : overTicket
                      ? '+' + usd(validStake * overTicket.payoutRate)
                      : 'not offered'}
                  </span>
                  <small>
                    {overTicket ? overTicket.winChancePct + '% of ticks' : 'nothing is over 9'}
                  </small>
                </button>

                <button
                  className="ou sell"
                  disabled={blocked || !underTicket}
                  onClick={() => void submitTrade('BUY', 'UNDER')}
                >
                  <span className="ou-main">
                    <IconArrowDown size={16} />
                    Under {digit}
                  </span>
                  <span className="ou-pay tnum">
                    {tradeBusy
                      ? 'Placing…'
                      : underTicket
                      ? '+' + usd(validStake * underTicket.payoutRate)
                      : 'not offered'}
                  </span>
                  <small>
                    {underTicket ? underTicket.winChancePct + '% of ticks' : 'nothing is under 0'}
                  </small>
                </button>
              </div>

              {/* The appealing half is "wins 9 times in 10", so the half that
                  corrects it sits on the same card. Do not drop the last
                  sentence. */}
              <p className="digital-note">
                A loss costs the whole {usd(validStake)}. Landing exactly on {digit} loses
                either way, which is why the two sides add to 90% rather than 100%.
                Each trade costs{' '}
                {Math.abs(
                  (overTicket ?? underTicket)?.expectedPctOfStake ?? 0
                ).toFixed(0)}
                % of stake on average.
              </p>
            </>
          ) : (
            <>
              <div className="terms">
                <div className="term">
                  <span className="k">Position size</span>
                  <span className="v tnum">×{multiplier.toLocaleString('en-KE')}</span>
                </div>
                <div className="term">
                  <span className="k">Max profit</span>
                  <span className="v tnum up">{usd(maxProfit)}</span>
                </div>
                <div className="term">
                  <span className="k">Closes itself if price moves</span>
                  <span className="v tnum down">{wipeoutMovePct.toFixed(3)}% against you</span>
                </div>
                <div className="term">
                  <span className="k">Spread (cost to open)</span>
                  <span className="v tnum">
                    {onPromo && <s className="was">{(config.houseEdge * 100).toFixed(1)}%</s>}
                    {usd(spreadCost)} · {(effectiveEdge * 100).toFixed(1)}%
                  </span>
                </div>
              </div>

              <button
                className="autotrade"
                disabled={autoBusy || blocked}
                onClick={() => void startAuto()}
              >
                <span className="at-main">AI Scanner</span>
                <span className="at-sub">
                  Scans all {config.instruments.length} markets, then opens {autoRunCount} positions
                </span>
              </button>

              <div className="trade-actions">
                <button
                  className="trade-btn buy"
                  disabled={blocked}
                  onClick={() => void submitTrade('BUY')}
                >
                  <IconArrowUp size={17} />
                  {tradeBusy === 'BUY' ? 'Placing…' : 'Buy'}
                  <small>Price goes up</small>
                </button>
                <button
                  className="trade-btn sell"
                  disabled={blocked}
                  onClick={() => void submitTrade('SELL')}
                >
                  <IconArrowDown size={17} />
                  {tradeBusy === 'SELL' ? 'Placing…' : 'Sell'}
                  <small>Price goes down</small>
                </button>
              </div>
            </>
          )}

          {onPromo && user?.promoUntil && (
            <div className="promo-live">
              <b>{user.promoCode}</b> active — you pay {(effectiveEdge * 100).toFixed(1)}% instead
              of {(config.houseEdge * 100).toFixed(1)}% until{' '}
              {new Date(user.promoUntil).toLocaleString('en-KE', {
                hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short',
              })}
            </div>
          )}

          {run && run.status === 'RUNNING' && (
            <div className="at-live">
              <span>
                Position {Math.min(run.completedCount + 1, run.totalCount)} of {run.totalCount}
              </span>
              <b className={'tnum ' + (run.netProfit >= 0 ? 'up' : 'down')}>
                {run.netProfit >= 0 ? '+' : '−'}
                {usd(toUsd(Math.abs(run.netProfit)))}
              </b>
            </div>
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
        </div>
      </div>

      <OpenPositions />
    </div>
  );
}
