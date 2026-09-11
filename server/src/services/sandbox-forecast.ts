import { env } from '../env.js';
import { getInstrument } from './instruments.js';
import { replayEpoch } from './synthetic.js';
import { normalCdf } from '../lib/stats.js';
import { ALLOWED_DURATIONS, applySpread, exitLevels, multiplierFor, unrealisedProfit } from './trading.js';
import { SandboxError } from './sandbox.js';
import { fetchEpochs } from './sandbox-replay.js';

/**
 * The legitimate forecast for the live market, and the measurement of what it
 * is worth.
 *
 * ## There is exactly one honest forecast, and this is it
 *
 * The instrument is a driftless geometric random walk. For such a process the
 * conditional distribution of any future price, given every price that has ever
 * occurred, depends on precisely two things: the price now, and sigma. That is
 * the Markov property, and it is not an approximation — it is how the series is
 * constructed, published in the algorithm on /api/fairness.
 *
 * So the best possible estimate of where price will be in 30 seconds is: where
 * it is now. Not as a shrug, as the answer. Any forecast whose centre line is
 * not flat is claiming information the process does not contain, and on a
 * driftless series that claim is always false.
 *
 * What a real forecast can give you, and what this produces, is the *shape of
 * the uncertainty*: how wide the distribution is at each horizon, and the
 * probability of touching each barrier before it expires. Those are genuine,
 * useful, and completely determined by price and sigma.
 *
 * ## "Even if it is a few seconds behind"
 *
 * A delayed copy of the path that actually occurred is not a forecast. Released
 * after the fact it is history — which is real, and is what replay does from the
 * seeds the platform publishes once an epoch closes. Released while the window
 * is still open it is foreknowledge with a lag, which is the same thing as
 * foreknowledge for any position shorter than the lag, and is what the
 * commitment scheme exists to promise nobody has.
 *
 * There is no third option in between, because the only thing a delay changes
 * is whether the information is still actionable.
 *
 * ## Which is a claim, so it gets measured
 *
 * `audit` does not assert that the series is unpredictable. It takes the real
 * published history of the live market — thousands of actual ticks, rebuilt from
 * the seeds the platform released — and tests it: autocorrelation at a range of
 * lags, variance ratios, whether an up-tick predicts an up-tick, and whether
 * momentum or mean-reversion strategies make money after the spread. If any
 * structure existed, that is where it would show up.
 */

type Forecast = {
  durationSec: number;
  horizonSec: number;
  /** The martingale estimate. Equal to spot, which is the content of the result. */
  centre: number;
  sdPct: number;
  band68: { low: number; high: number };
  band95: { low: number; high: number };
  multiplier: number;
  BUY: BarrierOdds;
  SELL: BarrierOdds;
};

type BarrierOdds = {
  entry: number;
  stopOut: number;
  takeProfit: number;
  /** Touched at any point before expiry, not merely finished beyond. */
  stopOutProbability: number;
  takeProfitProbability: number;
  finishesUpProbability: number;
  expectedPerUnit: number;
};

/** Probability a driftless walk touches a barrier `d` away (fraction) within t. */
function touchProbability(distance: number, sd: number): number {
  if (sd <= 0) return 0;
  return Math.min(2 * normalCdf(-Math.abs(distance) / sd), 1);
}

