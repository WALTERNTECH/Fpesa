import { createHash } from 'node:crypto';
import { env } from '../env.js';
import { getInstrument } from './instruments.js';
import { replayEpoch } from './synthetic.js';
import {
  ALLOWED_DURATIONS,
  applySpread,
  exitLevels,
  multiplierFor,
  unrealisedProfit,
} from './trading.js';
import { SandboxError } from './sandbox.js';

/**
 * Replay: re-run a real epoch of the live market, and ask what-if questions of it.
 *
 * ## Why this exists, and why it does not need the live seed shared
 *
 * The live platform publishes `sha256(seed)` before an epoch opens and the seed
 * itself once that epoch closes. That is the whole point of the commitment
 * scheme, and it means every finished epoch of the real market is already public
 * property: seed, opening price, sigma, drift and tick interval, all on
 * /api/fairness, all verifiable by anyone.
 *
 * So the three things replay is for are already reachable without handing this
 * service a running seed:
 *
 *   - *Replay a specific scenario.* A closed epoch's seed reproduces its ticks
 *     exactly. Not an approximation of that afternoon — that afternoon.
 *   - *Hold randomness constant and vary parameters.* Every tick's shock is
 *     `Box-Muller(HMAC(seed, "epoch:i"))`, which depends on the seed and nothing
 *     else. Change sigma, the edge or the multipliers and the same z-sequence
 *     drives the new path: identical shape, different amplitude. There is no
 *     cleaner way to isolate a variable than reusing the draws.
 *   - *Stress the extremes.* Amplifying shocks means changing sigma, which by
 *     definition is no longer the live market. A live seed buys nothing here.
 *
 * And replay does something a live feed cannot: run the same afternoon a hundred
 * times with different settings. Live only happens once.
 *
 * ## What it deliberately cannot do
 *
 * It reads only closed epochs, from the same public endpoint any trader can
 * open. The seed of a *running* epoch is not published, is not returned by any
 * endpoint, and nothing here asks for it. That is not an oversight to be tidied
 * up later: an operator holding the current seed holds the outcomes of positions
 * customers have live money on, which is the exact thing the published
 * commitment promises nobody holds. Replay works on history, where the promise
 * has already been kept and the seed has already been given away on purpose.
 */

type RevealedEpoch = {
  epoch: number;
  startPrice: number;
  seedHash: string;
  startedAt: number;
  endedAt: number | null;
  seed: string | null;
  tickMs: number;
  sigma: number;
  drift: number;
};

export type ReplayEpoch = {
  epoch: number;
  symbol: string;
  startPrice: number;
  seed: string;
  seedHash: string;
  startedAt: number;
  endedAt: number;
  tickMs: number;
  sigma: number;
  drift: number;
  /** sha256(seed) recomputed here and checked against the published hash. */
  verified: boolean;
};

/** Knobs. All default to the epoch's own live settings, so nothing changes. */
export type ReplayKnobs = {
  /** Multiplies sigma. 1 is the market as it happened; 5 is a five-sigma world. */
  shock: number;
  houseEdge: number;
  maxProfitMultiple: number;
  /** Multiplies every duration's position multiplier. */
  multiplierScale: number;
  /** Tick within the epoch at which a position is taken. */
  entryTick: number;
};

export type ReplayOutcome = {
  durationSec: number;
  direction: 'BUY' | 'SELL';
  multiplier: number;
  entryPrice: number;
  stopOutPrice: number;
  takeProfitPrice: number;
  exitPrice: number;
  profitPerUnit: number;
  reason: 'EXPIRY' | 'STOP_OUT' | 'TAKE_PROFIT';
  ticks: number;
};

const SOURCE = (env.sandbox.replaySource || 'https://www.fpesa.markets').replace(/\/+$/, '');
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; epochs: ReplayEpoch[] }>();

/**
 * Closed epochs of the live market, from its public fairness endpoint.
 *
 * Every seed is re-hashed here and compared with the commitment that was
 * published before its epoch opened. An epoch that fails that check is dropped
 * rather than replayed: a path built from an unverified seed is not the market
 * that traded, and silently studying the wrong one is worse than studying none.
 */
export async function fetchEpochs(symbol: string): Promise<{
  source: string;
  symbol: string;
  epochs: ReplayEpoch[];
}> {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return { source: SOURCE, symbol, epochs: hit.epochs };
  }

  const url = SOURCE + '/api/fairness?symbol=' + encodeURIComponent(symbol);
  let body: { symbol?: string; revealed?: RevealedEpoch[] };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) {
      throw new SandboxError(
        'SOURCE_UNAVAILABLE',
        'The live platform returned ' + res.status + ' for its fairness endpoint.',
        502
      );
    }
    body = (await res.json()) as typeof body;
  } catch (err) {
    if (err instanceof SandboxError) throw err;
    throw new SandboxError(
      'SOURCE_UNAVAILABLE',
      'Could not reach ' + SOURCE + ' to read its published epochs.',
      502
    );
  }

  const epochs: ReplayEpoch[] = (body.revealed ?? [])
    .filter((e): e is RevealedEpoch & { seed: string } => typeof e.seed === 'string' && !!e.endedAt)
    .map((e) => ({
      epoch: e.epoch,
      symbol: body.symbol ?? symbol,
      startPrice: e.startPrice,
      seed: e.seed,
      seedHash: e.seedHash,
      startedAt: e.startedAt,
      endedAt: e.endedAt!,
      tickMs: e.tickMs,
      sigma: e.sigma,
      drift: e.drift,
      verified: createHash('sha256').update(e.seed).digest('hex') === e.seedHash,
    }))
    .filter((e) => e.verified);

  cache.set(symbol, { at: Date.now(), epochs });
  return { source: SOURCE, symbol, epochs };
}

