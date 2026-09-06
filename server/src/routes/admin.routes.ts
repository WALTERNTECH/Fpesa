import { Router } from 'express';
import { env } from '../env.js';
import { db } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { exposureGuard } from '../services/exposure.js';
import { priceFeed, SYMBOL } from '../services/prices.js';
import { ALLOWED_DURATIONS, multiplierFor } from '../services/trading.js';

export const adminRouter = Router();

adminRouter.use(requireAuth, (req, res, next) => {
  if (!req.user!.isAdmin) {
    res.status(403).json({ error: 'FORBIDDEN', message: 'Admins only.' });
    return;
  }
  next();
});

/**
 * Operator overview: the book, the float, and the shape of the instrument.
 *
 * What this deliberately does not contain is any forward price. The engine can
 * produce one — it is deterministic — but serving it would let whoever holds
 * this endpoint take the other side of every customer position with certainty,
 * which is the thing the published commitment scheme exists to rule out. The
 * distribution is here instead: it is what can be known about the future
 * without knowing an individual outcome.
 */
adminRouter.get('/overview', async (_req, res) => {
  const { data, error } = await db.rpc('fpesa_admin_overview');
  if (error) {
    console.error('[admin] overview failed:', error.message);
    res.status(500).json({ error: 'LOAD_FAILED', message: 'Could not load the overview.' });
    return;
  }

  const engine = priceFeed.engine();
  const quote = priceFeed.stats();
  const day = await exposureGuard.read(0);

  res.json({
    ...(data as Record<string, unknown>),
    desk: exposureGuard.state(),
    exposure: day,
    instrument: {
      symbol: SYMBOL,
      name: env.symbolName,
      mode: env.priceMode,
      price: quote.price,
      change: quote.change,
      changePct: quote.changePct,
      provablyFair: engine !== null,
      epoch: engine ? engine.commitment().epoch : null,
      commitment: engine ? engine.commitment().seedHash : null,
      params: engine ? engine.params() : null,
    },
    settings: {
      houseEdge: env.houseEdge,
      turnoverMultiple: env.turnoverMultiple,
      dailyPayoutCap: env.dailyPayoutCap,
      dailyPayoutReopenFactor: env.dailyPayoutReopenFactor,
      dailyPayoutMinBase: env.dailyPayoutMinBase,
      maxProfitMultiple: env.maxProfitMultiple,
      minStake: env.minStake,
      maxStake: env.maxStake,
      multipliers: Object.fromEntries(
        ALLOWED_DURATIONS.map((d) => [String(d), multiplierFor(d)])
      ),
    },
    /**
     * How the instrument behaves, per duration — the operator's real forecast.
     * A 1-sigma move is what roughly two thirds of positions land inside, and
     * the stop-out figure is how far price must run to wipe a stake at that
     * duration's multiplier.
     */
    distribution: engine
      ? ALLOWED_DURATIONS.map((d) => {
          const sigma = engine.params().sigma * Math.sqrt(d);
          const mult = multiplierFor(d);
          return {
            duration: d,
            multiplier: mult,
            oneSigmaPct: Number((sigma * 100).toFixed(4)),
            oneSigmaPrice: Number((quote.price * sigma).toFixed(2)),
            /** Fraction of stake a 1-sigma move is worth at this multiplier. */
            oneSigmaStakePct: Number((sigma * mult * 100).toFixed(1)),
            stopOutMovePct: Number(((1 / mult) * 100).toFixed(4)),
            /** Roughly how often a position is wiped out, two-tailed normal. */
            stopOutOdds: Number((2 * (1 - normalCdf(1 / (sigma * mult))) * 100).toFixed(2)),
          };
        })
      : null,
  });
});

/** Abramowitz-Stegun 7.1.26 — plenty accurate for an operations readout. */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p =
    d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 +
      t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}
