import { env } from '../env.js';
import { normalCdf } from '../lib/stats.js';

/**
 * The digital product: win often and small, or lose the stake.
 *
 * The scaled product pays in proportion to how far price moved, which pins the
 * win rate below 50% — the spread has to be crossed before a position is worth
 * anything, and at zero spread it is exactly a coin flip. No amount of pricing
 * gets past that.
 *
 * This one is decided by a single comparison at expiry against a barrier fixed
 * when the position opened. Put the barrier below entry and most positions win;
 * how far below decides how often. The payout then falls out of the arithmetic:
 *
 *     payout = ((1 - winRate) - edge) / winRate
 *
 * At a 70% win rate and a 3% edge that is +38.6% of stake on a win against a
 * full stake on a loss. Expected result is -3% either way, identical to the
 * scaled product at the same edge. The house earns the same; only the shape of
 * the experience changes.
 *
 * ## The ceiling, stated where the code lives
 *
 * A higher win rate always costs payout, pound for pound. There is no setting
 * here that makes a trader better off overall — `expectedPerUnit` is -edge at
 * every win rate, and that is not a limitation of the implementation but what
 * "house edge" means. Anything claiming otherwise is a different product or a
 * false claim.
 */

/** Inverse normal CDF, by bisection. Accurate enough for a barrier placement. */
function inverseNormal(p: number): number {
  if (p <= 0) return -8;
  if (p >= 1) return 8;
  let lo = -8;
  let hi = 8;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (normalCdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export type DigitalQuote = {
  winRate: number;
  durationSec: number;
  entry: number;
  barrier: number;
  /** Profit on a win, as a fraction of stake. */
  payoutRate: number;
  /** What the trader gets back on a win, stake included. */
  payoutPerUnit: number;
  edge: number;
  expectedPerUnit: number;
  /** How far the barrier sits from entry, for display. */
  barrierMovePct: number;
  sigma: number;
};

/**
 * Prices one digital ticket.
 *
 * The barrier is placed from the instrument's own sigma, so a 70% ticket is a
 * 70% ticket on every market and every duration — the distance moves, the odds
 * do not. Nothing here reads a future price; it reads the volatility the
 * instrument is configured with, exactly as the scaled product's odds do.
 */
export function quoteDigital(params: {
  winRate: number;
  durationSec: number;
  price: number;
  sigma: number;
  edge: number;
  direction: 'BUY' | 'SELL';
  precision: number;
}): DigitalQuote {
  const winRate = Math.min(Math.max(params.winRate, 0.5), 0.95);
  const edge = Math.min(Math.max(params.edge, 0), 0.2);
  const sd = params.sigma * Math.sqrt(params.durationSec);

  // z is negative for a win rate above half: the barrier sits against the
  // direction of the bet, and price has to fall through it to lose.
  const z = inverseNormal(1 - winRate);
  const offset = z * sd;

  // BUY wins while price stays above its barrier; SELL while it stays below.
  const signed = params.direction === 'BUY' ? offset : -offset;
  const barrier = Number((params.price * (1 + signed)).toFixed(params.precision));

  const payoutRate = ((1 - winRate) - edge) / winRate;

  return {
    winRate,
    durationSec: params.durationSec,
    entry: params.price,
    barrier,
    payoutRate,
    payoutPerUnit: 1 + payoutRate,
    edge,
    // -edge at every win rate. This is the whole point and it is worth
    // returning explicitly so a caller cannot quote a better one by accident.
    expectedPerUnit: Number((-edge).toFixed(6)),
    barrierMovePct: Number((Math.abs(offset) * 100).toFixed(5)),
    sigma: params.sigma,
  };
}

/** The win rates offered on the ticket. */
export const DIGITAL_WIN_RATES = [0.6, 0.7, 0.8] as const;

/** The default, and the one the product is marketed on. */
export const DEFAULT_WIN_RATE = 0.7;

export function isOfferedWinRate(v: number): boolean {
  return (DIGITAL_WIN_RATES as readonly number[]).includes(v);
}

/** Whether digitals are open for business, so the product can be dark-launched. */
export function digitalsEnabled(): boolean {
  return env.digitalEnabled;
}

/** Never below this, so the house cannot end up running the product at cost. */
const MIN_EDGE = 0.005;

/**
 * The edge a digital is priced at for one trader.
 *
 * Held separately from the scaled product's because on a digital the edge is
 * visible: it comes straight off the payout the trader is quoted before they
 * commit. The scaled product can carry 11% because it sits inside the entry
 * price; the same 11% here turns a 70% ticket into a 27% payout against losing
 * the whole stake, which looks far worse than it is and gets the product
 * ignored. A product nobody takes earns nothing.
 *
 * A trading pass still applies when it beats this rate, so the pass stays worth
 * buying on both products. Floored either way — the house takes less on this
 * product, never nothing.
 */
export function digitalEdgeFor(promoEdge?: number | null): number {
  const base = Math.min(Math.max(env.digitalEdge, MIN_EDGE), 0.2);
  if (typeof promoEdge === 'number' && Number.isFinite(promoEdge) && promoEdge < base) {
    return Math.max(promoEdge, MIN_EDGE);
  }
  return base;
}
