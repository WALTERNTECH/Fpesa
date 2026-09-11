import { createHash } from 'node:crypto';
import { db } from '../lib/db.js';

/**
 * The durable, hash-chained fairness record.
 *
 * ## What was wrong
 *
 * The published record used to live in the price engine's memory. A restart
 * reset the epoch counter to 1 and erased every epoch before it, so a trader
 * could not verify a price from before the last deploy — and, worse, a
 * *discarded* epoch looked exactly like a deploy. An operator who disliked how
 * an epoch was going could restart the process and the evidence would simply be
 * gone, with nothing in the published record even hinting that it had existed.
 *
 * A commitment scheme that a restart can erase is not a commitment scheme.
 *
 * ## What this gives instead
 *
 * Every epoch is written to the database *before* it produces a tick, carrying
 * its commitment and the parameters it will run under, and linked to the epoch
 * before it:
 *
 *     chainHash = sha256(prevChainHash + "|" + canonical(record))
 *
 * The record covers the seed hash, the opening price, sigma, drift and the
 * timings. So the chain fixes not only *which prices* an epoch will produce but
 * *what settings* it produced them under. A drift quietly moved for an hour and
 * moved back leaves a permanent, timestamped mark.
 *
 * Removing or editing any row breaks every link after it, and the numbering is
 * per symbol and strictly increasing across restarts. There is no sequence of
 * human interventions that rewrites this record without leaving a hole a
 * verifier walks straight into.
 *
 * ## What it still does not do, stated plainly
 *
 * The operator publishes the chain from their own server. That makes tampering
 * *detectable by anyone who recorded the chain head earlier* — it does not make
 * it impossible for someone who controls every copy. Closing that last gap needs
 * the head witnessed somewhere the operator does not control: an auditor
 * recording it on a schedule, or anchoring it in a public append-only log. The
 * head is exposed on /api/fairness precisely so that can be done, and until it
 * is, this is tamper-evident rather than tamper-proof.
 */

export type EpochCommitment = {
  symbol: string;
  epoch: number;
  seedHash: string;
  startPrice: number;
  tickMs: number;
  epochMs: number;
  sigma: number;
  drift: number;
  startedAt: number;
};

export type ChainHead = { epoch: number; chainHash: string };

/**
 * The bytes the chain commits to.
 *
 * Fixed key order and fixed numeric formatting, because a canonical form that
 * depends on how a language happens to serialise objects is not canonical. Any
 * independent implementation must produce this string exactly.
 */
export function canonical(c: EpochCommitment): string {
  return [
    c.symbol,
    String(c.epoch),
    c.seedHash,
    c.startPrice.toFixed(6),
    String(c.tickMs),
    String(c.epochMs),
    c.sigma.toFixed(12),
    c.drift.toFixed(12),
    String(c.startedAt),
  ].join('|');
}

export function chainHashOf(prev: string | null, c: EpochCommitment): string {
  return createHash('sha256')
    .update((prev ?? '') + '|' + canonical(c))
    .digest('hex');
}

type Row = {
  symbol: string;
  epoch: number | string;
  seed_hash: string;
  prev_chain_hash: string | null;
  chain_hash: string;
  start_price: number | string;
  tick_ms: number;
  epoch_ms: number;
  sigma: number | string;
  drift: number | string;
  started_at: string;
  ended_at: string | null;
  seed: string | null;
};

/** Where each symbol's chain currently ends, so a restart continues it. */
export async function loadHeads(): Promise<Map<string, ChainHead>> {
  const heads = new Map<string, ChainHead>();
  const { data, error } = await db
    .from('fairness_epochs')
    .select('symbol, epoch, chain_hash')
    .order('epoch', { ascending: false });
  if (error) {
    console.error('[fairness] could not load chain heads:', error.message);
    return heads;
  }
  for (const row of (data ?? []) as Array<{ symbol: string; epoch: number; chain_hash: string }>) {
    // Ordered newest first, so the first row seen for a symbol is its head.
    if (!heads.has(row.symbol)) {
      heads.set(row.symbol, { epoch: Number(row.epoch), chainHash: row.chain_hash });
    }
  }
  return heads;
}

/**
 * Appends a commitment.
 *
 * Retried, because a gap here is a hole in the published record and a hole is
 * what tampering looks like. Persistent failure is counted and surfaced on
 * /api/fairness rather than swallowed, so an infrastructure problem cannot be
 * mistaken for — or hide behind — a missing epoch.
 */
let unrecorded = 0;

export function unrecordedCount(): number {
  return unrecorded;
}

