import { env } from '../env.js';
import { digitalEdgeFor } from './digital.js';
import { INSTRUMENTS } from './instruments.js';
import { db } from '../lib/db.js';

/**
 * Over/Under on the last digit.
 *
 * The trader picks a digit 0-9. `OVER n` wins when the last digit of the
 * closing quote is strictly greater than n; `UNDER n` when it is strictly less.
 * Landing exactly on the picked digit loses either way — that is what makes
 * Over 5 and Under 5 add to 90% rather than 100%, and it is where part of the
 * product's structure comes from.
 *
 * Because the digit is uniform, the probability is exact arithmetic rather than
 * a model: nine tenths for Over 0, one tenth for Over 8. Nothing is estimated,
 * so there is no volatility input and no barrier to place — the same ticket
 * prices identically on every market and every duration.
 *
 * The payout then follows from the same identity the digital uses:
 *
 *     payout = ((1 - p) - edge) / p
 *
 * which makes the expected result -edge at every digit. Picking a rarer digit
 * buys a bigger payout and nothing else.
 *
 * ## The uniformity this rests on
 *
 * Measured against the live price engine rather than assumed: across all five
 * instruments and every offered duration, each digit lands within a few
 * hundredths of a point of 10%, and the chi-square against uniform sits well
 * inside its 1% critical value. The engine moves price several ticks per step,
 * so the last digit turns over many times inside even a five-second contract.
 * If the engine's volatility or an instrument's precision ever changes enough
 * that a contract spans less than a full digit cycle, that stops being true and
 * these odds stop being honest — re-measure before changing either.
 */

export type DigitPick = 'OVER' | 'UNDER';

/** Over 9 and Under 0 can never win, so neither is offered. */
export function isOfferedDigit(pick: DigitPick, digit: number): boolean {
  if (!Number.isInteger(digit)) return false;
  return pick === 'OVER' ? digit >= 0 && digit <= 8 : digit >= 1 && digit <= 9;
}

/** Chance of winning: how many of the ten digits settle in the trader's favour. */
export function digitWinChance(pick: DigitPick, digit: number): number {
  return pick === 'OVER' ? (9 - digit) / 10 : digit / 10;
}

export type DigitQuote = {
  pick: DigitPick;
  digit: number;
  /** Chance of winning, as a fraction. Exact, not modelled. */
  winChance: number;
  winChancePct: number;
  /** Profit on a win, as a fraction of stake. */
  payoutRate: number;
  payoutPctOfStake: number;
  edge: number;
  /** Always -(edge). Returned so no caller can quote a better one by accident. */
  expectedPctOfStake: number;
};

export function quoteDigit(pick: DigitPick, digit: number, edge: number): DigitQuote {
  const winChance = digitWinChance(pick, digit);
  const payoutRate = ((1 - winChance) - edge) / winChance;
  return {
    pick,
    digit,
    winChance,
    winChancePct: Math.round(winChance * 100),
    payoutRate,
    payoutPctOfStake: Number((payoutRate * 100).toFixed(1)),
    edge,
    expectedPctOfStake: Number((-edge * 100).toFixed(2)),
  };
}

/** Every ticket on offer, both sides, priced for one trader. */
export function quoteAllDigits(promoEdge?: number | null): {
  edge: number;
  over: DigitQuote[];
  under: DigitQuote[];
} {
  // Same edge as the digital: on both products it is subtracted from a payout
  // the trader can see before committing, so it is priced the same way.
  const edge = digitalEdgeFor(promoEdge);
  const over: DigitQuote[] = [];
  const under: DigitQuote[] = [];
  for (let d = 0; d <= 9; d++) {
    if (isOfferedDigit('OVER', d)) over.push(quoteDigit('OVER', d, edge));
    if (isOfferedDigit('UNDER', d)) under.push(quoteDigit('UNDER', d, edge));
  }
  return { edge, over, under };
}

/** Whether Over/Under is open for business, so it can be dark-launched. */
export function digitsEnabled(): boolean {
  return env.digitsEnabled;
}

/**
 * Publishes each instrument's display precision to the database.
 *
 * Settlement reads the last digit at the precision the trader was shown, and
 * SQL has no way to know what that is. Writing it on every boot keeps the two
 * in step automatically: change an instrument's precision in the config and the
 * next deploy carries it, rather than leaving settlement reading a digit the
 * ticket never displayed. fpesa_place_trade refuses to open an Over/Under on a
 * symbol with no row here, so a failure to write is a closed product rather
 * than a mispaid one.
 */
export async function publishDigitPrecision(): Promise<void> {
  const rows = INSTRUMENTS.map((i) => ({
    symbol: i.symbol,
    price_precision: i.precision,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await db.from('instrument_digits').upsert(rows, { onConflict: 'symbol' });
  if (error) {
    console.error('[digits] could not publish precision, Over/Under stays closed:', error.message);
    return;
  }
  console.log(
    '[digits] precision published: ' +
      rows.map((r) => r.symbol + '@' + r.price_precision).join(' ')
  );
}
