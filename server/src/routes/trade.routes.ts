import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { env } from '../env.js';
import { settings } from '../services/settings.js';
import { solvency } from '../services/solvency.js';
import { winRateAt as sharedWinRateAt } from '../lib/stats.js';
import { multiplierFor } from '../services/trading.js';
import { SYMBOL } from '../services/prices.js';
import {
  ALLOWED_DURATIONS,
  TradeError,
  toPublicTrade,
  tradingEngine,
  toPublicRun,
  type Duration,
  type RunRow,
  type TradeRow,
} from '../services/trading.js';

export const tradeRouter = Router();

/** The reference ticket every quoted win rate is measured on: FPX100 over 10s. */
function winRateAt(edge: number): number {
  return sharedWinRateAt(edge, multiplierFor(10, SYMBOL), env.synth.sigma, 10);
}

/**
 * The trading pass: what it costs, and what it actually buys.
 *
 * Quoted in win rates rather than percentages, because a spread means nothing
 * to a trader on its own. At 11% they win 39 positions in 100; at 3%, 47. That
 * is the product being sold and it should be stated as such — and it must never
 * be dressed up as a change in profitability, which it is not.
 */
tradeRouter.get('/pass', requireAuth, async (req, res) => {
  const { data, error } = await db
    .from('pass_plans')
    .select('*')
    .eq('active', true)
    .order('sort_order', { ascending: true });
  if (error) {
    res.status(500).json({ error: 'LOAD_FAILED', message: 'Could not load passes.' });
    return;
  }

  const normal = settings.houseEdge();
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  res.json({
    normalEdge: normal,
    normalWinRate: Number((winRateAt(normal) * 100).toFixed(1)),
    // The trader's own pass, if one is running.
    active: req.user!.promoUntil
      ? {
          code: req.user!.promoCode,
          edge: req.user!.promoEdge,
          validUntil: req.user!.promoUntil,
          winRate: Number((winRateAt(req.user!.promoEdge ?? normal) * 100).toFixed(1)),
        }
      : null,
    plans: rows.map((r) => ({
      code: r.code,
      label: r.label,
      price: Number(r.price),
      hours: Number(r.hours),
      edge: Number(r.edge),
      winRate: Number((winRateAt(Number(r.edge)) * 100).toFixed(1)),
    })),
  });
});

tradeRouter.post('/pass', requireAuth, async (req, res) => {
  const plan = String((req.body as { plan?: unknown }).plan ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3,10}$/.test(plan)) {
    res.status(400).json({ error: 'VALIDATION', message: 'Choose a pass.' });
    return;
  }

  const { data, error } = await db.rpc('fpesa_buy_pass', { p_user: req.user!.id, p_plan: plan });
  if (error) {
    if (error.message.includes('NO_SUCH_PLAN')) {
      res.status(400).json({ error: 'NO_SUCH_PLAN', message: 'That pass is not available.' });
      return;
    }
    if (error.message.includes('INSUFFICIENT_FUNDS')) {
      res.status(400).json({
        error: 'INSUFFICIENT_FUNDS',
        message: 'Your balance is too low for that pass. Deposit, or choose a shorter one.',
      });
      return;
    }
    console.error('[pass] purchase failed:', error.message);
    res.status(500).json({ error: 'PASS_FAILED', message: 'Could not buy the pass.' });
    return;
  }

  const r = data as {
    plan: string; label: string; price: number;
    edge: number; validUntil: string; balance: number;
  };
  console.log('[pass] ' + req.user!.username + ' bought ' + r.plan + ' for ' + r.price);

  // Headroom rises by the price — the money stopped being owed to anyone — so
  // the cached book is stale from this moment.
  solvency.invalidate();

  res.json({
    ok: true,
    ...r,
    winRate: Number((winRateAt(r.edge) * 100).toFixed(1)),
    normalWinRate: Number((winRateAt(settings.houseEdge()) * 100).toFixed(1)),
  });
});

/**
 * Redeems a promo code, which lowers this trader's spread for a window.
 *
 * The spread is the only honest lever on a win rate — 39% of positions win at
 * 11%, 48% at 2%, exactly 50% at zero and nothing above it. So the response
 * says what the code actually bought, in those terms, rather than leaving the
 * trader to infer it from a percentage.
 */
tradeRouter.post('/promo', requireAuth, async (req, res) => {
  const code = String((req.body as { code?: unknown }).code ?? '').trim();
  if (code.length < 3 || code.length > 32) {
    res.status(400).json({ error: 'VALIDATION', message: 'Enter your code.' });
    return;
  }

  const { data, error } = await db.rpc('fpesa_redeem_promo', {
    p_user: req.user!.id,
    p_code: code,
  });

  if (error) {
    const known: Record<string, string> = {
      NO_SUCH_CODE: 'That code does not exist.',
      CODE_INACTIVE: 'That code is no longer active.',
      CODE_EXPIRED: 'That code has expired.',
      CODE_EXHAUSTED: 'That code has been fully claimed.',
      ALREADY_REDEEMED: 'You have already used that code.',
    };
    const hit = Object.keys(known).find((k) => error.message.includes(k));
    if (hit) {
      res.status(400).json({ error: hit, message: known[hit] });
      return;
    }
    console.error('[promo] redeem failed:', error.message);
    res.status(500).json({ error: 'PROMO_FAILED', message: 'Could not apply that code.' });
    return;
  }

  const result = data as { code: string; edge: number; validUntil: string; hours: number };
  res.json({
    ok: true,
    code: result.code,
    edge: result.edge,
    validUntil: result.validUntil,
    normalEdge: settings.houseEdge(),
  });
});

