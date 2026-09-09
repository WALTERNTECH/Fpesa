import dotenv from 'dotenv';
dotenv.config();

function str(key: string, fallback?: string): string {
  const v = process.env[key]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  return '';
}
function num(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : fallback;
}
function bool(key: string, fallback = false): boolean {
  const v = process.env[key]?.trim().toLowerCase();
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1' || v === 'yes';
}

export const env = {
  nodeEnv: str('NODE_ENV', 'development'),
  isProd: str('NODE_ENV', 'development') === 'production',
  port: num('PORT', 10000),
  /**
   * trader — the public trading app, price engine, sockets and settlement
   * admin  — the operations console only, on its own origin
   *
   * The two run as separate Render services off one codebase. The admin one
   * shares the database but never ships the trader bundle, runs no price
   * engine of its own (two engines would generate two different markets), and
   * issues its own session cookie scoped to its own host.
   */
  appMode: str('APP_MODE', 'trader') as 'trader' | 'admin',
  /** Where the admin console reads live instrument and desk state from. */
  upstreamUrl: str('UPSTREAM_URL', 'https://fpesa.onrender.com').replace(/\/+$/, ''),
  publicUrl: str('PUBLIC_URL', '').replace(/\/+$/, ''),

  supabaseUrl: str('SUPABASE_URL'),
  supabaseServiceKey: str('SUPABASE_SERVICE_ROLE_KEY'),

  jwtSecret: str('JWT_SECRET'),
  /** Secret path segment on the callback URL, shared with whichever provider. */
  webhookToken: str('PALPLUSS_WEBHOOK_TOKEN') || str('INTASEND_WEBHOOK_TOKEN'),

  /**
   * Which M-Pesa provider is live. Both adapters normalise to one shape, so
   * this is the only thing that has to change to switch.
   */
  paymentsProvider: str('PAYMENTS_PROVIDER', 'palpluss') as 'palpluss' | 'intasend',

  palpluss: {
    apiKey: str('PALPLUSS_API_KEY'),
    baseUrl: str('PALPLUSS_BASE_URL', 'https://api.palpluss.com').replace(/\/+$/, ''),
    /**
     * Their endpoint pages document /v1/... while their machine-readable index
     * lists /api/... . These are overridable so a wrong guess is a setting to
     * change rather than a deploy to wait for.
     */
    stkPath: str('PALPLUSS_STK_PATH', '/v1/payments/stk'),
    b2cPath: str('PALPLUSS_B2C_PATH', '/v1/b2c/payouts'),
    txnPath: str('PALPLUSS_TXN_PATH', '/v1/transactions/{id}'),
    balancePath: str('PALPLUSS_BALANCE_PATH', '/v1/wallets/balance'),
  },

  intasend: {
    secretKey: str('INTASEND_SECRET_KEY'),
    baseUrl: str('INTASEND_BASE_URL', 'https://payment.intasend.com').replace(/\/+$/, ''),
    // IntaSend does not sign callbacks; it echoes a challenge string that is
    // configured alongside the webhook URL in their dashboard.
    webhookChallenge: str('INTASEND_WEBHOOK_CHALLENGE'),
  },
  paymentsMock: bool('PAYMENTS_MOCK', false),

  /**
   * live      — poll a real XAU/USD quote and interpolate ticks between polls
   * synthetic — deterministic, provably-fair instrument generated from a seed
   * simulated — unseeded random walk, local development only
   */
  priceMode: str('PRICE_MODE', 'synthetic') as 'live' | 'synthetic' | 'simulated',
  /** Instrument identity. A synthetic index must not wear a real market's name. */
  symbol: str('MARKET_SYMBOL', 'FPX100'),
  symbolName: str('MARKET_NAME', 'Fpesa Volatility 100'),
  synth: {
    basePrice: num('SYNTH_BASE_PRICE', 1000),
    /** Fraction-of-price volatility per sqrt(second); matches the multiplier tuning. */
    sigma: num('SYNTH_VOLATILITY', 0.00009),
    /**
     * Log drift per second. Should stay 0: margin belongs in the disclosed
     * spread, not in a tilt hidden inside the price path. Whatever it is set
     * to is published on the fairness endpoint.
     */
    drift: num('SYNTH_DRIFT', 0),
    epochMs: num('SYNTH_EPOCH_MS', 300000),
  },
  twelveDataKey: str('TWELVEDATA_API_KEY'),

  payoutRate: num('TRADE_PAYOUT_RATE', 0.87),
  /**
   * Position multiplier per duration, as "seconds:multiplier" pairs. The stake
   * is margin: profit is stake x multiplier x fractional price move.
   *
   * Defaults are tuned to the feed's volatility so a one-standard-deviation
   * move over the chosen duration is worth about 40% of the stake, whichever
   * duration is picked. That makes a wipe-out a real risk (roughly 1 trade in
   * 80) without making it the normal outcome. Retune these if you swap in a
   * price feed with different volatility.
   */
  multipliers: str('TRADE_MULTIPLIERS', '5:2000,10:1400,15:1150,30:800,60:575'),
  /** Profit ceiling as a multiple of stake. Caps the operator's liability. */
  maxProfitMultiple: num('TRADE_MAX_PROFIT_MULTIPLE', 3),
  /**
   * House edge per trade, as a fraction of stake — the same idea as a casino's
   * RTP or a broker's spread. It is applied by marking the entry price against
   * the trader by edge/multiplier, so the expected cost is exactly this share
   * of the stake at every duration.
   *
   * This is the only thing that sets long-run retention, since nothing is
   * withheld from anyone: retained = 1 - (1 - edge) ^ trades.
   *
   * 0.11 targets ~70% retained (30% disbursed) at ~10 trades per depositor,
   * which is roughly what a mixed book of traders produces. The churn figure
   * is the whole assumption: at 5 trades the same edge keeps only 44%, and at
   * 20 it keeps 90%. Measure it from GET /api/wallet/book (trades divided by
   * depositors) and reset this against the real number.
   *
   * It is disclosed in the trade panel as a shilling cost before the position
   * opens. Raising it far past here starts being visible enough to suppress
   * the very churn the retention depends on.
   */
  houseEdge: num('TRADE_HOUSE_EDGE', 0.11),
  /**
   * Hard backstop on the day's book. Once net shillings paid to traders reach
   * this share of the day's deposits, the desk stops opening NEW real
   * positions. It never alters an open position and never withholds a payout
   * that has been won.  0 disables it.
   */
  dailyPayoutCap: num('DAILY_PAYOUT_CAP_RATIO', 0.3),
  /**
   * Hysteresis. A desk closed at the cap only reopens once the ratio has
   * fallen to cap x this factor, so it cannot flicker open and shut on every
   * deposit and every winning trade around the threshold.
   */
  dailyPayoutReopenFactor: num('DAILY_PAYOUT_REOPEN_FACTOR', 0.8),
  /**
   * Deposit base the day must reach before the cap can engage at all. Below
   * this the ratio is small-sample noise: a single lucky trade on one small
   * deposit would otherwise close the desk, and closing it prevents the very
   * deposits that would bring the ratio back down.
   */
  dailyPayoutMinBase: num('DAILY_PAYOUT_MIN_DEPOSITS', 20000),
  /**
   * Staked volume a deposit must go through before it can be withdrawn, as a
   * multiple of the deposit. **Off by default.**
   *
   * A lock is the wrong tool for setting retention here. Refusing to pay a
   * trader who is up — on their first trade, having done nothing wrong — is
   * the single fastest way to earn chargebacks, a BCLB complaint and a
   * reputation that does not wash off. Retention comes from the edge instead,
   * which acts on every trade without ever holding anyone's winnings.
   *
   * Set it to 1 if pure deposit-then-withdraw cycling becomes a problem: that
   * requires the deposit to be traded once, which any real trader clears
   * immediately, while stopping the wallet being used as a money conduit.
   * Higher values start withholding genuine winnings again.
   */
  turnoverMultiple: num('WITHDRAWAL_TURNOVER_MULTIPLE', 0),
  minStake: num('TRADE_MIN_STAKE', 50),
  maxStake: num('TRADE_MAX_STAKE', 1000000),
  demoStartingBalance: num('DEMO_STARTING_BALANCE', 10000),
  minDeposit: num('MIN_DEPOSIT', 1000),
  /**
   * Ceiling on a single deposit. **0 means no ceiling of ours.**
   *
   * Note what that does and does not remove. M-Pesa itself caps one customer
   * transaction — Safaricom's limit, not this platform's — so an STK push above
   * it is refused by the provider however this is set. Zero here means we stop
   * adding a limit of our own and let the trader deposit in as many
   * transactions as they need; it does not make a single larger push succeed.
   */
  maxDeposit: num('MAX_DEPOSIT', 0),
  minWithdrawal: num('MIN_WITHDRAWAL', 100),
  /**
   * Ceiling on a single payout. **0 means no ceiling of ours**, which is the
   * default: a trader who has traded and won can take out what they have won,
   * with no daily limit and no per-payout limit imposed by this platform.
   *
   * A transfer larger than the provider will carry still fails at the provider.
   * That path is safe — the reservation is released and the balance comes
   * straight back — so the failure costs the trader time, not money.
   */
  maxWithdrawal: num('MAX_WITHDRAWAL', 0),
  /**
   * The operator's own capital, in shillings, available to pay winners.
   *
   * This is the number that decides how large a live position the book can
   * safely carry. A position's worst case is stake x TRADE_MAX_PROFIT_MULTIPLE,
   * and a position only opens if the book can cover that — so a win that can
   * happen is always a win that can be paid.
   *
   * At 0 the house has nothing of its own behind it. Customer deposits cannot
   * fund customer winnings: a trader who deposits 1,000 and wins 3,000 has to
   * be paid from somewhere, and their own 1,000 is not enough. So at 0 the
   * headroom stays near zero and live trading cannot open a position until the
   * accumulated house margin has built some.
   *
   * Set it to the amount actually sitting in the payout account.
   */
  /**
   * Fallback only. The live figure is set in the operations console and stored
   * in the database, because it changes whenever the payout wallet is topped up
   * and a redeploy for that would guarantee it goes stale. This value is used
   * only until the console sets one.
   */
  operatorFloat: num('OPERATOR_FLOAT', 0),
  /**
   * The largest share of the book's headroom a single position may consume.
   *
   * The solvency guard alone already keeps every win payable — a run of wins
   * throttles itself, because each win shrinks the headroom the next position
   * is measured against. What it does not do is stop one trader taking the
   * whole of that capacity with them: seven straight maximum wins from a
   * KSh 1,000 deposit ends with the book covered to within one shilling and
   * every other trader refused until that money leaves or loses.
   *
   * At 0.25 no single position can hold more than a quarter of the house's
   * capacity, so a hot streak stays payable and the desk stays open to
   * everyone else. Raise it toward 1 to allow bigger individual positions at
   * the cost of that protection.
   */
  maxPositionShare: num('MAX_POSITION_SHARE', 0.25),

  supportTelegram: str('SUPPORT_TELEGRAM_URL', 'https://t.me/KRYPTONinv'),
};

