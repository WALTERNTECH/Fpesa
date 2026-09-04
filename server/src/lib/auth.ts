import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../env.js';
import { db } from './db.js';

export type SessionUser = {
  id: string;
  username: string;
  phone: string;
  demoBalance: number;
  realBalance: number;
  isAdmin: boolean;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

const TOKEN_TTL = '30d';
export const SESSION_COOKIE = 'fpesa_session';

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 11);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, env.jwtSecret, { expiresIn: TOKEN_TTL });
}

function readToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
  return cookie ?? null;
}

type UserRow = {
  id: string;
  username: string;
  phone: string;
  demo_balance: string | number;
  real_balance: string | number;
  is_admin: boolean;
  is_active: boolean;
};

export function toSessionUser(row: UserRow): SessionUser {
  return {
    id: row.id,
    username: row.username,
    phone: row.phone,
    demoBalance: Number(row.demo_balance),
    realBalance: Number(row.real_balance),
    isAdmin: row.is_admin,
  };
}

async function loadUser(userId: string): Promise<SessionUser | null> {
  const { data, error } = await db
    .from('users')
    .select('id, username, phone, demo_balance, real_balance, is_admin, is_active')
    .eq('id', userId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as UserRow;
  if (!row.is_active) return null;
  return toSessionUser(row);
}

/** Attaches req.user when a valid session exists; never rejects. */
export async function attachUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = readToken(req);
  if (!token) return next();
  try {
    const payload = jwt.verify(token, env.jwtSecret) as { sub?: string };
    if (payload.sub) {
      const user = await loadUser(payload.sub);
      if (user) req.user = user;
    }
  } catch {
    // Expired or tampered token — continue as a guest.
  }
  next();
}

/** Gate for endpoints that move money or write on a user's behalf. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'AUTH_REQUIRED', message: 'Please log in to continue.' });
    return;
  }
  next();
}

/**
 * Normalises Kenyan mobile numbers to the 2547XXXXXXXX / 2541XXXXXXXX form
 * that both M-Pesa and our database constraint expect.
 */
export function normalisePhone(input: string): string | null {
  const digits = input.replace(/[^0-9]/g, '');
  let n = digits;
  if (n.startsWith('254')) n = n.slice(3);
  else if (n.startsWith('0')) n = n.slice(1);
  if (!/^(7|1)[0-9]{8}$/.test(n)) return null;
  return '254' + n;
}
