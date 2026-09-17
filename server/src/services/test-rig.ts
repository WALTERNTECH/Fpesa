import { db } from '../lib/db.js';
import { env } from '../env.js';

/**
 * The test outcome rig.
 *
 * ## What it is
 *
 * A switch that decides the outcome of a fixed-payout ticket instead of letting
 * the closing digit decide it. It exists to answer questions about the platform
 * that a fair feed cannot be made to answer on demand:
 *
 *   - does the book, the float and the exposure guard behave when an account is
 *     winning 85% of its tickets?
 *   - does the accounting hold at a chosen return to player?
 *
 * Both are questions about the ledger, not about the market, and waiting for a
 * 50/50 feed to produce a long winning run in order to test one is not a plan.
 *
 * ## What it deliberately does not do
 *
 * It does not touch prices. The exit price written to a forced trade is the
 * real closing quote, so a forced row visibly disagrees with its own price
 * rather than quietly agreeing with a falsified one. Every such row is stamped
 * `outcome_forced` in the database, which means test data can be found and
 * deleted exactly, and a book with forced outcomes in it can never be mistaken
 * for one that was played fairly.
 *
 * It also does not touch the scaled product, whose profit is proportional to
 * the move and has no binary outcome to force.
 *
 * ## The thing to be clear about
 *
 * While this is armed the platform is not running the product it is showing.
 * The screen says a digit decides the ticket; the rig decides it. That is fine
 * on a pre-launch book being exercised by its operator, and it is not fine in
 * front of anyone who deposited money expecting the market to settle their
 * trade. It is off unless TEST_RIG=true is set, it announces itself at boot and
 * on /health, and it should be disarmed and its trades deleted before the
 * platform takes public deposits.
 */

type Settling = {
  userId: string;
  username: string;
  stake: number;
  /** What the ticket pays on a win, over and above the stake returned. */
  winProfit: number;
  tradeType: string;
};

/** Win rates set per account, overriding the RTP target for those accounts. */
function parseAccounts(raw: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of raw.split(',')) {
    const [name, rate] = part.split(':');
    const key = name?.trim().toLowerCase();
    const value = Number(rate);
    if (!key) continue;
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      console.warn('[test-rig] ignoring account entry "' + part.trim() + '": rate must be 0..1');
      continue;
    }
    out.set(key, value);
  }
  return out;
}

/** The fixed-payout products. The rig has no opinion about anything else. */
const FORCEABLE = new Set([
  'DIGITS_OVER', 'DIGITS_UNDER', 'DIGITS_EVEN', 'DIGITS_ODD', 'DIGITAL',
]);

class TestRig {
  private readonly accounts = parseAccounts(env.testRig.accounts);

  /** Money staked and money paid out, over forced tickets, since boot. */
  private staked = 0;
  private paid = 0;

  /** Per-account tally, so a target win rate is steered rather than hoped for. */
  private tally = new Map<string, { trades: number; wins: number }>();

  get armed(): boolean {
    return env.testRig.enabled;
  }

  /**
   * Writes users.is_test to match this rig's configuration.
   *
   * The flag takes an account out of the solvency book entirely — its cash, its
   * balance and its open positions all stop counting, it is not measured
   * against the book's headroom when it opens a position, and its withdrawals
   * are capped at the payout wallet instead. That is right for play money and
   * badly wrong for a customer, so the flag is derived here rather than set by
   * hand: the accounts named in TEST_RIG_ACCOUNTS carry it, and everyone else
   * has it cleared on every boot.
   *
   * Disarming the rig therefore restores the book on its own. Unset TEST_RIG
   * and the next boot clears every flag, because an account left outside the
   * solvency guard by a forgotten setting is exactly the failure that guard
   * exists to prevent, and nothing would have complained.
   */
  async syncFlags(): Promise<void> {
    const names = this.armed ? [...this.accounts.keys()] : [];

    const { data, error } = await db
      .from('users')
      .select('id, username, is_test');
    if (error) {
      console.error('[test-rig] could not read accounts to sync flags:', error.message);
      return;
    }

    const rows = (data ?? []) as Array<{ id: string; username: string; is_test: boolean }>;
    const wanted = new Set(names);
    const changes = rows
      .map((r) => ({ row: r, should: wanted.has(r.username.toLowerCase()) }))
      .filter(({ row, should }) => row.is_test !== should);

    for (const { row, should } of changes) {
      const { error: writeError } = await db
        .from('users')
        .update({ is_test: should })
        .eq('id', row.id);
      if (writeError) {
        console.error(
          '[test-rig] could not set is_test on ' + row.username + ':', writeError.message
        );
        continue;
      }
      console.warn(
        '[test-rig] ' + row.username + ' is ' +
        (should ? 'now OUTSIDE the solvency book' : 'back INSIDE the solvency book')
      );
    }

    // Named but not found is worth saying out loud: the operator believes an
    // account is being treated as a test account and it is not.
    const present = new Set(rows.map((r) => r.username.toLowerCase()));
    for (const name of names) {
      if (!present.has(name)) {
        console.warn('[test-rig] TEST_RIG_ACCOUNTS names "' + name + '", which is not an account');
      }
    }
  }

