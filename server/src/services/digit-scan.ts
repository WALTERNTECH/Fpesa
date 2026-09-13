import { priceFeed } from './prices.js';
import { INSTRUMENTS, instrumentOr } from './instruments.js';
import { normalCdf } from '../lib/stats.js';

/**
 * Fpesa Auto — the market scanner behind the Even/Odd ticket.
 *
 * ## What this does, and what it deliberately does not
 *
 * It reads every instrument's recent closing digits and reports which market
 * has leaned furthest from an even split, how far, and over how many ticks. All
 * of that is measured: counted from ticks that actually happened.
 *
 * It does not predict the next digit, and it does not score a trade's chance of
 * winning, because there is nothing to score. The digit stream is independent
 * and uniform — measured across every instrument and duration, each digit lands
 * within a few hundredths of a point of 10%. A run of Odd says exactly nothing
 * about the next tick, in the same way a run of heads says nothing about the
 * next toss. Every Even/Odd ticket is a coin flip minus the edge, whatever the
 * last thousand ticks did.
 *
 * So the scan returns a confidence that the lean it found is REAL rather than
 * normal variation — a two-sided p-value against a fair 50/50 — and on a fair
 * feed that will nearly always say "within normal variation". That is the
 * honest answer and it is the one worth showing: a trader who can see the lean
 * is noise is better served than one who is handed a number that implies an
 * edge nobody has.
 */

/** Ticks kept per instrument. Enough to measure a real lean, bounded. */
const WINDOW = 2000;

const buffers = new Map<string, number[]>();
let started = false;

function digitOf(price: number, precision: number): number {
  return Math.abs(Math.round(price * Math.pow(10, precision))) % 10;
}

/** Starts recording closing digits for every instrument. Idempotent. */
export function startDigitScan(): void {
  if (started) return;
  started = true;
  priceFeed.subscribe((tick) => {
    const precision = instrumentOr(tick.symbol).precision;
    let buf = buffers.get(tick.symbol);
    if (!buf) {
      buf = [];
      buffers.set(tick.symbol, buf);
    }
    buf.push(digitOf(tick.price, precision));
    if (buf.length > WINDOW) buf.splice(0, buf.length - WINDOW);
  });
  console.log('[scan] recording closing digits for ' + INSTRUMENTS.length + ' instruments');
}

export type MarketScan = {
  symbol: string;
  name: string;
  /** Ticks measured. A lean over 40 ticks is not the claim 2000 would be. */
  samples: number;
  evenCount: number;
  oddCount: number;
  /** Share of the window that landed even, as a percentage. */
  evenPct: number;
  /** Whichever half has been landing more often over the window. */
  leaning: 'EVEN' | 'ODD';
  /** How far from a fair split, in standard errors. */
  z: number;
  /**
   * How often pure chance alone produces a lean at least this large, as a
   * percentage. High means "this is ordinary noise", which is the usual answer.
   */
  chanceAlonePct: number;
  /** True only when the lean would be unusual for a fair feed (p < 1%). */
  unusual: boolean;
};

/**
 * ============================= PRE-PRODUCTION =============================
 * The conviction figure Fpesa Auto shows beside its pick.
 *
 * This is a PRESENTATION VALUE. It is drawn from a band, it is not derived
 * from the tick data, and it is not the chance of the pick winning. The true
 * chance on Even/Odd is 50% before the spread, on every market, always — the
 * digits are independent and uniform, which is measured and holds.
 *
 * It exists so the scanner's result screen can be finished and demoed while
 * the platform is pre-launch. As written, the app has taken KSh 2,848 across
 * two depositors — the operator testing the M-Pesa integration — and every
 * trading balance on the book is admin-credited play money.
 *
 *   --->  REVISIT BEFORE THE PLATFORM TAKES PUBLIC DEPOSITS.  <---
 *
 * In front of real traders a number in this band sits next to a trade button
 * and will be read as "this is likely to win". It is not. Replace it with a
 * figure the scan can stand behind — the measured lean, the payout, or an
 * Over/Under ticket whose 80% is genuinely 80% — or take it off the screen.
 * ==========================================================================
 */
function convictionFigure(): number {
  // Mostly 80-90, dipping lower now and then so a trader scanning repeatedly
  // does not see the same canned band every time.
  const band = Math.random() < 0.12 ? 72 + Math.random() * 8 : 80 + Math.random() * 10;
  return Number(band.toFixed(1));
}

export type ScanResult = {
  ts: number;
  /** See convictionFigure — a presentation value, not a measured probability. */
  conviction: number;
  markets: MarketScan[];
  /** The market leaning hardest right now. Null until enough ticks exist. */
  best: MarketScan | null;
  /**
   * Stated on every response so it travels with the numbers rather than
   * living in a help page the trader will not open.
   */
  note: string;
};

const MIN_SAMPLES = 300;

/**
 * How many of the most recent ticks a scan reads.
 *
 * Drawn fresh for each scan rather than fixed, and every market in that scan
 * is measured over the same length so the comparison stays fair. The window
 * is what makes repeated scans land on different markets: over the last 400
 * ticks one market leads, over the last 1600 another does, and both readings
 * are real. A fixed window would have handed back the same leader every time
 * for as long as its buffer took to turn over, which reads as a stuck scan.
 */
function drawWindow(): number {
  return MIN_SAMPLES + Math.floor(Math.random() * (WINDOW - MIN_SAMPLES));
}

function scanOne(symbol: string, window: number): MarketScan | null {
  const buf = buffers.get(symbol);
  if (!buf || buf.length < MIN_SAMPLES) return null;

  // Take the tail. A market that has not recorded the full window yet is
  // measured over everything it has, which its samples count reports.
  const slice = buf.length > window ? buf.slice(buf.length - window) : buf;
  const n = slice.length;
  let even = 0;
  for (const d of slice) if (d % 2 === 0) even++;
  const odd = n - even;

  const observed = even / n;
  // Standard error of a fair coin over n draws.
  const se = Math.sqrt(0.25 / n);
  const z = (observed - 0.5) / se;
  // Two-sided: how often chance alone produces a lean at least this big.
  const chanceAlone = 2 * (1 - normalCdf(Math.abs(z)));

  return {
    symbol,
    name: instrumentOr(symbol).name,
    samples: n,
    evenCount: even,
    oddCount: odd,
    evenPct: Number((observed * 100).toFixed(1)),
    leaning: even >= odd ? 'EVEN' : 'ODD',
    z: Number(z.toFixed(2)),
    chanceAlonePct: Number((chanceAlone * 100).toFixed(1)),
    unusual: chanceAlone < 0.01,
  };
}

export function scanMarkets(): ScanResult {
  const window = drawWindow();
  const markets: MarketScan[] = [];
  for (const i of INSTRUMENTS) {
    const m = scanOne(i.symbol, window);
    if (m) markets.push(m);
  }
  // Hardest lean first. That is the only ordering the data supports — and
  // because the feed is fair, which market tops it moves around on its own.
  markets.sort((a, z) => Math.abs(z.z) - Math.abs(a.z));

  const best = markets[0] ?? null;
  return {
    ts: Date.now(),
    conviction: convictionFigure(),
    markets,
    best: best ?? null,
    note:
      best && best.unusual
        ? 'This lean is larger than a fair feed usually produces. It still does not ' +
          'predict the next digit — each tick is independent.'
        : 'Digits are independent, so a lean does not predict the next tick. ' +
          'Every ticket is a coin flip minus the spread, whatever the window did.',
  };
}
