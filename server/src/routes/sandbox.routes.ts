import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../env.js';
import { ALLOWED_DURATIONS } from '../services/trading.js';
import { sandboxBook, SandboxError } from '../services/sandbox.js';

/**
 * The sandbox API.
 *
 * Mounted only when APP_MODE=sandbox — see index.ts — and every handler reaches
 * a service that refuses to answer outside that mode anyway. There is no account
 * system behind it: one passphrase admits a caller, who gets a cookie naming a
 * throwaway book that lives in memory until the process restarts.
 *
 * It is gated at all only so the forecast is not simply open on the internet. A
 * passphrase is the right weight of lock for that — there is nothing behind it
 * worth stealing, and anything heavier would imply there is.
 */
export const sandboxRouter = Router();

const COOKIE = 'fpesa_sandbox';
const TTL_HOURS = 12;

function issue(res: Response): void {
  // Seconds rather than a "12h" string: the typings only accept the literal
  // string forms, and a computed one fails to narrow.
  const token = jwt.sign({ sbx: randomUUID() }, env.jwtSecret, {
    expiresIn: TTL_HOURS * 3600,
  });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProd,
    maxAge: TTL_HOURS * 3600 * 1000,
    path: '/',
  });
}

function readSession(req: Request): string | null {
  const raw = (req as Request & { cookies?: Record<string, string> }).cookies?.[COOKIE];
  if (!raw) return null;
  try {
    const payload = jwt.verify(raw, env.jwtSecret) as { sbx?: string };
    return payload.sbx ?? null;
  } catch {
    return null;
  }
}

function requireSandboxSession(req: Request, res: Response, next: NextFunction): void {
  const id = readSession(req);
  if (!id) {
    res.status(401).json({ error: 'AUTH_REQUIRED', message: 'Enter the sandbox passphrase.' });
    return;
  }
  (req as Request & { sandboxId?: string }).sandboxId = id;
  next();
}

function sessionId(req: Request): string {
  return (req as Request & { sandboxId?: string }).sandboxId!;
}

/** Resolves ?symbol=, falling back to the sandbox's first instrument. */
function pickSymbol(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return sandboxBook.defaultSymbol();
  const s = String(raw).toUpperCase();
  return sandboxBook.has(s) ? s : null;
}

function fail(res: Response, err: unknown): void {
  if (err instanceof SandboxError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  console.error('[sandbox]', err);
  res.status(500).json({ error: 'SERVER_ERROR', message: 'Something went wrong.' });
}

/** Constant-time-ish compare. Overkill for a throwaway, but the habit is free. */
function sameSecret(supplied: string, expected: string): boolean {
  if (supplied.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < supplied.length; i++) {
    diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

// ----------------------------------------------------------------- session

sandboxRouter.post('/login', (req, res) => {
  const supplied = String((req.body as { passphrase?: unknown })?.passphrase ?? '');
  if (!sameSecret(supplied, env.sandbox.passphrase)) {
    res.status(401).json({ error: 'BAD_PASSPHRASE', message: 'That passphrase is wrong.' });
    return;
  }
  issue(res);
  res.json({ ok: true });
});

sandboxRouter.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

sandboxRouter.get('/session', (req, res) => {
  res.json({ authenticated: readSession(req) !== null });
});

// ------------------------------------------------------------------- state

/**
 * The whole client-side state in one shape.
 *
 * Both /state and /trade return this. They used to differ — /trade replied with
 * just the book — and the screen replaced its state with the narrower object and
 * crashed on the first missing field. One builder, used by both, is the fix that
 * cannot drift back apart.
 */
function fullState(id: string): Record<string, unknown> {
  return {
    ...sandboxBook.state(id),
    instruments: sandboxBook.instruments(),
    durations: [...ALLOWED_DURATIONS],
    maxProfitMultiple: env.maxProfitMultiple,
    houseEdge: env.houseEdge,
  };
}

sandboxRouter.get('/state', requireSandboxSession, (req, res) => {
  try {
    res.json(fullState(sessionId(req)));
  } catch (err) {
    fail(res, err);
  }
});

sandboxRouter.post('/reset', requireSandboxSession, (req, res) => {
  try {
    const s = sandboxBook.reset(sessionId(req));
    res.json({ balance: s.balance });
  } catch (err) {
    fail(res, err);
  }
});

// ------------------------------------------------------------------ oracle

/**
 * Every future tick this market will produce, and what each position opened now
 * would earn.
 *
 * This is the point of the sandbox and it would be indefensible anywhere else.
 * See the header of services/sandbox.ts for why it is defensible here, and in
 * particular why these seeds have nothing to do with the live market's.
 */
sandboxRouter.get('/oracle', requireSandboxSession, (req, res) => {
  const symbol = pickSymbol(req.query.symbol);
  if (!symbol) {
    res.status(400).json({ error: 'UNKNOWN_MARKET', message: 'No such market.' });
    return;
  }
  try {
    res.json(sandboxBook.oracle(symbol));
  } catch (err) {
    fail(res, err);
  }
});

// ----------------------------------------------------------------- trading

sandboxRouter.post('/trade', requireSandboxSession, (req, res) => {
  const body = req.body as {
    symbol?: unknown;
    direction?: unknown;
    stake?: unknown;
    durationSec?: unknown;
  };
  const symbol = pickSymbol(body.symbol);
  if (!symbol) {
    res.status(400).json({ error: 'UNKNOWN_MARKET', message: 'No such market.' });
    return;
  }
  const direction = String(body.direction ?? '').toUpperCase();
  if (direction !== 'BUY' && direction !== 'SELL') {
    res.status(400).json({ error: 'VALIDATION', message: 'Pick Buy or Sell.' });
    return;
  }
  try {
    sandboxBook.open(sessionId(req), {
      symbol,
      direction,
      stake: Number(body.stake),
      durationSec: Number(body.durationSec),
    });
    res.status(201).json(fullState(sessionId(req)));
  } catch (err) {
    fail(res, err);
  }
});
