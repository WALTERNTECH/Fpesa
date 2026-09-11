import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { env } from '../env.js';
import { INSTRUMENTS, type Instrument } from './instruments.js';
import { replayEpoch } from './synthetic.js';
import {
  ALLOWED_DURATIONS,
  applySpread,
  exitLevels,
  multiplierFor,
  unrealisedProfit,
} from './trading.js';

/**
 * The sandbox: a throwaway market with its seed on display.
 *
 * ## What it is for
 *
 * The price engine is deterministic — every tick is HMAC(seed, "epoch:index")
 * through a GBM step — and the published commitment scheme proves outcomes were
 * not *altered* after the fact. What it cannot do is stop them being *known* by
 * whoever holds the live seed, a limit stated plainly at the top of
 * synthetic.ts. This service is that limit put on a screen, so it can be
 * inspected directly instead of taken on trust: its own market, its own seeds,
 * every future tick visible, and the exact profit any position opened right now
 * would make.
 *
 * ## Why it shares nothing with the live market
 *
 * This market is built here, from seeds this process generates at boot. It does
 * not read the live price feed, does not hold a reference to a live engine, and
 * there is no method anywhere that will hand out a running engine's seed — the
 * production engine is untouched by this file. The only piece of live code used
 * is `replayEpoch`, which was already exported as a pure function so that the
 * public verification script and the server could not drift apart, and which
 * tells you nothing unless you already hold the seed you pass it.
 *
 * That matters more than the mode guards: a sandbox built by reaching into the
 * live engine would be one line away from pointing at the live market. A sandbox
 * that generates its own seed cannot be repointed at all, because the live seed
 * is not on offer to anything.
 *
 * Same code, different random numbers — two dice from one factory. Nothing
 * learned here transfers, because there is nothing to learn: the path is random,
 * and the only reason it is knowable in advance is that the secret is being
 * handed over on purpose.
 *
 * ## Why the exposure is safe here and nowhere else
 *
 * Nothing in this market is real. There is no database, so no account, balance
 * or trade outside this process exists or can be reached. There is no payment
 * provider, so no money can move. Balances are numbers in a Map that die with
 * the process, and `assertSandboxIsolated()` refuses to boot the service if a
 * database or payment credential is so much as present in its environment.
 *
 * The same screen pointed at the live market would be fraud: the operator would
 * hold the outcomes of positions real customers have staked real money against,
 * while the site publishes a commitment promising nobody does.
 */

const TICK_MS = 250;

export class SandboxError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

function refuseOutsideSandbox(): void {
  if (env.appMode !== 'sandbox') {
    // Defence in depth. The routes are only mounted in sandbox mode, so this
    // should be unreachable — which is exactly why it is worth asserting: an
    // unreachable guard costs nothing and a reachable one would be a disaster.
    throw new SandboxError(
      'NOT_SANDBOX',
      'The sandbox is only available in sandbox mode.',
      404
    );
  }
}

/**
 * One instrument's worth of throwaway market.
 *
 * The whole epoch is computed up front rather than a tick at a time, because the
 * point of this service is that the path is already decided — pretending to
 * discover it on a timer would be theatre. Price "now" is just an index into
 * that array, derived from the clock.
 */
class SandboxInstrument {
  private seed = '';
  private nextSeed = '';
  private epoch = 0;
  private startedAt = 0;
  private startPrice: number;
  /** The current epoch, tick 1..ticksPerEpoch. */
  private path: number[] = [];
  /** The epoch after it, so a 60s position never runs off the end. */
  private nextPath: number[] = [];

  readonly ticksPerEpoch: number;

  constructor(readonly instrument: Instrument) {
    this.startPrice = instrument.basePrice;
    this.ticksPerEpoch = Math.max(Math.round(env.synth.epochMs / TICK_MS), 1);
    this.nextSeed = randomBytes(32).toString('hex');
    this.startedAt = Date.now();
    this.rotate();
  }

