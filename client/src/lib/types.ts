export type User = {
  id: string;
  username: string;
  phone: string;
  demoBalance: number;
  realBalance: number;
  isAdmin: boolean;
  turnoverRequired: number;
  turnoverProgress: number;
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

export type Run = {
  id: string;
  direction: Direction;
  symbol: string;
  stake: number;
  durationSec: number;
  totalCount: number;
  completedCount: number;
  netProfit: number;
  status: 'RUNNING' | 'DONE' | 'ABORTED';
  abortReason: string | null;
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
  precision?: number;
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
  kind: 'DEPOSIT' | 'WITHDRAWAL' | 'ADJUSTMENT';
  amount: number;
  status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'EXPIRED';
  phone: string;
  reference: string;
  mpesaReceipt: string | null;
  message: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DeskState = {
  open: boolean;
  reason: string | null;
  ratio: number;
  cap: number;
  reopenAt: number;
  minBase: number;
  armed: boolean;
};

/** One tradeable market. */
export type Instrument = {
  symbol: string;
  name: string;
  volatility: number;
  precision: number;
  multipliers: Record<string, number>;
};

/** An instrument with its live headline numbers, for the market switcher. */
export type MarketSummary = Instrument & {
  price: number;
  change: number;
  changePct: number;
  dayOpen: number;
};

export type HistoryWindow = {
  trades: number;
  wins: number;
  losses: number;
  ties: number;
  winRate: number;
  netProfit: number;
  volume: number;
  best: number;
  worst: number;
};

export type Lifetime = {
  deposits: number;
  withdrawals: number;
  adjustments: number;
  tradingNet: number;
  volume: number;
  trades: number;
  balance: number;
  netVsDeposits: number;
};

export type HistoryResponse = {
  mode: AccountMode;
  trades: Trade[];
  window: HistoryWindow;
  lifetime: Lifetime;
};

export type PlatformConfig = {
  minStake: number;
  maxStake: number;
  payoutRate: number;
  durations: number[];
  multipliers: Record<string, number>;
  maxProfitMultiple: number;
  houseEdge: number;
  turnoverMultiple: number;
  symbol: string;
  symbolName: string;
  instruments: Instrument[];
  provablyFair: boolean;
  adminUrl: string;
  desk: DeskState;
  minDeposit: number;
  /** 0 means no ceiling of ours — see the server's env.ts. */
  maxDeposit: number;
  minWithdrawal: number;
  maxWithdrawal: number;
  supportTelegram: string;
  demoStartingBalance: number;
};

export type Timeframe = '1s' | '5s' | '15s' | '1m' | '5m';