export function forecast(symbol: string, price: number, sigma: number): {
  symbol: string;
  spot: number;
  sigma: number;
  note: string;
  horizons: Forecast[];
} {
  const precision = getInstrument(symbol)?.precision ?? 2;

  const horizons = ALLOWED_DURATIONS.map((durationSec): Forecast => {
    const sd = sigma * Math.sqrt(durationSec);
    const multiplier = multiplierFor(durationSec, symbol);

    const side = (direction: 'BUY' | 'SELL'): BarrierOdds => {
      const entry = applySpread(price, direction, multiplier, precision);
      const { stopOut, takeProfit } = exitLevels(
        entry, direction, multiplier, env.maxProfitMultiple, precision
      );
      const stopDistance = Math.abs(stopOut - entry) / entry;
      const targetDistance = Math.abs(takeProfit - entry) / entry;
      // Entry sits against the trader by edge/multiplier, so "finishes up" is
      // the chance of clearing that offset — always under half.
      const breakeven = env.houseEdge / multiplier;
      return {
        entry,
        stopOut,
        takeProfit,
        stopOutProbability: Number((touchProbability(stopDistance, sd) * 100).toFixed(3)),
        takeProfitProbability: Number((touchProbability(targetDistance, sd) * 100).toFixed(3)),
        finishesUpProbability: Number(((1 - normalCdf(breakeven / sd)) * 100).toFixed(2)),
        // Exactly the disclosed spread, at every duration and on every side.
        expectedPerUnit: Number((-env.houseEdge).toFixed(6)),
      };
    };

    return {
      durationSec,
      horizonSec: durationSec,
      centre: price,
      sdPct: Number((sd * 100).toFixed(5)),
      band68: {
        low: Number((price * Math.exp(-sd)).toFixed(precision)),
        high: Number((price * Math.exp(sd)).toFixed(precision)),
      },
      band95: {
        low: Number((price * Math.exp(-1.96 * sd)).toFixed(precision)),
        high: Number((price * Math.exp(1.96 * sd)).toFixed(precision)),
      },
      multiplier,
      BUY: side('BUY'),
      SELL: side('SELL'),
    };
  });

  return {
    symbol,
    spot: price,
    sigma,
    note:
      'The centre line is flat because the best estimate of a driftless walk at ' +
      'any horizon is its current value. That is the forecast, not a refusal to ' +
      'make one — a sloped centre line would be claiming information the process ' +
      'does not contain.',
    horizons,
  };
}

// ----------------------------------------------------------------- audit

export type Audit = Awaited<ReturnType<typeof audit>>;

/**
 * Tests the live market's real published history for anything a forecast could
 * stand on.
 *
 * Every tick here actually traded: rebuilt from the seeds the platform released
 * when each epoch closed, each one verified against the commitment published
 * before that epoch opened.
 */
