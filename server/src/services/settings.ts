import { db } from '../lib/db.js';
import { env } from '../env.js';

/**
 * Runtime settings the operator can change without a redeploy.
 *
 * The house edge used to be TRADE_HOUSE_EDGE, which meant repricing the product
 * required a deploy — and in practice meant it never got repriced. It now lives
 * beside the operator float: stored, audited, changeable from the console.
 *
 * ## Why it is cached rather than read per trade
 *
 * Pricing a position must not depend on a database round trip. A slow read
 * would delay the entry stamp, which is the one moment where latency turns into
 * uncontrolled slippage for the trader. So the value is held in memory, refreshed
 * on a timer and immediately on an admin change, and every read is synchronous.
 *
 * A failed refresh keeps the last known value rather than falling back to the
 * deploy-time default. Silently reverting to a different price because a
 * database blinked would be worse than being briefly stale: traders would be
 * charged one spread while the console showed another.
 */

const REFRESH_MS = 30_000;

class Settings {
  private edge: number = env.houseEdge;
  private edgeIsManaged = false;
  private timer: NodeJS.Timeout | null = null;

  /** The live house edge. Synchronous on purpose — see the note above. */
  houseEdge(): number {
    return this.edge;
  }

  /** True once it has been set from the console rather than inherited from the deploy. */
  isManaged(): boolean {
    return this.edgeIsManaged;
  }

  async refresh(): Promise<number> {
    try {
      const { data, error } = await db
        .from('platform_settings')
        .select('value')
        .eq('key', 'house_edge')
        .maybeSingle();
      if (error) throw new Error(error.message);
      const row = data as { value: string | number } | null;
      if (row) {
        const value = Number(row.value);
        // Same bound the database enforces. A value outside it means something
        // wrote to the table directly, and the safe response is to ignore it
        // rather than price trades from it.
        if (Number.isFinite(value) && value >= 0 && value <= 0.2) {
          this.edge = value;
          this.edgeIsManaged = true;
        } else {
          console.error('[settings] house_edge out of range (' + value + '), keeping ' + this.edge);
        }
      }
    } catch (err) {
      console.error('[settings] could not refresh:', err);
    }
    return this.edge;
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const settings = new Settings();
