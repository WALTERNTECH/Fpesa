import { env } from '../env.js';
import { getInstrument } from './instruments.js';
import { analyseTrade, type TradeAnalysis } from '../lib/stats.js';
import { applySpread, exitLevels, multiplierFor } from './trading.js';
import { SandboxError } from './sandbox.js';

/**
 * Conformance: does the sandbox price a contract exactly the way production does?
 *
 * ## Why this, and not the live seed
 *
 * A contract proposal is made of six things, and the seed is not one of them:
 *
 *     entry      = mid x (1 +- houseEdge / multiplier)
 *     stop-out   = entry x (1 -+ 1 / multiplier)
 *     take-profit= entry x (1 +- maxProfitMultiple / multiplier)
 *     max profit = stake x maxProfitMultiple
 *     win odds   = 1 - CDF(breakeven / (sigma x sqrt(t)))
 *     stop odds  = 2 x CDF(-stopMove / (sigma x sqrt(t)))
 *
 * Inputs: the trader's stake and duration, the current mid, the multiplier, the
 * edge, sigma and the profit cap. Every one of those is published — mid on
 * /api/market/quote, multipliers and edge and cap on /api/market/config, sigma
 * on /api/fairness. The seed determines which path is *realised*; the margin is
 * a property of the *distribution*. Substituting the realisation for the
 * distribution does not make a margin more accurate, it replaces a margin with a
 * certainty, which is a different quantity and the one nobody quoting a contract
 * is entitled to.
 *
 * ## What this does instead, which is stronger
 *
 * It takes production's live price and production's published parameters, prices
 * the same ticket through the sandbox's own code, and diffs the result against
 * the numbers production itself publishes for that ticket on /api/market/analyse.
 * Field by field, to the last decimal.
 *
 * That is a better pre-flight check than any seed comparison, because it tests
 * the arithmetic rather than one sampled outcome. A seed would tell you what
 * happened once. This tells you whether the sandbox would quote a different
 * contract from production — which is the actual question.
 *
 * It reports two kinds of agreement separately, because they fail for different
 * reasons and want different fixes:
 *
 *   - arithmetic: fed production's parameters, does the sandbox's code produce
 *     production's answer? A mismatch means the code has drifted.
 *   - parameters: does the sandbox's own configuration match production's? A
 *     mismatch means the deployment has drifted, and the sandbox is faithfully
 *     pricing a different product.
 */

const SOURCE = (env.sandbox.replaySource || 'https://www.fpesa.markets').replace(/\/+$/, '');

type LiveConfig = {
  houseEdge: number;
  maxProfitMultiple: number;
  instruments: Array<{
    symbol: string;
    precision: number;
    multipliers: Record<string, number>;
  }>;
};

async function get<T>(path: string): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(SOURCE + path, { signal: ctrl.signal });
    if (!res.ok) {
      throw new SandboxError(
        'SOURCE_UNAVAILABLE',
        'The live platform returned ' + res.status + ' for ' + path + '.',
        502
      );
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof SandboxError) throw err;
    throw new SandboxError('SOURCE_UNAVAILABLE', 'Could not reach ' + SOURCE + '.', 502);
  } finally {
    clearTimeout(timer);
  }
}

type Cmp = { production: number; sandbox: number; delta: number; match: boolean };

/** Exact equality on the published figures; both sides round identically. */
function cmp(production: number, sandbox: number): Cmp {
  const delta = Number((sandbox - production).toFixed(8));
  return { production, sandbox, delta, match: delta === 0 };
}

