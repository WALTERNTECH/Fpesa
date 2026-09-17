import type { Direction, Trade } from './types';

/**
 * The four last-digit products.
 *
 * Listed in one place because they have to be treated alike everywhere and
 * were not: Even and Odd were missing from the running-profit and margin
 * checks, so they fell through to the scaled formula and showed a profit
 * swinging above and below zero on a ticket that pays one fixed amount.
 */
export function isDigitTrade(trade: Trade): boolean {
  return (
    trade.tradeType === 'DIGITS_OVER' ||
    trade.tradeType === 'DIGITS_UNDER' ||
    trade.tradeType === 'DIGITS_EVEN' ||
    trade.tradeType === 'DIGITS_ODD'
  );
}

/** The last digit of a price, at the precision the ticket settles on. */
export function lastDigit(price: number, precision: number): number {
  return Math.abs(Math.round(price * Math.pow(10, precision))) % 10;
}

/**
 * Whether a digit ticket would win if the market closed on this price.
 *
 * The same comparison `fpesa_settle_trade` makes, against the digit standing
 * right now instead of the one at expiry.
 */
export function digitWinningAt(trade: Trade, price: number, precision: number): boolean {
  const d = lastDigit(price, precision);
  switch (trade.tradeType) {
    case 'DIGITS_EVEN':
      return d % 2 === 0;
    case 'DIGITS_ODD':
      return d % 2 === 1;
    case 'DIGITS_OVER':
      return trade.barrierPrice !== null && d > trade.barrierPrice;
    case 'DIGITS_UNDER':
      return trade.barrierPrice !== null && d < trade.barrierPrice;
    default:
      return false;
  }
}

/**
 * Running profit on an open position.
 *
 * Mirrors `fpesa_settle_trade` exactly — same formula, same clamps — so the
 * number the trader watches while the countdown runs is the number they get
 * when it closes. If the two ever drift apart, the settlement side is the one
 * that decides money, and this display is the bug.
 */
export function unrealisedProfit(trade: Trade, price: number, precision: number): number {
  // A digital is not worth "some of" its payout part way through: at expiry it
  // is one comparison against the barrier, so the honest running figure is the
  // result it would settle at if it closed now. Running the scaled formula over
  // it would show a number that never gets paid.
  if (trade.tradeType === 'DIGITAL') {
    return digitalWinning(trade, price) ? trade.maxProfit : -trade.stake;
  }
  // A digit ticket is worth what it would pay if the market closed on the digit
  // standing right now — the same treatment a digital gets above.
  //
  // This is not a forecast and does not claim to be one: the next tick is
  // independent, so where the digit sits now says nothing about where it will
  // sit at expiry. It is the honest answer to "where do I stand", which is the
  // question an open position raises, and it moves as the digit moves rather
  // than sitting blank for the whole life of the ticket.
  if (isDigitTrade(trade)) {
    return digitWinningAt(trade, price, precision) ? trade.maxProfit : -trade.stake;
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
export function marginUsed(trade: Trade, price: number, precision: number): number {
  // A digital has no gradual wipeout — it is winning or it is losing the lot,
  // so the bar is empty or full rather than creeping across.
  if (trade.tradeType === 'DIGITAL') {
    return digitalWinning(trade, price) ? 0 : 1;
  }
  // Nothing is eaten away gradually on a digit ticket: like a digital it is
  // winning or it is losing the lot, so the bar is empty or full.
  if (isDigitTrade(trade)) return digitWinningAt(trade, price, precision) ? 0 : 1;
  const loss = Math.min(unrealisedProfit(trade, price, precision), 0);
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