  /** Printed at boot so an armed rig is never a surprise. */
  announce(): void {
    if (!this.armed) return;
    const lines = [
      '',
      '  ####################################################################',
      '  #  TEST OUTCOME RIG IS ARMED                                       #',
      '  #                                                                  #',
      '  #  Fixed-payout tickets are being settled by this server, not by   #',
      '  #  the closing digit. Every such trade is stamped outcome_forced.  #',
      '  #                                                                  #',
      '  #  Target return to player: ' + (env.testRig.rtp * 100).toFixed(1).padEnd(38) + '#',
    ];
    for (const [name, rate] of this.accounts) {
      lines.push('  #  Account override: ' + (name + ' at ' + (rate * 100).toFixed(0) + '%').padEnd(45) + '#');
    }
    lines.push(
      '  #                                                                  #',
      '  #  Unset TEST_RIG before this platform takes public deposits.      #',
      '  ####################################################################',
      ''
    );
    console.warn(lines.join('\n'));
  }

  /**
   * Whether this account is one of the rig's, and so sits outside the book.
   *
   * Reads the same configuration syncFlags writes to the database, so the two
   * cannot disagree about who is a test account.
   */
  isTestAccount(username: string | null | undefined): boolean {
    if (!this.armed || !username) return false;
    return this.accounts.has(username.toLowerCase());
  }

  /** What /health reports, so the state is visible without reading logs. */
  status(): Record<string, unknown> {
    if (!this.armed) return { armed: false };
    const realisedRtp = this.staked > 0 ? this.paid / this.staked : null;
    return {
      armed: true,
      targetRtp: env.testRig.rtp,
      realisedRtp: realisedRtp === null ? null : Number(realisedRtp.toFixed(4)),
      // Accounts with their own win rate are steered separately and are not in
      // the RTP figures above.
      rtpPoolStaked: Number(this.staked.toFixed(2)),
      forcedTrades: [...this.tally.values()].reduce((a, t) => a + t.trades, 0),
      accounts: Object.fromEntries(
        [...this.accounts].map(([name, target]) => {
          const t = this.tally.get(name);
          return [name, {
            target,
            realised: t && t.trades > 0 ? Number((t.wins / t.trades).toFixed(4)) : null,
            trades: t?.trades ?? 0,
          }];
        })
      ),
    };
  }

  /**
   * Decides how a trade should settle, or null to let the digit decide.
   *
   * Reads the trade itself rather than relying on anything cached, and does not
   * read anything at all when disarmed — a production server never issues this
   * query.
   */
  async decide(tradeId: string): Promise<'WIN' | 'LOSS' | null> {
    if (!this.armed) return null;

    // Nothing this test-only code does may stop a trade settling. It sits in
    // the settlement path, and an exception escaping here would reject the
    // settle promise before the payout RPC ever ran — leaving the stake
    // stranded and the position open on the trader's screen for good. On any
    // failure it gives up its opinion and the closing digit decides, which is
    // the correct behaviour anyway.
    try {
      const row = await this.load(tradeId);
      if (!row) return null;
      if (!FORCEABLE.has(row.tradeType)) return null;

      const key = row.username.toLowerCase();
      const accountTarget = this.accounts.get(key);

      const chance = accountTarget === undefined
        ? this.chanceForRtp(row)
        : this.chanceForWinRate(key, accountTarget);

      const win = Math.random() < chance;
      this.record(key, row, win, accountTarget === undefined);
      return win ? 'WIN' : 'LOSS';
    } catch (err) {
      console.error('[test-rig] stood down on ' + tradeId + ', digit decides:', err);
      return null;
    }
  }

  /**
   * The win chance that lands realised RTP on target after this ticket.
   *
   * Solves (paid + chance * payout) / (staked + stake) = target for chance, so
   * the rig corrects its own drift instead of relying on a fixed coin landing
   * on its expectation. Clamped, because a single ticket cannot always undo
   * where the running total already is.
   */
  private chanceForRtp(row: Settling): number {
    const payout = row.stake + row.winProfit;
    if (payout <= 0) return 0;
    const wanted = env.testRig.rtp * (this.staked + row.stake) - this.paid;
    return Math.min(1, Math.max(0, wanted / payout));
  }

  /** The same idea on win count rather than money. */
  private chanceForWinRate(key: string, target: number): number {
    const t = this.tally.get(key) ?? { trades: 0, wins: 0 };
    const wanted = target * (t.trades + 1) - t.wins;
    return Math.min(1, Math.max(0, wanted));
  }

  /**
   * `inRtpPool` keeps the two targets independent.
   *
   * An account on a fixed win rate must not be counted into the RTP ledger. If
   * it were, an account winning 85% would drag realised RTP above target and
   * the controller would claw it back out of everyone else — so setting one
   * knob would silently move the other. Accounts with an override are steered
   * by their own target and are invisible to the RTP pool.
   */
  private record(key: string, row: Settling, win: boolean, inRtpPool: boolean): void {
    if (inRtpPool) {
      this.staked += row.stake;
      this.paid += win ? row.stake + row.winProfit : 0;
    }
    const t = this.tally.get(key) ?? { trades: 0, wins: 0 };
    t.trades += 1;
    if (win) t.wins += 1;
    this.tally.set(key, t);
  }

  private async load(tradeId: string): Promise<Settling | null> {
    const { data, error } = await db
      .from('trades')
      .select('user_id, stake, max_profit, trade_type, users!inner(username)')
      .eq('id', tradeId)
      .maybeSingle();

    if (error || !data) {
      if (error) console.error('[test-rig] could not read trade ' + tradeId + ':', error.message);
      return null;
    }

    const row = data as unknown as {
      user_id: string;
      stake: string | number;
      max_profit: string | number | null;
      trade_type: string;
      users: { username: string } | { username: string }[];
    };
    const user = Array.isArray(row.users) ? row.users[0] : row.users;

    return {
      userId: row.user_id,
      username: user?.username ?? '',
      stake: Number(row.stake),
      winProfit: Number(row.max_profit ?? 0),
      tradeType: row.trade_type,
    };
  }
}

export const testRig = new TestRig();
