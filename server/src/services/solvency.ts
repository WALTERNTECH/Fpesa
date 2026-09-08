import { db } from '../lib/db.js';
import { env } from '../env.js';

export type BookFloat = {
  cash: number;
  operatorFloat: number;
  owed: number;
  atRisk: number;
  headroom: number;
};

const EMPTY: BookFloat = { cash: 0, operatorFloat: 0, owed: 0, atRisk: 0, headroom: 0 };

/**
 * The book's capacity to pay a winner.
 *
 * This is a cached *display* of the figure the database computes. The decision
 * that matters — whether one position may open — is made inside
 * fpesa_place_trade in the same transaction that debits the balance, because
 * two trades arriving together must not both pass a limit only one of them
 * fits in. Nothing here is allowed to authorise a trade.
 */
class SolvencyView {
  private cached: BookFloat = EMPTY;
  private readAt = 0;
  private inflight: Promise<BookFloat> | null = null;

  /** Fresh enough for a ceiling shown in the UI; never used to permit a trade. */
  async read(maxAgeMs = 10_000): Promise<BookFloat> {
    if (Date.now() - this.readAt < maxAgeMs) return this.cached;
    if (this.inflight) return this.inflight;

    this.inflight = (async () => {
      try {
        const { data, error } = await db.rpc('fpesa_book_float', {
          p_operator_float: env.operatorFloat,
        });
        if (error) throw new Error(error.message);
        const row = data as Record<string, string | number>;
        this.cached = {
          cash: Number(row.cash ?? 0),
          operatorFloat: Number(row.operatorFloat ?? 0),
          owed: Number(row.owed ?? 0),
          atRisk: Number(row.atRisk ?? 0),
          headroom: Number(row.headroom ?? 0),
        };
        this.readAt = Date.now();
      } catch (err) {
        console.error('[solvency] could not read the book float:', err);
        // Keep the last known figure rather than reporting infinite capacity.
      } finally {
        this.inflight = null;
      }
      return this.cached;
    })();

    return this.inflight;
  }

  /** Last figure read, without touching the database. */
  peek(): BookFloat {
    return this.cached;
  }

  /**
   * Drops the cache so the next read hits the database.
   *
   * Called when the operator changes the float. Ten seconds of staleness is
   * harmless in the direction that matters — the authoritative check runs
   * inside the trade transaction — but after the float is *lowered* it leaves
   * the panel advertising a ceiling the book no longer has, and a trader typing
   * that number and being refused is the exact experience the ceiling exists
   * to prevent.
   */
  invalidate(): void {
    this.readAt = 0;
  }

  /**
   * The largest live stake the book could currently cover, given that a
   * position's worst case is stake x maxProfitMultiple.
   *
   * Returned so the trade panel can show a real ceiling instead of letting
   * someone type an amount that is only refused after they tap.
   */
  maxLiveStake(headroom = this.cached.headroom): number {
    if (env.maxProfitMultiple <= 0) return env.maxStake;
    // A position may only take a share of the book, so the ceiling is measured
    // against that share rather than the whole of headroom.
    const room = Math.max(0, headroom) * env.maxPositionShare;
    const affordable = Math.floor(room / env.maxProfitMultiple);
    return Math.max(0, Math.min(env.maxStake, affordable));
  }
}

export const solvency = new SolvencyView();