export async function conform(params: {
  symbol: string;
  stake: number;
  durationSec: number;
}): Promise<{
  source: string;
  symbol: string;
  stake: number;
  durationSec: number;
  live: {
    price: number;
    precision: number;
    multiplier: number;
    houseEdge: number;
    maxProfitMultiple: number;
    sigma: number;
  };
  sandboxConfig: {
    multiplier: number;
    houseEdge: number;
    maxProfitMultiple: number;
    sigma: number;
  };
  parameters: Record<string, { production: number; sandbox: number; match: boolean }>;
  parametersMatch: boolean;
  proposal: {
    BUY: { entry: number; stopOut: number; takeProfit: number };
    SELL: { entry: number; stopOut: number; takeProfit: number };
    maxProfit: number;
    maxLoss: number;
  };
  margins: Record<string, Cmp>;
  arithmeticMatch: boolean;
}> {
  if (env.appMode !== 'sandbox') {
    throw new SandboxError('NOT_SANDBOX', 'Conformance runs only in the sandbox.', 404);
  }

  const [config, quote, analysis, fairness] = await Promise.all([
    get<LiveConfig>('/api/market/config'),
    get<{ price: number; precision: number }>(
      '/api/market/quote?symbol=' + encodeURIComponent(params.symbol)
    ),
    get<TradeAnalysis>(
      '/api/market/analyse?symbol=' + encodeURIComponent(params.symbol) +
      '&stake=' + params.stake + '&durationSec=' + params.durationSec
    ),
    get<{ parameters: { sigma: number } }>(
      '/api/fairness?symbol=' + encodeURIComponent(params.symbol)
    ),
  ]);

  const liveInstrument = config.instruments.find((i) => i.symbol === params.symbol);
  if (!liveInstrument) {
    throw new SandboxError('UNKNOWN_MARKET', 'Production does not list ' + params.symbol + '.', 404);
  }
  const liveMultiplier = liveInstrument.multipliers[String(params.durationSec)];
  if (liveMultiplier === undefined) {
    throw new SandboxError('VALIDATION', 'Production offers no ' + params.durationSec + 's ticket.');
  }

  const live = {
    price: quote.price,
    precision: liveInstrument.precision,
    multiplier: liveMultiplier,
    houseEdge: config.houseEdge,
    maxProfitMultiple: config.maxProfitMultiple,
    sigma: fairness.parameters.sigma,
  };

  // What this deployment would use if it were pricing the ticket itself.
  const local = getInstrument(params.symbol);
  const sandboxConfig = {
    multiplier: multiplierFor(params.durationSec, params.symbol),
    houseEdge: env.houseEdge,
    maxProfitMultiple: env.maxProfitMultiple,
    sigma: local?.sigma ?? 0,
  };

  const parameters: Record<string, { production: number; sandbox: number; match: boolean }> = {};
  for (const key of ['multiplier', 'houseEdge', 'maxProfitMultiple', 'sigma'] as const) {
    parameters[key] = {
      production: live[key],
      sandbox: sandboxConfig[key],
      match: live[key] === sandboxConfig[key],
    };
  }
  const parametersMatch = Object.values(parameters).every((p) => p.match);

  // Priced through the sandbox's own code, on production's parameters. Any
  // disagreement below is therefore the code, not the configuration.
  const levels = (direction: 'BUY' | 'SELL'): {
    entry: number;
    stopOut: number;
    takeProfit: number;
  } => {
    const entry = applySpread(
      live.price, direction, live.multiplier, live.precision, live.houseEdge
    );
    const { stopOut, takeProfit } = exitLevels(
      entry, direction, live.multiplier, live.maxProfitMultiple, live.precision
    );
    return { entry, stopOut, takeProfit };
  };

  const mine = analyseTrade({
    stake: params.stake,
    durationSec: params.durationSec,
    multiplier: live.multiplier,
    houseEdge: live.houseEdge,
    sigma: live.sigma,
    maxProfitMultiple: live.maxProfitMultiple,
  });

  const margins: Record<string, Cmp> = {
    multiplier: cmp(analysis.multiplier, mine.multiplier),
    spreadCost: cmp(analysis.spreadCost, mine.spreadCost),
    breakevenMovePct: cmp(analysis.breakevenMovePct, mine.breakevenMovePct),
    typicalMovePct: cmp(analysis.typicalMovePct, mine.typicalMovePct),
    stopOutMovePct: cmp(analysis.stopOutMovePct, mine.stopOutMovePct),
    winProbability: cmp(analysis.winProbability, mine.winProbability),
    stopOutProbability: cmp(analysis.stopOutProbability, mine.stopOutProbability),
    expectedResult: cmp(analysis.expectedResult, mine.expectedResult),
    maxProfit: cmp(analysis.maxProfit, mine.maxProfit),
    maxLoss: cmp(analysis.maxLoss, mine.maxLoss),
  };

  return {
    source: SOURCE,
    symbol: params.symbol,
    stake: params.stake,
    durationSec: params.durationSec,
    live,
    sandboxConfig,
    parameters,
    parametersMatch,
    proposal: {
      BUY: levels('BUY'),
      SELL: levels('SELL'),
      maxProfit: Math.round(params.stake * live.maxProfitMultiple * 100) / 100,
      maxLoss: params.stake,
    },
    margins,
    arithmeticMatch: Object.values(margins).every((m) => m.match),
  };
}
