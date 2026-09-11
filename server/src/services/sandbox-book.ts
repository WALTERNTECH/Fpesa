import { env } from '../env.js';
import { SandboxError } from './sandbox.js';

/**
 * Book stress: how much risk the solvency guard will let onto the book, and
 * what happens if every bit of it wins at once.
 *
 * ## Why this, and not a live price feed
 *
 * Two of the scenarios people reach for a live feed to test — "how does a large
 * order slice through available liquidity" and "does risk management survive a
 * black swan" — are not about prices on this platform, because there is no order
 * book here. Nothing queues, nothing fills against a counterparty, and no depth
 * gets consumed. A position is a row, and the only thing a large one competes
 * for is the book's capacity to pay it.
 *
 * That capacity is `fpesa_book_float`, and it is exact arithmetic rather than
 * something to sample:
 *
 *     cash     = successful deposits - withdrawals + adjustments
 *     owed     = every user's real balance, summed
 *     atRisk   = sum over open real positions of (stake + max_profit)
 *     headroom = cash + operatorFloat - owed - atRisk
 *
 * and `fpesa_place_trade` admits a position only when
 *
 *     headroom * positionShare >= maxProfit
 *
 * ## The result worth knowing
 *
 * Opening a position moves two terms at once: the stake leaves the trader's
 * balance, so `owed` falls by the stake, while `atRisk` rises by stake plus
 * max profit. Those cancel, and headroom falls by exactly `maxProfit`. Which
 * means the guard is not a heuristic that usually holds — every admitted
 * position sets aside its own worst case in full, so a book where *every* open
 * position wins at its cap simultaneously still settles with headroom to spare.
 *
 * A correlated black swan is therefore survivable by construction, not by luck,
 * and no amount of watching a live feed during a crisis could establish that
 * more firmly than the arithmetic does. What this simulator is for is showing
 * where the capacity runs out: how many maximum positions a given book carries,
 * and what one large position does to the room left for everyone else.
 */

export type BookInput = {
  cash: number;
  operatorFloat: number;
  owed: number;
  atRisk: number;
  positionShare: number;
  maxProfitMultiple: number;
  stake: number;
};

export type BookStress = {
  input: BookInput;
  headroom: number;
  /** Largest single position the guard would admit right now. */
  maxLiveStake: number;
  perPosition: { stake: number; maxProfit: number; headroomCost: number };
  /** Position by position until the guard refuses. */
  sequence: Array<{
    n: number;
    headroomBefore: number;
    admitted: boolean;
    refusedBecause: string | null;
    headroomAfter: number;
  }>;
  capacity: { positions: number; totalStake: number; totalMaxPayout: number };
  /** Every admitted position wins at its cap, in the same instant. */
  correlatedWin: {
    positions: number;
    paidInProfit: number;
    stakesReturned: number;
    owedAfter: number;
    cashPlusFloat: number;
    headroomAfter: number;
    solvent: boolean;
    shortfall: number;
  };
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(Math.max(n, lo), hi);
}

/** The live ceiling, mirroring SolvencyView.maxLiveStake. */
function maxLiveStake(headroom: number, share: number, multiple: number): number {
  if (multiple <= 0) return env.maxStake;
  const room = Math.max(0, headroom) * share;
  return Math.max(0, Math.min(env.maxStake, Math.floor(room / multiple)));
}

export function stressBook(raw: Partial<BookInput>): BookStress {
  if (env.appMode !== 'sandbox') {
    throw new SandboxError('NOT_SANDBOX', 'Book stress is only available in the sandbox.', 404);
  }

  const input: BookInput = {
    cash: clamp(raw.cash ?? 0, 0, 1e12),
    operatorFloat: clamp(raw.operatorFloat ?? 0, 0, 1e12),
    owed: clamp(raw.owed ?? 0, 0, 1e12),
    atRisk: clamp(raw.atRisk ?? 0, 0, 1e12),
    positionShare: clamp(raw.positionShare ?? env.maxPositionShare, 0.01, 1),
    maxProfitMultiple: clamp(raw.maxProfitMultiple ?? env.maxProfitMultiple, 0.1, 100),
    stake: clamp(raw.stake ?? env.minStake, 0.01, 1e12),
  };

  const headroom = round2(
    input.cash + input.operatorFloat - input.owed - input.atRisk
  );
  const maxProfit = round2(input.stake * input.maxProfitMultiple);

  // Opening debits the stake from the trader (owed falls by stake) and books
  // stake + maxProfit as at-risk. Net effect on headroom: exactly maxProfit.
  const headroomCost = maxProfit;

  const sequence: BookStress['sequence'] = [];
  let running = headroom;
  let admitted = 0;
  // Enough iterations to show the shape and find the wall; a book that admits
  // thousands of positions is answered by the capacity figure, not the list.
  const LIST_CAP = 200;

  for (let n = 1; n <= LIST_CAP; n++) {
    const room = Math.max(running, 0) * input.positionShare;
    const ok = room >= maxProfit;
    const after = ok ? round2(running - headroomCost) : running;
    sequence.push({
      n,
      headroomBefore: round2(running),
      admitted: ok,
      refusedBecause: ok
        ? null
        : 'headroom ' + round2(Math.max(running, 0)) + ' x share ' +
          input.positionShare + ' = ' + round2(room) + ', short of the ' +
          round2(maxProfit) + ' this position could win',
      headroomAfter: after,
    });
    if (!ok) break;
    running = after;
    admitted += 1;
  }

  // If the list hit its cap without refusing, finish the count arithmetically
  // rather than looping: admission holds while (h - n*cost) * share >= maxProfit.
  let positions = admitted;
  if (admitted === LIST_CAP && headroomCost > 0) {
    const limit = maxProfit / input.positionShare;
    positions = Math.max(0, Math.floor((headroom - limit) / headroomCost) + 1);
  }

  const totalStake = round2(positions * input.stake);
  const totalMaxPayout = round2(positions * maxProfit);

  // Everything open wins at its cap at the same moment. Stakes go back to the
  // traders along with the profit, so owed rises by both; atRisk empties.
  const owedAfter = round2(input.owed - totalStake + totalStake + totalMaxPayout);
  const cashPlusFloat = round2(input.cash + input.operatorFloat);
  const headroomAfter = round2(cashPlusFloat - owedAfter - input.atRisk);

  return {
    input,
    headroom,
    maxLiveStake: maxLiveStake(headroom, input.positionShare, input.maxProfitMultiple),
    perPosition: { stake: input.stake, maxProfit, headroomCost },
    sequence,
    capacity: { positions, totalStake, totalMaxPayout },
    correlatedWin: {
      positions,
      paidInProfit: totalMaxPayout,
      stakesReturned: totalStake,
      owedAfter,
      cashPlusFloat,
      headroomAfter,
      solvent: headroomAfter >= 0,
      shortfall: headroomAfter >= 0 ? 0 : round2(-headroomAfter),
    },
  };
}
