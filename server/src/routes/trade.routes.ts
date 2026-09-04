import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import {
  ALLOWED_DURATIONS,
  TradeError,
  toPublicTrade,
  tradingEngine,
  type Duration,
  type TradeRow,
} from '../services/trading.js';

export const tradeRouter = Router();

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
  const { direction, stake, durationSec, accountMode } = parsed.data;

  try {
    const result = await tradingEngine.placeTrade({
      userId: req.user!.id,
      mode: accountMode,
      direction,
      stake,
      durationSec: durationSec as Duration,
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
