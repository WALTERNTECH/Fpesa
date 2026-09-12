import { useMemo } from 'react';
import { useApp } from '../store/app';
import { usd, durationLabel, price as fmtPrice } from '../lib/format';
import { OpenPositions } from './OpenPositions';
import { IconArrowDown, IconArrowUp } from './Icons';

export function TradePanel(): JSX.Element {
  const {
    user, config, accountMode, setAccountMode, balance, openModal,
    stake, setStake, duration, setDuration,
    tradeBusy, tradeError, setTradeError, stakeIssue, canTrade, submitTrade, desk,
    run, startAuto, autoBusy, symbol, multiplier, stakeCeiling, toUsd, autoRunCount,
    tradeType, setTradeType, winRate, setWinRate, digitalQuote, digitalTerms,
  } = useApp();

  const isDigital = config.digitalEnabled && tradeType === 'DIGITAL';
  const stakeAmount = Number(stake);
  const maxProfit = Number.isFinite(stakeAmount)
    ? stakeAmount * config.maxProfitMultiple
    : 0;
  // The move that would wipe the stake out, shown as a percentage because the
  // absolute price level depends on which side the trader takes.
  const wipeoutMovePct = useMemo(() => (1 / multiplier) * 100, [multiplier]);
  // The spread this trader actually pays: their promo rate while one is
  // running, otherwise the platform's. Quoting the platform rate to someone on
  // a promo would understate what they get and overstate what they are charged.
  const effectiveEdge = user?.promoEdge ?? config.houseEdge;
  const onPromo = user?.promoEdge != null && user.promoEdge < config.houseEdge;
  // What the spread costs on this ticket, stated up front. The ticket is in
  // dollars, so this and maxProfit above are already dollars.
  const spreadCost = Number.isFinite(stakeAmount)
    ? stakeAmount * effectiveEdge
    : 0;

  const quickAmounts = useMemo(() => {
    // Four chips spanning the range, not four clustered at the floor. The old
    // ladder took the lowest four of a fixed list, which on a 50–150,000 range
    // topped out at 1,000 and left everything above it reachable only by typing.
    // Dollar figures now, and the ceiling converts because the book's limit
    // is held in shillings.
    const ceilingUsd = Math.floor(toUsd(stakeCeiling));
    const options = [config.minStakeUsd, 5, 25, ceilingUsd];
    return Array.from(
      new Set(options.filter((v) => v >= config.minStakeUsd && v <= ceilingUsd))
    ).sort((a, b) => a - b);
  }, [config.minStakeUsd, stakeCeiling, toUsd]);

  // What a winning digital pays, in dollars, at the chosen win rate.
  const digitalWin = digitalTerms && Number.isFinite(stakeAmount)
    ? stakeAmount * digitalTerms.payoutRate
    : 0;

  // Real trading is gated while the book is over its daily payout target.
  const deskClosed = accountMode === 'real' && !desk.open;
  const inlineError = tradeError ?? stakeIssue;

  return (
    <div className="trade-panel">
      <div className="card">
        <div className="card-head">
          <div className="section-title">
            <span className="dot" />
            Trade {symbol}
          </div>
          <span className="eyebrow">×{multiplier.toLocaleString('en-KE')}</span>
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
              <span>Trade amount</span>
              <span className="hint">
                {usd(config.minStakeUsd)} – {usd(toUsd(stakeCeiling))}
              </span>
            </div>
            <div className={'amount-input' + (stakeIssue ? ' invalid' : '')}>
              <span className="cur">$</span>
              {/* text + decimal rather than a number input: the number input has
                  focus and keyboard quirks on Android, and the bounds live in
                  the store anyway, where they are compared in shillings. */}
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={stake}
                onChange={(e) => {
                  setStake(e.target.value.replace(/[^0-9.]/g, ''));
                  setTradeError(null);
                }}
                aria-label="Trade amount in US dollars"
              />
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

          <div className="field">
            <div className="field-label">
              <span>Trade duration</span>
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

          {/* Two products, named by what the trader experiences rather than by
              the jargon: the choice is between win-often-small and
              win-rarely-big. They no longer carry the same edge — the digital
              is priced lower, because on that product the edge is subtracted
              from a payout the trader can see. */}
          {config.digitalEnabled && (
            <div className="field">
              <div className="field-label">
                <span>Payout style</span>
                <span className="hint">Pick how you get paid</span>
              </div>
              <div className="prod-switch" role="group" aria-label="Payout style">
                <button
                  type="button"
                  aria-pressed={!isDigital}
                  onClick={() => setTradeType('SCALED')}
                >
                  <b>Bigger wins</b>
                  <small>Less often · paid on the size of the move</small>
                </button>
                <button
                  type="button"
                  aria-pressed={isDigital}
                  onClick={() => setTradeType('DIGITAL')}
                >
                  <b>Smaller wins</b>
                  <small>More often · one fixed payout</small>
                </button>
              </div>
            </div>
          )}

          {isDigital && (
            <div className="field">
              <div className="field-label">
                <span>How often you win</span>
                <span className="hint">Higher odds pay less</span>
              </div>
              <div className="dur-grid" role="group" aria-label="Win rate">
                {(digitalQuote?.winRates ?? []).map((row) => (
                  <button
                    key={row.winRate}
                    type="button"
                    className="dur"
                    aria-pressed={winRate === row.winRate}
                    onClick={() => setWinRate(row.winRate)}
                  >
                    {row.winRatePct}%
                  </button>
                ))}
              </div>
            </div>
          )}

          {isDigital ? (
            /* Two rows, because that is the whole product: what a win pays and
               what a loss costs. The two barriers are on the Buy and Sell
               buttons, where the trader is looking when they pick a side, so
               repeating them here was noise. */
            <div className="terms">
              <div className="term">
                <span className="k">Win pays</span>
                <span className="v tnum up">
                  {digitalTerms
                    ? '+' + usd(digitalWin) + ' · ' + digitalTerms.payoutPctOfStake.toFixed(0) + '%'
                    : '—'}
                </span>
              </div>
              <div className="term">
                <span className="k">If it loses</span>
                <span className="v tnum down">{usd(stakeAmount || 0)}</span>
              </div>
            </div>
          ) : (
          /* Proportional outcome, so the panel states the terms rather than a
              single payout figure: how the move is scaled, the most that can
              be won, and the most that can be lost. */
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
              <span className="v tnum down">
                {wipeoutMovePct.toFixed(3)}% against you
              </span>
            </div>
            <div className="term">
              <span className="k">Spread (cost to open)</span>
              <span className="v tnum">
                {onPromo && (
                  <s className="was">{(config.houseEdge * 100).toFixed(1)}%</s>
                )}
                {usd(spreadCost)} · {(effectiveEdge * 100).toFixed(1)}%
              </span>
            </div>
          </div>
          )}

          {/* One line, because a wall of text reads as a disclaimer and gets
              skipped. It still has to do the honest work: winning most of the
              time is not the same as coming out ahead, and saying so plainly is
              what keeps "win 70 in 100" from being a false promise. Shorten the
              wording if you like; do not drop the second half. */}
          {isDigital && digitalTerms && (
            <p className="digital-note">
              Wins about <b>{digitalTerms.winRatePct} in 100</b> — more often, not more overall.
              Each trade still costs {Math.abs(digitalTerms.expectedPctOfStake).toFixed(0)}% on
              average.
            </p>
          )}

          {onPromo && user?.promoUntil && (
            <div className="promo-live">
              <b>{user.promoCode}</b> active — you pay{' '}
              {(effectiveEdge * 100).toFixed(1)}% instead of{' '}
              {(config.houseEdge * 100).toFixed(1)}% until{' '}
              {new Date(user.promoUntil).toLocaleString('en-KE', {
                hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short',
              })}
            </div>
          )}

          {/* Reads every market's realised volatility, picks the one where
              this duration is least likely to stop out, and opens the batch
              there. It chooses the market, not the side — the series is
              driftless, so the side stays a coin flip per leg.

              Scaled only, and hidden rather than disabled on the digital
              ticket: the scan ranks markets by stop-out odds, which a digital
              does not have, and the run places the scaled product. Leaving the
              button up would open a different product than the one selected. */}
          {!isDigital && (
            <button
              className="autotrade"
              disabled={autoBusy || tradeBusy !== null || deskClosed || (Boolean(user) && !canTrade)}
              onClick={() => void startAuto()}
            >
              <span className="at-main">AI Scanner</span>
              <span className="at-sub">Scans all {config.instruments.length} markets, then opens {autoRunCount} positions</span>
            </button>
          )}

          {run && run.status === 'RUNNING' && (
            <div className="at-live">
              <span>
                Position {Math.min(run.completedCount + 1, run.totalCount)} of {run.totalCount}
              </span>
              <b className={'tnum ' + (run.netProfit >= 0 ? 'up' : 'down')}>
                {run.netProfit >= 0 ? '+' : '−'}{usd(toUsd(Math.abs(run.netProfit)))}
              </b>
            </div>
          )}



          {/* Hidden on phones, where the sticky bar carries these instead so the
              chart stays on screen while the trade is placed. */}
          <div className="trade-actions">
            <button
              className="trade-btn buy"
              disabled={tradeBusy !== null || deskClosed || (Boolean(user) && !canTrade)}
              onClick={() => void submitTrade('BUY')}
            >
              <IconArrowUp size={17} />
              {tradeBusy === 'BUY' ? 'Placing…' : 'Buy'}
              <small>
                {isDigital && digitalTerms
                  ? 'Above ' + fmtPrice(digitalTerms.BUY.barrier)
                  : 'Price goes up'}
              </small>
            </button>
            <button
              className="trade-btn sell"
              disabled={tradeBusy !== null || deskClosed || (Boolean(user) && !canTrade)}
              onClick={() => void submitTrade('SELL')}
            >
              <IconArrowDown size={17} />
              {tradeBusy === 'SELL' ? 'Placing…' : 'Sell'}
              <small>
                {isDigital && digitalTerms
                  ? 'Below ' + fmtPrice(digitalTerms.SELL.barrier)
                  : 'Price goes down'}
              </small>
            </button>
          </div>

          {deskClosed && (
            <div className="panel-error">
              {desk.reason ?? 'Live trading is paused.'}
            </div>
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
