import { Router } from 'express';
import { env } from '../env.js';
import { challengeMatches, parseWebhook } from '../services/intasend.js';
import { handleProviderCallback } from '../services/wallet.js';

export const webhookRouter = Router();

/**
 * IntaSend callback for both collections and payouts.
 *
 * Three independent gates, because a payment webhook is an unauthenticated
 * public endpoint and this one moves money:
 *   1. a secret token in the URL path, given only to IntaSend
 *   2. the challenge string IntaSend echoes in every delivery
 *   3. the body is still only a hint — handleProviderCallback re-reads the
 *      transaction from IntaSend before any balance changes
 */
webhookRouter.post('/intasend/:token', async (req, res) => {
  if (!env.webhookToken || req.params.token !== env.webhookToken) {
    res.status(404).json({ error: 'NOT_FOUND' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;

  if (!challengeMatches(body)) {
    console.warn('[webhook] rejected callback with a bad or missing challenge');
    res.status(401).json({ error: 'BAD_CHALLENGE' });
    return;
  }

  // Acknowledge immediately: providers retry on non-2xx, and we reconcile
  // independently anyway, so slow processing must not look like a failure.
  res.status(200).json({ received: true });

  try {
    const hint = parseWebhook(body);
    if (!hint) {
      console.warn('[webhook] unrecognised payload shape:', JSON.stringify(body).slice(0, 300));
      return;
    }
    if (!hint.reference) {
      console.warn('[webhook] callback carried no reference for ' + hint.providerId);
      return;
    }
    await handleProviderCallback(hint);
  } catch (err) {
    console.error('[webhook] processing failed:', err);
  }
});
