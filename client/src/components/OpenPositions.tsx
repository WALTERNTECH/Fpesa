import { useEffect, useState } from 'react';
import { useApp } from '../store/app';
import { usd, price as fmtPrice } from '../lib/format';
import { marginUsed, unrealisedProfit } from '../lib/pnl';
import type { Trade } from '../lib/types';

const RADIUS = 17;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function Countdown({ trade, now }: { trade: Trade; now: number }): JSX.Element {
  const total = trade.durationSec * 1000;
  const expires = Date.parse(trade.expiresAt);
  const remaining = Math.max(expires - now, 0);
  const fraction = total > 0 ? remaining / total : 0;
  const seconds = Math.ceil(remaining / 1000);

  return (
    <div className="countdown" aria-label={seconds + ' seconds remaining'}>
      <svg width="42" height="42" viewBox="0 0 42 42">
        <circle className="track" cx="21" cy="21" r={RADIUS} fill="none" strokeWidth="3" />
        <circle
          className="fill"
          cx="21"
          cy="21"
          r={RADIUS}
          fill="none"
          strokeWidth="3"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
        />
      </svg>
      <span className="num tnum">{seconds}</span>
    </div>
  );
}

export function OpenPositions(): JSX.Element | null {
  const { openTrades, price, toUsd } = useApp();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (openTrades.length === 0) return;
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [openTrades.length]);

  if (openTrades.length === 0) return null;

  return (
    <div className="card positions">
      <div className="card-head">
        <div className="section-title">
          <span className="dot" />
          Open positions
        </div>
        <span className="eyebrow">{openTrades.length} live</span>
      </div>

      <div className="card-body" style={{ paddingTop: 12, paddingBottom: 12 }}>
        {openTrades.map((trade) => {
          const profit = unrealisedProfit(trade, price);
          const used = marginUsed(trade, price);
          const digital = trade.tradeType === 'DIGITAL';
          const winning = profit > 0;
          const flat = profit === 0;

          return (
            <div
              key={trade.id}
              className={'position ' + (trade.direction === 'BUY' ? 'buy' : 'sell')}
            >
              <Countdown trade={trade} now={now} />

              <div className="meta">
                <div className="dir">
                  {trade.direction === 'BUY' ? 'Buy' : 'Sell'}
                  {/* A digital has no position size — it pays one fixed amount —
                      so quoting ×1 beside it would only mislead. */}
                  {digital ? ' · fixed payout' : ' · ×' + trade.multiplier}
                </div>
                <div className="stake tnum">{usd(toUsd(trade.stake))}</div>
                <div className="entry tnum">
                  {fmtPrice(trade.entryPrice)} → {fmtPrice(price)}
                  {digital && trade.barrierPrice !== null && (
                    <>
                      {' '}
                      · needs {trade.direction === 'BUY' ? '>' : '<'}{' '}
                      {fmtPrice(trade.barrierPrice)}
                    </>
                  )}
                  {!digital && trade.stopOutPrice !== null && (
                    <> · out {fmtPrice(trade.stopOutPrice)}</>
                  )}
                </div>
                {/* How much of the stake the move has already eaten. Full bar
                    means the position is about to close itself. On a digital
                    there is no partial loss, so it reads empty or full. */}
                <div className="margin-bar" aria-hidden="true">
                  <i style={{ width: Math.round(used * 100) + '%' }} />
                </div>
              </div>

              <div className={'pnl tnum ' + (flat ? '' : winning ? 'win' : 'lose')}>
                {flat ? '—' : (winning ? '+' : '−') + usd(toUsd(Math.abs(profit)))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