  private compute(seed: string, epoch: number, startPrice: number): number[] {
    return replayEpoch({
      seed,
      epoch,
      startPrice,
      ticks: this.ticksPerEpoch,
      tickMs: TICK_MS,
      sigma: this.instrument.sigma,
      drift: env.synth.drift,
    });
  }

  private rotate(): void {
    this.epoch += 1;
    this.seed = this.nextSeed;
    this.nextSeed = randomBytes(32).toString('hex');
    this.path = this.compute(this.seed, this.epoch, this.startPrice);
    this.nextPath = this.compute(
      this.nextSeed,
      this.epoch + 1,
      this.path[this.path.length - 1] ?? this.startPrice
    );
  }

  /** Advances whole epochs if the clock has moved past them. */
  private sync(): void {
    while (Date.now() - this.startedAt >= this.ticksPerEpoch * TICK_MS) {
      this.startedAt += this.ticksPerEpoch * TICK_MS;
      this.startPrice = this.path[this.path.length - 1] ?? this.startPrice;
      this.rotate();
    }
  }

  /** Ticks elapsed in the current epoch. 0 means the epoch has just opened. */
  tickIndex(): number {
    this.sync();
    return Math.floor((Date.now() - this.startedAt) / TICK_MS);
  }

  /** Price after `k` ticks of the current epoch, spanning into the next one. */
  priceAtTick(k: number): number {
    if (k <= 0) return this.startPrice;
    if (k <= this.path.length) return this.path[k - 1]!;
    const into = k - this.path.length;
    return this.nextPath[into - 1] ?? this.nextPath[this.nextPath.length - 1] ?? this.startPrice;
  }

  price(): number {
    return this.priceAtTick(this.tickIndex());
  }

  /** Ticks already behind us, oldest first, for drawing the chart. */
  recent(count: number): Array<{ at: number; price: number }> {
    const now = this.tickIndex();
    const from = Math.max(now - count, 0);
    const out: Array<{ at: number; price: number }> = [];
    for (let k = from; k <= now; k++) {
      out.push({ at: this.startedAt + k * TICK_MS, price: this.priceAtTick(k) });
    }
    return out;
  }

  /** Ticks still to come, nearest first. This is the part that is the point. */
  future(count: number): Array<{ at: number; price: number }> {
    const now = this.tickIndex();
    const limit = this.path.length + this.nextPath.length;
    const out: Array<{ at: number; price: number }> = [];
    for (let k = now + 1; k <= Math.min(now + count, limit); k++) {
      out.push({ at: this.startedAt + k * TICK_MS, price: this.priceAtTick(k) });
    }
    return out;
  }

  /**
   * The seed, and the commitment that would have been published for it.
   *
   * Both are shown together deliberately: the hash is what a trader on the live
   * platform gets while an epoch is running, the seed is what they get once it
   * closes, and seeing them side by side is the clearest way to understand what
   * the commitment does and does not promise.
   */
  reveal(): {
    epoch: number;
    seed: string;
    seedHash: string;
    nextSeedHash: string;
    startPrice: number;
    startedAt: number;
    endsAt: number;
    tickIndex: number;
    ticksPerEpoch: number;
  } {
    const tickIndex = this.tickIndex();
    return {
      epoch: this.epoch,
      seed: this.seed,
      seedHash: createHash('sha256').update(this.seed).digest('hex'),
      nextSeedHash: createHash('sha256').update(this.nextSeed).digest('hex'),
      startPrice: this.startPrice,
      startedAt: this.startedAt,
      endsAt: this.startedAt + this.ticksPerEpoch * TICK_MS,
      tickIndex,
      ticksPerEpoch: this.ticksPerEpoch,
    };
  }
}

// --------------------------------------------------------------- the book

type Position = {
  id: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  stake: number;
  durationSec: number;
  multiplier: number;
  entryPrice: number;
  stopOutPrice: number;
  takeProfitPrice: number;
  maxProfit: number;
  openedAt: number;
  /** When the screen is allowed to show the outcome. */
  settlesAt: number;
  status: 'OPEN' | 'WON' | 'LOST';
  exitPrice: number | null;
  profit: number | null;
  closeReason: 'EXPIRY' | 'STOP_OUT' | 'TAKE_PROFIT' | null;
  /**
   * What the oracle said at the moment of opening, kept so the screen can show
   * the forecast beside the settled result. A forecast nobody can check against
   * what happened is just a claim.
   */
  predicted: { profit: number; reason: 'EXPIRY' | 'STOP_OUT' | 'TAKE_PROFIT' };
};

