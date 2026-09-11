import { Router } from 'express';
import { env } from '../env.js';
import { db, pgErrorCode } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { notifyBalance, notifyEdgeChanged, notifyFloatChanged } from './internal.routes.js';
import { exposureGuard } from '../services/exposure.js';
import { solvency } from '../services/solvency.js';
import { priceFeed, SYMBOL } from '../services/prices.js';
import { ALLOWED_DURATIONS, multiplierFor } from '../services/trading.js';

export const adminRouter = Router();

/**
 * The share of positions that finish profitable at a given spread.
 *
 * Uses the normalCdf declared further down this file — declarations hoist, and
 * one copy of an approximation is better than two that can drift.
 *
 * Quoted on the reference ticket — FPX100 over 10s — because a win rate has no
 * meaning without saying on what. The shape is the same on every instrument,
 * since the multipliers are scaled to hold the barrier at a constant number of
 * standard deviations.
 *
 * It approaches 50% as the spread approaches zero and never passes it. That
 * ceiling is not a tuning choice: the series is driftless and symmetric, so
 * with no spread a position is a coin flip, and the gap below 50% is exactly
 * the house's revenue.
 */
function winRateAt(edge: number): number {
  const multiplier = multiplierFor(10, SYMBOL);
  const sd = env.synth.sigma * Math.sqrt(10);
  return 1 - normalCdf(edge / multiplier / sd);
}

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
  const book = await solvency.read(0);
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
    /**
     * Whether the book can pay what it might owe. headroom is what is left
     * after every live balance and the worst case on every open position; it is
     * what limits how large a live trade may be.
     */
    float: {
      ...book,
      maxLiveStake: solvency.maxLiveStake(book.headroom),
      positionShare: env.maxPositionShare,
    },
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

type OpenRow = {
  direction: 'BUY' | 'SELL';
  stake: string | number;
  multiplier: string | number;
  entry_price: string | number;
  stop_out_price: string | number | null;
  max_profit: string | number | null;
  expires_at: string;
};

/**
 * The book's live directional risk.
 *
 * This is the operator's actual signal. Not where price is going — nothing
 * knowable says that on a driftless walk — but where the house is exposed if
 * it goes somewhere. If most open stake is on Buy, the house is short and a
 * rally is what costs money.
 *
 * The ladder prices that out: for each candidate move it sums what every open
 * position would pay or lose, applying the same clamps settlement applies, and
 * flips the sign to the house's side.
 */
async function liveExposure(price: number): Promise<{
  openCount: number;
  buyStake: number;
  sellStake: number;
  netBias: number;
  worstCase: number;
  ladder: Array<{ movePct: number; priceAt: number; housePnl: number }>;
} | null> {
  const { data, error } = await db
    .from('trades')
    .select('direction, stake, multiplier, entry_price, stop_out_price, max_profit, expires_at')
    .eq('status', 'OPEN')
    .eq('account_mode', 'real')
    .limit(2000);
  if (error) {
    console.error('[admin] exposure read failed:', error.message);
    return null;
  }
  const rows = (data ?? []) as OpenRow[];

  let buyStake = 0;
  let sellStake = 0;
  for (const r of rows) {
    const stake = Number(r.stake);
    if (r.direction === 'BUY') buyStake += stake;
    else sellStake += stake;
  }

  const traderPnlAt = (p: number): number =>
    rows.reduce((sum, r) => {
      const stake = Number(r.stake);
      const entry = Number(r.entry_price);
      const mult = Number(r.multiplier);
      const cap = r.max_profit === null ? stake : Number(r.max_profit);
      const move = (p - entry) / entry;
      const signed = r.direction === 'BUY' ? move : -move;
      return sum + Math.min(Math.max(stake * mult * signed, -stake), cap);
    }, 0);

  const moves = [-0.002, -0.001, -0.0005, -0.00025, 0, 0.00025, 0.0005, 0.001, 0.002];
  const ladder = moves.map((m) => {
    const at = Math.round(price * (1 + m) * 100) / 100;
    return {
      movePct: Number((m * 100).toFixed(3)),
      priceAt: at,
      // Positive is good for the house: what the traders lose, the book keeps.
      housePnl: Math.round(-traderPnlAt(at) * 100) / 100,
    };
  });

  return {
    openCount: rows.length,
    buyStake: Math.round(buyStake * 100) / 100,
    sellStake: Math.round(sellStake * 100) / 100,
    netBias: Math.round((buyStake - sellStake) * 100) / 100,
    worstCase: Math.round(Math.min(...ladder.map((l) => l.housePnl)) * 100) / 100,
    ladder,
  };
}

