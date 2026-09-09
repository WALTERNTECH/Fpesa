import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { env } from '../env.js';
import { exposureGuard } from '../services/exposure.js';
import { toKes, usdKes } from '../services/fx.js';
import {
  WalletError,
  startDeposit,
  startWithdrawal,
  toPublicTx,
  type TxRow,
} from '../services/wallet.js';

export const walletRouter = Router();

// Each STK prompt buzzes a real phone, so keep the tap rate sane.
const moveLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: 'RATE_LIMITED',
    message: 'Please wait a minute before trying another transaction.',
  },
});

const amountSchema = z.object({ amount: z.coerce.number().positive() });

walletRouter.post('/deposit', requireAuth, moveLimiter, async (req, res) => {
  const parsed = amountSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'VALIDATION', message: 'Enter a valid amount.' });
    return;
  }
  const currency = (req.body as { currency?: string }).currency === 'USD' ? 'USD' : 'KES';

  // The rate is read here rather than accepted from the browser. What the
  // client showed was a quote; this is what the customer is actually charged,
  // and the two are allowed to differ by whatever the market did in between.
  let amountKes = parsed.data.amount;
  let quoted: { usd: number; rate: number; kes: number } | null = null;

  if (currency === 'USD') {
    if (parsed.data.amount < env.minDepositUsd) {
      res.status(400).json({
        error: 'AMOUNT_TOO_LOW',
        message: 'Minimum deposit is USD ' + env.minDepositUsd + '.',
      });
      return;
    }
    const rate = await usdKes();
    amountKes = toKes(parsed.data.amount, rate);
    quoted = { usd: parsed.data.amount, rate, kes: amountKes };
  }

  try {
    const tx = await startDeposit(req.user!, amountKes);
    res.status(202).json({
      transaction: tx,
      quoted,
      message:
        'Check your phone and enter your M-Pesa PIN to approve KSh ' +
        amountKes.toLocaleString('en-KE') + '.',
    });
  } catch (err) {
    if (err instanceof WalletError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    console.error('[wallet] deposit failed:', err);
    res.status(500).json({ error: 'DEPOSIT_FAILED', message: 'Could not start the deposit.' });
  }
});

walletRouter.post('/withdraw', requireAuth, moveLimiter, async (req, res) => {
  const parsed = amountSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'VALIDATION', message: 'Enter a valid amount.' });
    return;
  }
  try {
    const tx = await startWithdrawal(req.user!, parsed.data.amount);
    res.status(202).json({
      transaction: tx,
      message: 'Your withdrawal is on its way to ' + req.user!.phone + '.',
    });
  } catch (err) {
    if (err instanceof WalletError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    console.error('[wallet] withdrawal failed:', err);
    res.status(500).json({ error: 'WITHDRAWAL_FAILED', message: 'Could not start the withdrawal.' });
  }
});

walletRouter.get('/transactions', requireAuth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 25) || 25, 100);
  const { data, error } = await db
    .from('transactions')
    .select('*')
    .eq('user_id', req.user!.id)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    res.status(500).json({ error: 'LOAD_FAILED', message: 'Could not load your transactions.' });
    return;
  }
  res.json({ transactions: ((data ?? []) as TxRow[]).map(toPublicTx) });
});

/** Polled by the deposit dialog while the STK prompt is on the user's phone. */
walletRouter.get('/transactions/:id', requireAuth, async (req, res) => {
  const { data, error } = await db
    .from('transactions')
    .select('*')
    .eq('id', req.params.id)
    .eq('user_id', req.user!.id)
    .maybeSingle();
  if (error || !data) {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Transaction not found.' });
    return;
  }
  res.json({ transaction: toPublicTx(data as TxRow) });
});

walletRouter.get('/balance', requireAuth, (req, res) => {
  const remaining = Math.max(req.user!.turnoverRequired - req.user!.turnoverProgress, 0);
  res.json({
    demoBalance: req.user!.demoBalance,
    realBalance: req.user!.realBalance,
    turnoverRequired: req.user!.turnoverRequired,
    turnoverProgress: req.user!.turnoverProgress,
    turnoverRemaining: Math.round(remaining * 100) / 100,
    canWithdraw: remaining <= 0,
  });
});

/**
 * The day's book: what came in, what went out, and where that sits against the
 * daily payout target. Operator view — admin accounts only.
 */
walletRouter.get('/book', requireAuth, async (req, res) => {
  if (!req.user!.isAdmin) {
    res.status(403).json({ error: 'FORBIDDEN', message: 'Admins only.' });
    return;
  }
  const day = await exposureGuard.read(0);
  res.json({
    ...day,
    target: env.dailyPayoutCap,
    houseEdge: env.houseEdge,
    deskOpen: env.dailyPayoutCap <= 0 || day.payoutRatio < env.dailyPayoutCap,
  });
});