type Session = {
  id: string;
  balance: number;
  open: Map<string, Position>;
  closed: Position[];
  createdAt: number;
};

/** One outcome the oracle can see coming. */
export type Play = {
  durationSec: number;
  direction: 'BUY' | 'SELL';
  multiplier: number;
  entryPrice: number;
  stopOutPrice: number;
  takeProfitPrice: number;
  exitPrice: number;
  /** Per shilling staked, so durations and ticket sizes compare directly. */
  profitPerUnit: number;
  reason: 'EXPIRY' | 'STOP_OUT' | 'TAKE_PROFIT';
  /** Ticks from now until it closes. */
  ticks: number;
};

class SandboxBook {
  private markets = new Map<string, SandboxInstrument>();
  private sessions = new Map<string, Session>();

  start(): void {
    refuseOutsideSandbox();
    for (const instrument of INSTRUMENTS) {
      this.markets.set(instrument.symbol, new SandboxInstrument(instrument));
    }
    console.log(
      '[sandbox] ' + this.markets.size + ' throwaway market(s) seeded in this process'
    );
  }

  stop(): void {
    this.markets.clear();
    this.sessions.clear();
  }

  private market(symbol: string): SandboxInstrument {
    const m = this.markets.get(symbol);
    if (!m) throw new SandboxError('UNKNOWN_MARKET', 'No such market.', 404);
    return m;
  }

  has(symbol: string): boolean {
    return this.markets.has(symbol);
  }

  defaultSymbol(): string {
    return INSTRUMENTS[0]!.symbol;
  }

  instruments(): Array<{ symbol: string; name: string; volatility: number; price: number }> {
    refuseOutsideSandbox();
    return [...this.markets.values()].map((m) => ({
      symbol: m.instrument.symbol,
      name: m.instrument.name,
      volatility: m.instrument.volatility,
      price: m.price(),
    }));
  }