/**
 * The operator float: how much of your own capital stands behind the book.
 *
 * Setting it moves no money. It is a statement about what is in the payout
 * wallet, and the solvency guard trusts it completely — so a figure larger than
 * the wallet really holds authorises winnings that cannot be paid. That is why
 * it is audited like a balance adjustment and why the reason is mandatory.
 */
adminRouter.get('/float', async (_req, res) => {
  const [book, setting, history] = await Promise.all([
    solvency.read(0),
    db.from('platform_settings').select('value, reason, updated_at, updated_by')
      .eq('key', 'operator_float').maybeSingle(),
    db.from('platform_settings_log')
      .select('id, old_value, new_value, reason, created_at, admin_id')
      .eq('key', 'operator_float').order('created_at', { ascending: false }).limit(20),
  ]);

  const rows = (history.data ?? []) as Array<Record<string, unknown>>;
  const ids = [...new Set(rows.map((r) => String(r.admin_id)))];
  const { data: people } = ids.length
    ? await db.from('users').select('id, username').in('id', ids)
    : { data: [] as Array<{ id: string; username: string }> };
  const nameOf = new Map(
    ((people ?? []) as Array<{ id: string; username: string }>).map((p) => [p.id, p.username])
  );

  const s = setting.data as Record<string, unknown> | null;
  res.json({
    float: book.operatorFloat,
    book,
    maxLiveStake: solvency.maxLiveStake(book.headroom),
    positionShare: env.maxPositionShare,
    maxProfitMultiple: env.maxProfitMultiple,
    /** True once it has been set here rather than inherited from the deploy. */
    managed: Boolean(s),
    reason: s ? s.reason : null,
    updatedAt: s ? s.updated_at : null,
    history: rows.map((r) => ({
      id: r.id,
      from: r.old_value === null ? null : Number(r.old_value),
      to: Number(r.new_value),
      reason: r.reason,
      admin: nameOf.get(String(r.admin_id)) ?? '—',
      createdAt: r.created_at,
    })),
  });
});

adminRouter.post('/float', async (req, res) => {
  const body = req.body as { amount?: unknown; reason?: unknown };
  const amount = Number(body.amount);
  const reason = String(body.reason ?? '').trim();

  if (!Number.isFinite(amount) || amount < 0) {
    res.status(400).json({
      error: 'INVALID_VALUE',
      message: 'Enter the amount in the payout wallet. It cannot be negative.',
    });
    return;
  }
  if (reason.length < 3) {
    res.status(400).json({
      error: 'REASON_REQUIRED',
      message: 'Give a reason — it is stored against the change.',
    });
    return;
  }

  const { data, error } = await db.rpc('fpesa_set_operator_float', {
    p_admin: req.user!.id,
    p_value: Math.round(amount * 100) / 100,
    p_reason: reason,
  });

  if (error) {
    const code = pgErrorCode(error.message);
    if (code === 'INVALID_VALUE' || code === 'REASON_REQUIRED') {
      res.status(400).json({ error: code, message: 'Check the amount and the reason.' });
      return;
    }
    console.error('[admin] float update failed:', error.message);
    res.status(500).json({ error: 'FLOAT_FAILED', message: 'Could not save the float.' });
    return;
  }

  const result = data as { previous: number | null; value: number };
  console.log(
    '[admin] ' + req.user!.username + ' set the operator float to ' + result.value +
    ' (was ' + (result.previous ?? 'unset') + '): ' + reason
  );

  // The cached view is what the trade panel's ceiling is drawn from, and the
  // trading service keeps its own. Clear both, or a float that was just lowered
  // leaves traders being offered a stake the book can no longer cover.
  await notifyFloatChanged();
  const book = await solvency.read(0);
  res.json({
    ok: true,
    previous: result.previous,
    float: result.value,
    book,
    maxLiveStake: solvency.maxLiveStake(book.headroom),
  });
});

