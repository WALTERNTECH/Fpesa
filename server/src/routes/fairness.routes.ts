import { Router } from 'express';
import { env } from '../env.js';
import { requireAuth } from '../lib/auth.js';
import { priceFeed, SYMBOL } from '../services/prices.js';
import { getInstrument, INSTRUMENTS } from '../services/instruments.js';
import { readChain, unrecordedCount } from '../services/fairness-chain.js';

export const fairnessRouter = Router();

/** Resolves ?symbol=, defaulting to the reference instrument. */
function pick(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return SYMBOL;
  const i = getInstrument(String(raw));
  return i && priceFeed.has(i.symbol) ? i.symbol : null;
}

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
fairnessRouter.get('/', async (req, res) => {
  const symbol = pick(req.query.symbol);
  if (!symbol) {
    res.status(400).json({ error: 'UNKNOWN_MARKET', message: 'No such market.' });
    return;
  }
  const engine = priceFeed.engine(symbol);
  if (!engine) {
    res.json({
      mode: env.priceMode,
      symbol,
      provablyFair: false,
      note:
        'This deployment tracks an external market feed, so prices are not ' +
        'generated from a seed and cannot be replayed. Run PRICE_MODE=synthetic ' +
        'for a verifiable instrument.',
    });
    return;
  }

  const params = engine.params();
  const chain = await readChain(symbol);
  res.json({
    mode: env.priceMode,
    symbol,
    name: getInstrument(symbol)?.name ?? env.symbolName,
    // Each instrument runs its own seed chain, so a commitment for one says
    // nothing about any other. Listed here so a verifier knows what to ask for.
    markets: INSTRUMENTS.filter((i) => priceFeed.has(i.symbol)).map((i) => i.symbol),
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
    // Served from the database rather than this process's memory. It used to
    // come from memory, which meant a restart reset the epoch counter to 1 and
    // orphaned every epoch before it — a discarded epoch and a deploy looked
    // identical, which is the one thing a commitment scheme must not allow.
    revealed: chain.epochs,
    chain: {
      head: chain.head,
      // null means the record could not be read, which is an infrastructure
      // problem and not a tampering claim. Only false means the links broke.
      readable: chain.readable,
      linksValid: chain.linksValid,
      brokenAt: chain.brokenAt,
      unrecorded: unrecordedCount(),
      algorithm:
        'chainHash = sha256(prevChainHash + "|" + symbol|epoch|seedHash|' +
        'startPrice(6dp)|tickMs|epochMs|sigma(12dp)|drift(12dp)|startedAt)',
      note:
        'Each epoch is written before it produces a tick and linked to the one ' +
        'before it, so no epoch can be removed, reordered or edited — including ' +
        'its sigma and drift — without breaking every link after it. Record the ' +
        'head yourself periodically: this is published by the operator, so it is ' +
        'tamper-evident to anyone holding an earlier head, and only that outside ' +
        'witness makes it tamper-proof.',
    },
    verify:
      'node scripts/verify-epoch.mjs <epoch> [symbol] — replays a closed epoch ' +
      'from its published seed and checks it against sha256(seed). ' +
      'node scripts/verify-chain.mjs [symbol] — walks the whole chain.',
  });
});

/** Operator view: the model behind the market, and its live state. */
fairnessRouter.get('/engine', requireAuth, (req, res) => {
  if (!req.user!.isAdmin) {
    res.status(403).json({ error: 'FORBIDDEN', message: 'Admins only.' });
    return;
  }
  const symbol = pick(req.query.symbol);
  if (!symbol) {
    res.status(400).json({ error: 'UNKNOWN_MARKET', message: 'No such market.' });
    return;
  }
  const engine = priceFeed.engine(symbol);
  const quote = priceFeed.stats(symbol);

  res.json({
    mode: env.priceMode,
    symbol,
    name: getInstrument(symbol)?.name ?? env.symbolName,
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