export async function audit(symbol: string): Promise<{
  symbol: string;
  source: string;
  epochs: number;
  ticks: number;
  from: number;
  to: number;
  returns: { meanPct: number; sdPct: number };
  autocorrelation: Array<{ lag: number; rho: number; se: number; significant: boolean }>;
  varianceRatio: Array<{ k: number; vr: number; z: number; consistentWithRandomWalk: boolean }>;
  signPersistence: {
    upAfterUp: number;
    upAfterDown: number;
    samples: number;
    edgePct: number;
    significant: boolean;
  };
  strategies: Array<{
    name: string;
    durationSec: number;
    trades: number;
    winRate: number;
    netPerUnitStaked: number;
    netPct: number;
  }>;
  tests: number;
  flags: number;
  expectedByChance: number;
  verdict: string;
}> {
  if (env.appMode !== 'sandbox') {
    throw new SandboxError('NOT_SANDBOX', 'The audit runs only in the sandbox.', 404);
  }

  const { epochs, source } = await fetchEpochs(symbol);
  if (epochs.length === 0) {
    throw new SandboxError('NO_HISTORY', 'No closed epochs are published yet.', 503);
  }

  // Oldest first, so the series is continuous across epoch boundaries.
  const ordered = [...epochs].sort((a, z) => a.startedAt - z.startedAt);
  const ticksPerEpoch = Math.max(Math.round(env.synth.epochMs / ordered[0]!.tickMs), 1);

  const prices: number[] = [];
  for (const e of ordered) {
    prices.push(
      ...replayEpoch({
        seed: e.seed,
        epoch: e.epoch,
        startPrice: e.startPrice,
        ticks: ticksPerEpoch,
        tickMs: e.tickMs,
        sigma: e.sigma,
        drift: e.drift,
      })
    );
  }

  const r: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1]! > 0 && prices[i]! > 0) r.push(Math.log(prices[i]! / prices[i - 1]!));
  }
  const n = r.length;
  const mean = r.reduce((s, v) => s + v, 0) / n;
  const variance = r.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);

  // --- autocorrelation -------------------------------------------------
  // Under a random walk each rho is ~N(0, 1/n), so 1.96/sqrt(n) is the bar.
  const se = 1 / Math.sqrt(n);
  const autocorrelation = [1, 2, 3, 4, 5, 10, 20, 40].map((lag) => {
    let cov = 0;
    for (let i = lag; i < n; i++) cov += (r[i]! - mean) * (r[i - lag]! - mean);
    cov /= n - lag;
    const rho = cov / variance;
    return {
      lag,
      rho: Number(rho.toFixed(5)),
      se: Number(se.toFixed(5)),
      significant: Math.abs(rho) > 1.96 * se,
    };
  });

  // --- variance ratio ---------------------------------------------------
  // Var(k-period) / (k x Var(1-period)). A random walk gives 1; momentum
  // pushes it above, mean reversion below.
  const varianceRatio = [2, 4, 8, 16, 32].map((k) => {
    const agg: number[] = [];
    for (let i = 0; i + k <= n; i += k) {
      let s = 0;
      for (let j = 0; j < k; j++) s += r[i + j]!;
      agg.push(s);
    }
    const m2 = agg.reduce((s, v) => s + v, 0) / agg.length;
    const v2 = agg.reduce((s, v) => s + (v - m2) ** 2, 0) / (agg.length - 1);
    const vr = v2 / (k * variance);
    // Lo-MacKinlay homoskedastic standard error.
    const seVr = Math.sqrt((2 * (2 * k - 1) * (k - 1)) / (3 * k * n));
    const z = (vr - 1) / seVr;
    return {
      k,
      vr: Number(vr.toFixed(4)),
      z: Number(z.toFixed(2)),
      consistentWithRandomWalk: Math.abs(z) < 1.96,
    };
  });

  // --- does an up tick predict an up tick? ------------------------------
  let upAfterUp = 0;
  let afterUp = 0;
  let upAfterDown = 0;
  let afterDown = 0;
  for (let i = 1; i < n; i++) {
    if (r[i - 1]! > 0) {
      afterUp += 1;
      if (r[i]! > 0) upAfterUp += 1;
    } else if (r[i - 1]! < 0) {
      afterDown += 1;
      if (r[i]! > 0) upAfterDown += 1;
    }
  }
  const pUp = afterUp ? upAfterUp / afterUp : 0;
  const pDown = afterDown ? upAfterDown / afterDown : 0;
  const edge = pUp - pDown;
  const seEdge = Math.sqrt(0.25 / Math.max(afterUp, 1) + 0.25 / Math.max(afterDown, 1));

  // --- do the obvious strategies make money? -----------------------------
  const precision = getInstrument(symbol)?.precision ?? 2;
  const strategies: Array<{
    name: string;
    durationSec: number;
    trades: number;
    winRate: number;
    netPerUnitStaked: number;
    netPct: number;
  }> = [];

  const run = (
    name: string,
    durationSec: number,
    pick: (i: number) => 'BUY' | 'SELL' | null
  ): void => {
    const multiplier = multiplierFor(durationSec, symbol);
    const horizon = Math.round((durationSec * 1000) / ordered[0]!.tickMs);
    let trades = 0;
    let wins = 0;
    let net = 0;
    // Every fourth tick: one second apart, plenty of independent samples
    // without re-testing what is essentially the same position.
    for (let i = 1; i + horizon < prices.length; i += 4) {
      const direction = pick(i);
      if (!direction) continue;
      const mid = prices[i]!;
      const entry = applySpread(mid, direction, multiplier, precision);
      const { stopOut, takeProfit } = exitLevels(
        entry, direction, multiplier, env.maxProfitMultiple, precision
      );
      let exit = prices[i + horizon]!;
      for (let j = i + 1; j <= i + horizon; j++) {
        const p = prices[j]!;
        const hitStop = direction === 'BUY' ? p <= stopOut : p >= stopOut;
        const hitTarget = direction === 'BUY' ? p >= takeProfit : p <= takeProfit;
        if (hitStop || hitTarget) {
          exit = p;
          break;
        }
      }
      const profit = unrealisedProfit(
        { stake: 1, multiplier, entryPrice: entry, direction, maxProfit: env.maxProfitMultiple },
        exit
      );
      trades += 1;
      if (profit > 0) wins += 1;
      net += profit;
    }
    strategies.push({
      name,
      durationSec,
      trades,
      winRate: trades ? Number(((wins / trades) * 100).toFixed(2)) : 0,
      netPerUnitStaked: Number((trades ? net / trades : 0).toFixed(5)),
      netPct: Number((trades ? (net / trades) * 100 : 0).toFixed(3)),
    });
  };

  for (const d of [5, 30] as const) {
    run('momentum (follow the last tick)', d, (i) =>
      prices[i]! > prices[i - 1]! ? 'BUY' : prices[i]! < prices[i - 1]! ? 'SELL' : null
    );
    run('reversion (fade the last tick)', d, (i) =>
      prices[i]! > prices[i - 1]! ? 'SELL' : prices[i]! < prices[i - 1]! ? 'BUY' : null
    );
    run('always buy', d, () => 'BUY');
  }

  // Multiple comparisons, stated rather than left to the reader. At a 5%
  // threshold roughly one test in twenty flags on random data, so the count of
  // flags only means something measured against how many tests were run.
  const tests = autocorrelation.length + varianceRatio.length + 1;
  const flags =
    autocorrelation.filter((a) => a.significant).length +
    varianceRatio.filter((v) => !v.consistentWithRandomWalk).length +
    (Math.abs(edge) > 1.96 * seEdge ? 1 : 0);
  const expectedByChance = Number((tests * 0.05).toFixed(1));
  const anySignal = flags > expectedByChance + 2;

  return {
    symbol,
    source,
    epochs: ordered.length,
    ticks: prices.length,
    from: ordered[0]!.startedAt,
    to: ordered[ordered.length - 1]!.endedAt,
    returns: {
      meanPct: Number((mean * 100).toFixed(7)),
      sdPct: Number((sd * 100).toFixed(7)),
    },
    autocorrelation,
    varianceRatio,
    signPersistence: {
      upAfterUp: Number((pUp * 100).toFixed(2)),
      upAfterDown: Number((pDown * 100).toFixed(2)),
      samples: afterUp + afterDown,
      edgePct: Number((edge * 100).toFixed(3)),
      significant: Math.abs(edge) > 1.96 * seEdge,
    },
    strategies,
    tests,
    flags,
    expectedByChance,
    verdict: anySignal
      ? flags + ' of ' + tests + ' tests flagged, against about ' + expectedByChance +
        ' expected by chance — more than noise would usually produce. Check which ' +
        'ones before trusting it, and require it to reproduce on another market ' +
        'and another window: all five instruments run the same generator, so ' +
        'anything structural appears on all of them, and anything appearing on ' +
        'one is a sample.'
      : flags + ' of ' + tests + ' tests flagged, against about ' + expectedByChance +
        ' expected by chance on random data — so nothing here needs explaining. ' +
        'Returns are uncorrelated at the lags tested, variance ratios sit at 1, ' +
        'an up tick does not predict an up tick, and every strategy loses about ' +
        'the spread, which is what a fair coin costs when you pay to flip it. ' +
        'There is nothing for a forecast of direction to stand on.',
  };
}
