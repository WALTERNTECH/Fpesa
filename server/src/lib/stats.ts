/** Abramowitz-Stegun 7.1.26. Accurate to ~7.5e-8, far past what is needed here. */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p =
    d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 +
      t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

export type TradeAnalysis = {
  stake: number;
  durationSec: number;
  multiplier: number;
  spreadCost: number;
  breakevenMovePct: number;
  typicalMovePct: number;
  stopOutMovePct: number;
  winProbability: number;
  stopOutProbability: number;
  expectedResult: number;
  maxProfit: number;
  maxLoss: number;
  /** Honest verdict on direction, which for this instrument is always "neither". */
  edge: 'none';
  notes: string[];
};

/**
 * Exact odds and costs for a proposed position.
 *
 * FPX100 is a driftless geometric random walk, which makes every one of these
 * closed-form rather than estimated — there is nothing to infer or learn, so
 * the honest analysis is arithmetic and it is exact.
 *
 * It reports no direction. Up and down are equally likely by construction, so
 * a Buy/Sell recommendation here would be a coin flip dressed as advice, sold
 * to someone about to risk real money against an 11% spread.
 */
export function analyseTrade(params: {
  stake: number;
  durationSec: number;
  multiplier: number;
  houseEdge: number;
  sigma: number;
  maxProfitMultiple: number;
}): TradeAnalysis {
  const { stake, durationSec, multiplier, houseEdge, sigma, maxProfitMultiple } = params;

  // Standard deviation of the fractional move over the holding period.
  const sd = sigma * Math.sqrt(durationSec);
  // The spread puts entry this far against the trader, so price must travel
  // that much in their favour before the position is worth anything.
  const breakeven = houseEdge / multiplier;
  // Distance to a wiped stake.
  const stopMove = 1 / multiplier;

  const winProbability = 1 - normalCdf(breakeven / sd);
  // Probability of touching the barrier at any point before expiry, not just
  // finishing beyond it — a position that dips through mid-way is already gone.
  const stopOutProbability = Math.min(2 * normalCdf(-stopMove / sd), 1);

  const notes: string[] = [
    'Up and down are equally likely on this instrument — it has no drift, so no ' +
      'indicator computed from past prices predicts direction.',
    'The spread is why the win probability sits below 50%: price has to move ' +
      (breakeven * 100).toFixed(4) + '% in your favour before you are level.',
  ];
  if (stopOutProbability > 0.02) {
    notes.push(
      'At this duration roughly ' + (stopOutProbability * 100).toFixed(1) +
        ' in 100 positions are wiped out before the timer ends.'
    );
  }

  return {
    stake,
    durationSec,
    multiplier,
    spreadCost: Math.round(stake * houseEdge * 100) / 100,
    breakevenMovePct: Number((breakeven * 100).toFixed(5)),
    typicalMovePct: Number((sd * 100).toFixed(5)),
    stopOutMovePct: Number((stopMove * 100).toFixed(5)),
    winProbability: Number((winProbability * 100).toFixed(1)),
    stopOutProbability: Number((stopOutProbability * 100).toFixed(2)),
    expectedResult: Math.round(-stake * houseEdge * 100) / 100,
    maxProfit: Math.round(stake * maxProfitMultiple * 100) / 100,
    maxLoss: stake,
    edge: 'none',
    notes,
  };
}

/**
 * The share of positions that finish profitable at a given spread.
 *
 * Quoted on a reference ticket, because a win rate is meaningless without
 * saying on what. The shape is the same on every instrument: the multipliers
 * are scaled by volatility so the barrier sits at a constant number of standard
 * deviations everywhere.
 *
 * It approaches 50% as the spread approaches zero and never passes it. That
 * ceiling is not a tuning choice — the series is driftless and symmetric, so
 * with no spread a position is a coin flip, and the gap below 50% is exactly
 * the operator's revenue. Any claim of a higher win rate is either a different
 * product or a lie.
 */
export function winRateAt(edge: number, multiplier: number, sigma: number, durationSec = 10): number {
  const sd = sigma * Math.sqrt(durationSec);
  if (sd <= 0 || multiplier <= 0) return 0.5;
  return 1 - normalCdf(edge / multiplier / sd);
}
