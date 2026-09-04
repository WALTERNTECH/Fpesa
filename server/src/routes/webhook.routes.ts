import { Router } from 'express';
import { env } from '../env.js';
import { normaliseTransaction } from '../services/palpluss.js';
import { handleProviderCallback } from '../services/wallet.js';

export const webhookRouter = Router();

/**
 * Palpluss transaction callback.
 *
 * The provider does not publish a signing scheme, so the URL carries a secret
 * path token that only Palpluss is given. Even past that gate the body is only
 * a hint — `handleProviderCallback` re-reads the transaction from Palpluss
 * before any balance moves, so a leaked URL still cannot mint money.
 */
webhookRouter.post('/palpluss/:token', async (req, res) => {
  if (!env.webhookToken || req.params.token !== env.webhookToken) {
    res.status(404).json({ error: 'NOT_FOUND' });
    return;
  }

  // Always ack fast; providers retry on non-2xx and we do our own reconciliation.
  res.status(200).json({ received: true });

  try {
    const body = req.body as { transaction?: Record<string, unknown> } & Record<string, unknown>;
    const raw = (body.transaction ?? body) as Record<string, unknown>;
    const tx = normaliseTransaction(raw as never);

    if (!tx.reference) {
      console.warn('[webhook] callback with no reference:', JSON.stringify(body).slice(0, 300));
      return;
    }

    await handleProviderCallback({
      reference: tx.reference,
      providerId: tx.transactionId || null,
      status: tx.status,
      receipt: tx.mpesaReceipt,
      resultCode: tx.resultCode,
      resultDesc: tx.resultDescription,
    });
  } catch (err) {
    console.error('[webhook] processing failed:', err);
  }
});
