import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../env.js';
import { db } from '../lib/db.js';
import {
  SESSION_COOKIE,
  hashPassword,
  normalisePhone,
  requireAuth,
  signToken,
  toSessionUser,
  verifyPassword,
} from '../lib/auth.js';

export const authRouter = Router();

const attemptLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many attempts. Try again in a few minutes.' },
});

const usernameRule = z
  .string()
  .trim()
  .min(3, 'Username must be at least 3 characters.')
  .max(20, 'Username must be 20 characters or fewer.')
  .regex(/^[a-zA-Z0-9_]+$/, 'Use letters, numbers and underscores only.');

const passwordRule = z.string().min(6, 'Password must be at least 6 characters.').max(72);

const registerSchema = z
  .object({
    username: usernameRule,
    phone: z.string().trim().min(9, 'Enter your M-Pesa phone number.'),
    password: passwordRule,
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  });

const loginSchema = z.object({
  username: z.string().trim().min(1, 'Enter your username or phone number.'),
  password: z.string().min(1, 'Enter your password.'),
});

function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: env.isProd,
    sameSite: 'lax' as const,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  };
}

function firstIssue(err: z.ZodError): string {
  return err.issues[0]?.message ?? 'Please check the form and try again.';
}

authRouter.post('/register', attemptLimiter, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'VALIDATION', message: firstIssue(parsed.error) });
    return;
  }
  const { username, password } = parsed.data;

  const phone = normalisePhone(parsed.data.phone);
  if (!phone) {
    res.status(400).json({
      error: 'VALIDATION',
      message: 'Enter a valid Safaricom number, e.g. 0712 345 678.',
    });
    return;
  }

  const { data: clash } = await db
    .from('users')
    .select('id, username, phone')
    .or('username.eq.' + username + ',phone.eq.' + phone)
    .limit(1)
    .maybeSingle();

  if (clash) {
    const row = clash as { username: string; phone: string };
    const takenPhone = row.phone === phone;
    res.status(409).json({
      error: takenPhone ? 'PHONE_TAKEN' : 'USERNAME_TAKEN',
      message: takenPhone
        ? 'That phone number already has an Fpesa account.'
        : 'That username is already taken.',
    });
    return;
  }

  const passwordHash = await hashPassword(password);
  const { data, error } = await db
    .from('users')
    .insert({
      username,
      phone,
      password_hash: passwordHash,
      demo_balance: env.demoStartingBalance,
      real_balance: 0,
    })
    .select('id, username, phone, demo_balance, real_balance, is_admin, is_active, turnover_required, turnover_progress')
    .single();

  if (error || !data) {
    // Unique indexes are the final word if two signups raced past the check above.
    if (error?.code === '23505') {
      res.status(409).json({
        error: 'ALREADY_EXISTS',
        message: 'Those details are already registered. Try logging in.',
      });
      return;
    }
    console.error('[auth] register failed:', error?.message);
    res.status(500).json({ error: 'REGISTER_FAILED', message: 'Could not create your account.' });
    return;
  }

  const user = toSessionUser(data as never);
  res.cookie(SESSION_COOKIE, signToken(user.id), sessionCookieOptions());
  res.status(201).json({ user, demoCredited: env.demoStartingBalance });
});

authRouter.post('/login', attemptLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'VALIDATION', message: firstIssue(parsed.error) });
    return;
  }
  const identifier = parsed.data.username;
  const asPhone = normalisePhone(identifier);

  const query = db
    .from('users')
    .select('id, username, phone, password_hash, demo_balance, real_balance, is_admin, is_active, turnover_required, turnover_progress');
  const { data } = asPhone
    ? await query.or('username.eq.' + identifier + ',phone.eq.' + asPhone).limit(1).maybeSingle()
    : await query.eq('username', identifier).maybeSingle();

  const row = data as (Record<string, unknown> & { password_hash: string; is_active: boolean }) | null;

  // Same response whether the account is missing or the password is wrong, so
  // the endpoint cannot be used to enumerate who has an account.
  const invalid = { error: 'INVALID_CREDENTIALS', message: 'Wrong username or password.' };
  if (!row) {
    await hashPassword('timing-equaliser');
    res.status(401).json(invalid);
    return;
  }
  const ok = await verifyPassword(parsed.data.password, row.password_hash);
  if (!ok || !row.is_active) {
    res.status(401).json(invalid);
    return;
  }

  const user = toSessionUser(row as never);
  await db.from('users').update({ last_seen_at: new Date().toISOString() }).eq('id', user.id);
  res.cookie(SESSION_COOKIE, signToken(user.id), sessionCookieOptions());
  res.json({ user });
});

authRouter.post('/logout', (_req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  if (!req.user) {
    res.json({ user: null });
    return;
  }
  res.json({ user: req.user });
});

authRouter.post('/demo/reset', requireAuth, async (req, res) => {
  const { data, error } = await db
    .from('users')
    .update({ demo_balance: env.demoStartingBalance })
    .eq('id', req.user!.id)
    .select('demo_balance')
    .single();
  if (error) {
    res.status(500).json({ error: 'RESET_FAILED', message: 'Could not reset the demo balance.' });
    return;
  }
  res.json({ demoBalance: Number((data as { demo_balance: string | number }).demo_balance) });
});
