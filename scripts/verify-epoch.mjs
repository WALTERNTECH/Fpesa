#!/usr/bin/env node
/**
 * Independently verifies a closed epoch of the Fpesa synthetic instrument.
 *
 *   node scripts/verify-epoch.mjs [epoch] [--url https://fpesa.onrender.com]
 *
 * With no epoch it checks the most recently revealed one. It fetches the
 * published record, confirms sha256(seed) matches the hash that was committed
 * before the epoch opened, then regenerates every tick from the seed.
 *
 * The maths is reimplemented here on purpose: importing the server's copy
 * would prove only that the code agrees with itself.
 */
import { createHash, createHmac } from 'node:crypto';

const args = process.argv.slice(2);
const urlFlag = args.indexOf('--url');
const baseUrl = urlFlag !== -1 ? args[urlFlag + 1] : 'https://fpesa.onrender.com';
const wanted = args.find((a) => /^\d+$/.test(a));

const TWO_POW_53 = 9007199254740992;

function uniform(digest, offset) {
  const hi = digest.readUInt32BE(offset) & 0x1fffff;
  const lo = digest.readUInt32BE(offset + 4);
  return (hi * 4294967296 + lo + 0.5) / TWO_POW_53;
}

function normalFrom(seed, label) {
  const digest = createHmac('sha256', seed).update(label).digest();
  const u1 = uniform(digest, 0);
  const u2 = uniform(digest, 8);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

const res = await fetch(baseUrl.replace(/\/+$/, '') + '/api/fairness');
if (!res.ok) {
  console.error('Could not read /api/fairness (' + res.status + ')');
  process.exit(1);
}
const body = await res.json();

if (!body.provablyFair) {
  console.error('This deployment is not running a seeded instrument:');
  console.error('  ' + (body.note ?? 'mode=' + body.mode));
  process.exit(1);
}

const epochs = body.revealed ?? [];
const record = wanted
  ? epochs.find((e) => String(e.epoch) === wanted)
  : epochs[0];

if (!record) {
  console.error(
    wanted
      ? 'Epoch ' + wanted + ' is not among the published epochs.'
      : 'No closed epochs published yet — wait for the first one to end.'
  );
  process.exit(1);
}

console.log('Instrument : ' + body.symbol + ' (' + body.name + ')');
console.log('Epoch      : ' + record.epoch);
console.log('Started    : ' + new Date(record.startedAt).toISOString());
console.log('Ended      : ' + new Date(record.endedAt).toISOString());
console.log('Start price: ' + record.startPrice);
console.log('sigma/drift: ' + record.sigma + ' / ' + record.drift);
console.log();

// 1. The seed must match the hash committed before the epoch opened.
const actualHash = createHash('sha256').update(record.seed).digest('hex');
const hashOk = actualHash === record.seedHash;
console.log('committed hash : ' + record.seedHash);
console.log('sha256(seed)   : ' + actualHash);
console.log(hashOk ? 'COMMITMENT OK — the seed was fixed before the epoch ran'
                   : 'COMMITMENT FAILED — the seed does not match what was published');

// 2. Regenerate the path from the seed.
const ticks = Math.floor((record.endedAt - record.startedAt) / record.tickMs);
const dt = record.tickMs / 1000;
let price = record.startPrice;
const path = [];
for (let i = 0; i < ticks; i++) {
  const z = normalFrom(record.seed, record.epoch + ':' + i);
  price = price * Math.exp(record.drift * dt + record.sigma * Math.sqrt(dt) * z);
  // Quantise to two decimals and CARRY THE ROUNDED VALUE into the next step.
  // The engine stores the rounded price, so a verifier that keeps full
  // precision forward will agree for a tick or two and then drift by cents —
  // which looks exactly like a rigged feed when it is really a rounding bug.
  price = Math.max(Math.round(price * 100) / 100, 0.01);
  path.push(price);
}

console.log();
console.log('regenerated ' + path.length + ' ticks from the seed');
console.log('  first 5 : ' + path.slice(0, 5).join(', '));
console.log('  last 5  : ' + path.slice(-5).join(', '));
const lo = Math.min(...path), hi = Math.max(...path);
console.log('  range   : ' + lo.toFixed(2) + ' – ' + hi.toFixed(2));
console.log();
console.log(
  hashOk
    ? 'Compare these against the prices you traded on in this epoch. They are\n' +
      'reproducible by anyone holding the published seed, and the seed was\n' +
      'committed by hash before the first tick existed.'
    : 'Do not trust this epoch.'
);

// Set the code rather than calling process.exit(): exiting while the fetch
// socket is still closing trips a libuv assertion on Windows, which would make
// this unusable from CI.
process.exitCode = hashOk ? 0 : 1;