  private session(id: string): Session {
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        id,
        balance: env.sandbox.startingBalance,
        open: new Map(),
        closed: [],
        createdAt: Date.now(),
      };
      this.sessions.set(id, s);
    }
    return s;
  }

  reset(id: string): Session {
    refuseOutsideSandbox();
    this.sessions.delete(id);
    return this.session(id);
  }

  /**
   * Reveals any position whose settlement time has passed.
   *
   * The outcome was computed when the position opened — it was already decided
   * by then, which is equally true on the live platform — so this only moves it
   * from open to closed and credits the balance. Called before every read and
   * write, so no timers are involved and a restart cannot strand anything.
   */
  private sweep(session: Session): void {
    const now = Date.now();
    for (const pos of [...session.open.values()]) {
      if (pos.settlesAt > now) continue;
      session.open.delete(pos.id);
      session.balance = round2(session.balance + pos.stake + (pos.profit ?? 0));
      session.closed.unshift(pos);
    }
    if (session.closed.length > 50) session.closed.length = 50;
  }

  /**
   * Opens a paper position.
   *
   * The arithmetic is imported, not reimplemented: applySpread, exitLevels and
   * unrealisedProfit are the same functions the real book settles against, and
   * the barrier scan below checks stop-out before take-profit in the same order
   * the live engine does. A sandbox that computed its own version of the maths
   * would be testing something other than the product.
   */
  open(
    sessionId: string,
    params: { symbol: string; direction: 'BUY' | 'SELL'; stake: number; durationSec: number }
  ): Position {
    refuseOutsideSandbox();
    const session = this.session(sessionId);
    this.sweep(session);

    if (!(ALLOWED_DURATIONS as readonly number[]).includes(params.durationSec)) {
      throw new SandboxError('VALIDATION', 'Choose an offered duration.');
    }
    if (!Number.isFinite(params.stake) || params.stake <= 0) {
      throw new SandboxError('VALIDATION', 'Enter a stake.');
    }
    if (params.stake > session.balance) {
      throw new SandboxError(
        'INSUFFICIENT',
        'Paper balance is ' + session.balance.toFixed(2) + '. Reset for a fresh ' +
        env.sandbox.startingBalance.toFixed(0) + '.'
      );
    }

    const play = this.resolve(params.symbol, params.durationSec, params.direction);
    const now = Date.now();
    const position: Position = {
      id: randomUUID(),
      symbol: params.symbol,
      direction: params.direction,
      stake: params.stake,
      durationSec: params.durationSec,
      multiplier: play.multiplier,
      entryPrice: play.entryPrice,
      stopOutPrice: play.stopOutPrice,
      takeProfitPrice: play.takeProfitPrice,
      maxProfit: round2(params.stake * env.maxProfitMultiple),
      openedAt: now,
      settlesAt: now + play.ticks * TICK_MS,
      status: 'OPEN',
      exitPrice: null,
      profit: null,
      closeReason: null,
      predicted: {
        profit: round2(play.profitPerUnit * params.stake),
        reason: play.reason,
      },
    };

    // Settled at open, because it genuinely is. Stored rather than shown until
    // settlesAt, so the screen still reads like a position being held.
    position.exitPrice = play.exitPrice;
    position.profit = round2(play.profitPerUnit * params.stake);
    position.closeReason = play.reason;
    position.status = position.profit >= 0 ? 'WON' : 'LOST';

    session.balance = round2(session.balance - params.stake);
    session.open.set(position.id, position);
    return position;
  }

  state(sessionId: string): {
    balance: number;
    startingBalance: number;
    open: Array<Omit<Position, 'exitPrice' | 'profit' | 'closeReason' | 'status'>>;
    closed: Position[];
    forecastAccuracy: { checked: number; matched: number } | null;
  } {
    refuseOutsideSandbox();
    const session = this.session(sessionId);
    this.sweep(session);

    return {
      balance: session.balance,
      startingBalance: env.sandbox.startingBalance,
      // The outcome is withheld from an open position on purpose. It is already
      // decided, but showing it before the clock runs out would make the screen
      // unreadable as a trading screen, and the closed list proves the point
      // just as well a few seconds later.
      open: [...session.open.values()].map((p) => {
        const { exitPrice: _e, profit: _p, closeReason: _c, status: _s, ...rest } = p;
        return rest;
      }),
      closed: session.closed,
      forecastAccuracy: session.closed.length
        ? {
            checked: session.closed.length,
            matched: session.closed.filter(
              (p) =>
                p.predicted.reason === p.closeReason &&
                Math.abs((p.profit ?? 0) - p.predicted.profit) <= 0.01
            ).length,
          }
        : null,
    };
  }

  /** What one duration and side would do, walked tick by tick over the known path. */
  private resolve(
    symbol: string,
    durationSec: number,
    direction: 'BUY' | 'SELL'
  ): Play {
    const market = this.market(symbol);
    const precision = market.instrument.precision;
    const multiplier = multiplierFor(durationSec, symbol);
    const mid = market.price();
    const entryPrice = applySpread(mid, direction, multiplier, precision);
    const { stopOut, takeProfit } = exitLevels(
      entryPrice,
      direction,
      multiplier,
      env.maxProfitMultiple,
      precision
    );

    const horizon = Math.round((durationSec * 1000) / TICK_MS);
    const path = market.future(horizon);
    let exitPrice = path.length ? path[path.length - 1]!.price : mid;
    let reason: Play['reason'] = 'EXPIRY';
    let ticks = horizon;

    for (let i = 0; i < path.length; i++) {
      const price = path[i]!.price;
      const hitStop = direction === 'BUY' ? price <= stopOut : price >= stopOut;
      const hitTarget = direction === 'BUY' ? price >= takeProfit : price <= takeProfit;
      if (!hitStop && !hitTarget) continue;
      exitPrice = price;
      reason = hitStop ? 'STOP_OUT' : 'TAKE_PROFIT';
      ticks = i + 1;
      break;
    }

    // Per unit of stake: profit is linear in stake, so one figure covers every
    // ticket size.
    const profitPerUnit = unrealisedProfit(
      { stake: 1, multiplier, entryPrice, direction, maxProfit: env.maxProfitMultiple },
      exitPrice
    );

    return {
      durationSec,
      direction,
      multiplier,
      entryPrice,
      stopOutPrice: stopOut,
      takeProfitPrice: takeProfit,
      exitPrice,
      profitPerUnit,
      reason,
      ticks,
    };
  }

  /** Every position that could be opened right now, and what each one does. */
  plays(symbol: string): Play[] {
    refuseOutsideSandbox();
    const out: Play[] = [];
    for (const durationSec of ALLOWED_DURATIONS) {
      for (const direction of ['BUY', 'SELL'] as const) {
        out.push(this.resolve(symbol, durationSec, direction));
      }
    }
    return out;
  }

  /**
   * Every market's next prices at once, for the operator dashboard.
   *
   * The per-symbol oracle carries the whole path and all ten plays, which is far
   * more than a five-row board needs. This is the same information thinned to
   * what a dashboard reads: where each market is now, where it will be at each
   * tradeable horizon, and the single best position available on it.
   *
   * Same restriction as everything else here — these are this process's own
   * markets. It predicts them perfectly because it generated them.
   */
  predictions(): Array<{
    symbol: string;
    name: string;
    volatility: number;
    price: number;
    tickMs: number;
    /** The next ticks, for a sparkline. */
    next: number[];
    /** Price at each tradeable horizon, and the move to get there. */
    horizons: Array<{ durationSec: number; price: number; movePct: number }>;
    best: Play | null;
  }> {
    refuseOutsideSandbox();
    return [...this.markets.values()].map((m) => {
      const symbol = m.instrument.symbol;
      const price = m.price();
      const future = m.future(Math.round((60 * 1000) / TICK_MS));
      const plays = this.plays(symbol);
      const best = plays.length
        ? plays.reduce((a, b) =>
            b.profitPerUnit > a.profitPerUnit ||
            (b.profitPerUnit === a.profitPerUnit && b.durationSec < a.durationSec)
              ? b
              : a
          )
        : null;

      return {
        symbol,
        name: m.instrument.name,
        volatility: m.instrument.volatility,
        price,
        tickMs: TICK_MS,
        next: future.slice(0, 40).map((t) => t.price),
        horizons: ALLOWED_DURATIONS.map((durationSec) => {
          const at = future[Math.round((durationSec * 1000) / TICK_MS) - 1];
          const target = at?.price ?? price;
          return {
            durationSec,
            price: target,
            movePct: Number((((target - price) / price) * 100).toFixed(4)),
          };
        }),
        best,
      };
    });
  }

  /** The oracle as the screen consumes it: the seed, the path, and the plays. */
  oracle(symbol: string): {
    symbol: string;
    name: string;
    now: number;
    tickMs: number;
    price: number;
    epoch: ReturnType<SandboxInstrument['reveal']>;
    recent: Array<{ at: number; price: number }>;
    future: Array<{ at: number; price: number }>;
    plays: Play[];
    best: Play | null;
  } {
    refuseOutsideSandbox();
    const market = this.market(symbol);
    const plays = this.plays(symbol);
    // Highest profit per shilling. Ties break towards the shorter duration:
    // the same money back sooner is strictly better.
    const best = plays.length
      ? plays.reduce((a, b) =>
          b.profitPerUnit > a.profitPerUnit ||
          (b.profitPerUnit === a.profitPerUnit && b.durationSec < a.durationSec)
            ? b
            : a
        )
      : null;

    return {
      symbol,
      name: market.instrument.name,
      now: Date.now(),
      tickMs: TICK_MS,
      price: market.price(),
      epoch: market.reveal(),
      recent: market.recent(160),
      future: market.future(env.sandbox.oracleTicks),
      plays,
      best,
    };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const sandboxBook = new SandboxBook();
