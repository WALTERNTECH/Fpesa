import { useMemo } from 'react';
import { useApp } from '../store/app';
import { ksh, durationLabel } from '../lib/format';
import { OpenPositions } from './OpenPositions';
import { IconArrowDown, IconArrowUp } from './Icons';

export function TradePanel(): JSX.Element {
  const {
    user, config, accountMode, setAccountMode, balance, openModal,
    stake, setStake, duration, setDuration,
    tradeBusy, tradeError, setTradeError, stakeIssue, canTrade, submitTrade,
  } = useApp();

  const stakeAmount = Number(stake);
  const multiplier = config.multipliers?.[String(duration)] ?? 1000;
  const maxProfit = Number.isFinite(stakeAmount)
    ? stakeAmount * config.maxProfitMultiple
    : 0;
  // The move that would wipe the stake out, shown as a percentage because the
  // absolute price level depends on which side the trader takes.
  const wipeoutMovePct = useMemo(() => (1 / multiplier) * 100, [multiplier]);

  const quickAmounts = useMemo(() => {
    const options = [config.minStake, 200, 500, 1000, 5000, config.maxStake];
    return Array.from(new Set(options.filter((v) => v >= config.minStake && v <= config.maxStake)))
      .sort((a, b) => a - b)
      .slice(0, 4);
  }, [config.minStake, config.maxStake]);

  const inlineError = tradeError ?? stakeIssue;

  return (
    <div className="trade-panel">
      <div className="card">
        <div className="card-head">
          <div className="section-title">
            <span className="dot" />
            Trade XAU/USD
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
              <div className="value tnum">{user ? ksh(balance) : ksh(0)}</div>
            </div>
            <span className="tag">{accountMode === 'demo' ? 'Demo' : 'Live'}</span>
          </div>

          <div className="field">
            <div className="field-label">
              <span>Trade amount</span>
              <span className="hint">
                {ksh(config.minStake, true)} – {ksh(config.maxStake, true)}
              </span>
            </div>
            <div className={'amount-input' + (stakeIssue ? ' invalid' : '')}>
              <span className="cur">KSh</span>
              <input
                type="number"
                inputMode="numeric"
                value={stake}
                min={config.minStake}
                max={config.maxStake}
                step={10}
                onChange={(e) => {
                  setStake(e.target.value);
                  setTradeError(null);
                }}
                aria-label="Trade amount in Kenyan shillings"
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
                  {value >= 1000 ? value / 1000 + 'K' : value}
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

          {/* Proportional outcome, so the panel states the terms rather than a
              single payout figure: how the move is scaled, the most that can
              be won, and the most that can be lost. */}
          <div className="terms">
            <div className="term">
              <span className="k">Position size</span>
              <span className="v tnum">×{multiplier.toLocaleString('en-KE')}</span>
            </div>
            <div className="term">
              <span className="k">Max profit</span>
              <span className="v tnum up">{ksh(maxProfit)}</span>
            </div>
            <div className="term">
              <span className="k">Closes itself if price moves</span>
              <span className="v tnum down">
                {wipeoutMovePct.toFixed(3)}% against you
              </span>
            </div>
          </div>

          {/* Hidden on phones, where the sticky bar carries these instead so the
              chart stays on screen while the trade is placed. */}
          <div className="trade-actions">
            <button
              className="trade-btn buy"
              disabled={tradeBusy !== null || (Boolean(user) && !canTrade)}
              onClick={() => void submitTrade('BUY')}
            >
              <IconArrowUp size={17} />
              {tradeBusy === 'BUY' ? 'Placing…' : 'Buy'}
              <small>Price goes up</small>
            </button>
            <button
              className="trade-btn sell"
              disabled={tradeBusy !== null || (Boolean(user) && !canTrade)}
              onClick={() => void submitTrade('SELL')}
            >
              <IconArrowDown size={17} />
              {tradeBusy === 'SELL' ? 'Placing…' : 'Sell'}
              <small>Price goes down</small>
            </button>
          </div>

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
