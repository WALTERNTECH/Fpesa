import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { hub } from '../realtime/hub.js';
import { getLeaderboard, maskUsername } from '../services/trading.js';

export const socialRouter = Router();

const chatLimiter = rateLimit({
  windowMs: 30_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'You are sending messages too quickly.' },
});

const messageSchema = z.object({
  body: z.string().trim().min(1, 'Type a message first.').max(400, 'Message is too long.'),
});

/**
 * Public room, so strip anything that looks like a contact detail or link.
 * Keeps the feed from turning into a channel for scams and off-platform payment
 * requests, which is the usual failure mode for an open trading chat.
 */
const BLOCKED = [
  /https?:\/\/\S+/gi,
  /\bwww\.\S+/gi,
  /\b(?:\+?254|0)7\d{8}\b/g,
  /\b\d{9,}\b/g,
];

function sanitise(text: string): string {
  let out = text.replace(/\s+/g, ' ').trim();
  for (const rule of BLOCKED) out = out.replace(rule, '[removed]');
  return out;
}

socialRouter.get('/chat', async (_req, res) => {
  const { data, error } = await db
    .from('chat_messages')
    .select('id, username, body, created_at')
    .order('created_at', { ascending: false })
    .limit(60);
  if (error) {
    res.status(500).json({ error: 'LOAD_FAILED', message: 'Could not load the chat.' });
    return;
  }
  const rows = ((data ?? []) as Array<{
    id: string;
    username: string;
    body: string;
    created_at: string;
  }>).reverse();
  res.json({
    messages: rows.map((r) => ({
      id: r.id,
      username: r.username,
      body: r.body,
      createdAt: r.created_at,
    })),
  });
});

socialRouter.post('/chat', requireAuth, chatLimiter, async (req, res) => {
  const parsed = messageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'VALIDATION',
      message: parsed.error.issues[0]?.message ?? 'Type a message first.',
    });
    return;
  }
  const body = sanitise(parsed.data.body);
  if (!body || body === '[removed]') {
    res.status(400).json({ error: 'VALIDATION', message: 'That message could not be posted.' });
    return;
  }

  const { data, error } = await db
    .from('chat_messages')
    .insert({ user_id: req.user!.id, username: req.user!.username, body })
    .select('id, username, body, created_at')
    .single();

  if (error || !data) {
    res.status(500).json({ error: 'SEND_FAILED', message: 'Could not send your message.' });
    return;
  }
  const row = data as { id: string; username: string; body: string; created_at: string };
  const message = {
    id: row.id,
    username: row.username,
    body: row.body,
    createdAt: row.created_at,
  };
  hub.broadcast({ type: 'chat', ...message });
  res.status(201).json({ message });
});

socialRouter.get('/feed', async (_req, res) => {
  const { data, error } = await db
    .from('activity_feed')
    .select('id, kind, username, amount, created_at')
    .order('created_at', { ascending: false })
    .limit(25);
  if (error) {
    res.status(500).json({ error: 'LOAD_FAILED', message: 'Could not load the activity feed.' });
    return;
  }
  res.json({
    items: ((data ?? []) as Array<{
      id: string;
      kind: string;
      username: string;
      amount: string | number;
      created_at: string;
    }>).map((r) => ({
      id: r.id,
      kind: r.kind,
      username: maskUsername(r.username),
      amount: Number(r.amount),
      createdAt: r.created_at,
    })),
  });
});

socialRouter.get('/leaderboard', async (_req, res) => {
  const rows = await getLeaderboard(5);
  res.json({ rows, topTrader: rows[0] ?? null });
});

socialRouter.get('/stats', async (_req, res) => {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);

  const [{ count: tradersToday }, { data: volumeRows }] = await Promise.all([
    db
      .from('trades')
      .select('user_id', { count: 'exact', head: true })
      .gte('opened_at', since.toISOString()),
    db.from('trades').select('stake').gte('opened_at', since.toISOString()).limit(5000),
  ]);

  const volume = ((volumeRows ?? []) as Array<{ stake: string | number }>).reduce(
    (sum, r) => sum + Number(r.stake),
    0
  );

  res.json({
    online: hub.onlineCount(),
    tradesToday: tradersToday ?? 0,
    volumeToday: Math.round(volume),
  });
});
