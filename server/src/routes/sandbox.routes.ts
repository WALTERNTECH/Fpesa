import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../env.js';
import { ALLOWED_DURATIONS } from '../services/trading.js';
import { sandboxBook, SandboxError } from '../services/sandbox.js';
import { fetchEpochs, runReplay } from '../services/sandbox-replay.js';
import { stressBook } from '../services/sandbox-book.js';
import { conform } from '../services/sandbox-conform.js';
import { shadowFeed } from '../services/sandbox-mirror.js';
import { audit, forecast } from '../services/sandbox-forecast.js';

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

/**
 * Every market's next prices, for the operator dashboard.
 *
 * Same market, same seeds, same restriction as the rest of this service: it
 * predicts the markets this process generates, which it can do exactly, and it
 * says nothing whatever about fpesa.markets.
 */
sandboxRouter.get('/admin/predictions', requireSandboxSession, (_req, res) => {
  try {
    res.json({
      ts: Date.now(),
      markets: sandboxBook.predictions(),
      durations: [...ALLOWED_DURATIONS],
      houseEdge: env.houseEdge,
      maxProfitMultiple: env.maxProfitMultiple,
    });
  } catch (err) {
    fail(res, err);
  }
});

// ------------------------------------------------------------------ replay

/**
 * Closed epochs of the real market, available to replay.
 *
 * Read from the live platform's public fairness endpoint — the same one any
 * trader can open — and every seed is re-hashed against the commitment that was
 * published before its epoch opened, with failures dropped rather than served.
 * Only closed epochs carry a seed; the running one does not, anywhere.
 */
sandboxRouter.get('/replay/epochs', requireSandboxSession, (req, res) => {
  const symbol = pickSymbol(req.query.symbol);
  if (!symbol) {
    res.status(400).json({ error: 'UNKNOWN_MARKET', message: 'No such market.' });
    return;
  }
  void fetchEpochs(symbol)
    .then((r) => res.json(r))
    .catch((err) => fail(res, err));
});

/**
 * Re-runs one epoch, optionally under different parameters.
 *
 * Returns the epoch as it actually traded alongside the variant, both built from
 * the same seed. Reusing the draws rather than redrawing them is what makes the
 * comparison mean anything: whatever differs between the two runs was caused by
 * the knob that moved.
 */
sandboxRouter.post('/replay', requireSandboxSession, (req, res) => {
  const body = req.body as {
    symbol?: unknown;
    epoch?: unknown;
    shock?: unknown;
    houseEdge?: unknown;
    maxProfitMultiple?: unknown;
    multiplierScale?: unknown;
    entryTick?: unknown;
  };
  const symbol = pickSymbol(body.symbol);
  if (!symbol) {
    res.status(400).json({ error: 'UNKNOWN_MARKET', message: 'No such market.' });
    return;
  }
  const epoch = Number(body.epoch);
  if (!Number.isFinite(epoch)) {
    res.status(400).json({ error: 'VALIDATION', message: 'Choose an epoch to replay.' });
    return;
  }

  const knob = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  void runReplay({
    symbol,
    epoch,
    knobs: {
      shock: knob(body.shock),
      houseEdge: knob(body.houseEdge),
      maxProfitMultiple: knob(body.maxProfitMultiple),
      multiplierScale: knob(body.multiplierScale),
      entryTick: knob(body.entryTick),
    },
  })
    .then((r) => res.json(r))
    .catch((err) => fail(res, err));
});

// -------------------------------------------------------------- forecast

/**
 * The forecast for the live market: centre, uncertainty bands, barrier odds.
 *
 * Built on production's live mid and published sigma. The centre line is flat
 * because that is the correct estimate for a driftless walk, not because
 * anything is being withheld — see services/sandbox-forecast.ts.
 */
sandboxRouter.get('/forecast', requireSandboxSession, (req, res) => {
  const symbol = pickSymbol(req.query.symbol);
  if (!symbol) {
    res.status(400).json({ error: 'UNKNOWN_MARKET', message: 'No such market.' });
    return;
  }
  void (async () => {
    // env.ts already strips any trailing slash from this.
    const base = env.sandbox.replaySource || 'https://www.fpesa.markets';
    const [quote, fair] = await Promise.all([
      fetch(base + '/api/market/quote?symbol=' + encodeURIComponent(symbol)).then((r) => r.json()),
      fetch(base + '/api/fairness?symbol=' + encodeURIComponent(symbol)).then((r) => r.json()),
    ]);
    const q = quote as { price: number };
    const f = fair as { parameters: { sigma: number } };
    res.json(forecast(symbol, q.price, f.parameters.sigma));
  })().catch((err) => fail(res, err));
});

