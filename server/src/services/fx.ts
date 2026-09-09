import { env } from '../env.js';

/**
 * USD to KES, for deposits quoted in dollars.
 *
 * The ledger is and stays shillings — balances, stakes, payouts, the book, all
 * of it. Only the deposit screen is denominated in dollars, and the shilling
 * figure the customer is actually charged is computed here, on the server, at
 * the moment the request is made. A rate the browser worked out is a rate the
 * browser can be wrong about or lie about; this one is what the STK push uses.
 *
 * Cached for an hour. A rate that moves half a percent between two deposits is
 * not worth a network call per keystroke, and the fallback exists so a dead
 * upstream degrades to a stale-but-sane number rather than to no deposits.
 */

const CACHE_MS = 60 * 60 * 1000;

let cached = 0;
let fetchedAt = 0;
let inflight: Promise<number> | null = null;

/** Sanity bounds. A rate outside these is a broken feed, not a market move. */
const FLOOR = 50;
const CEILING = 400;

async function fetchRate(): Promise<number | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = (await res.json()) as { rates?: Record<string, number> };
    const kes = body.rates?.KES;
    if (typeof kes !== 'number' || !Number.isFinite(kes)) return null;
    if (kes < FLOOR || kes > CEILING) {
      console.warn('[fx] ignoring implausible USD/KES rate: ' + kes);
      return null;
    }
    return kes;
  } catch {
    return null;
  }
}

/** The live rate, or the last good one, or the configured fallback. */
export async function usdKes(): Promise<number> {
  if (cached && Date.now() - fetchedAt < CACHE_MS) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    const fresh = await fetchRate();
    if (fresh !== null) {
      cached = fresh;
      fetchedAt = Date.now();
    } else if (!cached) {
      cached = env.fxUsdKesFallback;
      // Deliberately not stamping fetchedAt: a fallback should keep trying for
      // the real rate rather than settle in for an hour.
      console.warn('[fx] using the configured fallback rate ' + cached);
    }
    inflight = null;
    return cached;
  })();

  return inflight;
}

/** Last known rate without a network call. */
export function peekRate(): number {
  return cached || env.fxUsdKesFallback;
}

/** Dollars to whole shillings, rounded the way the customer will be charged. */
export function toKes(usd: number, rate: number): number {
  return Math.round(usd * rate);
}

/** Warms the cache at boot so the first deposit screen has a real rate. */
export function startFx(): void {
  void usdKes();
  setInterval(() => void usdKes(), CACHE_MS);
}
