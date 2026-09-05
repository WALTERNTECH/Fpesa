export type User = {
  id: string;
  username: string;
  phone: string;
  demoBalance: number;
  realBalance: number;
  isAdmin: boolean;
};

export type AccountMode = 'demo' | 'real';
export type Direction = 'BUY' | 'SELL';
export type TradeStatus = 'OPEN' | 'WON' | 'LOST' | 'TIE' | 'VOID';

export type Trade = {
  id: string;
  accountMode: AccountMode;
  symbol: string;
  direction: Direction;
  stake: number;
  durationSec: number;
  payoutRate: number;
  entryPrice: number;
  exitPrice: number | null;
  payout: number | null;
  profit: number | null;
  status: TradeStatus;
  openedAt: string;
  expiresAt: string;
  settledAt: string | null;
  multiplier: number;
  stopOutPrice: number | null;
  takeProfitPrice: number | null;
  maxProfit: number;
  closeReason: 'EXPIRY' | 'STOP_OUT' | 'TAKE_PROFIT' | null;
};

export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type Quote = {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePct: number;
  dayOpen: number;
  ts: number;
  feed: { source: string; anchored: boolean; lastUpstreamAt: number; mode: string };
};

export type NewsItem = {
  id: string;
  title: string;
  link: string;
  source: string;
  publishedAt: string;
};

export type ChatMessage = {
  id: string;
  username: string;
  body: string;
  createdAt: string;
};

export type FeedItem = {
  id: string;
  kind: string;
  username: string;
  amount: number;
  createdAt: string;
};

export type LeaderRow = {
  username: string;
  profit: number;
  wins: number;
  trades: number;
};

export type Transaction = {
  id: string;
  kind: 'DEPOSIT' | 'WITHDRAWAL';
  amount: number;
  status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'EXPIRED';
  phone: string;
  reference: string;
  mpesaReceipt: string | null;
  message: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PlatformConfig = {
  minStake: number;
  maxStake: number;
  payoutRate: number;
  durations: number[];
  multipliers: Record<string, number>;
  maxProfitMultiple: number;
  minDeposit: number;
  minWithdrawal: number;
  supportTelegram: string;
  demoStartingBalance: number;
};

export type Timeframe = '1s' | '5s' | '15s' | '1m' | '5m';