// A human cannot meaningfully place more than a couple of trades a second;
// this stops a scripted client from hammering the settlement engine.
const placeLimiter = rateLimit({
  windowMs: 10_000,
  limit: 15,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Slow down a moment before placing another trade.' },
});

const placeSchema = z.object({
  direction: z.enum(['BUY', 'SELL']),
  stake: z.coerce.number().positive(),
  durationSec: z.coerce.number().refine(
    (v) => (ALLOWED_DURATIONS as readonly number[]).includes(v),
    'Choose one of the offered trade durations.'
  ),
  accountMode: z.enum(['demo', 'real']).default('demo'),
  // Omitted by older clients, which trade the default market. On a run this
  // also accepts 'AUTO', which lets the scan choose the instrument.
  symbol: z.string().min(1).max(16).optional(),
});

tradeRouter.post('/', requireAuth, placeLimiter, async (req, res) => {
  const parsed = placeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'VALIDATION',
      message: parsed.error.issues[0]?.message ?? 'Check the trade details.',
    });
    return;
  }
  const { direction, stake, durationSec, accountMode, symbol } = parsed.data;

  try {
    const result = await tradingEngine.placeTrade({
      userId: req.user!.id,
      mode: accountMode,
      direction,
      stake,
      durationSec: durationSec as Duration,
      symbol,
      // Undefined when no promo is running, which falls through to the
      // platform edge.
      edge: req.user!.promoEdge ?? undefined,
    });
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof TradeError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    console.error('[trade] unexpected failure:', err);
    res.status(500).json({ error: 'TRADE_FAILED', message: 'Could not open the trade.' });
  }
});

const runSchema = placeSchema.extend({
  // AUTO lets the server pick each leg's side, which is what the one-tap
  // auto-trade button sends.
  direction: z.enum(['BUY', 'SELL', 'AUTO']).default('AUTO'),
  count: z.coerce.number().int().min(2).max(5).default(3),
});

/**
 * Auto-run: the same ticket placed several times, each leg opening once the
 * previous settles. The sequencing runs on the server, so a locked phone or a
 * closed tab does not strand the batch part way through.
 */
tradeRouter.post('/run', requireAuth, placeLimiter, async (req, res) => {
  const parsed = runSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'VALIDATION',
      message: parsed.error.issues[0]?.message ?? 'Check the trade details.',
    });
    return;
  }
  const { direction, stake, durationSec, accountMode, count, symbol } = parsed.data;

  try {
    const result = await tradingEngine.startRun({
      userId: req.user!.id,
      mode: accountMode,
      direction,
      stake,
      durationSec: durationSec as Duration,
      count,
      symbol,
      edge: req.user!.promoEdge ?? undefined,
    });
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof TradeError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    console.error('[trade] run failed:', err);
    res.status(500).json({ error: 'RUN_FAILED', message: 'Could not start the auto-run.' });
  }
});

/** Progress of one run, for rehydrating after a refresh. */
tradeRouter.get('/runs/:id', requireAuth, async (req, res) => {
  const { data, error } = await db
    .from('trade_runs')
    .select('*')
    .eq('id', req.params.id)
    .eq('user_id', req.user!.id)
    .maybeSingle();
  if (error || !data) {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Run not found.' });
    return;
  }
  res.json({ run: toPublicRun(data as RunRow) });
});

tradeRouter.get('/', requireAuth, async (req, res) => {
  const mode = req.query.mode === 'real' ? 'real' : req.query.mode === 'demo' ? 'demo' : null;
  const limit = Math.min(Number(req.query.limit ?? 25) || 25, 100);

  let query = db
    .from('trades')
    .select('*')
    .eq('user_id', req.user!.id)
    .order('opened_at', { ascending: false })
    .limit(limit);
  if (mode) query = query.eq('account_mode', mode);

  const { data, error } = await query;
  if (error) {
    res.status(500).json({ error: 'LOAD_FAILED', message: 'Could not load your trades.' });
    return;
  }
  res.json({ trades: ((data ?? []) as TradeRow[]).map(toPublicTrade) });
});

/** Open positions, used to rehydrate live countdowns after a refresh. */
tradeRouter.get('/open', requireAuth, async (req, res) => {
  const { data, error } = await db
    .from('trades')
    .select('*')
    .eq('user_id', req.user!.id)
    .eq('status', 'OPEN')
    .order('expires_at', { ascending: true });
  if (error) {
    res.status(500).json({ error: 'LOAD_FAILED', message: 'Could not load open trades.' });
    return;
  }
  res.json({ trades: ((data ?? []) as TradeRow[]).map(toPublicTrade) });
});

