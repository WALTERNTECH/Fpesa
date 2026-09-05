import { env } from '../env.js';
import { db, pgErrorCode } from '../lib/db.js';
import { priceFeed, SYMBOL } from './prices.js';
import { hub } from '../realtime/hub.js';

export type TradeRow = {
  id: string;
  user_id: string;
  account_mode: 'demo' | 'real';
  symbol: string;
  direction: 'BUY' | 'SELL';
  stake: string | number;
  duration_sec: number;
  payout_rate: string | number;
  entry_price: string | number;
  exit_price: string | number | null;
  payout: string | number | null;
  profit: string | number | null;
  status: 'OPEN' | 'WON' | 'LOST' | 'TIE' | 'VOID';
  opened_at: string;
  expires_at: string;
  settled_at: string | null;
  multiplier: string | number;
  stop_out_price: string | number | null;
  take_profit_price: string | number | null;
  max_profit: string | number | null;
  close_reason: 'EXPIRY' | 'STOP_OUT' | 'TAKE_PROFIT' | null;
};

export type PublicTrade = {
  id: string;
  accountMode: 'demo' | 'real';
  symbol: string;
  direction: 'BUY' | 'SELL';
  stake: number;
  durationSec: number;
  payoutRate: number;
  entryPrice: number;
  exitPrice: number | null;
  payout: number | null;
  profit: number | null;
  status: TradeRow['status'];
  openedAt: string;
  expiresAt: string;
  settledAt: string | null;
  multiplier: number;
  stopOutPrice: number | null;
  takeProfitPrice: number | null;
  maxProfit: number;
  closeReason: TradeRow['close_reason'];
};

export function toPublicTrade(row: TradeRow): PublicTrade {
  return {
    id: row.id,
    accountMode: row.account_mode,
    symbol: row.symbol,
    direction: row.direction,
    stake: Number(row.stake),
    durationSec: row.duration_sec,
    payoutRate: Number(row.payout_rate),
    entryPrice: Number(row.entry_price),
    exitPrice: row.exit_price === null ? null : Number(row.exit_price),
    payout: row.payout === null ? null : Number(row.payout),
    profit: row.profit === null ? null : Number(row.profit),
    status: row.status,
    openedAt: row.opened_at,
    expiresAt: row.expires_at,
    settledAt: row.settled_at,
    multiplier: Number(row.multiplier ?? 1),
    stopOutPrice: row.stop_out_price === null ? null : Number(row.stop_out_price),
    takeProfitPrice: row.take_profit_price === null ? null : Number(row.take_profit_price),
    maxProfit: Number(row.max_profit ?? row.stake),
    closeReason: row.close_reason,
  };
}

export const ALLOWED_DURATIONS = [5, 10, 15, 30, 60] as const;
export type Duration = (typeof ALLOWED_DURATIONS)[number];

/** Parsed once from TRADE_MULTIPLIERS ("5:2000,10:1400,..."). */
const MULTIPLIERS: Map<number, number> = (() => {
  const map = new Map<number, number>();
  for (const pair of env.multipliers.split(',')) {
    const [secs, mult] = pair.split(':');
    const s = Number(secs);
    const m = Number(mult);
    if (Number.isFinite(s) && Number.isFinite(m) && m > 0) map.set(s, m);
  }
  for (const d of ALLOWED_DURATIONS) {
    if (!map.has(d)) map.set(d, 1000);
  }
  return map;
})();

export function multiplierFor(durationSec: number): number {
  return MULTIPLIERS.get(durationSec) ?? 1000;
}

/**
 * The price levels at which a position closes itself.
 *
 * Stop-out sits where the loss equals the whole stake — the trader can lose
 * what they staked and not a shilling more. Take-profit sits at the liability
 * ceiling. Both are computed at entry and shown to the trader, so the exit
 * conditions are known before the position is opened.
 */
