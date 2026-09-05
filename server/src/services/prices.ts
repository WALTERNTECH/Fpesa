import { env } from '../env.js';

export type Tick = { symbol: string; price: number; ts: number };
export type Candle = { time: number; open: number; high: number; low: number; close: number };

export const SYMBOL = 'XAUUSD';
export const TIMEFRAMES = ['1s', '5s', '15s', '1m', '5m'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

const TF_SECONDS: Record<Timeframe, number> = {
  '1s': 1, '5s': 5, '15s': 15, '1m': 60, '5m': 300,
};

const TICK_MS = 250;          // 4 ticks/second — smooth without flooding clients
const MAX_BARS = 600;         // per timeframe, kept in memory
const UPSTREAM_POLL_MS = 15_000;

/**
 * Fraction-of-price volatility per sqrt(second). Gold moves roughly 0.02% over
 * a 5-second window during active hours; this reproduces that scale so short
 * expiries actually resolve on movement rather than sitting flat.
 */
const SIGMA = 0.00009;
/**
 * Pull-to-anchor strength per tick. Keeps the synthetic walk tethered to the
 * real quote and absorbs upstream corrections over ~30s instead of jumping.
 */
const THETA = 0.02;
/**
 * Fractional gap at which a correction is applied as a jump rather than a
 * glide. Real 15-second moves in gold are far under this, so ordinary
 * corrections still ease in; only genuine dislocations snap.
 */
const SNAP_THRESHOLD = 0.005;

/** Box-Muller: one standard normal sample. */
function gaussian(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

type Listener = (tick: Tick) => void;

class PriceFeed {
  private price = 0;
  private anchor = 0;
  /** true once a real upstream quote has been applied at least once */
  private anchored = false;
  private lastUpstreamAt = 0;
  private upstreamSource = 'none';
  private listeners = new Set<Listener>();
  private candles = new Map<Timeframe, Candle[]>();
  private tickTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private dayOpen = 0;

  async start(): Promise<void> {
    // Retry before falling back. Starting on the fallback and correcting later
    // is the worst case for settlement, so it is worth a few seconds here.
    let seed: number | null = null;
    for (let attempt = 0; attempt < 3 && seed === null; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
      seed = await this.fetchUpstream();
    }

    const fallback = Number(process.env.SIMULATED_BASE_PRICE ?? 2650);
    this.price = seed ?? fallback;
    this.anchor = this.price;
    this.anchored = seed !== null;
    // Reference for the session-change figure. A real previous close is used
    // when a keyed provider can supply one; otherwise the change is measured
    // from the first real quote we saw, so it never reports a move we invented.
    this.dayOpen = (await this.fetchPreviousClose()) ?? this.price;
    this.seedHistory();

    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    if (env.priceMode === 'live') {
      this.pollTimer = setInterval(() => void this.poll(), UPSTREAM_POLL_MS);
    }
    console.log(
      '[prices] ' + SYMBOL + ' feed started at ' + this.price.toFixed(2) +
      ' (mode=' + env.priceMode + ', source=' + this.upstreamSource + ')'
    );
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  // -------------------------------------------------------------- upstream
  private async poll(): Promise<void> {
    const p = await this.fetchUpstream();
    if (p === null || !Number.isFinite(p) || p <= 0) return;

    this.anchor = p;
    this.lastUpstreamAt = Date.now();

    // A large gap means we cold-started on the fallback, or the synthetic walk
    // has drifted badly. Gliding across it would manufacture a one-way trend
    // that lasts many expiries — every Buy wins while it closes. Snap instead:
    // one discontinuity is honest, a rideable ramp is not.
    const gap = Math.abs(p - this.price) / p;
    if (!this.anchored || gap > SNAP_THRESHOLD) {
      this.price = p;
      this.dayOpen = this.anchored ? this.dayOpen : p;
      this.seedHistory();
    }
    this.anchored = true;
  }

  /** True once a real upstream quote has been applied. Trading gates on this. */
  isReady(): boolean {
    return this.anchored || env.priceMode !== 'live';
  }

  private async fetchUpstream(): Promise<number | null> {
    if (env.priceMode !== 'live') return null;

    if (env.twelveDataKey) {
      const p = await this.tryFetch(
        'https://api.twelvedata.com/price?symbol=XAU/USD&apikey=' + env.twelveDataKey,
        (j) => Number((j as { price?: string }).price)
      );
      if (p !== null) { this.upstreamSource = 'twelvedata'; return p; }
    }

    // Keyless fallback so the feed works out of the box.
    const p = await this.tryFetch(
      'https://api.gold-api.com/price/XAU',
      (j) => Number((j as { price?: number }).price)
    );
    if (p !== null) { this.upstreamSource = 'gold-api'; return p; }

    return null;
  }

  /** Real prior session close, when the configured provider exposes one. */
  private async fetchPreviousClose(): Promise<number | null> {
    if (env.priceMode !== 'live' || !env.twelveDataKey) return null;
    return this.tryFetch(
      'https://api.twelvedata.com/quote?symbol=XAU/USD&apikey=' + env.twelveDataKey,
      (j) => Number((j as { previous_close?: string }).previous_close)
    );
  }

  private async tryFetch(url: string, pick: (j: unknown) => number): Promise<number | null> {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      const value = pick(await res.json());
      return Number.isFinite(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------ tick engine
  private tick(): void {
    const dt = TICK_MS / 1000;
    const diffusion = this.price * SIGMA * Math.sqrt(dt) * gaussian();
    const reversion = (this.anchor - this.price) * THETA;
    const next = this.price + diffusion + reversion;

    this.price = round2(Math.max(next, 0.01));
    const tick: Tick = { symbol: SYMBOL, price: this.price, ts: Date.now() };

    this.applyToCandles(tick);
    for (const fn of this.listeners) {
      try {
        fn(tick);
      } catch {
        // A misbehaving subscriber must never stall the feed.
      }
    }
  }

  // ---------------------------------------------------------------- candles
  /**
   * Fills the chart with plausible pre-boot bars so it is never empty.
   *
   * The path is mean-reverting rather than a free random walk: an unbounded
   * walk over 600 bars drifts several percent from spot, which would render a
   * large fabricated move on the chart and in the session-change figure. This
   * keeps seeded history tethered within a fraction of a percent of the real
   * price, and the final bar closes exactly on it.
   */
  private seedHistory(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const tf of TIMEFRAMES) {
      const step = TF_SECONDS[tf];

      const path: number[] = [];
      let p = this.price;
      for (let i = 0; i < MAX_BARS; i++) {
        const shock = this.price * SIGMA * Math.sqrt(step) * gaussian();
        p = p + shock + (this.price - p) * 0.08;
        path.push(p);
      }
      path[path.length - 1] = this.price;

      const bars: Candle[] = [];
      for (let i = 0; i < MAX_BARS; i++) {
        const time = (Math.floor(now / step) - (MAX_BARS - 1 - i)) * step;
        const close = path[i]!;
        const open = i === 0 ? close : path[i - 1]!;
        const wick = Math.abs(this.price * SIGMA * Math.sqrt(step) * gaussian()) * 0.8;
        bars.push({
          time,
          open: round2(open),
          high: round2(Math.max(open, close) + wick),
          low: round2(Math.min(open, close) - wick),
          close: round2(close),
        });
      }
      this.candles.set(tf, bars);
    }
  }

  private applyToCandles(tick: Tick): void {
    const sec = Math.floor(tick.ts / 1000);
    for (const tf of TIMEFRAMES) {
      const step = TF_SECONDS[tf];
      const bucket = Math.floor(sec / step) * step;
      const bars = this.candles.get(tf);
      if (!bars) continue;
      const last = bars[bars.length - 1];

      if (last && last.time === bucket) {
        last.close = tick.price;
        if (tick.price > last.high) last.high = tick.price;
        if (tick.price < last.low) last.low = tick.price;
      } else {
        bars.push({
          time: bucket,
          open: last ? last.close : tick.price,
          high: tick.price,
          low: tick.price,
          close: tick.price,
        });
        if (bars.length > MAX_BARS) bars.shift();
      }
    }
  }

  // ------------------------------------------------------------------- api
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  current(): Tick {
    return { symbol: SYMBOL, price: this.price, ts: Date.now() };
  }

  history(tf: Timeframe): Candle[] {
    return this.candles.get(tf) ?? [];
  }

  /** Session change used by the header quote strip. */
  stats(): { price: number; change: number; changePct: number; dayOpen: number } {
    const change = this.price - this.dayOpen;
    return {
      price: this.price,
      change: round2(change),
      changePct: this.dayOpen ? round2((change / this.dayOpen) * 10000) / 100 : 0,
      dayOpen: round2(this.dayOpen),
    };
  }

  health(): { source: string; anchored: boolean; lastUpstreamAt: number; mode: string } {
    return {
      source: this.upstreamSource,
      anchored: this.anchored,
      lastUpstreamAt: this.lastUpstreamAt,
      mode: env.priceMode,
    };
  }
}

export const priceFeed = new PriceFeed();
