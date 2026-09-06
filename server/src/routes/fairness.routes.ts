import { Router } from 'express';
import { env } from '../env.js';
import { requireAuth } from '../lib/auth.js';
import { priceFeed, SYMBOL } from '../services/prices.js';

export const fairnessRouter = Router();

/**
 * Public proof surface for the synthetic instrument.
 *
 * The commitment for the running epoch is published before that epoch produces
 * a single tick, and its seed is published once the epoch closes. A trader can
 * therefore take any closed epoch, replay it, and confirm the prices they
 * traded against are exactly the ones the seed produces — and that the seed
 * matches the hash published beforehand.
 *
 * Note what is deliberately absent: the seed of the *running* epoch. It is
 * never served until its epoch has ended.
 */
fairnessRouter.get('/', (_req, res) => {
  const engine = priceFeed.engine();
  if (!engine) {
    res.json({
      mode: env.priceMode,
      symbol: SYMBOL,
      provablyFair: false,
      note:
        'This deployment tracks an external market feed, so prices are not ' +
        'generated from a seed and cannot be replayed. Run PRICE_MODE=synthetic ' +
        'for a verifiable instrument.',
    });
    return;
  }

  const params = engine.params();
  res.json({
    mode: env.priceMode,
    symbol: SYMBOL,
    name: env.symbolName,
    provablyFair: true,
    algorithm: {
      digest: 'HMAC-SHA256(seed, "<epoch>:<tickIndex>")',
      uniform: 'two 53-bit words from the digest, mapped to (0,1)',
      normal: 'Box-Muller(u1, u2)',
      step: 'price[i] = price[i-1] * exp(drift*dt + sigma*sqrt(dt)*z)',
      commitment: 'sha256(seed) is published before the epoch opens',
    },
    parameters: {
      tickMs: params.tickMs,
      epochMs: params.epochMs,
      sigma: params.sigma,
      // Published deliberately. A non-zero drift is a tilt in the price path,
      // and a tilt nobody can see is indistinguishable from a rigged feed.
      drift: params.drift,
    },
    current: engine.commitment(),
    revealed: engine.revealed(24),
    verify:
      'node scripts/verify-epoch.mjs <epoch> — replays a closed epoch from its ' +
      'published seed and checks it against sha256(seed).',
  });
});

/** Operator view: the model behind the market, and its live state. */
fairnessRouter.get('/engine', requireAuth, (req, res) => {
  if (!req.user!.isAdmin) {
    res.status(403).json({ error: 'FORBIDDEN', message: 'Admins only.' });
    return;
  }
  const engine = priceFeed.engine();
  const quote = priceFeed.stats();

  res.json({
    mode: env.priceMode,
    symbol: SYMBOL,
    name: env.symbolName,
    feed: priceFeed.health(),
    quote,
    parameters: engine ? engine.params() : null,
    current: engine ? engine.commitment() : null,
    epochsRetained: engine ? engine.revealed(1000).length : 0,
    // Expected magnitude of a move over each tradeable duration, which is what
    // "how the market moves" actually means for a distribution: the operator
    // sets the shape, not any individual outcome.
    expectedMove: engine
      ? Object.fromEntries(
          [5, 10, 15, 30, 60].map((d) => [
            d + 's',
            {
              oneSigmaPct: Number((engine.params().sigma * Math.sqrt(d) * 100).toFixed(4)),
              oneSigmaPrice: Number((quote.price * engine.params().sigma * Math.sqrt(d)).toFixed(2)),
            },
          ])
        )
      : null,
  });
});
