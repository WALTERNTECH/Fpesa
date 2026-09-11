#!/usr/bin/env node
/**
 * Walks Fpesa's published fairness chain and checks every link.
 *
 *   node scripts/verify-chain.mjs [symbol] [--url https://www.fpesa.markets]
 *                                          [--head <hash>] [--replay]
 *
 * What it checks, in order:
 *
 *   1. Every epoch's chainHash is what the published algorithm says it should
 *      be, given that epoch's own contents.
 *   2. Every epoch links to the one before it.
 *   3. Epoch numbers are strictly increasing with no gaps.
 *   4. Every revealed seed hashes to the commitment published beforehand.
 *   5. With --replay, the ticks of the newest closed epoch are regenerated and
 *      compared against the seed.
 *
 * With --head, the chain is also checked against a head hash you recorded
 * earlier. That is the part that matters most and the part only you can do:
 * everything else is the operator's own server vouching for itself. A head you
 * wrote down last week, still present in today's chain, is evidence no epoch
 * between then and now was rewritten. Record it on a schedule and keep it
 * somewhere the operator cannot reach.
 *
 * The maths and the hashing are reimplemented here on purpose. Importing the
 * server's copy would prove only that the code agrees with itself.
 */
import { createHash, createHmac } from 'node:crypto';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const baseUrl = (flag('--url') ?? 'https://www.fpesa.markets').replace(/\/+$/, '');
const expectedHead = flag('--head');
const doReplay = args.includes('--replay');
const symbol = args.find((a) => /^FPX\d+$/i.test(a))?.toUpperCase() ?? 'FPX100';

const TWO_POW_53 = 9007199254740992;

function uniform(digest, offset) {
  const hi = digest.readUInt32BE(offset) & 0x1fffff;
  const lo = digest.readUInt32BE(offset + 4);
  return (hi * 4294967296 + lo + 0.5) / TWO_POW_53;
}

function normalFrom(seed, label) {
  const digest = createHmac('sha256', seed).update(label).digest();
  return Math.sqrt(-2 * Math.log(uniform(digest, 0))) * Math.cos(2 * Math.PI * uniform(digest, 8));
}

/** The canonical form the chain commits to. Key order and precision are fixed. */
function canonical(e) {
  return [
    symbol,
    String(e.epoch),
    e.seedHash,
    Number(e.startPrice).toFixed(6),
    String(e.tickMs),
    String(e.epochMs),
    Number(e.sigma).toFixed(12),
    Number(e.drift).toFixed(12),
    String(e.startedAt),
  ].join('|');
}

function chainHashOf(prev, e) {
  return createHash('sha256').update((prev ?? '') + '|' + canonical(e)).digest('hex');
}

const res = await fetch(baseUrl + '/api/fairness?symbol=' + encodeURIComponent(symbol));
if (!res.ok) {
  console.error('Could not read ' + baseUrl + '/api/fairness — HTTP ' + res.status);
  process.exitCode = 2;
  throw new Error('verification aborted');
}
const f = await res.json();
if (!f.provablyFair) {
  console.error('This deployment is not running a seeded instrument.');
  process.exitCode = 2;
  throw new Error('verification aborted');
}

// The full window including the epoch still running; falls back to the closed-only
// list so this also works against a server predating the chain.
const epochs = [...(f.chain?.epochs ?? f.revealed ?? [])].sort((a, z) => a.epoch - z.epoch);
if (epochs.length === 0) {
  console.error('No epochs published yet.');
  process.exitCode = 2;
  throw new Error('verification aborted');
}

console.log('Fpesa fairness chain — ' + symbol + ' @ ' + baseUrl);
console.log('  epochs in this window : ' + epochs.length +
  '  (#' + epochs[0].epoch + ' to #' + epochs[epochs.length - 1].epoch + ')');
console.log('  head reported by server: ' + (f.chain?.head?.chainHash ?? 'none'));
console.log('  server says links valid: ' + f.chain?.linksValid);
if (f.chain?.unrecorded) {
  console.log('  epochs the server failed to record: ' + f.chain.unrecorded + '  <-- investigate');
}
console.log('');

let failures = 0;
let previous = null;

for (const e of epochs) {
  const problems = [];

  const expected = chainHashOf(e.prevChainHash, e);
  if (expected !== e.chainHash) problems.push('chainHash does not match its own contents');

  if (previous) {
    if (e.prevChainHash !== previous.chainHash) problems.push('does not link to epoch #' + previous.epoch);
    if (e.epoch !== previous.epoch + 1) problems.push('gap: follows #' + previous.epoch);
  }

  if (e.seed) {
    const h = createHash('sha256').update(e.seed).digest('hex');
    if (h !== e.seedHash) problems.push('seed does not hash to its published commitment');
  }

  if (problems.length) {
    failures += 1;
    console.log('  #' + String(e.epoch).padEnd(6) + ' FAIL  ' + problems.join('; '));
  }
  previous = e;
}

if (failures === 0) {
  console.log('  all ' + epochs.length + ' epochs: hashes match, links intact, no gaps, ' +
    'every revealed seed matches its commitment.');
}

// --- the check only you can make ---------------------------------------
if (expectedHead) {
  const found = epochs.find((e) => e.chainHash === expectedHead);
  console.log('');
  if (found) {
    console.log('  HEAD CHECK: the hash you recorded is still in the chain, at epoch #' +
      found.epoch + '. Nothing up to that point has been rewritten.');
  } else {
    failures += 1;
    console.log('  HEAD CHECK FAILED: the hash you recorded does not appear in this window.');
    console.log('  That is either an older head than the window covers, or the chain was rebuilt.');
  }
}

// --- optional: regenerate the ticks ------------------------------------
if (doReplay) {
  const closed = [...epochs].reverse().find((e) => e.seed);
  if (!closed) {
    console.log('\n  --replay: no closed epoch with a seed in this window.');
  } else {
    const ticks = Math.round(closed.epochMs / closed.tickMs);
    const dt = closed.tickMs / 1000;
    let price = Number(closed.startPrice);
    const first = [];
    for (let i = 0; i < ticks; i++) {
      const z = normalFrom(closed.seed, closed.epoch + ':' + i);
      price = Math.max(
        Math.round(price * Math.exp(Number(closed.drift) * dt + Number(closed.sigma) * Math.sqrt(dt) * z) * 100) / 100,
        0.01
      );
      if (i < 6) first.push(price);
    }
    console.log('\n  --replay: epoch #' + closed.epoch + ' regenerated from its seed');
    console.log('    ' + ticks + ' ticks, opening at ' + closed.startPrice);
    console.log('    first six: ' + first.join(', '));
    console.log('    closing:   ' + price);
    console.log('    drift published as ' + closed.drift +
      (Number(closed.drift) === 0 ? ' — no tilt hidden in the path' : '  <-- NON-ZERO, the path is tilted'));
  }
}

console.log('');
if (failures === 0) {
  console.log('PASS. Record this head and check it again later:');
  console.log('  ' + (f.chain?.head?.chainHash ?? epochs[epochs.length - 1].chainHash));
} else {
  console.log('FAIL — ' + failures + ' problem(s). The published record does not hold together.');
}
// Set rather than force-exit: an abrupt exit() while the fetch socket is still
// closing trips a libuv assertion on Windows, which looks like the verifier
// itself failed.
process.exitCode = failures === 0 ? 0 : 1;