function findEpoch(epochs: ReplayEpoch[], epoch: number): ReplayEpoch {
  const found = epochs.find((e) => e.epoch === epoch);
  if (!found) {
    throw new SandboxError(
      'NO_SUCH_EPOCH',
      'Epoch ' + epoch + ' is not among the published closed epochs. Only closed ' +
      'ones carry a seed, and the live platform keeps about a day of them.',
      404
    );
  }
  return found;
}

/** Walks one position over a known path and reports where it closed. */
function resolveOn(
  path: number[],
  entryIndex: number,
  durationSec: number,
  direction: 'BUY' | 'SELL',
  multiplier: number,
  precision: number,
  knobs: Pick<ReplayKnobs, 'houseEdge' | 'maxProfitMultiple'>
): ReplayOutcome {
  // Entry is marked off the price standing at the entry tick, exactly as the
  // live book marks it when a position is opened.
  const mid = entryIndex === 0 ? path[0]! : path[entryIndex - 1]!;
  const entryPrice = applySpread(mid, direction, multiplier, precision, knobs.houseEdge);
  const { stopOut, takeProfit } = exitLevels(
    entryPrice,
    direction,
    multiplier,
    knobs.maxProfitMultiple,
    precision
  );

  const horizon = Math.round((durationSec * 1000) / 250);
  const last = Math.min(entryIndex + horizon, path.length);
  let exitPrice = path[last - 1] ?? mid;
  let reason: ReplayOutcome['reason'] = 'EXPIRY';
  let ticks = last - entryIndex;

  for (let i = entryIndex; i < last; i++) {
    const price = path[i]!;
    const hitStop = direction === 'BUY' ? price <= stopOut : price >= stopOut;
    const hitTarget = direction === 'BUY' ? price >= takeProfit : price <= takeProfit;
    if (!hitStop && !hitTarget) continue;
    exitPrice = price;
    reason = hitStop ? 'STOP_OUT' : 'TAKE_PROFIT';
    ticks = i - entryIndex + 1;
    break;
  }

  return {
    durationSec,
    direction,
    multiplier,
    entryPrice,
    stopOutPrice: stopOut,
    takeProfitPrice: takeProfit,
    exitPrice,
    profitPerUnit: unrealisedProfit(
      { stake: 1, multiplier, entryPrice, direction, maxProfit: knobs.maxProfitMultiple },
      exitPrice
    ),
    reason,
    ticks,
  };
}

/** Descriptive figures about a path, for comparing a shocked run with the real one. */
function describe(path: number[], startPrice: number): {
  low: number;
  high: number;
  close: number;
  rangePct: number;
  maxDrawdownPct: number;
  biggestTickMovePct: number;
} {
  let low = Infinity;
  let high = -Infinity;
  let peak = startPrice;
  let maxDrawdown = 0;
  let biggestTick = 0;
  let previous = startPrice;

  for (const price of path) {
    if (price < low) low = price;
    if (price > high) high = price;
    if (price > peak) peak = price;
    const drawdown = (peak - price) / peak;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    const move = Math.abs(price - previous) / previous;
    if (move > biggestTick) biggestTick = move;
    previous = price;
  }

  return {
    low: Number(low.toFixed(4)),
    high: Number(high.toFixed(4)),
    close: path[path.length - 1] ?? startPrice,
    rangePct: Number((((high - low) / startPrice) * 100).toFixed(4)),
    maxDrawdownPct: Number((maxDrawdown * 100).toFixed(4)),
    biggestTickMovePct: Number((biggestTick * 100).toFixed(4)),
  };
}

/**
 * The figure an operator actually wants out of a stress run: across every
 * moment in the epoch, the most a single position could have taken off the
 * book. Answers "if someone had opened the luckiest possible trade in that
 * window, how much would it have cost me" — which is the number the solvency
 * guard has to survive.
 */
