import type { Direction, Trade } from './types';

/**
 * Running profit on an open position.
 *
 * Mirrors `fpesa_settle_trade` exactly — same formula, same clamps — so the
 * number the trader watches while the countdown runs is the number they get
 * when it closes. If the two ever drift apart, the settlement side is the one
 * that decides money, and this display is the bug.
 */
export function unrealisedProfit(trade: Trade, price: number): number {
  // A digital is not worth "some of" its payout part way through: at expiry it
  // is one comparison against the barrier, so the honest running figure is the
  // result it would settle at if it closed now. Running the scaled formula over
  // it would show a number that never gets paid.
  if (trade.tradeType === 'DIGITAL') {
    return digitalWinning(trade, price) ? trade.maxProfit : -trade.stake;
  }
  // Over/Under is decided by the CLOSING digit, so nothing about the current
  // price says anything about the outcome. Showing a running win or loss would
  // be inventing information — it is simply unresolved until it settles.
  if (trade.tradeType === 'DIGITS_OVER' || trade.tradeType === 'DIGITS_UNDER') {
    return 0;
  }
  const move = (price - trade.entryPrice) / trade.entryPrice;
  const signed = trade.direction === 'BUY' ? move : -move;
  const raw = trade.stake * trade.multiplier * signed;
  const clamped = Math.min(Math.max(raw, -trade.stake), trade.maxProfit);
  return Math.round(clamped * 100) / 100;
}

/**
 * Whether a digital is on the winning side of its barrier right now.
 *
 * Same comparison the settle function makes, including the strictness: landing
 * exactly on the barrier is a loss.
 */
export function digitalWinning(trade: Trade, price: number): boolean {
  if (trade.barrierPrice === null) return false;
  return trade.direction === 'BUY'
    ? price > trade.barrierPrice
    : price < trade.barrierPrice;
}

/** How close the position is to being wiped out, as 0..1 of the stake. */
export function marginUsed(trade: Trade, price: number): number {
  // A digital has no gradual wipeout — it is winning or it is losing the lot,
  // so the bar is empty or full rather than creeping across.
  if (trade.tradeType === 'DIGITAL') {
    return digitalWinning(trade, price) ? 0 : 1;
  }
  // Nothing is being eaten away on an Over/Under; it resolves in one step.
  if (trade.tradeType === 'DIGITS_OVER' || trade.tradeType === 'DIGITS_UNDER') {
    return 0;
  }
  const loss = Math.min(unrealisedProfit(trade, price), 0);
  return Math.min(Math.abs(loss) / trade.stake, 1);
}

/** Price at which the stake would be wiped out, for a not-yet-placed ticket. */
export function stopOutPreview(
  entry: number,
  direction: Direction,
  multiplier: number
): number {
  const sign = direction === 'BUY' ? 1 : -1;
  return Math.round(entry * (1 - sign / multiplier) * 100) / 100;
}