export async function recordEpoch(
  c: EpochCommitment,
  prevChainHash: string | null,
  chainHash: string
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * attempt));
    const { error } = await db.rpc('fpesa_record_epoch', {
      p_symbol: c.symbol,
      p_epoch: c.epoch,
      p_seed_hash: c.seedHash,
      p_prev_chain_hash: prevChainHash,
      p_chain_hash: chainHash,
      p_start_price: c.startPrice,
      p_tick_ms: c.tickMs,
      p_epoch_ms: c.epochMs,
      p_sigma: c.sigma,
      p_drift: c.drift,
      p_started_at: new Date(c.startedAt).toISOString(),
    });
    if (!error) return true;
    // A chain mismatch is not transient and must be loud: it means this process
    // believes a different history from the one in the database.
    if (error.message.includes('CHAIN_MISMATCH') || error.message.includes('EPOCH_NOT_ADVANCING')) {
      console.error(
        '[fairness] REFUSED to append ' + c.symbol + ' epoch ' + c.epoch + ': ' + error.message +
        ' — this process disagrees with the recorded chain. Prices continue; the ' +
        'record does not. Investigate before trusting either.'
      );
      unrecorded += 1;
      return false;
    }
    console.error('[fairness] append failed (attempt ' + (attempt + 1) + '):', error.message);
  }
  unrecorded += 1;
  return false;
}

/** Publishes a closed epoch's seed. Refused if a different one is already there. */
export async function revealEpoch(
  symbol: string,
  epoch: number,
  seed: string,
  endedAt: number
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * attempt));
    const { error } = await db.rpc('fpesa_reveal_epoch', {
      p_symbol: symbol,
      p_epoch: epoch,
      p_seed: seed,
      p_ended_at: new Date(endedAt).toISOString(),
    });
    if (!error) return true;
    if (error.message.includes('SEED_ALREADY_REVEALED')) {
      console.error(
        '[fairness] REFUSED to re-reveal ' + symbol + ' epoch ' + epoch +
        ' with a different seed. The published one stands.'
      );
      return false;
    }
    console.error('[fairness] reveal failed (attempt ' + (attempt + 1) + '):', error.message);
  }
  return false;
}

export type PublishedEpoch = {
  epoch: number;
  startPrice: number;
  seedHash: string;
  prevChainHash: string | null;
  chainHash: string;
  startedAt: number;
  endedAt: number | null;
  seed: string | null;
  tickMs: number;
  epochMs: number;
  sigma: number;
  drift: number;
};

/**
 * The published chain for one symbol, newest first, with every link checked
 * here before it is served.
 *
 * Recomputing the hashes on read is the point: a row edited directly in the
 * database still has to survive this, and a verifier running the same
 * computation independently should reach the same verdict.
 */
export async function readChain(symbol: string, limit = 48): Promise<{
  epochs: PublishedEpoch[];
  head: ChainHead | null;
  /**
   * Whether the record could be read at all. Kept separate from linksValid
   * because "the database was unreachable" and "the chain has been tampered
   * with" are completely different claims, and reporting the first as the
   * second would cry wolf every time infrastructure hiccups.
   */
  readable: boolean;
  linksValid: boolean | null;
  brokenAt: number | null;
}> {
  const { data, error } = await db
    .from('fairness_epochs')
    .select('*')
    .eq('symbol', symbol)
    .order('epoch', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('[fairness] could not read chain:', error.message);
    return { epochs: [], head: null, readable: false, linksValid: null, brokenAt: null };
  }

  const rows = ((data ?? []) as Row[]).map((r): PublishedEpoch => ({
    epoch: Number(r.epoch),
    startPrice: Number(r.start_price),
    seedHash: r.seed_hash,
    prevChainHash: r.prev_chain_hash,
    chainHash: r.chain_hash,
    startedAt: Date.parse(r.started_at),
    endedAt: r.ended_at ? Date.parse(r.ended_at) : null,
    seed: r.seed,
    tickMs: r.tick_ms,
    epochMs: r.epoch_ms,
    sigma: Number(r.sigma),
    drift: Number(r.drift),
  }));

  let linksValid = true;
  let brokenAt: number | null = null;

  // Oldest first for checking, so a break is reported at the earliest epoch it
  // affects rather than the newest.
  const ordered = [...rows].reverse();
  for (let i = 0; i < ordered.length; i++) {
    const e = ordered[i]!;
    const expected = chainHashOf(e.prevChainHash, {
      symbol,
      epoch: e.epoch,
      seedHash: e.seedHash,
      startPrice: e.startPrice,
      tickMs: e.tickMs,
      epochMs: e.epochMs,
      sigma: e.sigma,
      drift: e.drift,
      startedAt: e.startedAt,
    });
    const contentOk = expected === e.chainHash;
    // The window may start mid-chain, so the first row's predecessor is only
    // checked when it is actually present in this page.
    const previous = ordered[i - 1];
    const linkOk = !previous || previous.chainHash === e.prevChainHash;
    if (!contentOk || !linkOk) {
      linksValid = false;
      brokenAt = e.epoch;
      break;
    }
  }

  return {
    epochs: rows,
    head: rows[0] ? { epoch: rows[0].epoch, chainHash: rows[0].chainHash } : null,
    readable: true,
    // An empty chain that read cleanly has nothing wrong with it — there is
    // simply nothing in it yet.
    linksValid,
    brokenAt,
  };
}
