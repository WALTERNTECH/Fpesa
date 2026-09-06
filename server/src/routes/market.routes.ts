import { Router } from 'express';
import { priceFeed, SYMBOL, TIMEFRAMES, type Timeframe } from '../services/prices.js';
import { getNews } from '../services/news.js';
import { ALLOWED_DURATIONS, multiplierFor } from '../services/trading.js';
import { exposureGuard } from '../services/exposure.js';
import { analyseTrade } from '../lib/stats.js';
import { env } from '../env.js';

export const marketRouter = Router();

marketRouter.get('/quote', (_req, res) => {
  const stats = priceFeed.stats();
  res.json({
    symbol: SYMBOL,
    name: env.symbolName,
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
  res.json({ symbol: SYMBOL, timeframe: tf, candles: priceFeed.history(tf as Timeframe) });
});

/**
 * Exact odds and costs for a proposed position.
 *
 * Everything here is closed-form, because the instrument is a driftless walk
 * and there is nothing to infer. It deliberately returns no Buy/Sell call: on
 * this series a direction would be a coin flip presented as advice to someone
 * about to stake real money against the spread.
 */
marketRouter.get('/analyse', (req, res) => {
  const stake = Number(req.query.stake);
  const durationSec = Number(req.query.durationSec);

  if (!Number.isFinite(stake) || stake < env.minStake || stake > env.maxStake) {
    res.status(400).json({
      error: 'VALIDATION',
      message: 'Amount must be between KSh ' + env.minStake + ' and KSh ' +
        env.maxStake.toLocaleString('en-KE') + '.',
    });
    return;
  }
  if (!(ALLOWED_DURATIONS as readonly number[]).includes(durationSec)) {
    res.status(400).json({ error: 'VALIDATION', message: 'Choose an offered duration.' });
    return;
  }

  const engine = priceFeed.engine();
  // Fall back to the tuning constant when running against a live feed, where
  // volatility is a property of the market rather than of our own generator.
  const sigma = engine ? engine.params().sigma : 0.00009;

  res.json(
    analyseTrade({
      stake,
      durationSec,
      multiplier: multiplierFor(durationSec),
      houseEdge: env.houseEdge,
      sigma,
      maxProfitMultiple: env.maxProfitMultiple,
    })
  );
});

marketRouter.get('/news', async (_req, res) => {
  const items = await getNews();
  res.json({ items });
});

marketRouter.get('/config', (_req, res) => {
  res.json({
    // Included so a client loading while the desk is shut knows immediately,
    // rather than finding out by having a tap rejected. Changes after load
    // arrive over the socket as a "desk" message.
    desk: exposureGuard.state(),
    minStake: env.minStake,
    maxStake: env.maxStake,
    payoutRate: env.payoutRate,
    durations: [...ALLOWED_DURATIONS],
    multipliers: Object.fromEntries(
      ALLOWED_DURATIONS.map((d) => [String(d), multiplierFor(d)])
    ),
    maxProfitMultiple: env.maxProfitMultiple,
    // Disclosed, not buried: the trader can see the cost of opening a position
    // before they open one, the same way a broker publishes its spread.
    houseEdge: env.houseEdge,
    turnoverMultiple: env.turnoverMultiple,
    minDeposit: env.minDeposit,
    minWithdrawal: env.minWithdrawal,
    symbol: SYMBOL,
    symbolName: env.symbolName,
    provablyFair: env.priceMode === 'synthetic',
    adminUrl: env.adminUrl,
    supportTelegram: env.supportTelegram,
    demoStartingBalance: env.demoStartingBalance,
  });
});