export function exitLevels(
  entry: number,
  direction: 'BUY' | 'SELL',
  multiplier: number,
  maxProfitMultiple: number
): { stopOut: number; takeProfit: number } {
  const lossMove = 1 / multiplier;
  const gainMove = maxProfitMultiple / multiplier;
  const sign = direction === 'BUY' ? 1 : -1;
  return {
    stopOut: round2(entry * (1 - sign * lossMove)),
    takeProfit: round2(entry * (1 + sign * gainMove)),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Running profit on an open position at the current price. */
export function unrealisedProfit(
  trade: Pick<PublicTrade, 'stake' | 'multiplier' | 'entryPrice' | 'direction' | 'maxProfit'>,
  price: number
): number {
  const move = (price - trade.entryPrice) / trade.entryPrice;
  const signed = trade.direction === 'BUY' ? move : -move;
  const raw = trade.stake * trade.multiplier * signed;
  return round2(Math.min(Math.max(raw, -trade.stake), trade.maxProfit));
}

export class TradeError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

/** What the tick monitor needs to decide whether a position must close now. */
type LivePosition = {
  id: string;
  direction: 'BUY' | 'SELL';
  stopOut: number;
  takeProfit: number;
};

class TradingEngine {
  private timers = new Map<string, NodeJS.Timeout>();
  private live = new Map<string, LivePosition>();
  private leaderboardTimer: NodeJS.Timeout | null = null;
  private unsubscribeTicks: (() => void) | null = null;

  async start(): Promise<void> {
    await this.recoverOpenTrades();

    // Watch every tick so a position that runs out of margin closes the moment
    // it happens, rather than waiting for its expiry timer.
    this.unsubscribeTicks = priceFeed.subscribe((tick) => this.checkLevels(tick.price));

    this.leaderboardTimer = setInterval(() => void this.publishLeaderboard(), 20_000);
    void this.publishLeaderboard();
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.live.clear();
    this.unsubscribeTicks?.();
    if (this.leaderboardTimer) clearInterval(this.leaderboardTimer);
  }

  /**
   * Closes any position whose price barrier has been crossed. Runs on every
   * tick, so it stays a plain scan over open positions — settlement itself is
   * idempotent, so a race with the expiry timer resolves harmlessly.
   */
  private checkLevels(price: number): void {
    if (this.live.size === 0) return;
    for (const pos of this.live.values()) {
      const hitStop =
        pos.direction === 'BUY' ? price <= pos.stopOut : price >= pos.stopOut;
      const hitTarget =
        pos.direction === 'BUY' ? price >= pos.takeProfit : price <= pos.takeProfit;
      if (!hitStop && !hitTarget) continue;

      this.live.delete(pos.id);
      const timer = this.timers.get(pos.id);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(pos.id);
      }
      void this.settle(pos.id, hitStop ? 'STOP_OUT' : 'TAKE_PROFIT');
    }
  }

  /**
   * A restart (or a Render cold start) must not strand money in OPEN trades.
   * Anything already past expiry settles immediately; the rest get fresh timers.
   */
  private async recoverOpenTrades(): Promise<void> {
    const { data, error } = await db
      .from('trades')
      .select('*')
      .eq('status', 'OPEN');
    if (error) {
      console.error('[trading] failed to load open trades:', error.message);
      return;
    }
    const rows = (data ?? []) as TradeRow[];
    if (rows.length) console.log('[trading] recovering ' + rows.length + ' open trade(s)');
    for (const row of rows) {
      const trade = toPublicTrade(row);
      const msLeft = new Date(row.expires_at).getTime() - Date.now();
      if (msLeft <= 0) {
        await this.settle(row.id, 'EXPIRY');
      } else {
        // Barriers have to be watched again after a restart, or a recovered
        // position could run past its stop-out untouched until expiry.
        this.track(trade);
        this.scheduleSettlement(row.id, msLeft);
      }
    }
  }

  private track(trade: PublicTrade): void {
    if (trade.stopOutPrice === null || trade.takeProfitPrice === null) return;
    this.live.set(trade.id, {
      id: trade.id,
      direction: trade.direction,
      stopOut: trade.stopOutPrice,
      takeProfit: trade.takeProfitPrice,
    });
  }

  private scheduleSettlement(tradeId: string, msFromNow: number): void {
    const existing = this.timers.get(tradeId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(tradeId);
      this.live.delete(tradeId);
      void this.settle(tradeId, 'EXPIRY');
    }, Math.max(msFromNow, 0));
    this.timers.set(tradeId, timer);
  }

  async placeTrade(params: {
    userId: string;
    mode: 'demo' | 'real';
    direction: 'BUY' | 'SELL';
    stake: number;
    durationSec: Duration;
  }): Promise<{ trade: PublicTrade; balance: number }> {
    const { userId, mode, direction, stake, durationSec } = params;

    if (!Number.isFinite(stake)) {
      throw new TradeError('INVALID_STAKE', 'Enter a valid trade amount.');
    }
    const rounded = Math.round(stake * 100) / 100;
    if (rounded < env.minStake || rounded > env.maxStake) {
      throw new TradeError(
        'STAKE_OUT_OF_RANGE',
        'Trade amount must be between KSh ' + env.minStake + ' and KSh ' +
          env.maxStake.toLocaleString('en-KE') + '.'
      );
    }
    if (!ALLOWED_DURATIONS.includes(durationSec)) {
      throw new TradeError('INVALID_DURATION', 'Choose one of the offered trade durations.');
    }

    // Refuse to open a position until the feed has a real quote behind it.
    // Straight after a cold start the price is still the fallback seed, and a
    // trade opened there would settle against a number we invented.
    if (!priceFeed.isReady()) {
      throw new TradeError(
        'FEED_NOT_READY',
        'Market feed is still connecting. Try again in a few seconds.',
        503
      );
    }

    // The entry price is whatever the server's feed says right now — never a
    // value supplied by the browser.
    const entry = priceFeed.current().price;
    const multiplier = multiplierFor(durationSec);
    const { stopOut, takeProfit } = exitLevels(
      entry,
      direction,
      multiplier,
      env.maxProfitMultiple
    );

    const { data, error } = await db.rpc('fpesa_place_trade', {
      p_user: userId,
      p_mode: mode,
      p_direction: direction,
      p_stake: rounded,
      p_duration: durationSec,
      p_entry: entry,
      p_payout_rate: env.payoutRate,
      p_symbol: SYMBOL,
      p_multiplier: multiplier,
      p_stop_out: stopOut,
      p_take_profit: takeProfit,
      p_max_profit: Math.round(rounded * env.maxProfitMultiple * 100) / 100,
    });

    if (error) {
      const code = pgErrorCode(error.message);
      if (code === 'INSUFFICIENT_FUNDS') {
        throw new TradeError(
          'INSUFFICIENT_FUNDS',
          mode === 'demo'
            ? 'Your demo balance is too low for that amount.'
            : 'Insufficient balance. Deposit to continue trading.'
        );
      }
      if (code === 'USER_NOT_FOUND') throw new TradeError('USER_NOT_FOUND', 'Account not found.', 404);
      console.error('[trading] place failed:', error.message);
      throw new TradeError('TRADE_FAILED', 'Could not open the trade. Please try again.', 500);
    }

    const result = data as { trade: TradeRow; balance: string | number };
    const trade = toPublicTrade(result.trade);
    this.track(trade);
    this.scheduleSettlement(trade.id, durationSec * 1000);

    return { trade, balance: Number(result.balance) };
  }

  /** Settles one trade against the live feed. Safe to call twice. */
  async settle(tradeId: string, reason: 'EXPIRY' | 'STOP_OUT' | 'TAKE_PROFIT'): Promise<void> {
    const exit = priceFeed.current().price;
    this.live.delete(tradeId);

    const { data, error } = await db.rpc('fpesa_settle_trade', {
      p_trade: tradeId,
      p_exit: exit,
      p_reason: reason,
    });

    if (error) {
      console.error('[trading] settle failed for ' + tradeId + ':', error.message);
      // Retry once shortly; a transient DB blip should not strand a stake.
      this.scheduleSettlement(tradeId, 3000);
      return;
    }

    const result = data as
      | { already_settled: true }
      | { trade: TradeRow; balance: string | number };

    if ('already_settled' in result) return;

    const trade = toPublicTrade(result.trade);
    const balance = Number(result.balance);

    hub.toUser(result.trade.user_id, { type: 'trade', trade, balance });

    // Real-money wins above a threshold surface on the public activity feed.
    if (trade.accountMode === 'real' && trade.status === 'WON' && (trade.profit ?? 0) >= 500) {
      const { data: userRow } = await db
        .from('users')
        .select('username')
        .eq('id', result.trade.user_id)
        .maybeSingle();
      const username = (userRow as { username?: string } | null)?.username;
      if (username) {
        await db.from('activity_feed').insert({
          kind: 'BIG_WIN',
          username,
          amount: trade.profit ?? 0,
        });
        hub.broadcast({
          type: 'feed',
          kind: 'BIG_WIN',
          username: maskUsername(username),
          amount: trade.profit ?? 0,
          createdAt: new Date().toISOString(),
        });
      }
    }

    if (trade.accountMode === 'real') void this.publishLeaderboard();
  }

  async publishLeaderboard(): Promise<void> {
    const rows = await getLeaderboard();
    hub.broadcast({ type: 'leaderboard', rows });
  }
}

export type LeaderboardRow = {
  username: string;
  profit: number;
  wins: number;
  trades: number;
};

export async function getLeaderboard(limit = 5): Promise<LeaderboardRow[]> {
  const { data, error } = await db.rpc('fpesa_leaderboard', { p_limit: limit });
  if (error) {
    console.error('[trading] leaderboard failed:', error.message);
    return [];
  }
  return ((data ?? []) as Array<{
    username: string;
    profit: string | number;
    wins: string | number;
    trades: string | number;
  }>).map((r) => ({
    username: maskUsername(r.username),
    profit: Number(r.profit),
    wins: Number(r.wins),
    trades: Number(r.trades),
  }));
}

/**
 * Public boards and feeds show a partly-masked handle. Traders get recognition
 * without the site publishing a full list of who holds a balance.
 */
export function maskUsername(name: string): string {
  if (name.length <= 2) return name[0] + '*';
  if (name.length <= 4) return name.slice(0, 2) + '*'.repeat(name.length - 2);
  return name.slice(0, 3) + '*'.repeat(Math.min(name.length - 3, 4));
}

export const tradingEngine = new TradingEngine();
