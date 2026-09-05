import { db } from '../lib/db.js';
import { env } from '../env.js';
import { hub } from '../realtime/hub.js';

export type DailyExposure = {
  deposits: number;
  withdrawals: number;
  netPaidOut: number;
  stakes: number;
  trades: number;
  payoutRatio: number;
};

export type DeskState = {
  open: boolean;
  reason: string | null;
  ratio: number;
  cap: number;
  reopenAt: number;
};

const EMPTY: DailyExposure = {
  deposits: 0,
  withdrawals: 0,
  netPaidOut: 0,
  stakes: 0,
  trades: 0,
  payoutRatio: 0,
};

const CLOSED_MESSAGE =
  'Live trading is paused — the desk has hit its payout limit for now. ' +
  'It reopens by itself as the book recovers. Demo trading is unaffected.';

/**
 * Daily disbursement guard.
 *
 * A book control, not an outcome control: it decides whether the desk keeps
 * *accepting* new real-money positions. It never changes the result of an open
 * position and never withholds a payout that has been won.
 *
 * The gate is re-evaluated continuously rather than latched, so the desk comes
 * back on its own — the ratio falls whenever fresh deposits arrive or the book
 * wins trades, and it resets outright at Nairobi midnight.
 */
class ExposureGuard {
  private cached: DailyExposure = EMPTY;
  private fetchedAt = 0;
  private inFlight: Promise<DailyExposure> | null = null;
  private open = true;
  private timer: NodeJS.Timeout | null = null;

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

  /** Ratio at which a closed desk is allowed to reopen. */
  private reopenLevel(): number {
    return env.dailyPayoutCap * env.dailyPayoutReopenFactor;
  }

  /**
   * Applies hysteresis to the ratio.
   *
   * Closing and reopening on the same number would make the desk flicker:
   * one deposit nudges the ratio under the cap and it opens, the next winning
   * trade nudges it back over and it shuts, over and over within seconds. So
   * it closes at the cap but only reopens once the ratio has fallen to a
   * clearly lower level.
   */
  private evaluate(day: DailyExposure): boolean {
    if (env.dailyPayoutCap <= 0) return true;
    if (day.deposits <= 0) return true;

    if (this.open) {
      if (day.payoutRatio >= env.dailyPayoutCap) this.open = false;
    } else if (day.payoutRatio <= this.reopenLevel()) {
      this.open = true;
    }
    return this.open;
  }

  state(): DeskState {
    return {
      open: this.open,
      reason: this.open ? null : CLOSED_MESSAGE,
      ratio: this.cached.payoutRatio,
      cap: env.dailyPayoutCap,
      reopenAt: this.reopenLevel(),
    };
  }

  async allowRealTrade(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const day = await this.read();
    return this.evaluate(day) ? { ok: true } : { ok: false, reason: CLOSED_MESSAGE };
  }

  /**
   * Re-checks the book on a timer and announces any change, so a trader
   * already sitting on the page sees the desk reopen without refreshing or
   * discovering it by having a tap rejected.
   */
  start(): void {
    const tick = async (): Promise<void> => {
      const was = this.open;
      this.evaluate(await this.read(0));
      if (was !== this.open) {
        console.log(
          '[exposure] desk ' + (this.open ? 'reopened' : 'closed') +
          ' at ratio ' + this.cached.payoutRatio.toFixed(4)
        );
        hub.broadcast({ type: 'desk', ...this.state() });
      }
    };
    this.timer = setInterval(() => void tick().catch(() => undefined), 20_000);
    void tick().catch(() => undefined);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

export const exposureGuard = new ExposureGuard();