/** Fail fast on a misconfigured production deploy rather than 500ing later. */
export function assertEnv(): void {
  const missing: string[] = [];
  if (!env.supabaseUrl) missing.push('SUPABASE_URL');
  if (!env.supabaseServiceKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!env.jwtSecret) missing.push('JWT_SECRET');
  if (missing.length) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
      'See .env.example for the full list.'
    );
  }
  if (env.isProd && env.jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters in production.');
  }

  // Mock payments credit a real balance without any money arriving. On a
  // production deployment that is a free-money bug: those balances become
  // withdrawable the moment a live Palpluss key is configured. Refuse to boot
  // rather than let the two settings ever be combined by accident.
  if (env.isProd && env.paymentsMock) {
    throw new Error(
      'PAYMENTS_MOCK must not be enabled when NODE_ENV=production — it credits ' +
      'deposits without taking payment. Unset it, or run with NODE_ENV=development.'
    );
  }
  const providerKey =
    env.paymentsProvider === 'intasend' ? env.intasend.secretKey : env.palpluss.apiKey;
  const providerVar =
    env.paymentsProvider === 'intasend' ? 'INTASEND_SECRET_KEY' : 'PALPLUSS_API_KEY';

  if (!env.paymentsMock && !providerKey) {
    console.warn(
      '[fpesa] ' + providerVar + ' is not set — deposits and withdrawals will be ' +
      'rejected. Set PAYMENTS_MOCK=true to exercise the flow without live keys.'
    );
  }
  if (!env.paymentsMock && providerKey && !env.webhookToken) {
    console.warn(
      '[fpesa] no webhook token is set, so the callback URL has no secret in it. ' +
      'Set PALPLUSS_WEBHOOK_TOKEN before taking live payments.'
    );
  }
  if (env.paymentsProvider === 'intasend' &&
      !env.paymentsMock && env.intasend.secretKey && !env.intasend.webhookChallenge) {
    console.warn(
      '[fpesa] INTASEND_WEBHOOK_CHALLENGE is not set — provider callbacks cannot ' +
      'be authenticated, so they will be ignored and settlement will fall back ' +
      'to the reconciliation sweep.'
    );
  }
}