/**
 * Market conditions, for the operator.
 *
 * The console runs no price engine of its own — starting one would generate a
 * second, different market — so this comes from the trading service, the same
 * way the instrument view does.
 *
 * It answers "where is risk lowest right now", which is a real question with a
 * real answer. It does not answer "which way will it go": nothing can, on a
 * series with no drift, and an endpoint that claimed to would put the operator
 * on the other side of information customers are staking money against.
 */
adminRouter.get('/conditions', async (_req, res) => {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const upstream = await fetch(env.upstreamUrl + '/api/market/conditions', {
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!upstream.ok) {
      res.status(502).json({ error: 'UPSTREAM', message: 'Could not read market conditions.' });
      return;
    }
    res.json(await upstream.json());
  } catch {
    res.status(502).json({ error: 'UPSTREAM', message: 'Could not reach the trading service.' });
  }
});

/**
 * The house edge — the price of the product.
 *
 * It was an environment variable, which meant repricing needed a redeploy. It
 * now sits beside the operator float: same table, same audit log, same
 * mandatory reason, because changing what every trader pays is at least as
 * consequential as restating the payout wallet.
 *
 * Bounded 0–20% in the database. Above that it is not a spread — at 80% a
 * position would lose four fifths of its stake the moment it opened — and a
 * stray keystroke must not be able to make every trade on the platform
 * unwinnable.
 */
adminRouter.get('/edge', async (_req, res) => {
  const [setting, history] = await Promise.all([
    db.from('platform_settings').select('value, reason, updated_at')
      .eq('key', 'house_edge').maybeSingle(),
    db.from('platform_settings_log')
      .select('id, old_value, new_value, reason, created_at, admin_id')
      .eq('key', 'house_edge').order('created_at', { ascending: false }).limit(20),
  ]);

  const rows = (history.data ?? []) as Array<Record<string, unknown>>;
  const ids = [...new Set(rows.map((r) => String(r.admin_id)))];
  const { data: people } = ids.length
    ? await db.from('users').select('id, username').in('id', ids)
    : { data: [] as Array<{ id: string; username: string }> };
  const nameOf = new Map(
    ((people ?? []) as Array<{ id: string; username: string }>).map((p) => [p.id, p.username])
  );

  const s = setting.data as Record<string, unknown> | null;
  res.json({
    edge: s ? Number(s.value) : env.houseEdge,
    /** True once set here rather than inherited from the deploy. */
    managed: Boolean(s),
    deployDefault: env.houseEdge,
    min: 0,
    max: 0.2,
    reason: s ? s.reason : null,
    updatedAt: s ? s.updated_at : null,
    history: rows.map((r) => ({
      id: r.id,
      from: r.old_value === null ? null : Number(r.old_value),
      to: Number(r.new_value),
      reason: r.reason,
      admin: nameOf.get(String(r.admin_id)) ?? '—',
      createdAt: r.created_at,
    })),
  });
});