/**
 * Does the live market's real history contain anything a forecast could use?
 *
 * Rebuilt from the seeds production published when each epoch closed, then
 * tested for autocorrelation, variance ratios, sign persistence, and whether
 * momentum or reversion beat the spread.
 */
sandboxRouter.get('/forecast/audit', requireSandboxSession, (req, res) => {
  const symbol = pickSymbol(req.query.symbol);
  if (!symbol) {
    res.status(400).json({ error: 'UNKNOWN_MARKET', message: 'No such market.' });
    return;
  }
  void audit(symbol)
    .then((r) => res.json(r))
    .catch((err) => fail(res, err));
});

// ---------------------------------------------------------------- shadow

/**
 * Shadow mode: this book running on production's own tick stream.
 *
 * There is deliberately no oracle here. These prices come from a market whose
 * seed this process does not hold, so there is no future to look at — following
 * a market and seeing ahead of it are the same fact from two sides. See
 * services/sandbox-mirror.ts.
 */
sandboxRouter.get('/shadow', requireSandboxSession, (req, res) => {
  const symbol = pickSymbol(req.query.symbol);
  if (!symbol) {
    res.status(400).json({ error: 'UNKNOWN_MARKET', message: 'No such market.' });
    return;
  }
  try {
    res.json({
      ...shadowFeed.status(),
      ...shadowFeed.state(sessionId(req)),
      symbol,
      recent: shadowFeed.recent(symbol),
      durations: [...ALLOWED_DURATIONS],
      maxProfitMultiple: env.maxProfitMultiple,
      houseEdge: env.houseEdge,
    });
  } catch (err) {
    fail(res, err);
  }
});

sandboxRouter.post('/shadow/trade', requireSandboxSession, (req, res) => {
  const body = req.body as Record<string, unknown>;
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
    shadowFeed.open(sessionId(req), {
      symbol,
      direction,
      stake: Number(body.stake),
      durationSec: Number(body.durationSec),
    });
    res.status(201).json({
      ...shadowFeed.status(),
      ...shadowFeed.state(sessionId(req)),
      symbol,
      recent: shadowFeed.recent(symbol),
      durations: [...ALLOWED_DURATIONS],
      maxProfitMultiple: env.maxProfitMultiple,
      houseEdge: env.houseEdge,
    });
  } catch (err) {
    fail(res, err);
  }
});

sandboxRouter.post('/shadow/reset', requireSandboxSession, (req, res) => {
  try {
    shadowFeed.reset(sessionId(req));
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

// ------------------------------------------------------------ conformance

/**
 * Does the sandbox quote the same contract production would?
 *
 * Takes production's live price and published parameters, prices the ticket
 * through this service's own code, and diffs it against the margin figures
 * production publishes for that same ticket. See services/sandbox-conform.ts
 * for why this tests the thing a seed comparison could not.
 */
sandboxRouter.get('/conform', requireSandboxSession, (req, res) => {
  const symbol = pickSymbol(req.query.symbol);
  if (!symbol) {
    res.status(400).json({ error: 'UNKNOWN_MARKET', message: 'No such market.' });
    return;
  }
  const stake = Number(req.query.stake ?? 1000);
  const durationSec = Number(req.query.durationSec ?? 10);
  if (!Number.isFinite(stake) || stake <= 0) {
    res.status(400).json({ error: 'VALIDATION', message: 'Enter a stake.' });
    return;
  }
  if (!(ALLOWED_DURATIONS as readonly number[]).includes(durationSec)) {
    res.status(400).json({ error: 'VALIDATION', message: 'Choose an offered duration.' });
    return;
  }
  void conform({ symbol, stake, durationSec })
    .then((r) => res.json(r))
    .catch((err) => fail(res, err));
});

// ------------------------------------------------------------ book stress

/**
 * How much risk the solvency guard admits, and what a correlated win costs.
 *
 * Takes a hypothetical book rather than reading a real one — there is no
 * database here — so any state can be tried, including ones the live book has
 * never been in and hopefully never will be. See services/sandbox-book.ts for
 * why this, and not a price feed, is what "large order impact" and "black swan
 * survival" actually mean on a platform with no order book.
 */
sandboxRouter.post('/book', requireSandboxSession, (req, res) => {
  const b = req.body as Record<string, unknown>;
  const n = (v: unknown): number | undefined => {
    const x = Number(v);
    return Number.isFinite(x) ? x : undefined;
  };
  try {
    res.json(
      stressBook({
        cash: n(b.cash),
        operatorFloat: n(b.operatorFloat),
        owed: n(b.owed),
        atRisk: n(b.atRisk),
        positionShare: n(b.positionShare),
        maxProfitMultiple: n(b.maxProfitMultiple),
        stake: n(b.stake),
      })
    );
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
