import { Router } from 'express';
import { priceFeed, TIMEFRAMES, type Timeframe } from '../services/prices.js';
import { getNews } from '../services/news.js';
import { env } from '../env.js';

export const marketRouter = Router();

marketRouter.get('/quote', (_req, res) => {
  const stats = priceFeed.stats();
  res.json({
    symbol: 'XAUUSD',
    name: 'Gold / US Dollar',
    ...stats,
    ts: Date.now(),
    feed: priceFeed.health(),
  });
});

marketRouter.get('/candles', (req, res) => {
  const tf = String(req.query.tf ?? '5s');
  if (!TIMEFRAMES.includes(tf as Timeframe)) {
    res.status(400).json({
      error: 'BAD_TIMEFRAME',
      message: 'Timeframe must be one of ' + TIMEFRAMES.join(', ') + '.',
    });
    return;
  }
  res.json({ symbol: 'XAUUSD', timeframe: tf, candles: priceFeed.history(tf as Timeframe) });
});

marketRouter.get('/news', async (_req, res) => {
  const items = await getNews();
  res.json({ items });
});

marketRouter.get('/config', (_req, res) => {
  res.json({
    minStake: env.minStake,
    maxStake: env.maxStake,
    payoutRate: env.payoutRate,
    durations: [5, 10, 15, 30, 60],
    minDeposit: env.minDeposit,
    minWithdrawal: env.minWithdrawal,
    supportTelegram: env.supportTelegram,
    demoStartingBalance: env.demoStartingBalance,
  });
});