adminRouter.post('/edge', async (req, res) => {
  const body = req.body as { edge?: unknown; reason?: unknown };
  const edge = Number(body.edge);
  const reason = String(body.reason ?? '').trim();

  if (!Number.isFinite(edge) || edge < 0 || edge > 0.2) {
    res.status(400).json({
      error: 'INVALID_VALUE',
      message: 'The edge must be between 0% and 20%. Enter it as a fraction, so 0.05 is 5%.',
    });
    return;
  }
  if (reason.length < 3) {
    res.status(400).json({
      error: 'REASON_REQUIRED',
      message: 'Give a reason — it is stored against the change.',
    });
    return;
  }

  const { data, error } = await db.rpc('fpesa_set_house_edge', {
    p_admin: req.user!.id,
    p_value: edge,
    p_reason: reason,
  });

  if (error) {
    const code = pgErrorCode(error.message);
    if (code === 'INVALID_VALUE' || code === 'REASON_REQUIRED') {
      res.status(400).json({ error: code, message: 'Check the value and the reason.' });
      return;
    }
    console.error('[admin] edge update failed:', error.message);
    res.status(500).json({ error: 'EDGE_FAILED', message: 'Could not save the edge.' });
    return;
  }

  const result = data as { previous: number | null; value: number };
  console.log(
    '[admin] ' + req.user!.username + ' set the house edge to ' +
    (result.value * 100).toFixed(2) + '% (was ' +
    (result.previous === null ? 'unset' : (Number(result.previous) * 100).toFixed(2) + '%') +
    '): ' + reason
  );

  // The trading service prices from a cached copy, so tell it to re-read rather
  // than leaving trades on the old spread for up to half a minute.
  await notifyEdgeChanged();

  res.json({ ok: true, previous: result.previous, edge: result.value });
});

/**
 * Promo codes: a reduced spread, handed out, redeemed by a trader.
 *
 * What a code is really selling is a win rate, so the listing says so in those
 * terms. At 11% a trader wins 39% of positions; at 2%, 48%; at zero, exactly
 * 50% and not a fraction more. An operator choosing a number should see what it
 * buys rather than work it out afterwards.
 */
adminRouter.get('/promos', async (_req, res) => {
  const { data, error } = await db
    .from('promo_codes')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) {
    console.error('[admin] promo list failed:', error.message);
    res.status(500).json({ error: 'LOAD_FAILED', message: 'Could not load promo codes.' });
    return;
  }

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  res.json({
    houseEdge: env.houseEdge,
    codes: rows.map((r) => ({
      code: r.code,
      edge: Number(r.edge),
      hours: r.hours,
      maxRedemptions: r.max_redemptions === null ? null : Number(r.max_redemptions),
      redemptions: Number(r.redemptions),
      expiresAt: r.expires_at,
      active: r.active,
      note: r.note,
      createdAt: r.created_at,
      // The honest headline: what this code does to a 10s FPX100 ticket.
      winRate: Number((winRateAt(Number(r.edge)) * 100).toFixed(1)),
    })),
  });
});

adminRouter.post('/promos', async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const code = String(b.code ?? '').trim().toUpperCase();
  const edge = Number(b.edge);
  const hours = Number(b.hours);
  const maxRedemptions = b.maxRedemptions === null || b.maxRedemptions === undefined
    ? null : Number(b.maxRedemptions);
  const note = String(b.note ?? '').trim() || null;

  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) {
    res.status(400).json({
      error: 'VALIDATION',
      message: 'Code must be 3–32 characters: letters, digits, dash or underscore.',
    });
    return;
  }
  if (!Number.isFinite(edge) || edge < 0 || edge > 0.2) {
    res.status(400).json({
      error: 'VALIDATION',
      message: 'The promo spread must be between 0% and 20%. Enter it as a fraction.',
    });
    return;
  }
  if (!Number.isFinite(hours) || hours < 1 || hours > 720) {
    res.status(400).json({ error: 'VALIDATION', message: 'Hours must be between 1 and 720.' });
    return;
  }
  if (maxRedemptions !== null && (!Number.isFinite(maxRedemptions) || maxRedemptions < 1)) {
    res.status(400).json({ error: 'VALIDATION', message: 'Leave the limit blank or set at least 1.' });
    return;
  }

  const { error } = await db.from('promo_codes').insert({
    code,
    edge,
    hours,
    max_redemptions: maxRedemptions,
    note,
    created_by: req.user!.id,
  });

  if (error) {
    if (error.message.includes('duplicate key')) {
      res.status(400).json({ error: 'DUPLICATE', message: 'That code already exists.' });
      return;
    }
    console.error('[admin] promo create failed:', error.message);
    res.status(500).json({ error: 'CREATE_FAILED', message: 'Could not create the code.' });
    return;
  }

  console.log(
    '[admin] ' + req.user!.username + ' created promo ' + code + ' at ' +
    (edge * 100).toFixed(1) + '% for ' + hours + 'h'
  );
  res.status(201).json({ ok: true, code, edge, hours, winRate: winRateAt(edge) });
});

