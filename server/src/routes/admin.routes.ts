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

type InstrumentView = {
  symbol: string;
  name: string;
  mode: string;
  price: number;
  change: number;
  changePct: number;
  provablyFair: boolean;
  epoch: number | null;
  commitment: string | null;
  params: { tickMs: number; epochMs: number; sigma: number; drift: number } | null;
};

type DeskView = {
  open: boolean;
  ratio: number;
  cap: number;
  reopenAt: number;
  armed: boolean;
  minBase: number;
};

/**
 * The operations console runs no price engine of its own — a second engine
 * would generate a second, different market — so it reads live instrument and
 * desk state from the trading service instead. Book figures still come
 * straight from the shared database, so they stay correct even if the trading
 * service is unreachable.
 */
async function fromUpstream(): Promise<{
  instrument: InstrumentView | null;
  desk: DeskView | null;
  ok: boolean;
}> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const [fairRes, cfgRes] = await Promise.all([
      fetch(env.upstreamUrl + '/api/fairness', { signal: ctrl.signal }),
      fetch(env.upstreamUrl + '/api/market/config', { signal: ctrl.signal }),
    ]);
    clearTimeout(timer);
    if (!fairRes.ok || !cfgRes.ok) return { instrument: null, desk: null, ok: false };

    const fair = (await fairRes.json()) as Record<string, never>;
    const cfg = (await cfgRes.json()) as Record<string, never>;
    const f = fair as unknown as {
      symbol: string; name?: string; mode: string; provablyFair: boolean;
      current?: { epoch: number; seedHash: string };
      parameters?: { tickMs: number; epochMs: number; sigma: number; drift: number };
    };
    const c = cfg as unknown as {
      symbol: string; symbolName: string;
      desk: DeskView;
    };

    return {
      ok: true,
      instrument: {
        symbol: f.symbol ?? c.symbol,
        name: f.name ?? c.symbolName,
        mode: f.mode,
        price: 0, // filled from the quote below
        change: 0,
        changePct: 0,
        provablyFair: Boolean(f.provablyFair),
        epoch: f.current?.epoch ?? null,
        commitment: f.current?.seedHash ?? null,
        params: f.parameters ?? null,
      },
      desk: c.desk ?? null,
    };
  } catch {
    return { instrument: null, desk: null, ok: false };
  }
}

async function upstreamQuote(): Promise<{ price: number; change: number; changePct: number }> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(env.upstreamUrl + '/api/market/quote', { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return { price: 0, change: 0, changePct: 0 };
    const q = (await res.json()) as { price: number; change: number; changePct: number };
    return { price: q.price, change: q.change, changePct: q.changePct };
  } catch {
    return { price: 0, change: 0, changePct: 0 };
  }
}

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

  const day = await exposureGuard.read(0);
  const remote = env.appMode === 'admin';

  let instrument: InstrumentView | null;
  let desk: DeskView | null;
  let upstreamOk = true;

  if (remote) {
    const up = await fromUpstream();
    upstreamOk = up.ok;
    desk = up.desk;
    instrument = up.instrument;
    if (instrument) {
      const q = await upstreamQuote();
      instrument.price = q.price;
      instrument.change = q.change;
      instrument.changePct = q.changePct;
    }
  } else {
    const engine = priceFeed.engine();
    const quote = priceFeed.stats();
    const state = exposureGuard.state();
    instrument = {
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
    };
    desk = {
      open: state.open,
      ratio: state.ratio,
      cap: state.cap,
      reopenAt: state.reopenAt,
      armed: state.armed,
      minBase: state.minBase,
    };
  }

  const sigma = instrument?.params?.sigma ?? null;
  const price = instrument?.price ?? 0;

  res.json({
    ...(data as Record<string, unknown>),
    desk: desk ?? {
      open: true, ratio: day.payoutRatio, cap: env.dailyPayoutCap,
      reopenAt: env.dailyPayoutCap * env.dailyPayoutReopenFactor,
      armed: day.deposits >= env.dailyPayoutMinBase, minBase: env.dailyPayoutMinBase,
    },
    exposure: day,
    instrument,
    upstream: remote ? { ok: upstreamOk, url: env.upstreamUrl } : undefined,
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
    distribution:
      sigma === null
        ? null
        : ALLOWED_DURATIONS.map((d) => {
            const s = sigma * Math.sqrt(d);
            const mult = multiplierFor(d);
            return {
              duration: d,
              multiplier: mult,
              oneSigmaPct: Number((s * 100).toFixed(4)),
              oneSigmaPrice: Number((price * s).toFixed(2)),
              oneSigmaStakePct: Number((s * mult * 100).toFixed(1)),
              stopOutMovePct: Number(((1 / mult) * 100).toFixed(4)),
              stopOutOdds: Number((2 * (1 - normalCdf(1 / (s * mult))) * 100).toFixed(2)),
            };
          }),
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