/**
 * The trader's own record: every closed position, plus the lifetime figures
 * that put them in context.
 *
 * `from`/`to` are ISO dates. The window is applied to `settled_at` rather than
 * `opened_at`, because a position opened at 23:59:58 and closed at 00:00:03
 * belongs to the day it resolved — that is the day its money moved.
 */
tradeRouter.get('/history', requireAuth, async (req, res) => {
  const mode = req.query.mode === 'demo' ? 'demo' : 'real';
  const limit = Math.min(Number(req.query.limit ?? 300) || 300, 1000);

  let query = db
    .from('trades')
    .select('*')
    .eq('user_id', req.user!.id)
    .eq('account_mode', mode)
    .neq('status', 'OPEN')
    .order('settled_at', { ascending: false })
    .limit(limit);

  const from = typeof req.query.from === 'string' ? req.query.from : null;
  const to = typeof req.query.to === 'string' ? req.query.to : null;
  if (from && !Number.isNaN(Date.parse(from))) query = query.gte('settled_at', from);
  if (to && !Number.isNaN(Date.parse(to))) query = query.lte('settled_at', to);
  if (typeof req.query.symbol === 'string' && req.query.symbol) {
    query = query.eq('symbol', req.query.symbol);
  }

  const [tradesRes, statementRes] = await Promise.all([
    query,
    db.rpc('fpesa_user_statement', { p_user: req.user!.id }),
  ]);

  if (tradesRes.error) {
    console.error('[trade] history failed:', tradesRes.error.message);
    res.status(500).json({ error: 'LOAD_FAILED', message: 'Could not load your history.' });
    return;
  }

  const trades = ((tradesRes.data ?? []) as TradeRow[]).map(toPublicTrade);

  // Totals are computed over the returned window so the header always agrees
  // with the rows underneath it. Lifetime figures come from the statement.
  const wins = trades.filter((t) => t.status === 'WON').length;
  const losses = trades.filter((t) => t.status === 'LOST').length;
  const net = trades.reduce((sum, t) => sum + (t.profit ?? 0), 0);
  const volume = trades.reduce((sum, t) => sum + t.stake, 0);
  const best = trades.reduce((m, t) => Math.max(m, t.profit ?? 0), 0);
  const worst = trades.reduce((m, t) => Math.min(m, t.profit ?? 0), 0);

  const s = (statementRes.data ?? {}) as Record<string, string | number>;
  const numeric = (key: string): number => Number(s[key] ?? 0);

  res.json({
    mode,
    trades,
    window: {
      trades: trades.length,
      wins,
      losses,
      ties: trades.length - wins - losses,
      winRate: trades.length ? Math.round((wins / trades.length) * 1000) / 10 : 0,
      netProfit: Math.round(net * 100) / 100,
      volume: Math.round(volume * 100) / 100,
      best: Math.round(best * 100) / 100,
      worst: Math.round(worst * 100) / 100,
    },
    /**
     * Lifetime, real money only. `netVsDeposits` is the figure a trader
     * actually wants: what the account is worth now against everything they
     * have ever put into it, withdrawals added back.
     */
    lifetime: {
      deposits: numeric('deposits'),
      withdrawals: numeric('withdrawals'),
      adjustments: numeric('adjustments'),
      tradingNet: numeric('realNet'),
      volume: numeric('realVolume'),
      trades: numeric('realTrades'),
      balance: numeric('realBalance'),
      // Taken from the statement rather than recomputed here. The two agree
      // whenever the figure is derived, so a local sum looked harmless — but it
      // silently discarded an operator's explicit correction, which is the one
      // case the value exists to carry.
      netVsDeposits: numeric('netVsDeposits'),
    },
  });
});

/** Per-account performance summary for the account panel. */
tradeRouter.get('/summary', requireAuth, async (req, res) => {
  const mode = req.query.mode === 'real' ? 'real' : 'demo';
  const { data, error } = await db
    .from('trades')
    .select('status, profit, stake')
    .eq('user_id', req.user!.id)
    .eq('account_mode', mode)
    .neq('status', 'OPEN');
  if (error) {
    res.status(500).json({ error: 'LOAD_FAILED', message: 'Could not load your summary.' });
    return;
  }
  const rows = (data ?? []) as Array<{ status: string; profit: string | number; stake: string | number }>;
  const wins = rows.filter((r) => r.status === 'WON').length;
  const netProfit = rows.reduce((sum, r) => sum + Number(r.profit ?? 0), 0);
  const volume = rows.reduce((sum, r) => sum + Number(r.stake ?? 0), 0);
  res.json({
    mode,
    trades: rows.length,
    wins,
    losses: rows.filter((r) => r.status === 'LOST').length,
    winRate: rows.length ? Math.round((wins / rows.length) * 1000) / 10 : 0,
    netProfit: Math.round(netProfit * 100) / 100,
    volume: Math.round(volume * 100) / 100,
  });
});
