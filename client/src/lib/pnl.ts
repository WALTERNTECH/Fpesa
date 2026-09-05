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
  const move = (price - trade.entryPrice) / trade.entryPrice;
  const signed = trade.direction === 'BUY' ? move : -move;
  const raw = trade.stake * trade.multiplier * signed;
  const clamped = Math.min(Math.max(raw, -trade.stake), trade.maxProfit);
  return Math.round(clamped * 100) / 100;
}

/** How close the position is to being wiped out, as 0..1 of the stake. */
export function marginUsed(trade: Trade, price: number): number {
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
