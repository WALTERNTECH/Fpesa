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
  webhookToken: str('PALPLUSS_WEBHOOK_TOKEN'),

  palpluss: {
    apiKey: str('PALPLUSS_API_KEY'),
    baseUrl: str('PALPLUSS_BASE_URL', 'https://api.palpluss.com/v1').replace(/\/+$/, ''),
    channelId: str('PALPLUSS_CHANNEL_ID'),
  },
  paymentsMock: bool('PAYMENTS_MOCK', false),

  priceMode: str('PRICE_MODE', 'live') as 'live' | 'simulated',
  twelveDataKey: str('TWELVEDATA_API_KEY'),

  payoutRate: num('TRADE_PAYOUT_RATE', 0.87),
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
  if (!env.paymentsMock && !env.palpluss.apiKey) {
    console.warn(
      '[fpesa] PALPLUSS_API_KEY is not set — deposits and withdrawals will be ' +
      'rejected. Set PAYMENTS_MOCK=true to exercise the flow without live keys.'
    );
  }
}
