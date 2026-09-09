import { Router } from 'express';
import { env } from '../env.js';
import { PROVIDER, challengeMatches, parseWebhook } from '../services/payments.js';
import { handleProviderCallback } from '../services/wallet.js';

export const webhookRouter = Router();

/**
 * Provider callback for both collections and payouts.
 *
 * A payment webhook is an unauthenticated public endpoint that moves money, so
 * it is gated three ways:
 *   1. a secret token in the URL path, given only to the provider
 *   2. a body-level check where the provider offers one — IntaSend echoes a
 *      challenge string; Palpluss signs nothing at all, so on Palpluss this
 *      gate does not exist and the other two carry the weight
 *   3. the body is only ever a hint — handleProviderCallback re-reads the
 *      transaction from the provider's API before any balance changes, and
 *      refuses to credit a claimed success it cannot confirm
 *
 * Gate 3 is the one that actually matters. Anyone who learns this URL can post
 * a convincing "payment succeeded" body; nobody can make the provider's own API
 * agree with it.
 *
 * Both paths are mounted so a provider switch does not strand callbacks that
 * are already registered on the old address.
 */
async function handleCallback(req: import('express').Request, res: import('express').Response): Promise<void> {
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
}

webhookRouter.post('/palpluss/:token', handleCallback);
webhookRouter.post('/intasend/:token', handleCallback);

console.log('[webhook] live provider: ' + PROVIDER);