/** Turns a code off without deleting it, so redemptions already granted stand. */
adminRouter.post('/promos/:code/disable', async (req, res) => {
  const { error } = await db
    .from('promo_codes')
    .update({ active: false })
    .eq('code', String(req.params.code).toUpperCase());
  if (error) {
    res.status(500).json({ error: 'UPDATE_FAILED', message: 'Could not disable the code.' });
    return;
  }
  res.json({ ok: true });
});

// ------------------------------------------------------------ user accounts

/**
 * The register: every account, newest first.
 *
 * An optional `q` narrows it by username or phone. It used to be mandatory,
 * which meant an operator had to already know who they were looking for before
 * they could see anyone — no use at all for "who signed up today" or for
 * finding the account that just phoned about a missing deposit.
 */
adminRouter.get('/users', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
  const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);

  let query = db
    .from('users')
    .select(
      'id, username, phone, demo_balance, real_balance, is_admin, is_active, created_at, last_seen_at',
      { count: 'exact' }
    )
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (q.length > 0) query = query.or('username.ilike.%' + q + '%,phone.ilike.%' + q + '%');

  const { data, error, count } = await query;

  if (error) {
    console.error('[admin] user list failed:', error.message);
    res.status(500).json({ error: 'LOAD_FAILED', message: 'Could not load accounts.' });
    return;
  }

  res.json({
    total: count ?? 0,
    offset,
    limit,
    users: ((data ?? []) as Array<Record<string, unknown>>).map((u) => ({
      id: u.id,
      username: u.username,
      phone: u.phone,
      demoBalance: Number(u.demo_balance),
      realBalance: Number(u.real_balance),
      isAdmin: Boolean(u.is_admin),
      isActive: Boolean(u.is_active),
      createdAt: u.created_at,
      lastSeenAt: u.last_seen_at,
    })),
  });
});

/** One account in full, with its recent money movements and adjustments. */
adminRouter.get('/users/:id', async (req, res) => {
  const [userRes, txRes, adjRes, stmtRes, ovRes] = await Promise.all([
    db.from('users')
      .select('id, username, phone, demo_balance, real_balance, is_admin, is_active, created_at, last_seen_at')
      .eq('id', req.params.id)
      .maybeSingle(),
    db.from('transactions')
      .select('id, kind, amount, status, reference, mpesa_receipt, result_code, result_desc, created_at')
      .eq('user_id', req.params.id)
      .order('created_at', { ascending: false })
      .limit(25),
    db.from('admin_adjustments')
      .select('id, account_mode, amount, balance_before, balance_after, reason, created_at, admin_id')
      .eq('user_id', req.params.id)
      .order('created_at', { ascending: false })
      .limit(25),
    db.rpc('fpesa_user_statement', { p_user: req.params.id }),
    db.from('statement_override_log')
      .select('id, deposits, withdrawals, trades, net_vs_deposits, reason, created_at')
      .eq('user_id', req.params.id)
      .order('created_at', { ascending: false })
      .limit(10),
  ]);

  const u = userRes.data as Record<string, unknown> | null;
  if (userRes.error || !u) {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Account not found.' });
    return;
  }

  res.json({
    user: {
      id: u.id,
      username: u.username,
      phone: u.phone,
      demoBalance: Number(u.demo_balance),
      realBalance: Number(u.real_balance),
      isAdmin: Boolean(u.is_admin),
      isActive: Boolean(u.is_active),
      createdAt: u.created_at,
      lastSeenAt: u.last_seen_at,
    },
    statement: stmtRes.data ?? null,
    transactions: (txRes.data ?? []) as unknown[],
    adjustments: (adjRes.data ?? []) as unknown[],
    statementEdits: (ovRes.data ?? []) as unknown[],
  });
});

