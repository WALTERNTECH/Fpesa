import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { env } from '../env.js';
import { INSTRUMENTS, getInstrument } from './instruments.js';
import {
  ALLOWED_DURATIONS,
  applySpread,
  exitLevels,
  multiplierFor,
  unrealisedProfit,
} from './trading.js';
import { SandboxError } from './sandbox.js';

/**
 * Shadow mode: the sandbox following production's live prices, tick for tick.
 *
 * ## Why this and not a shared seed
 *
 * A shadow system needs the same price *values* as the primary. It does not
 * need the primary's generator state, and taking that instead is worse in a way
 * that matters: it bypasses the feed.
 *
 * Production decides a stop-out by comparing a tick *that arrived over its own
 * feed* against a stored level. A shadow that re-derived prices from the seed
 * would be testing the generator, not the system — and if the live feed ever
 * disagreed with its own generator (a restart mid-epoch, a rotation, a dropped
 * or repeated tick), the seed-derived shadow would compute the "right" answer
 * while production did something else. It would be silent about exactly the
 * class of bug a shadow exists to catch.
 *
 * So this subscribes to production's public tick stream at /ws — the same
 * stream every trader's browser receives, no credential involved — and drives
 * its book from that. Lockstep with what production actually saw, not with what
 * its RNG says it should have seen.
 *
 * ## The property that comes with it
 *
 * In shadow mode there is no oracle, and that is not a policy choice bolted on.
 * These prices come from a market whose seed this process does not hold, so
 * there is nothing here to look ahead at. Lockstep and foreknowledge are the
 * same fact seen from two sides: a market you are *following* is one you cannot
 * see the future of, and a market you can see the future of is one you are
 * generating rather than following. The seed-mode sandbox gives the second. This
 * gives the first. Nothing can give both.
 *
 * ## What it is faithful to
 *
 * Settlement here discovers outcomes the way production does — a barrier scan
 * on every arriving tick, stop-out checked before take-profit, plus an expiry
 * timer — rather than computing the result at open the way the seeded sandbox
 * can. That is the whole point: the trigger logic is what is under test.
 */

const HISTORY = 600;

function wsUrl(): string {
  const base = env.sandbox.replaySource || 'https://www.fpesa.markets';
  return base.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws';
}

type Mirrored = {
  symbol: string;
  price: number;
  ts: number;
  /** Ticks received since this process started. */
  ticks: number;
  /** When the last tick arrived here, by our clock. */
  receivedAt: number;
  history: Array<{ price: number; ts: number }>;
  socket: WebSocket | null;
  state: 'connecting' | 'open' | 'closed';
  retries: number;
};

type ShadowPosition = {
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
  expiresAt: number;
  status: 'OPEN' | 'WON' | 'LOST';
  exitPrice: number | null;
  profit: number | null;
  closeReason: 'EXPIRY' | 'STOP_OUT' | 'TAKE_PROFIT' | null;
  /** Ticks seen by this position before it closed — the trigger's own evidence. */
  ticksObserved: number;
};

