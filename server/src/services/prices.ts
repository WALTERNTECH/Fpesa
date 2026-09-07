import { env } from '../env.js';
import { SyntheticEngine, type SyntheticEngine as Engine } from './synthetic.js';
import {
  DEFAULT_SYMBOL,
  INSTRUMENTS,
  getInstrument,
  instrumentOr,
  type Instrument,
} from './instruments.js';

export type Tick = { symbol: string; price: number; ts: number };
export type Candle = { time: number; open: number; high: number; low: number; close: number };

/** The instrument a request means when it names none. */
export const SYMBOL = DEFAULT_SYMBOL;
export const TIMEFRAMES = ['1s', '5s', '15s', '1m', '5m'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

const TF_SECONDS: Record<Timeframe, number> = {
  '1s': 1, '5s': 5, '15s': 15, '1m': 60, '5m': 300,
};

const TICK_MS = 250;          // 4 ticks/second — smooth without flooding clients
const MAX_BARS = 600;         // per timeframe, per instrument, kept in memory
const UPSTREAM_POLL_MS = 15_000;

/** Pull-to-anchor strength per tick, live mode only. */
const THETA = 0.02;
/** Fractional gap at which a live correction snaps rather than glides. */
const SNAP_THRESHOLD = 0.005;

/** Box-Muller: one standard normal sample. */
function gaussian(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function roundTo(n: number, precision: number): number {
  const f = Math.pow(10, precision);
  return Math.round(n * f) / f;
}

/**
 * One instrument's live state: its engine, its price, its bars.
 *
 * Each instrument runs its own seed chain, so the commitment published for one
 * says nothing about any other. Sharing a seed across five markets would make
 * them five views of the same random numbers, which is both less useful and a
 * weaker fairness claim than it appears.
 */
class InstrumentFeed {
  price: number;
  dayOpen: number;
  private candles = new Map<Timeframe, Candle[]>();
  private engine: Engine | null = null;
  /** Live mode only. */
  private anchor = 0;
  private anchored = false;

  constructor(readonly instrument: Instrument, synthetic: boolean) {
    this.price = instrument.basePrice;
    this.dayOpen = instrument.basePrice;
    if (synthetic) {
      this.engine = new SyntheticEngine(
        TICK_MS,
        env.synth.epochMs,
        instrument.sigma,
        env.synth.drift,
        instrument.basePrice
      );
      this.price = this.engine.current();
      this.dayOpen = this.price;
      this.anchored = true;
    }
    this.seedHistory();
  }

  syntheticEngine(): Engine | null {
    return this.engine;
  }

  isAnchored(): boolean {
    return this.anchored;
  }

  /** Live mode: apply an upstream quote. */
  applyUpstream(p: number): void {
    this.anchor = p;
    const gap = Math.abs(p - this.price) / p;
    // Gliding across a large gap manufactures a one-way trend that lasts many
    // expiries — every Buy wins while it closes. One discontinuity is honest;
    // a rideable ramp is not.
    if (!this.anchored || gap > SNAP_THRESHOLD) {
      this.price = p;
      if (!this.anchored) this.dayOpen = p;
      this.seedHistory();
    }
    this.anchored = true;
  }

  setDayOpen(p: number): void {
    this.dayOpen = p;
  }

  /** Advances one tick and returns the new price. */
  advance(): number {
    if (this.engine) {
      this.price = this.engine.next();
      return this.price;
    }
    const dt = TICK_MS / 1000;
    const diffusion = this.price * this.instrument.sigma * Math.sqrt(dt) * gaussian();
    const reversion = (this.anchor - this.price) * THETA;
    this.price = roundTo(Math.max(this.price + diffusion + reversion, 0.01), this.instrument.precision);
    return this.price;
  }

  /**
   * Fills the chart with plausible pre-boot bars so it is never empty.
   *
   * The path is mean-reverting rather than a free random walk: an unbounded
   * walk over 600 bars drifts several percent from spot, which would render a
   * large fabricated move on the chart and in the session-change figure.
   */
  private seedHistory(): void {
    const now = Math.floor(Date.now() / 1000);
    const { sigma, precision } = this.instrument;

    for (const tf of TIMEFRAMES) {
      const step = TF_SECONDS[tf];
      const path: number[] = [];
      let p = this.price;
      for (let i = 0; i < MAX_BARS; i++) {
        const shock = this.price * sigma * Math.sqrt(step) * gaussian();
        p = p + shock + (this.price - p) * 0.08;
        path.push(p);
      }
      path[path.length - 1] = this.price;

      const bars: Candle[] = [];
      for (let i = 0; i < MAX_BARS; i++) {
        const time = (Math.floor(now / step) - (MAX_BARS - 1 - i)) * step;
        const close = path[i]!;
        const open = i === 0 ? close : path[i - 1]!;
        const wick = Math.abs(this.price * sigma * Math.sqrt(step) * gaussian()) * 0.8;
        bars.push({
          time,
          open: roundTo(open, precision),
          high: roundTo(Math.max(open, close) + wick, precision),
          low: roundTo(Math.min(open, close) - wick, precision),
          close: roundTo(close, precision),
        });
      }
      this.candles.set(tf, bars);
    }
  }

  applyToCandles(price: number, ts: number): void {
    const sec = Math.floor(ts / 1000);
    for (const tf of TIMEFRAMES) {
      const step = TF_SECONDS[tf];
      const bucket = Math.floor(sec / step) * step;
      const bars = this.candles.get(tf);
      if (!bars) continue;
      const last = bars[bars.length - 1];

      if (last && last.time === bucket) {
        last.close = price;
        if (price > last.high) last.high = price;
        if (price < last.low) last.low = price;
      } else {
        bars.push({
          time: bucket,
          open: last ? last.close : price,
          high: price,
          low: price,
          close: price,
        });
        if (bars.length > MAX_BARS) bars.shift();
      }
    }
  }

  history(tf: Timeframe): Candle[] {
    return this.candles.get(tf) ?? [];
  }

  stats(): { price: number; change: number; changePct: number; dayOpen: number } {
    const change = this.price - this.dayOpen;
    const p = this.instrument.precision;
    return {
      price: this.price,
      change: roundTo(change, p),
      changePct: this.dayOpen ? Math.round((change / this.dayOpen) * 10000) / 100 : 0,
      dayOpen: roundTo(this.dayOpen, p),
    };
  }
}

type Listener = (tick: Tick) => void;

class PriceFeed {
  private feeds = new Map<string, InstrumentFeed>();
  private listeners = new Set<Listener>();
  private tickTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private upstreamSource = 'none';
  private lastUpstreamAt = 0;

  async start(): Promise<void> {
    const synthetic = env.priceMode === 'synthetic';

    /**
     * The five-instrument family is a property of the synthetic engine. In
     * live mode there is exactly one instrument, because there is exactly one
     * upstream quote to drive it — inventing four more and calling them
     * markets would be dressing up a simulation as a feed.
     */
    const list = synthetic ? INSTRUMENTS : INSTRUMENTS.filter((i) => i.symbol === SYMBOL);
    for (const instrument of list) {
      this.feeds.set(instrument.symbol, new InstrumentFeed(instrument, synthetic));
    }

    if (!synthetic) {
      const feed = this.feeds.get(SYMBOL)!;
      // Retry before falling back. Starting on the fallback and correcting
      // later is the worst case for settlement, so it is worth a few seconds.
      let seed: number | null = null;
      for (let attempt = 0; attempt < 3 && seed === null; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
        seed = await this.fetchUpstream();
      }
      if (seed !== null) feed.applyUpstream(seed);
      const prev = await this.fetchPreviousClose();
      if (prev !== null) feed.setDayOpen(prev);

      if (env.priceMode === 'live') {
        this.pollTimer = setInterval(() => void this.poll(), UPSTREAM_POLL_MS);
      }
    } else {
      this.upstreamSource = 'synthetic';
    }

    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    console.log(
      '[prices] ' + this.feeds.size + ' instrument(s) started (mode=' + env.priceMode + '): ' +
      [...this.feeds.values()]
        .map((f) => f.instrument.symbol + '@' + f.price.toFixed(f.instrument.precision))
        .join(', ')
    );
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  // ------------------------------------------------------------ tick engine
  private tick(): void {
    const ts = Date.now();
    for (const feed of this.feeds.values()) {
      const price = feed.advance();
      feed.applyToCandles(price, ts);
      const t: Tick = { symbol: feed.instrument.symbol, price, ts };
      for (const fn of this.listeners) {
        try {
          fn(t);
        } catch {
          // A misbehaving subscriber must never stall the feed.
        }
      }
    }
  }

  // -------------------------------------------------------------- upstream
  private async poll(): Promise<void> {
    const p = await this.fetchUpstream();
    if (p === null || !Number.isFinite(p) || p <= 0) return;
    this.lastUpstreamAt = Date.now();
    this.feeds.get(SYMBOL)?.applyUpstream(p);
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
    const p = await this.tryFetch(
      'https://api.gold-api.com/price/XAU',
      (j) => Number((j as { price?: number }).price)
    );
    if (p !== null) { this.upstreamSource = 'gold-api'; return p; }
    return null;
  }

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

  // ------------------------------------------------------------------- api
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** True once every instrument has a price behind it. Trading gates on this. */
  isReady(): boolean {
    if (this.feeds.size === 0) return false;
    if (env.priceMode !== 'live') return true;
    return this.feeds.get(SYMBOL)?.isAnchored() ?? false;
  }

  has(symbol: string): boolean {
    return this.feeds.has(symbol);
  }

  tradeableSymbols(): string[] {
    return [...this.feeds.keys()];
  }

  /** The synthetic engine for one instrument, when one is running. */
  engine(symbol: string = SYMBOL): Engine | null {
    return this.feeds.get(symbol)?.syntheticEngine() ?? null;
  }

  current(symbol: string = SYMBOL): Tick {
    const feed = this.feeds.get(symbol);
    return {
      symbol,
      price: feed ? feed.price : 0,
      ts: Date.now(),
    };
  }

  history(symbol: string, tf: Timeframe): Candle[] {
    return this.feeds.get(symbol)?.history(tf) ?? [];
  }

  stats(symbol: string = SYMBOL): { price: number; change: number; changePct: number; dayOpen: number } {
    return (
      this.feeds.get(symbol)?.stats() ?? { price: 0, change: 0, changePct: 0, dayOpen: 0 }
    );
  }

  /** Every instrument's headline numbers, for the market switcher. */
  snapshot(): Array<{
    symbol: string;
    name: string;
    volatility: number;
    precision: number;
    price: number;
    change: number;
    changePct: number;
    dayOpen: number;
  }> {
    return [...this.feeds.values()].map((f) => ({
      symbol: f.instrument.symbol,
      name: f.instrument.name,
      volatility: f.instrument.volatility,
      precision: f.instrument.precision,
      ...f.stats(),
    }));
  }

  precisionFor(symbol: string): number {
    return instrumentOr(symbol).precision;
  }

  health(): { source: string; anchored: boolean; lastUpstreamAt: number; mode: string } {
    return {
      source: this.upstreamSource,
      anchored: this.isReady(),
      lastUpstreamAt: this.lastUpstreamAt,
      mode: env.priceMode,
    };
  }
}

export const priceFeed = new PriceFeed();
export { getInstrument, INSTRUMENTS };
