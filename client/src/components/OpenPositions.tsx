import { useEffect, useState } from 'react';
import { useApp } from '../store/app';
import { ksh, price as fmtPrice } from '../lib/format';
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
  const { openTrades, price } = useApp();
  const [now, setNow] = useState(() => Date.now());

  // Only run a clock while something is actually counting down.
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
          // Running result against the live tick: this is what the trader
          // watches while the countdown finishes.
          const winning =
            trade.direction === 'BUY' ? price > trade.entryPrice : price < trade.entryPrice;
          const level = price === trade.entryPrice;
          const projected = level ? 0 : winning ? trade.stake * trade.payoutRate : -trade.stake;
          const move = price - trade.entryPrice;

          return (
            <div
              key={trade.id}
              className={'position ' + (trade.direction === 'BUY' ? 'buy' : 'sell')}
            >
              <Countdown trade={trade} now={now} />

              <div className="meta">
                <div className="dir">{trade.direction === 'BUY' ? 'Buy' : 'Sell'}</div>
                <div className="stake tnum">{ksh(trade.stake)}</div>
                <div className="entry tnum">
                  Entry {fmtPrice(trade.entryPrice)} · Now {fmtPrice(price)} (
                  {move >= 0 ? '+' : '−'}
                  {Math.abs(move).toFixed(2)})
                </div>
              </div>

              <div
                className={
                  'pnl tnum ' + (level ? '' : winning ? 'win' : 'lose')
                }
              >
                {level ? '—' : (projected > 0 ? '+' : '−') + ksh(Math.abs(projected))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
