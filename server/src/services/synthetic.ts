import { createHash, createHmac, randomBytes } from 'node:crypto';
import { env } from '../env.js';

/**
 * Deterministic, provably-fair synthetic price engine.
 *
 * Every tick is derived from a seed:
 *
 *   digest      = HMAC-SHA256(seed, "<epoch>:<tickIndex>")
 *   u1, u2      = first two 8-byte words of the digest, mapped to (0,1)
 *   z           = Box-Muller(u1, u2)
 *   price[i]    = price[i-1] * exp(drift*dt + sigma*sqrt(dt)*z)
 *
 * The seed rotates each epoch. The SHA-256 of the next seed is published
 * *before* that epoch starts, and the seed itself is published once the epoch
 * ends — so anyone can replay every tick of a finished epoch and confirm it
 * matches what they traded against, and the operator cannot change a price
 * after the fact without breaking a hash they already published.
 *
 * The honest limit of this scheme, stated plainly because it matters: whoever
 * holds the live seed can compute the current epoch's remaining path. The
 * commitment stops outcomes being *altered*, not *known*. Epochs are therefore
 * kept short, and the live seed must be treated as a production secret — it is
 * never returned by any endpoint until its epoch has closed.
 */

export type EpochRecord = {
  epoch: number;
  startPrice: number;
  seedHash: string;
  startedAt: number;
  endedAt: number | null;
  /** Only ever populated once the epoch has closed. */
  seed: string | null;
  tickMs: number;
  sigma: number;
  drift: number;
};

const TWO_POW_53 = 9007199254740992;

/** Maps 8 bytes of digest into (0,1), excluding both endpoints. */
function uniform(digest: Buffer, offset: number): number {
  // 53 bits keeps it inside the exact-integer range of a double.
  const hi = digest.readUInt32BE(offset) & 0x1fffff; // 21 bits
  const lo = digest.readUInt32BE(offset + 4); // 32 bits
  const value = hi * 4294967296 + lo;
  return (value + 0.5) / TWO_POW_53;
}

