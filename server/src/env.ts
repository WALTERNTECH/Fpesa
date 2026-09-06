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
  publicUrl: str('PUBLIC_URL', '').replace(/\/+$/, ''),

  supabaseUrl: str('SUPABASE_URL'),
  supabaseServiceKey: str('SUPABASE_SERVICE_ROLE_KEY'),

  jwtSecret: str('JWT_SECRET'),
  webhookToken: str('INTASEND_WEBHOOK_TOKEN') || str('PALPLUSS_WEBHOOK_TOKEN'),

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
   * This, not any per-user selection, is what sets long-run disbursement:
   * remaining = (1 - edge) ^ trades. At 0.06 a deposit is down to ~29% after
   * 20 trades — i.e. ~30% disbursed, 70% retained. Raise it to disburse less.
   *
   * Retune against real churn: the 0.06 default assumes ~20 trades per
   * depositor. Read the real figure from GET /api/wallet/book.
   */
  houseEdge: num('TRADE_HOUSE_EDGE', 0.06),
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
   * multiple of the deposit.
   *
   * The house only earns on volume, so the share of a deposit retained is
   * edge x turnover. Retaining 70% at the 6% edge therefore needs 0.70/0.06 =
   * 11.7x. Deliberately a VOLUME multiple and not a trade count: twelve KSh 50
   * trades on a KSh 2,600 deposit would satisfy a count while risking nothing.
   *
   * Set to 0 to disable the requirement entirely.
   */
  turnoverMultiple: num('WITHDRAWAL_TURNOVER_MULTIPLE', 11.7),
  minStake: num('TRADE_MIN_STAKE', 50),
  maxStake: num('TRADE_MAX_STAKE', 20000),
  demoStartingBalance: num('DEMO_STARTING_BALANCE', 10000),
  minDeposit: num('MIN_DEPOSIT', 50),
  minWithdrawal: num('MIN_WITHDRAWAL', 100),

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
  if (!env.paymentsMock && !env.intasend.secretKey) {
    console.warn(
      '[fpesa] INTASEND_SECRET_KEY is not set — deposits and withdrawals will be ' +
      'rejected. Set PAYMENTS_MOCK=true to exercise the flow without live keys.'
    );
  }
  if (!env.paymentsMock && env.intasend.secretKey && !env.intasend.webhookChallenge) {
    console.warn(
      '[fpesa] INTASEND_WEBHOOK_CHALLENGE is not set — provider callbacks cannot ' +
      'be authenticated, so they will be ignored and settlement will fall back ' +
      'to the reconciliation sweep.'
    );
  }
}
