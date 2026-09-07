import { Router } from 'express';
import { priceFeed, SYMBOL, TIMEFRAMES, type Timeframe } from '../services/prices.js';
import { getInstrument, INSTRUMENTS } from '../services/instruments.js';
import { getNews } from '../services/news.js';
import { ALLOWED_DURATIONS, multiplierFor } from '../services/trading.js';
import { exposureGuard } from '../services/exposure.js';
import { analyseTrade } from '../lib/stats.js';
import { env } from '../env.js';

export const marketRouter = Router();

/** Resolves ?symbol=, falling back to the default instrument. */
function pickSymbol(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return SYMBOL;
  const instrument = getInstrument(String(raw));
  if (!instrument || !priceFeed.has(instrument.symbol)) return null;
  return instrument.symbol;
}

/** Every tradeable market with its live headline numbers. */
marketRouter.get('/instruments', (_req, res) => {
  res.json({
    instruments: priceFeed.snapshot().map((i) => ({
      ...i,
      multipliers: Object.fromEntries(
        ALLOWED_DURATIONS.map((d) => [String(d), multiplierFor(d, i.symbol)])
      ),
    })),
    ts: Date.now(),
  });
});

marketRouter.get('/quote', (req, res) => {
  const symbol = pickSymbol(req.query.symbol);
  if (!symbol) {
    res.status(400).json({ error: 'UNKNOWN_MARKET', message: 'No such market.' });
    return;
  }
  const instrument = getInstrument(symbol)!;
  res.json({
    symbol,
    name: instrument.name,
    precision: instrument.precision,
    ...priceFeed.stats(symbol),
    ts: Date.now(),
    feed: priceFeed.health(),
  });
});

marketRouter.get('/candles', (req, res) => {
  const symbol = pickSymbol(req.query.symbol);
  if (!symbol) {
    res.status(400).json({ error: 'UNKNOWN_MARKET', message: 'No such market.' });
    return;
  }
  const tf = String(req.query.tf ?? '5s');
  if (!TIMEFRAMES.includes(tf as Timeframe)) {
    res.status(400).json({
      error: 'BAD_TIMEFRAME',
      message: 'Timeframe must be one of ' + TIMEFRAMES.join(', ') + '.',
    });
    return;
  }
  res.json({
    symbol,
    timeframe: tf,
    precision: getInstrument(symbol)!.precision,
    candles: priceFeed.history(symbol, tf as Timeframe),
  });
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
  const symbol = pickSymbol(req.query.symbol);

  if (!symbol) {
    res.status(400).json({ error: 'UNKNOWN_MARKET', message: 'No such market.' });
    return;
  }
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

  const engine = priceFeed.engine(symbol);
  // Fall back to the instrument's configured volatility when running against a
  // live feed, where volatility is a property of the market rather than ours.
  const sigma = engine ? engine.params().sigma : getInstrument(symbol)!.sigma;

  res.json(
    analyseTrade({
      stake,
      durationSec,
      multiplier: multiplierFor(durationSec, symbol),
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
  const tradeable = new Set(priceFeed.tradeableSymbols());
  res.json({
    // Included so a client loading while the desk is shut knows immediately,
    // rather than finding out by having a tap rejected. Changes after load
    // arrive over the socket as a "desk" message.
    desk: exposureGuard.state(),
    minStake: env.minStake,
    maxStake: env.maxStake,
    payoutRate: env.payoutRate,
    durations: [...ALLOWED_DURATIONS],
    /** Multipliers for the default market; per-market values ship with each instrument. */
    multipliers: Object.fromEntries(
      ALLOWED_DURATIONS.map((d) => [String(d), multiplierFor(d, SYMBOL)])
    ),
    instruments: INSTRUMENTS.filter((i) => tradeable.has(i.symbol)).map((i) => ({
      symbol: i.symbol,
      name: i.name,
      volatility: i.volatility,
      precision: i.precision,
      multipliers: Object.fromEntries(
        ALLOWED_DURATIONS.map((d) => [String(d), multiplierFor(d, i.symbol)])
      ),
    })),
    maxProfitMultiple: env.maxProfitMultiple,
    // Disclosed, not buried: the trader can see the cost of opening a position
    // before they open one, the same way a broker publishes its spread.
    houseEdge: env.houseEdge,
    turnoverMultiple: env.turnoverMultiple,
    minDeposit: env.minDeposit,
    maxDeposit: env.maxDeposit,
    minWithdrawal: env.minWithdrawal,
    maxWithdrawal: env.maxWithdrawal,
    symbol: SYMBOL,
    symbolName: getInstrument(SYMBOL)?.name ?? env.symbolName,
    provablyFair: env.priceMode === 'synthetic',
    supportTelegram: env.supportTelegram,
    demoStartingBalance: env.demoStartingBalance,
  });
});