type Session = {
  id: string;
  balance: number;
  open: Map<string, ShadowPosition>;
  closed: ShadowPosition[];
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

class ShadowFeed {
  private markets = new Map<string, Mirrored>();
  private sessions = new Map<string, Session>();
  private timers = new Map<string, NodeJS.Timeout>();
  private started = false;

  start(): void {
    if (env.appMode !== 'sandbox') return;
    if (this.started) return;
    this.started = true;
    for (const instrument of INSTRUMENTS) {
      this.markets.set(instrument.symbol, {
        symbol: instrument.symbol,
        price: 0,
        ts: 0,
        ticks: 0,
        receivedAt: 0,
        history: [],
        socket: null,
        state: 'closed',
        retries: 0,
      });
      this.connect(instrument.symbol);
    }
    console.log('[shadow] following ' + wsUrl() + ' for ' + INSTRUMENTS.length + ' market(s)');
  }

  stop(): void {
    for (const m of this.markets.values()) {
      try {
        m.socket?.close();
      } catch {
        // Already gone; nothing to do.
      }
      m.socket = null;
      m.state = 'closed';
    }
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.started = false;
  }

  /**
   * One socket per instrument, because the hub sends a socket only the symbol
   * it asked to watch.
   */
  private connect(symbol: string): void {
    const m = this.markets.get(symbol);
    if (!m || !this.started) return;

    m.state = 'connecting';
    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl());
    } catch {
      this.scheduleReconnect(symbol);
      return;
    }
    m.socket = socket;

    socket.on('open', () => {
      m.state = 'open';
      m.retries = 0;
      socket.send(JSON.stringify({ type: 'watch', symbol }));
    });

    socket.on('message', (raw) => {
      let msg: { type?: string; symbol?: string; price?: number; ts?: number };
      try {
        msg = JSON.parse(String(raw)) as typeof msg;
      } catch {
        return;
      }
      if (msg.type !== 'tick' || msg.symbol !== symbol) return;
      if (typeof msg.price !== 'number' || !Number.isFinite(msg.price)) return;

      m.price = msg.price;
      m.ts = typeof msg.ts === 'number' ? msg.ts : Date.now();
      m.receivedAt = Date.now();
      m.ticks += 1;
      m.history.push({ price: m.price, ts: m.ts });
      if (m.history.length > HISTORY) m.history.shift();

      // Exactly where production runs its barrier scan: on the tick, as it
      // arrives, before anything else looks at it.
      this.checkLevels(symbol, m.price);
    });

    socket.on('close', () => {
      m.state = 'closed';
      this.scheduleReconnect(symbol);
    });
    socket.on('error', () => {
      m.state = 'closed';
      try {
        socket.close();
      } catch {
        // Close on an already-errored socket is best effort.
      }
    });
  }

  /** Backs off to a minute, so a production outage is not also a thundering herd. */
  private scheduleReconnect(symbol: string): void {
    const m = this.markets.get(symbol);
    if (!m || !this.started) return;
    m.retries += 1;
    const delay = Math.min(1000 * 2 ** Math.min(m.retries, 6), 60_000);
    const timer = setTimeout(() => this.connect(symbol), delay);
    timer.unref();
    this.timers.set('reconnect:' + symbol, timer);
  }

  private market(symbol: string): Mirrored {
    const m = this.markets.get(symbol);
    if (!m) throw new SandboxError('UNKNOWN_MARKET', 'No such market.', 404);
    if (m.price <= 0) {
      throw new SandboxError(
        'NO_FEED',
        'No tick has arrived for ' + symbol + ' yet. The shadow follows ' +
        'production, so it has nothing to price against until production sends one.',
        503
      );
    }
    return m;
  }

  // ---------------------------------------------------------------- book

  private session(id: string): Session {
    let s = this.sessions.get(id);
    if (!s) {
      s = { id, balance: env.sandbox.startingBalance, open: new Map(), closed: [] };
      this.sessions.set(id, s);
    }
    return s;
  }

  reset(id: string): void {
    const existing = this.sessions.get(id);
    if (existing) {
      for (const pos of existing.open.keys()) {
        const t = this.timers.get('expiry:' + pos);
        if (t) clearTimeout(t);
        this.timers.delete('expiry:' + pos);
      }
    }
    this.sessions.delete(id);
  }

  open(
    sessionId: string,
    params: { symbol: string; direction: 'BUY' | 'SELL'; stake: number; durationSec: number }
  ): ShadowPosition {
    if (env.appMode !== 'sandbox') {
      throw new SandboxError('NOT_SANDBOX', 'Shadow mode runs only in the sandbox.', 404);
    }
    if (!(ALLOWED_DURATIONS as readonly number[]).includes(params.durationSec)) {
      throw new SandboxError('VALIDATION', 'Choose an offered duration.');
    }
    if (!Number.isFinite(params.stake) || params.stake <= 0) {
      throw new SandboxError('VALIDATION', 'Enter a stake.');
    }
    const session = this.session(sessionId);
    if (params.stake > session.balance) {
      throw new SandboxError('INSUFFICIENT', 'Paper balance is ' + session.balance.toFixed(2) + '.');
    }

    const m = this.market(params.symbol);
    const precision = getInstrument(params.symbol)?.precision ?? 2;
    const multiplier = multiplierFor(params.durationSec, params.symbol);
    // The same functions production stamps with, on the tick production last
    // sent. Proven identical field by field by /api/sandbox/conform.
    const entryPrice = applySpread(m.price, params.direction, multiplier, precision);
    const { stopOut, takeProfit } = exitLevels(
      entryPrice, params.direction, multiplier, env.maxProfitMultiple, precision
    );

    const now = Date.now();
    const position: ShadowPosition = {
      id: randomUUID(),
      symbol: params.symbol,
      direction: params.direction,
      stake: params.stake,
      durationSec: params.durationSec,
      multiplier,
      entryPrice,
      stopOutPrice: stopOut,
      takeProfitPrice: takeProfit,
      maxProfit: round2(params.stake * env.maxProfitMultiple),
      openedAt: now,
      expiresAt: now + params.durationSec * 1000,
      status: 'OPEN',
      exitPrice: null,
      profit: null,
      closeReason: null,
      ticksObserved: 0,
    };

    session.balance = round2(session.balance - params.stake);
    session.open.set(position.id, position);

    const timer = setTimeout(
      () => this.settle(sessionId, position.id, 'EXPIRY'),
      params.durationSec * 1000
    );
    this.timers.set('expiry:' + position.id, timer);
    return position;
  }

  /** Mirrors TradingEngine.checkLevels, including the order of the two tests. */
  private checkLevels(symbol: string, price: number): void {
    for (const session of this.sessions.values()) {
      for (const pos of [...session.open.values()]) {
        if (pos.symbol !== symbol) continue;
        pos.ticksObserved += 1;
        const hitStop =
          pos.direction === 'BUY' ? price <= pos.stopOutPrice : price >= pos.stopOutPrice;
        const hitTarget =
          pos.direction === 'BUY' ? price >= pos.takeProfitPrice : price <= pos.takeProfitPrice;
        if (!hitStop && !hitTarget) continue;
        this.settle(session.id, pos.id, hitStop ? 'STOP_OUT' : 'TAKE_PROFIT', price);
      }
    }
  }

  private settle(
    sessionId: string,
    positionId: string,
    reason: 'EXPIRY' | 'STOP_OUT' | 'TAKE_PROFIT',
    atPrice?: number
  ): void {
    const session = this.sessions.get(sessionId);
    const pos = session?.open.get(positionId);
    if (!session || !pos) return;

    const timer = this.timers.get('expiry:' + positionId);
    if (timer) clearTimeout(timer);
    this.timers.delete('expiry:' + positionId);
    session.open.delete(positionId);

    const exit = atPrice ?? this.markets.get(pos.symbol)?.price ?? pos.entryPrice;
    const profit = unrealisedProfit(
      {
        stake: pos.stake,
        multiplier: pos.multiplier,
        entryPrice: pos.entryPrice,
        direction: pos.direction,
        maxProfit: pos.maxProfit,
      },
      exit
    );

    pos.exitPrice = exit;
    pos.profit = profit;
    pos.closeReason = reason;
    pos.status = profit >= 0 ? 'WON' : 'LOST';
    session.balance = round2(session.balance + pos.stake + profit);
    session.closed.unshift(pos);
    if (session.closed.length > 50) session.closed.length = 50;
  }

  // --------------------------------------------------------------- views

  /**
   * Lockstep evidence.
   *
   * `lagMs` is how long ago production's last tick for this market arrived
   * here. At a 250ms tick it should sit inside a few hundred milliseconds; a
   * figure that climbs means the shadow has fallen behind and its triggers are
   * being evaluated against stale prices — which is the one way this setup can
   * quietly stop testing what it claims to.
   */
  status(): {
    source: string;
    markets: Array<{
      symbol: string;
      price: number;
      ts: number;
      ticks: number;
      lagMs: number | null;
      state: string;
    }>;
    connected: number;
    total: number;
  } {
    const now = Date.now();
    return {
      source: wsUrl(),
      markets: [...this.markets.values()].map((m) => ({
        symbol: m.symbol,
        price: m.price,
        ts: m.ts,
        ticks: m.ticks,
        lagMs: m.receivedAt ? now - m.receivedAt : null,
        state: m.state,
      })),
      connected: [...this.markets.values()].filter((m) => m.state === 'open').length,
      total: this.markets.size,
    };
  }

  state(sessionId: string): {
    balance: number;
    startingBalance: number;
    open: ShadowPosition[];
    closed: ShadowPosition[];
  } {
    const s = this.session(sessionId);
    return {
      balance: s.balance,
      startingBalance: env.sandbox.startingBalance,
      open: [...s.open.values()],
      closed: s.closed,
    };
  }

  recent(symbol: string, count = 240): Array<{ price: number; ts: number }> {
    const m = this.markets.get(symbol);
    if (!m) throw new SandboxError('UNKNOWN_MARKET', 'No such market.', 404);
    return m.history.slice(-count);
  }
}

export const shadowFeed = new ShadowFeed();