/**
 * Manual balance adjustment.
 *
 * This exists because deposits do fail — the STK push times out, the callback
 * never arrives, the reconciliation sweep finds nothing — and the money is
 * genuinely gone from the customer's phone. Someone has to be able to put it
 * where it belongs.
 *
 * It is also the single most abusable call in the system, so it is built to
 * leave a trail rather than to be convenient: a reason is required, the whole
 * change is one locked transaction, the balance either side is recorded, and a
 * real-money credit also writes a line into the trader's own statement so they
 * see it too. Nothing here can quietly move money.
 */
adminRouter.post('/users/:id/balance', async (req, res) => {
  const body = req.body as { amount?: unknown; mode?: unknown; reason?: unknown };
  const amount = Number(body.amount);
  const mode = body.mode === 'demo' ? 'demo' : 'real';
  const reason = String(body.reason ?? '').trim();

  if (!Number.isFinite(amount) || amount === 0) {
    res.status(400).json({
      error: 'INVALID_AMOUNT',
      message: 'Enter an amount to credit (or a negative amount to debit).',
    });
    return;
  }
  if (reason.length < 3) {
    res.status(400).json({
      error: 'REASON_REQUIRED',
      message: 'Give a reason — it is stored against the adjustment.',
    });
    return;
  }

  const { data, error } = await db.rpc('fpesa_admin_adjust_balance', {
    p_admin: req.user!.id,
    p_user: req.params.id,
    p_mode: mode,
    p_amount: Math.round(amount * 100) / 100,
    p_reason: reason,
  });

  if (error) {
    const code = pgErrorCode(error.message);
    const known: Record<string, [number, string]> = {
      USER_NOT_FOUND: [404, 'Account not found.'],
      INSUFFICIENT_FUNDS: [400, 'That debit would take the balance below zero.'],
      REASON_REQUIRED: [400, 'Give a reason for the adjustment.'],
      INVALID_AMOUNT: [400, 'Enter a non-zero amount.'],
      INVALID_MODE: [400, 'Choose the demo or the live balance.'],
    };
    const hit = known[code ?? ''];
    if (hit) {
      res.status(hit[0]).json({ error: code, message: hit[1] });
      return;
    }
    console.error('[admin] balance adjust failed:', error.message);
    res.status(500).json({ error: 'ADJUST_FAILED', message: 'Could not adjust the balance.' });
    return;
  }

  const result = data as {
    adjustmentId: string; mode: 'demo' | 'real';
    before: number; after: number; demoBalance: number; realBalance: number;
  };

  console.log(
    '[admin] ' + req.user!.username + ' adjusted ' + result.mode + ' balance of ' +
    req.params.id + ' by ' + amount + ' (' + result.before + ' -> ' + result.after + '): ' + reason
  );

  // The trader may well be looking at the screen — they have usually just
  // phoned about this — so push the new balance rather than leaving them to
  // discover it on their next reload. The console holds no sockets of its own,
  // so this hops to the trading service.
  await notifyBalance(
    req.params.id,
    Number(result.demoBalance),
    Number(result.realBalance)
  );

  res.json({
    ok: true,
    adjustmentId: result.adjustmentId,
    mode: result.mode,
    before: Number(result.before),
    after: Number(result.after),
    demoBalance: Number(result.demoBalance),
    realBalance: Number(result.realBalance),
  });
});

