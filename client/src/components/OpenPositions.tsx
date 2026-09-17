import { useEffect, useState } from 'react';
import { useApp } from '../store/app';
import { usd, price as fmtPrice } from '../lib/format';
import { lastDigit, marginUsed, unrealisedProfit } from '../lib/pnl';
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
  const { openTrades, price, symbol, instruments, config, toUsd } = useApp();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (openTrades.length === 0) return;
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [openTrades.length]);

  if (openTrades.length === 0) return null;

  /**
   * The price and precision belonging to the position's OWN market.
   *
   * The socket streams only the selected market, so a position opened on one
   * and watched from another was being marked against the wrong instrument's
   * price entirely. The market switcher's slow poll covers those.
   */
  const marketOf = (s: string): { price: number; precision: number } => {
    const summary = instruments.find((i) => i.symbol === s);
    const fromConfig = config.instruments.find((i) => i.symbol === s);
    return {
      price: s === symbol ? price : (summary?.price ?? 0),
      precision: summary?.precision ?? fromConfig?.precision ?? 2,
    };
  };

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
          const market = marketOf(trade.symbol);
          const spot = market.price;
          const profit = unrealisedProfit(trade, spot, market.precision);
          const used = marginUsed(trade, spot, market.precision);
          const digital = trade.tradeType === 'DIGITAL';
          const overUnder =
            trade.tradeType === 'DIGITS_OVER' ? 'over'
            : trade.tradeType === 'DIGITS_UNDER' ? 'under'
            : null;
          // Every last-digit product, including Even and Odd, which used to
          // fall through to the scaled branch and show a multiplier that means
          // nothing on a ticket paying one fixed amount.
          const digitPick =
            overUnder ? overUnder + ' ' + (trade.barrierPrice ?? '')
            : trade.tradeType === 'DIGITS_EVEN' ? 'even'
            : trade.tradeType === 'DIGITS_ODD' ? 'odd'
            : null;
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
                  {/* A digit ticket has no side; the direction column carries a
                      placeholder, so naming it would be inventing a choice. */}
                  {digitPick ? 'Digit' : trade.direction === 'BUY' ? 'Buy' : 'Sell'}
                  {/* Neither a digit ticket nor a digital has a position size —
                      each pays one fixed amount — so quoting a multiplier
                      beside one would only mislead. */}
                  {digitPick
                    ? ' · ' + digitPick
                    : digital
                    ? ' · fixed payout'
                    : ' · ×' + trade.multiplier}
                </div>
                <div className="stake tnum">{usd(toUsd(trade.stake))}</div>
                <div className="entry tnum">
                  {fmtPrice(trade.entryPrice)} → {fmtPrice(spot)}
                  {/* The digit standing right now, which is what the figure on
                      the right is reading and what settles the ticket if the
                      market closes here. */}
                  {digitPick && spot > 0 && (
                    <> · digit {lastDigit(spot, market.precision)}</>
                  )}
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
