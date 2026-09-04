import { useMemo, useState } from 'react';
import { useApp } from '../store/app';
import { ApiError } from '../lib/api';
import { ksh, durationLabel } from '../lib/format';
import { OpenPositions } from './OpenPositions';
import { IconArrowDown, IconArrowUp } from './Icons';
import type { Direction } from '../lib/types';

export function TradePanel(): JSX.Element {
  const {
    user, config, accountMode, setAccountMode, balance,
    placeTrade, openModal, price,
  } = useApp();

  const [amount, setAmount] = useState<string>(String(config.minStake));
  const [duration, setDuration] = useState<number>(config.durations[1] ?? 10);
  const [busy, setBusy] = useState<Direction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stake = Number(amount);
  const stakeValid =
    Number.isFinite(stake) && stake >= config.minStake && stake <= config.maxStake;
  const affordable = !user || stake <= balance;
  const canTrade = stakeValid && affordable && price > 0;

  const payout = useMemo(
    () => (stakeValid ? stake * (1 + config.payoutRate) : 0),
    [stake, stakeValid, config.payoutRate]
  );

  const quickAmounts = useMemo(() => {
    const options = [config.minStake, 200, 500, 1000, 5000, config.maxStake];
    return Array.from(new Set(options.filter((v) => v >= config.minStake && v <= config.maxStake)))
      .sort((a, b) => a - b)
      .slice(0, 4);
  }, [config.minStake, config.maxStake]);

  const amountError = (): string | null => {
    if (amount === '') return null;
    if (!Number.isFinite(stake)) return 'Enter a valid amount.';
    if (stake < config.minStake) return 'Minimum trade is ' + ksh(config.minStake, true) + '.';
    if (stake > config.maxStake) return 'Maximum trade is ' + ksh(config.maxStake, true) + '.';
    if (!affordable) {
      return accountMode === 'demo'
        ? 'Demo balance is too low.'
        : 'Balance too low — deposit to continue.';
    }
    return null;
  };

  const onTrade = async (direction: Direction): Promise<void> => {
    if (!user) {
      openModal('register');
      return;
    }
    if (!canTrade || busy) return;

    setBusy(direction);
    setError(null);
    try {
      await placeTrade(direction, stake, duration);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not place the trade.');
    } finally {
      setBusy(null);
    }
  };

  const inlineError = error ?? amountError();

  return (
    <div className="trade-panel">
      <div className="card">
        <div className="card-head">
          <div className="section-title">
            <span className="dot" />
            Trade XAU/USD
          </div>
          <span className="eyebrow">{Math.round(config.payoutRate * 100)}% payout</span>
        </div>

        <div className="card-body">
          <div className="acct-switch" role="group" aria-label="Account type">
            <button
              onClick={() => setAccountMode('demo')}
              aria-pressed={accountMode === 'demo'}
            >
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
            <div
              className={
                'amount-input' + (amount !== '' && (!stakeValid || !affordable) ? ' invalid' : '')
              }
            >
              <span className="cur">KSh</span>
              <input
                type="number"
                inputMode="numeric"
                value={amount}
                min={config.minStake}
                max={config.maxStake}
                step={10}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setError(null);
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
                    setAmount(String(value));
                    setError(null);
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

          <div className="payout-row">
            <span className="k">If your prediction is right</span>
            <span className="v tnum">{ksh(payout)}</span>
          </div>

          <div className="trade-actions">
            <button
              className="trade-btn buy"
              disabled={busy !== null || (Boolean(user) && !canTrade)}
              onClick={() => void onTrade('BUY')}
            >
              <IconArrowUp size={17} />
              {busy === 'BUY' ? 'Placing…' : 'Buy'}
              <small>Price goes up</small>
            </button>
            <button
              className="trade-btn sell"
              disabled={busy !== null || (Boolean(user) && !canTrade)}
              onClick={() => void onTrade('SELL')}
            >
              <IconArrowDown size={17} />
              {busy === 'SELL' ? 'Placing…' : 'Sell'}
              <small>Price goes down</small>
            </button>
          </div>

          {inlineError && <div className="panel-error">{inlineError}</div>}

          {!user && (
            <p className="panel-note">
              Browsing as a guest — markets are live. Create a free account to trade.
            </p>
          )}
          {user && accountMode === 'real' && balance < config.minStake && (
            <button
              className="btn btn-primary btn-block"
              style={{ marginTop: 12 }}
              onClick={() => openModal('deposit')}
            >
              Deposit via M-Pesa
            </button>
          )}
          {user && accountMode === 'demo' && (
            <p className="panel-note">
              Practising with demo funds. Switch to Live to trade real money.
            </p>
          )}
        </div>
      </div>

      <OpenPositions />
    </div>
  );
}