/**
 * Corrects the lifetime figures on an account.
 *
 * A field left empty returns that figure to what the records actually say, so
 * an override can always be undone. The live balance is not editable here on
 * purpose — it is spendable money, so it goes through the balance adjustment
 * above and its own audit trail. Letting a displayed balance drift away from
 * the one a trader can stake would be a bug with someone's money in it.
 */
adminRouter.post('/users/:id/statement', async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const reason = String(body.reason ?? '').trim();

  if (reason.length < 3) {
    res.status(400).json({
      error: 'REASON_REQUIRED',
      message: 'Give a reason — it is stored against the correction.',
    });
    return;
  }

  /** '' and null both mean "use the records"; anything else must be a number. */
  const optional = (raw: unknown): number | null | undefined => {
    if (raw === undefined || raw === null || raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return undefined;
    return n;
  };

  const deposits = optional(body.deposits);
  const withdrawals = optional(body.withdrawals);
  const trades = optional(body.trades);
  // The net figure is the only one that may legitimately be negative — it is
  // profit and loss against everything paid in.
  const netRaw = body.netVsDeposits;
  const net =
    netRaw === undefined || netRaw === null || netRaw === ''
      ? null
      : Number.isFinite(Number(netRaw))
        ? Number(netRaw)
        : undefined;

  if (deposits === undefined || withdrawals === undefined || trades === undefined || net === undefined) {
    res.status(400).json({
      error: 'INVALID_VALUE',
      message: 'Amounts must be numbers, and deposits, withdrawals and trades cannot be negative.',
    });
    return;
  }

  const { data, error } = await db.rpc('fpesa_set_statement_override', {
    p_admin: req.user!.id,
    p_user: req.params.id,
    p_deposits: deposits,
    p_withdrawals: withdrawals,
    p_trades: trades === null ? null : Math.round(trades),
    p_net: net,
    p_reason: reason,
  });

  if (error) {
    const code = pgErrorCode(error.message);
    const known: Record<string, [number, string]> = {
      USER_NOT_FOUND: [404, 'Account not found.'],
      REASON_REQUIRED: [400, 'Give a reason for the correction.'],
      NEGATIVE_VALUE: [400, 'Deposits, withdrawals and trades cannot be negative.'],
    };
    const hit = known[code ?? ''];
    if (hit) {
      res.status(hit[0]).json({ error: code, message: hit[1] });
      return;
    }
    console.error('[admin] statement override failed:', error.message);
    res.status(500).json({ error: 'OVERRIDE_FAILED', message: 'Could not save the correction.' });
    return;
  }

  const cleared = deposits === null && withdrawals === null && trades === null && net === null;
  console.log(
    '[admin] ' + req.user!.username + (cleared ? ' cleared' : ' set') +
    ' statement figures for ' + req.params.id + ': ' + reason
  );

  res.json({ ok: true, statement: data });
});

/** Every manual adjustment made on the platform, newest first. */
adminRouter.get('/adjustments', async (_req, res) => {
  const { data, error } = await db
    .from('admin_adjustments')
    .select('id, user_id, admin_id, account_mode, amount, balance_before, balance_after, reason, created_at')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) {
    res.status(500).json({ error: 'LOAD_FAILED', message: 'Could not load adjustments.' });
    return;
  }

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const ids = [...new Set(rows.flatMap((r) => [String(r.user_id), String(r.admin_id)]))];
  const { data: people } = ids.length
    ? await db.from('users').select('id, username').in('id', ids)
    : { data: [] as Array<{ id: string; username: string }> };
  const nameOf = new Map(
    ((people ?? []) as Array<{ id: string; username: string }>).map((p) => [p.id, p.username])
  );

  res.json({
    adjustments: rows.map((r) => ({
      id: r.id,
      user: nameOf.get(String(r.user_id)) ?? '—',
      admin: nameOf.get(String(r.admin_id)) ?? '—',
      mode: r.account_mode,
      amount: Number(r.amount),
      before: Number(r.balance_before),
      after: Number(r.balance_after),
      reason: r.reason,
      createdAt: r.created_at,
    })),
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
