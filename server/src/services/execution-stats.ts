/**
 * How long it takes to stamp an entry price, and how far price moved while we
 * were doing it.
 *
 * ## The question this answers
 *
 * "Can the infrastructure route an order fast enough" is a real concern, but on
 * a venue with an order book it is about queue position — being ahead of someone
 * else for a limited fill. Fpesa has no book and no queue: a position is a row,
 * the entry price is whatever the server's own feed reads at the moment of
 * writing, and no trader is competing with another for it. Speed cannot win
 * anyone a better fill here.
 *
 * What latency *does* affect is fairness, and that is worth measuring. A trader
 * taps Buy at the price on their screen; the server reads its feed some
 * milliseconds later and stamps whatever it finds. That gap is uncontrolled
 * slippage, in whichever direction the market happened to go. Nobody chose it
 * and nobody profits from it systematically, but if it is large relative to the
 * distance to the stop-out, the price a trader agreed to is not the price they
 * got.
 *
 * So the useful figure is not milliseconds on their own — it is the price move
 * over those milliseconds, expressed against the barrier the trade is measured
 * from. 0.4% of the barrier is noise. 20% of it is a different product.
 *
 * None of this needs to know a future price. It needs a clock and the two
 * prices that actually occurred, which is why a live seed does nothing for it.
 */

const WINDOW = 500;

type Sample = {
  at: number;
  symbol: string;
  /** Request arrival to the feed read that becomes the entry. */
  stampMs: number;
  /** The database write that records the position. */
  writeMs: number;
  /** Price move over stampMs, as a share of the distance to the stop-out. */
  driftShareOfBarrier: number;
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(Math.floor((p / 100) * sorted.length), sorted.length - 1);
  return sorted[i]!;
}

class ExecutionStats {
  private samples: Sample[] = [];

  record(s: Omit<Sample, 'at'>): void {
    this.samples.push({ ...s, at: Date.now() });
    if (this.samples.length > WINDOW) this.samples.shift();
  }

  /**
   * Percentiles over the recent window.
   *
   * p99 on a few hundred samples is a single observation, so it is reported as
   * "worst seen" rather than dressed up as a percentile it cannot support.
   */
  summary(): {
    samples: number;
    stampMs: { p50: number; p95: number; worst: number };
    writeMs: { p50: number; p95: number; worst: number };
    driftShareOfBarrier: { p50: number; p95: number; worst: number };
    oldestAt: number | null;
  } {
    const n = this.samples.length;
    const pick = (f: (s: Sample) => number): { p50: number; p95: number; worst: number } => {
      const sorted = this.samples.map(f).sort((a, b) => a - b);
      return {
        p50: Number(percentile(sorted, 50).toFixed(3)),
        p95: Number(percentile(sorted, 95).toFixed(3)),
        worst: Number((sorted[sorted.length - 1] ?? 0).toFixed(3)),
      };
    };

    return {
      samples: n,
      stampMs: pick((s) => s.stampMs),
      writeMs: pick((s) => s.writeMs),
      driftShareOfBarrier: pick((s) => s.driftShareOfBarrier),
      oldestAt: n ? this.samples[0]!.at : null,
    };
  }
}

export const executionStats = new ExecutionStats();