function worstCase(
  path: number[],
  symbol: string,
  precision: number,
  knobs: ReplayKnobs
): { profitPerUnit: number; durationSec: number; direction: 'BUY' | 'SELL'; atTick: number } | null {
  let worst: {
    profitPerUnit: number;
    durationSec: number;
    direction: 'BUY' | 'SELL';
    atTick: number;
  } | null = null;

  // Every fourth tick — one second apart. Finer than that adds a great deal of
  // work to find essentially the same maximum, since a position opened 250ms
  // later is nearly the same position.
  for (let entry = 0; entry < path.length; entry += 4) {
    for (const durationSec of ALLOWED_DURATIONS) {
      const multiplier = Math.max(
        Math.round(multiplierFor(durationSec, symbol) * knobs.multiplierScale),
        1
      );
      for (const direction of ['BUY', 'SELL'] as const) {
        const o = resolveOn(path, entry, durationSec, direction, multiplier, precision, knobs);
        if (!worst || o.profitPerUnit > worst.profitPerUnit) {
          worst = {
            profitPerUnit: o.profitPerUnit,
            durationSec,
            direction,
            atTick: entry,
          };
        }
      }
    }
  }

  return worst;
}

export type ReplayResult = Awaited<ReturnType<typeof runReplay>>;

/**
 * Rebuilds one epoch and answers the what-if.
 *
 * Two paths come back. The baseline is the epoch exactly as it traded, at the
 * parameters the live platform used. The variant is the same seed — the same
 * draws, tick for tick — under whatever the knobs say. Comparing them is the
 * whole method: because the randomness is reused rather than redrawn, any
 * difference between the two is caused by the parameter that moved and by
 * nothing else.
 */
export async function runReplay(params: {
  symbol: string;
  epoch: number;
  knobs: Partial<ReplayKnobs>;
}): Promise<{
  epoch: ReplayEpoch;
  source: string;
  knobs: ReplayKnobs;
  tickMs: number;
  ticks: number;
  baseline: {
    path: number[];
    stats: ReturnType<typeof describe>;
    outcomes: ReplayOutcome[];
    worstCase: ReturnType<typeof worstCase>;
  };
  variant: {
    path: number[];
    stats: ReturnType<typeof describe>;
    outcomes: ReplayOutcome[];
    worstCase: ReturnType<typeof worstCase>;
    /** True when every knob is at its live value, so the two runs are identical. */
    isBaseline: boolean;
  };
}> {
  const { epochs, source } = await fetchEpochs(params.symbol);
  const record = findEpoch(epochs, params.epoch);
  const instrument = getInstrument(params.symbol);
  const precision = instrument?.precision ?? 2;
  const ticks = Math.max(Math.round(env.synth.epochMs / record.tickMs), 1);

  const knobs: ReplayKnobs = {
    shock: clamp(params.knobs.shock ?? 1, 0.01, 100),
    houseEdge: clamp(params.knobs.houseEdge ?? env.houseEdge, 0, 0.9),
    maxProfitMultiple: clamp(params.knobs.maxProfitMultiple ?? env.maxProfitMultiple, 0.1, 100),
    multiplierScale: clamp(params.knobs.multiplierScale ?? 1, 0.01, 100),
    entryTick: Math.floor(clamp(params.knobs.entryTick ?? 0, 0, ticks - 1)),
  };

  const build = (sigma: number): number[] =>
    replayEpoch({
      seed: record.seed,
      epoch: record.epoch,
      startPrice: record.startPrice,
      ticks,
      tickMs: record.tickMs,
      sigma,
      drift: record.drift,
    });

  const liveKnobs: ReplayKnobs = {
    shock: 1,
    houseEdge: env.houseEdge,
    maxProfitMultiple: env.maxProfitMultiple,
    multiplierScale: 1,
    entryTick: knobs.entryTick,
  };

  const basePath = build(record.sigma);
  const isBaseline =
    knobs.shock === 1 &&
    knobs.houseEdge === liveKnobs.houseEdge &&
    knobs.maxProfitMultiple === liveKnobs.maxProfitMultiple &&
    knobs.multiplierScale === 1;
  const variantPath = isBaseline ? basePath : build(record.sigma * knobs.shock);

  const outcomesFor = (path: number[], k: ReplayKnobs): ReplayOutcome[] => {
    const out: ReplayOutcome[] = [];
    for (const durationSec of ALLOWED_DURATIONS) {
      const multiplier = Math.max(
        Math.round(multiplierFor(durationSec, params.symbol) * k.multiplierScale),
        1
      );
      for (const direction of ['BUY', 'SELL'] as const) {
        out.push(
          resolveOn(path, k.entryTick, durationSec, direction, multiplier, precision, k)
        );
      }
    }
    return out;
  };

  return {
    epoch: record,
    source,
    knobs,
    tickMs: record.tickMs,
    ticks,
    baseline: {
      path: basePath,
      stats: describe(basePath, record.startPrice),
      outcomes: outcomesFor(basePath, liveKnobs),
      worstCase: worstCase(basePath, params.symbol, precision, liveKnobs),
    },
    variant: {
      path: variantPath,
      stats: describe(variantPath, record.startPrice),
      outcomes: outcomesFor(variantPath, knobs),
      worstCase: worstCase(variantPath, params.symbol, precision, knobs),
      isBaseline,
    },
  };
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(Math.max(n, lo), hi);
}
