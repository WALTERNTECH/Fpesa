import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../env.js';
import { hub } from '../realtime/hub.js';

export const internalRouter = Router();

/**
 * Service-to-service notifications from the operations console.
 *
 * The two services run as separate processes, so the console holds no sockets:
 * when an operator corrects a balance there, `hub.toUser` on that side reaches
 * nobody, and a trader watching their screen would see nothing until they next
 * reloaded. That is exactly the moment they have just phoned support about, so
 * it is worth closing.
 *
 * Authentication is a short-lived token signed with JWT_SECRET, which both
 * services already share. The token carries the payload, so a caller without
 * the secret cannot push a balance to anyone — and a captured token expires in
 * thirty seconds and can only restate numbers the database already holds.
 * Nothing here writes: it is a nudge to re-read, not a source of truth.
 */
internalRouter.post('/notify', (req, res) => {
  const token = String((req.body as { token?: unknown }).token ?? '');
  if (!token) {
    res.status(400).json({ error: 'NO_TOKEN' });
    return;
  }

  let claim: { sub?: string; demoBalance?: number; realBalance?: number };
  try {
    claim = jwt.verify(token, env.jwtSecret) as typeof claim;
  } catch {
    res.status(401).json({ error: 'BAD_TOKEN' });
    return;
  }
  if (!claim.sub) {
    res.status(400).json({ error: 'NO_SUBJECT' });
    return;
  }

  hub.toUser(claim.sub, {
    type: 'balance',
    demoBalance: claim.demoBalance,
    realBalance: claim.realBalance,
  });
  res.json({ ok: true });
});

/**
 * Signs and delivers one of those notifications. Failure is deliberately silent
 * at the call site: the balance change itself has already been committed, and
 * a console that could not reach the trading service must not report the
 * adjustment as failed when it plainly succeeded.
 */
export async function notifyBalance(
  userId: string,
  demoBalance: number,
  realBalance: number
): Promise<void> {
  if (env.appMode !== 'admin') {
    hub.toUser(userId, { type: 'balance', demoBalance, realBalance });
    return;
  }
  try {
    const token = jwt.sign(
      { sub: userId, demoBalance, realBalance },
      env.jwtSecret,
      { expiresIn: '30s' }
    );
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    await fetch(env.upstreamUrl + '/api/internal/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
  } catch {
    // The trader picks the new balance up on their next load.
  }
}
