import { env } from '../env.js';

/**
 * The tradeable instruments.
 *
 * Five synthetic volatility indices, each a driftless geometric walk generated
 * from its own committed seed. They differ in exactly one property: how far
 * price travels per second. That single number is what makes V10 a slow crawl
 * and V100 a whipsaw, and it is the whole reason a trader would pick one over
 * another.
 *
 * ## Why the multipliers scale inversely with volatility
 *
 * A position's profit is `stake x multiplier x fractional move`, and the
 * stop-out sits where that loss equals the stake — a move of `1/multiplier`.
 * Hold the multiplier fixed across instruments and the products stop being
 * comparable: on V10 the price would never travel far enough to resolve
 * anything inside 5 seconds, and on V100 every position would stop out almost
 * immediately.
 *
 * So each instrument's multiplier is the base multiplier scaled by
 * `100 / volatility`. That makes the stop-out sit the same number of standard
 * deviations away on every instrument, at every duration:
 *
 *     stop-out distance in sigma = (1 / multiplier) / (sigma * sqrt(duration))
 *
 * which is invariant once multiplier and sigma move together. The odds of any
 * given outcome are therefore identical across all five — what changes is how
 * the chart *looks* and how it feels to read. That is an honest difference to
 * offer: the trader picks the tempo they can actually follow, not a market
 * with better odds hiding in it.
 */

export type Instrument = {
  symbol: string;
  name: string;
  /** Index number in the family — 10, 25, 50, 75, 100. */
  volatility: number;
  /** Fraction-of-price standard deviation per sqrt(second). */
  sigma: number;
  basePrice: number;
  /** Decimal places the instrument quotes to. */
  precision: number;
  /** Multiplier scale relative to the reference instrument. */
  multiplierScale: number;
};

/**
 * The reference instrument. TRADE_MULTIPLIERS is expressed against this one,
 * and every other instrument scales off it.
 */
export const REFERENCE_VOLATILITY = 100;
const REFERENCE_SIGMA = env.synth.sigma;

function build(
  volatility: number,
  basePrice: number,
  precision: number
): Instrument {
  const scale = volatility / REFERENCE_VOLATILITY;
  return {
    symbol: 'FPX' + volatility,
    name: 'Volatility ' + volatility + ' Index',
    volatility,
    sigma: REFERENCE_SIGMA * scale,
    basePrice,
    precision,
    // Inverse of the volatility scale: half the movement, twice the multiplier.
    multiplierScale: 1 / scale,
  };
}

/**
 * Base prices are deliberately unlike one another. Five charts that all start
 * at the same number look like one instrument drawn five times, and a trader
 * flicking between them should be able to tell instantly which one they are on.
 */
export const INSTRUMENTS: Instrument[] = [
  build(10, 6500, 3),
  build(25, 3200, 3),
  build(50, 1850, 2),
  build(75, 9400, 2),
  build(100, env.synth.basePrice, 2),
];

const BY_SYMBOL = new Map(INSTRUMENTS.map((i) => [i.symbol, i]));

/** The instrument a request means when it names none. */
export const DEFAULT_SYMBOL =
  BY_SYMBOL.has(env.symbol) ? env.symbol : INSTRUMENTS[INSTRUMENTS.length - 1]!.symbol;

export function getInstrument(symbol: string | undefined | null): Instrument | null {
  if (!symbol) return null;
  return BY_SYMBOL.get(symbol.toUpperCase()) ?? null;
}

/**
 * Resolves a symbol for code paths that must not fail on an unknown one —
 * settling a historical trade whose instrument has since been retired, for
 * instance. Prefer `getInstrument` and a 400 anywhere a client chose the value.
 */
export function instrumentOr(symbol: string | undefined | null, fallback = DEFAULT_SYMBOL): Instrument {
  return getInstrument(symbol) ?? BY_SYMBOL.get(fallback) ?? INSTRUMENTS[INSTRUMENTS.length - 1]!;
}

export function isTradeableSymbol(symbol: string): boolean {
  return BY_SYMBOL.has(symbol.toUpperCase());
}

export const SYMBOLS: string[] = INSTRUMENTS.map((i) => i.symbol);
