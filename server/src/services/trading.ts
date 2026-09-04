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
  };
}

export const ALLOWED_DURATIONS = [5, 10, 15, 30, 60] as const;
export type Duration = (typeof ALLOWED_DURATIONS)[number];

export class TradeError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

class TradingEngine {
  private timers = new Map<string, NodeJS.Timeout>();
  private leaderboardTimer: NodeJS.Timeout | null = null;

  async start(): Promise<void> {
    await this.recoverOpenTrades();
    // Keep the board fresh even during quiet periods.
    this.leaderboardTimer = setInterval(() => void this.publishLeaderboard(), 20_000);
    void this.publishLeaderboard();
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.leaderboardTimer) clearInterval(this.leaderboardTimer);
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
      const msLeft = new Date(row.expires_at).getTime() - Date.now();
      if (msLeft <= 0) {
        await this.settle(row.id);
      } else {
        this.scheduleSettlement(row.id, msLeft);
      }
    }
  }

  private scheduleSettlement(tradeId: string, msFromNow: number): void {
    const existing = this.timers.get(tradeId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(tradeId);
      void this.settle(tradeId);
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

    // The entry price is whatever the server's feed says right now — never a
    // value supplied by the browser.
    const entry = priceFeed.current().price;

    const { data, error } = await db.rpc('fpesa_place_trade', {
      p_user: userId,
      p_mode: mode,
      p_direction: direction,
      p_stake: rounded,
      p_duration: durationSec,
      p_entry: entry,
      p_payout_rate: env.payoutRate,
      p_symbol: SYMBOL,
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
    this.scheduleSettlement(trade.id, durationSec * 1000);

    return { trade, balance: Number(result.balance) };
  }

  /** Settles one trade against the live feed. Safe to call twice. */
  async settle(tradeId: string): Promise<void> {
    const exit = priceFeed.current().price;
    const { data, error } = await db.rpc('fpesa_settle_trade', {
      p_trade: tradeId,
      p_exit: exit,
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
