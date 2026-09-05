import { db } from '../lib/db.js';
import { env } from '../env.js';

export type DailyExposure = {
  deposits: number;
  withdrawals: number;
  netPaidOut: number;
  stakes: number;
  trades: number;
  payoutRatio: number;
};

const EMPTY: DailyExposure = {
  deposits: 0,
  withdrawals: 0,
  netPaidOut: 0,
  stakes: 0,
  trades: 0,
  payoutRatio: 0,
};

/**
 * Daily disbursement guard.
 *
 * This is a book control, not an outcome control. It decides whether the desk
 * keeps *accepting* new real-money positions; it never changes the result of a
 * position already open, and it never withholds a payout that has been won.
 * Winners are always paid — the lever is whether new risk is taken on.
 *
 * Cached briefly because it is consulted on every real trade.
 */
class ExposureGuard {
  private cached: DailyExposure = EMPTY;
  private fetchedAt = 0;
  private inFlight: Promise<DailyExposure> | null = null;

  private async load(): Promise<DailyExposure> {
    const { data, error } = await db.rpc('fpesa_daily_exposure');
    if (error) {
      console.error('[exposure] daily read failed:', error.message);
      return this.cached;
    }
    const row = (data as Array<Record<string, string | number>> | null)?.[0];
    if (!row) return EMPTY;

    this.cached = {
      deposits: Number(row.deposits ?? 0),
      withdrawals: Number(row.withdrawals ?? 0),
      netPaidOut: Number(row.net_paid_out ?? 0),
      stakes: Number(row.stakes ?? 0),
      trades: Number(row.trades ?? 0),
      payoutRatio: Number(row.payout_ratio ?? 0),
    };
    this.fetchedAt = Date.now();
    return this.cached;
  }

  async read(maxAgeMs = 15_000): Promise<DailyExposure> {
    if (Date.now() - this.fetchedAt < maxAgeMs) return this.cached;
    if (!this.inFlight) {
      this.inFlight = this.load().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  /**
   * Whether a new real-money position may be opened. Returns a reason when it
   * may not, so the trader is told the desk is closed rather than silently
   * losing. Demo trading is never gated.
   */
  async allowRealTrade(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const cap = env.dailyPayoutCap;
    if (cap <= 0) return { ok: true };

    const day = await this.read();
    // No deposits yet today means no ratio to speak of; let the desk open.
    if (day.deposits <= 0) return { ok: true };
    if (day.payoutRatio < cap) return { ok: true };

    return {
      ok: false,
      reason:
        'Live trading is closed for today — the desk has reached its daily ' +
        'payout limit. Demo trading is still open, and it reopens at midnight.',
    };
  }
}

export const exposureGuard = new ExposureGuard();
