import { createClient } from '@supabase/supabase-js';
import { env } from '../env.js';

/**
 * Server-side Supabase client using the service role key. Every table has RLS
 * enabled with no policies, so this client is the only path to the data — the
 * browser never receives a Supabase key of any kind.
 */
export const db = createClient(
  // The sandbox runs with no database on purpose, and refuses to boot if one is
  // configured. createClient throws on an empty URL, so it gets a placeholder in
  // a reserved TLD that can never resolve: nothing in that mode calls the
  // database, and if something ever did it would fail loudly at DNS rather than
  // quietly reaching something real.
  env.supabaseUrl || 'http://none.invalid',
  env.supabaseServiceKey || 'no-database-in-sandbox-mode',
  {
    auth: { persistSession: false, autoRefreshToken: false },
  }
);

/** Unwraps a `raise exception 'CODE'` from a plpgsql function into a bare code. */
export function pgErrorCode(message: string | undefined): string | null {
  if (!message) return null;
  // Every code any fpesa_* function raises. A code missing from this list does
  // not fail loudly — it falls through to a generic "please try again", which
  // is how a precise refusal turns into a mystery. Kept in step with:
  //   select ... from pg_proc where proname like 'fpesa_%' -- grep raise exception
  const known = [
    'USER_NOT_FOUND',
    'INSUFFICIENT_FUNDS',
    'WITHDRAWAL_IN_FLIGHT',
    'TRANSACTION_NOT_FOUND',
    'TURNOVER_NOT_MET',
    'FLOAT_LIMIT',
    'INVALID_AMOUNT',
    'INVALID_MODE',
    'NEGATIVE_VALUE',
    'REASON_REQUIRED',
  ];
  return known.find((c) => message.includes(c)) ?? null;
}