/** Standard normal from one digest, deterministic in the seed. */
export function normalFrom(seed: string, label: string): number {
  const digest = createHmac('sha256', seed).update(label).digest();
  const u1 = uniform(digest, 0);
  const u2 = uniform(digest, 8);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Replays one epoch from its seed. Exported so the verification script and the
 * server share exactly one implementation — a verifier that reimplements the
 * maths is a verifier that can silently disagree.
 */
export function replayEpoch(params: {
  seed: string;
  epoch: number;
  startPrice: number;
  ticks: number;
  tickMs: number;
  sigma: number;
  drift: number;
}): number[] {
  const dt = params.tickMs / 1000;
  const out: number[] = [];
  let price = params.startPrice;
  for (let i = 0; i < params.ticks; i++) {
    const z = normalFrom(params.seed, params.epoch + ':' + i);
    const logReturn = params.drift * dt + params.sigma * Math.sqrt(dt) * z;
    price = price * Math.exp(logReturn);
    price = Math.round(price * 100) / 100;
    if (price < 0.01) price = 0.01;
    out.push(price);
  }
  return out;
}

/**
 * Where an epoch is announced and later revealed.
 *
 * The engine calls these and does not wait for them. A record that fails to
 * persist is a hole in the published history, which is serious — but an engine
 * that stalled or threw because a database was briefly unreachable would stop
 * settling live positions, which is worse. So the reporting is fire-and-forget
 * here and the failure is counted and surfaced by the recorder instead.
 */
export type ChainReporter = {
  /** Called at rotation, before the new epoch produces a tick. */
  announce: (commitment: {
    epoch: number;
    seedHash: string;
    startPrice: number;
    tickMs: number;
    epochMs: number;
    sigma: number;
    drift: number;
    startedAt: number;
  }) => void;
  /** Called when an epoch closes and its seed becomes publishable. */
  reveal: (epoch: number, seed: string, endedAt: number) => void;
};

export class SyntheticEngine {
  private epoch = 0;
  private seed = '';
  private nextSeed = '';
  private startPrice = 0;
  private startedAt = 0;
  private tickIndex = 0;
  private price = 0;
  private history: EpochRecord[] = [];
  private reporter: ChainReporter | null = null;

  constructor(
    private readonly tickMs: number,
    private readonly epochMs: number,
    private readonly sigma: number,
    private readonly drift: number,
    basePrice: number,
    /**
     * Where this symbol's chain left off, so the numbering continues across a
     * restart instead of starting again at 1. Before this existed, every deploy
     * reset the counter and orphaned the entire published record.
     */
    options?: { startEpoch?: number; reporter?: ChainReporter }
  ) {
    this.price = basePrice;
    this.epoch = Math.max(options?.startEpoch ?? 0, 0);
    this.reporter = options?.reporter ?? null;
    this.nextSeed = randomBytes(32).toString('hex');
    this.rotate();
  }

  /** Closes the running epoch, publishes its seed, and opens the next. */
  private rotate(): void {
    if (this.seed) {
      const previous = this.history[this.history.length - 1];
      if (previous && previous.epoch === this.epoch) {
        previous.endedAt = Date.now();
        previous.seed = this.seed; // revealed only now that it is closed
        this.report(() => this.reporter?.reveal(this.epoch, this.seed, previous.endedAt!));
      }
    }

    this.epoch += 1;
    this.seed = this.nextSeed;
    // Committed before a single tick of this epoch is generated.
    this.nextSeed = randomBytes(32).toString('hex');
    this.startPrice = this.price;
    this.startedAt = Date.now();
    this.tickIndex = 0;
    const seedHash = createHash('sha256').update(this.seed).digest('hex');

    this.history.push({
      epoch: this.epoch,
      startPrice: this.startPrice,
      seedHash,
      startedAt: this.startedAt,
      endedAt: null,
      seed: null,
      tickMs: this.tickMs,
      sigma: this.sigma,
      drift: this.drift,
    });

    // Announced before any tick of this epoch exists, which is the only moment
    // at which a commitment means anything.
    this.report(() =>
      this.reporter?.announce({
        epoch: this.epoch,
        seedHash,
        startPrice: this.startPrice,
        tickMs: this.tickMs,
        epochMs: this.epochMs,
        sigma: this.sigma,
        drift: this.drift,
        startedAt: this.startedAt,
      })
    );
    // Keep a day of epochs available for anyone checking their trades.
    const keep = Math.ceil((24 * 60 * 60 * 1000) / this.epochMs) + 2;
    if (this.history.length > keep) this.history.splice(0, this.history.length - keep);
  }

  /**
   * Runs a reporting callback without letting it affect price generation.
   *
   * rotate() is on the tick path. Anything that throws here would stop the
   * market and strand open positions, so the record is allowed to fail and the
   * prices are not.
   */
  private report(fn: () => void): void {
    if (!this.reporter) return;
    try {
      fn();
    } catch (err) {
      console.error('[synthetic] chain reporter threw (prices unaffected):', err);
    }
  }

  /** Advances one tick and returns the new price. */
  next(): number {
    if (Date.now() - this.startedAt >= this.epochMs) this.rotate();

    const dt = this.tickMs / 1000;
    const z = normalFrom(this.seed, this.epoch + ':' + this.tickIndex);
    const logReturn = this.drift * dt + this.sigma * Math.sqrt(dt) * z;
    const next = this.price * Math.exp(logReturn);

    this.tickIndex += 1;
    this.price = Math.max(Math.round(next * 100) / 100, 0.01);
    return this.price;
  }

  current(): number {
    return this.price;
  }

  /** The open commitment: hash now, seed after the epoch closes. */
  commitment(): {
    epoch: number;
    seedHash: string;
    startPrice: number;
    startedAt: number;
    endsAt: number;
    tickIndex: number;
    nextSeedHash: string;
  } {
    return {
      epoch: this.epoch,
      seedHash: createHash('sha256').update(this.seed).digest('hex'),
      startPrice: this.startPrice,
      startedAt: this.startedAt,
      endsAt: this.startedAt + this.epochMs,
      tickIndex: this.tickIndex,
      nextSeedHash: createHash('sha256').update(this.nextSeed).digest('hex'),
    };
  }

  /** Closed epochs only — the live seed is never included. */
  revealed(limit = 24): EpochRecord[] {
    return this.history.filter((e) => e.seed !== null).slice(-limit).reverse();
  }

  params(): { tickMs: number; epochMs: number; sigma: number; drift: number } {
    return {
      tickMs: this.tickMs,
      epochMs: this.epochMs,
      sigma: this.sigma,
      drift: this.drift,
    };
  }
}

export function buildSyntheticEngine(): SyntheticEngine {
  return new SyntheticEngine(
    250,
    env.synth.epochMs,
    env.synth.sigma,
    env.synth.drift,
    env.synth.basePrice
  );
}
