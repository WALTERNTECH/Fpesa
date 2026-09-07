import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiError } from '../lib/api';
import { marketSocket, type ServerMessage } from '../lib/ws';
import type {
  AccountMode,
  Direction,
  PlatformConfig,
  Quote,
  Trade,
  User,
  DeskState,
  Run,
  Instrument,
  MarketSummary,
} from '../lib/types';

export type Toast = {
  id: number;
  tone: 'info' | 'win' | 'lose';
  icon: string;
  title: string;
  detail?: string;
};

type ModalKind = 'login' | 'register' | 'deposit' | 'withdraw' | null;

type AppValue = {
  ready: boolean;
  config: PlatformConfig;
  user: User | null;
  quote: Quote | null;
  price: number;
  tickDir: 'up' | 'down' | null;
  connected: boolean;
  online: number;

  /* Markets. The selected instrument drives the chart, the ticket and the
     socket subscription; everything else in the app reads it from here so the
     chart and the trade panel can never disagree about what is being traded. */
  instruments: MarketSummary[];
  symbol: string;
  setSymbol: (symbol: string) => void;
  instrument: Instrument | null;
  multiplier: number;

  accountMode: AccountMode;
  setAccountMode: (mode: AccountMode) => void;
  balance: number;

  openTrades: Trade[];

  /* The trade ticket lives here rather than in the panel, because on a phone
     the Buy/Sell buttons render in a bar pinned beside the chart while the
     amount and duration inputs sit further down. Both read the same ticket. */
  stake: string;
  setStake: (value: string) => void;
  duration: number;
  setDuration: (seconds: number) => void;
  tradeBusy: Direction | null;
  tradeError: string | null;
  setTradeError: (message: string | null) => void;
  stakeIssue: string | null;
  /** The ceiling that actually applies right now, for the selected account. */
  stakeCeiling: number;
  canTrade: boolean;
  desk: DeskState;

  /* Auto-run: the same ticket repeated, sequenced on the server. */
  autoRunCount: number;
  run: Run | null;
  autoBusy: boolean;
  startAuto: () => Promise<void>;
  submitTrade: (direction: Direction) => Promise<void>;

  modal: ModalKind;
  openModal: (kind: ModalKind) => void;
  closeModal: () => void;

  login: (username: string, password: string) => Promise<void>;
  register: (input: {
    username: string;
    phone: string;
    password: string;
    confirmPassword: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  resetDemo: () => Promise<void>;

  toasts: Toast[];
  pushToast: (toast: Omit<Toast, 'id'>) => void;
};

const DEFAULT_CONFIG: PlatformConfig = {
  minStake: 50,
  maxStake: 1000000,
  maxStakeLive: 0,
  payoutRate: 0.87,
  durations: [5, 10, 15, 30, 60],
  multipliers: { '5': 2000, '10': 1400, '15': 1150, '30': 800, '60': 575 },
  maxProfitMultiple: 3,
  houseEdge: 0.11,
  turnoverMultiple: 11.7,
  symbol: 'FPX100',
  symbolName: 'Volatility 100 Index',
  instruments: [],
  provablyFair: true,
  desk: { open: true, reason: null, ratio: 0, cap: 0.3, reopenAt: 0.24, minBase: 20000, armed: false },
  minDeposit: 50,
  maxDeposit: 0,
  minWithdrawal: 100,
  maxWithdrawal: 250000,
  supportTelegram: 'https://t.me/KRYPTONinv',
  demoStartingBalance: 10000,
};

const AppContext = createContext<AppValue | null>(null);

export function useApp(): AppValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}

function dismissBootScreen(): void {
  const boot = document.getElementById('boot');
  if (!boot) return;
  boot.classList.add('is-done');
  window.setTimeout(() => boot.remove(), 500);
}

export function AppProvider({ children }: { children: ReactNode }): JSX.Element {
  const [ready, setReady] = useState(false);
  const [config, setConfig] = useState<PlatformConfig>(DEFAULT_CONFIG);
  const [user, setUser] = useState<User | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [price, setPrice] = useState(0);
  const [tickDir, setTickDir] = useState<'up' | 'down' | null>(null);
  const [connected, setConnected] = useState(false);
  const [online, setOnline] = useState(0);
  const [accountMode, setAccountMode] = useState<AccountMode>('demo');
  const [openTrades, setOpenTrades] = useState<Trade[]>([]);
  const [modal, setModal] = useState<ModalKind>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [stake, setStake] = useState<string>(String(DEFAULT_CONFIG.minStake));
  const [duration, setDuration] = useState<number>(10);
  const [tradeBusy, setTradeBusy] = useState<Direction | null>(null);
  const [tradeError, setTradeError] = useState<string | null>(null);
  const [desk, setDesk] = useState<DeskState>(DEFAULT_CONFIG.desk);
  const [run, setRun] = useState<Run | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);
  const [instruments, setInstruments] = useState<MarketSummary[]>([]);
  const [symbol, setSymbolState] = useState<string>(DEFAULT_CONFIG.symbol);
  const autoRunCount = 3;

  const lastPrice = useRef(0);
  // Read inside the socket handler, which is registered once and must not be
  // torn down and rebuilt on every market switch.
  const symbolRef = useRef(DEFAULT_CONFIG.symbol);
  const toastId = useRef(0);
  const flashTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
    };
  }, []);

  const pushToast = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = ++toastId.current;
    setToasts((prev) => [...prev, { ...toast, id }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5200);
  }, []);

  // ------------------------------------------------------------- bootstrap
  useEffect(() => {
    let cancelled = false;

    (async () => {
      // The market to open on: whatever they were last looking at, as long as
      // it is still offered. Falls back to the server's default.
      const remembered = (() => {
        try {
          return window.localStorage.getItem('fpesa.symbol');
        } catch {
          return null;
        }
      })();

      const [cfg, me, q, mk] = await Promise.allSettled([
        api.get<PlatformConfig>('/market/config'),
        api.get<{ user: User | null }>('/auth/me'),
        api.get<Quote>('/market/quote' + (remembered ? '?symbol=' + remembered : '')),
        api.get<{ instruments: MarketSummary[] }>('/market/instruments'),
      ]);
      if (cancelled) return;

      let opening = DEFAULT_CONFIG.symbol;
      if (cfg.status === 'fulfilled') {
        setConfig(cfg.value);
        if (cfg.value.desk) setDesk(cfg.value.desk);
        setStake(String(cfg.value.minStake));
        if (cfg.value.durations.includes(10)) setDuration(10);
        else if (cfg.value.durations[0]) setDuration(cfg.value.durations[0]);
        opening = cfg.value.symbol;
        if (remembered && cfg.value.instruments.some((i) => i.symbol === remembered)) {
          opening = remembered;
        }
        setSymbolState(opening);
        marketSocket.watch(opening);
      }
      if (mk.status === 'fulfilled') setInstruments(mk.value.instruments);
      if (me.status === 'fulfilled' && me.value.user) {
        setUser(me.value.user);
        // A returning trader with real funds lands on their live account.
        if (me.value.user.realBalance > 0) setAccountMode('real');
      }
      if (q.status === 'fulfilled') {
        setQuote(q.value);
        setPrice(q.value.price);
        lastPrice.current = q.value.price;
      }

      setReady(true);
      dismissBootScreen();
    })();

    marketSocket.connect();
    return () => {
      cancelled = true;
      marketSocket.disconnect();
    };
  }, []);

  // Reconnect promptly when the tab comes back rather than waiting out backoff.
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') marketSocket.resume();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, []);

  useEffect(() => {
    symbolRef.current = symbol;
  }, [symbol]);

  // The switcher shows a live price against every market, but only the selected
  // one streams over the socket. A slow poll keeps the rest honest without
  // subscribing to five tick streams.
  useEffect(() => {
    let stop = false;
    const pull = async (): Promise<void> => {
      try {
        const res = await api.get<{ instruments: MarketSummary[] }>('/market/instruments');
        if (!stop) setInstruments(res.instruments);
      } catch {
        // Keep the last known prices.
      }
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void pull();
    }, 10_000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => marketSocket.onStatus(setConnected), []);

  // --------------------------------------------------------- socket routing
  useEffect(() => {
    return marketSocket.on((msg: ServerMessage) => {
      if (msg.type === 'tick') {
        // A switch leaves the previous market's last tick in flight. Painting
        // it would put another instrument's price on this chart for a frame.
        if (msg.symbol !== symbolRef.current) return;
        setPrice(msg.price);
        if (msg.price !== lastPrice.current) {
          setTickDir(msg.price > lastPrice.current ? 'up' : 'down');
          lastPrice.current = msg.price;
          // Flash the direction, then settle back to the resting colour.
          // Leaving it applied would paint the price by the last random tick
          // rather than by where the market actually is.
          if (flashTimer.current) window.clearTimeout(flashTimer.current);
          flashTimer.current = window.setTimeout(() => setTickDir(null), 450);
        }
        return;
      }
      if (msg.type === 'run') {
        const r = msg.run as Run;
        setRun(r);
        const leg = msg.trade as Trade | undefined;
        if (leg) setOpenTrades((prev) => [...prev, leg]);
        // The next leg's debit lands here. Which balance it came out of is on
        // the trade itself, so there is no need to guess from current UI state.
        if (leg && typeof msg.balance === 'number') {
          const bal = msg.balance;
          setUser((prev) => {
            if (!prev) return prev;
            return leg.accountMode === 'demo'
              ? { ...prev, demoBalance: bal }
              : { ...prev, realBalance: bal };
          });
        }
        if (r.status !== 'RUNNING') {
          const up = r.netProfit >= 0;
          pushToast({
            tone: up ? 'win' : 'lose',
            icon: up ? '▲' : '▼',
            title:
              r.completedCount + ' of ' + r.totalCount + ' trades  ' +
              (up ? '+' : '−') + 'KSh ' + Math.abs(r.netProfit).toFixed(2),
            detail: r.status === 'ABORTED'
              ? (r.abortReason ?? 'Run stopped early.')
              : 'Auto-run complete.',
          });
        }
        return;
      }
      if (msg.type === 'desk') {
        // The desk reopens on its own as the book recovers, so reflect it live
        // rather than making the trader discover it by tapping Buy.
        setDesk({
          open: msg.open,
          reason: msg.reason,
          ratio: msg.ratio,
          cap: msg.cap,
          reopenAt: msg.reopenAt,
          minBase: msg.minBase,
          armed: msg.armed,
        });
        return;
      }
      if (msg.type === 'presence') {
        setOnline(msg.online);
        return;
      }
      if (msg.type === 'balance') {
        setUser((prev) =>
          prev
            ? {
                ...prev,
                demoBalance: msg.demoBalance ?? prev.demoBalance,
                realBalance: msg.realBalance ?? prev.realBalance,
              }
            : prev
        );
        return;
      }
      if (msg.type === 'trade') {
        const trade = msg.trade as Trade;
        setOpenTrades((prev) => prev.filter((t) => t.id !== trade.id));
        setUser((prev) => {
          if (!prev) return prev;
          return trade.accountMode === 'demo'
            ? { ...prev, demoBalance: msg.balance }
            : { ...prev, realBalance: msg.balance };
        });

        const profit = trade.profit ?? 0;
        const closedAt = trade.exitPrice?.toFixed(2) ?? '';
        // Why it closed matters as much as the number: a stop-out means the
        // move ran through the whole stake, not that the timer simply ran out.
        const why =
          trade.closeReason === 'STOP_OUT'
            ? 'Stopped out at ' + closedAt
            : trade.closeReason === 'TAKE_PROFIT'
              ? 'Max profit hit at ' + closedAt
              : trade.direction + ' · closed at ' + closedAt;

        if (trade.status === 'WON') {
          pushToast({
            tone: 'win',
            icon: '▲',
            title: 'Closed  +KSh ' + profit.toFixed(2),
            detail: why,
          });
        } else if (trade.status === 'LOST') {
          pushToast({
            tone: 'lose',
            icon: '▼',
            title: 'Closed  −KSh ' + Math.abs(profit).toFixed(2),
            detail: why,
          });
        } else if (trade.status === 'TIE') {
          pushToast({
            tone: 'info',
            icon: '=',
            title: 'Closed flat — stake returned',
            detail: why,
          });
        }
      }
    });
  }, [pushToast]);

  // Rehydrate live positions after a refresh so countdowns survive reloads.
  const loadOpenTrades = useCallback(async () => {
    if (!user) {
      setOpenTrades([]);
      return;
    }
    try {
      const res = await api.get<{ trades: Trade[] }>('/trades/open');
      setOpenTrades(res.trades);
    } catch {
      // Non-fatal: the panel simply starts empty.
    }
  }, [user]);

  useEffect(() => {
    void loadOpenTrades();
  }, [loadOpenTrades]);

  // ---------------------------------------------------------------- actions
  const refreshUser = useCallback(async () => {
    try {
      const res = await api.get<{ user: User | null }>('/auth/me');
      setUser(res.user);
    } catch {
      // Keep the current user on a transient failure.
    }
  }, []);

  const login = useCallback(
    async (username: string, password: string) => {
      const res = await api.post<{ user: User }>('/auth/login', { username, password });
      setUser(res.user);
      setAccountMode(res.user.realBalance > 0 ? 'real' : 'demo');
      setModal(null);
      pushToast({ tone: 'info', icon: '✓', title: 'Welcome back, ' + res.user.username });
      marketSocket.resume();
    },
    [pushToast]
  );

  const register = useCallback(
    async (input: {
      username: string;
      phone: string;
      password: string;
      confirmPassword: string;
    }) => {
      const res = await api.post<{ user: User; demoCredited: number }>('/auth/register', input);
      setUser(res.user);
      setAccountMode('demo');
      setModal(null);
      pushToast({
        tone: 'win',
        icon: '🎁',
        title: 'Demo account funded',
        detail: 'KSh ' + res.demoCredited.toLocaleString('en-KE') + ' added to practise with.',
      });
      marketSocket.resume();
    },
    [pushToast]
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      setUser(null);
      setOpenTrades([]);
      setAccountMode('demo');
    }
  }, []);

  const resetDemo = useCallback(async () => {
    const res = await api.post<{ demoBalance: number }>('/auth/demo/reset');
    setUser((prev) => (prev ? { ...prev, demoBalance: res.demoBalance } : prev));
    pushToast({ tone: 'info', icon: '↺', title: 'Demo balance reset' });
  }, [pushToast]);

  const balance = user ? (accountMode === 'demo' ? user.demoBalance : user.realBalance) : 0;

  /**
   * The active instrument. Multipliers differ per market — they scale inversely
   * with volatility so the odds stay identical — so the panel must read this
   * one rather than the platform-wide default.
   */
  const instrument = useMemo<Instrument | null>(() => {
    return (
      instruments.find((i) => i.symbol === symbol) ??
      config.instruments.find((i) => i.symbol === symbol) ??
      null
    );
  }, [instruments, config.instruments, symbol]);

  const multiplier =
    instrument?.multipliers?.[String(duration)] ?? config.multipliers[String(duration)] ?? 1000;

  // Validated once here so the panel and the sticky bar cannot disagree about
  // whether the current ticket is placeable.
  const stakeAmount = Number(stake);

  /**
   * Live trades are capped by what the book could pay if they won, which moves
   * with deposits, withdrawals and open positions. Demo money is owed to nobody,
   * so it keeps the full configured range.
   */
  const stakeCeiling =
    accountMode === 'real'
      ? Math.max(0, Math.min(config.maxStake, config.maxStakeLive))
      : config.maxStake;

  const stakeIssue = ((): string | null => {
    if (stake.trim() === '') return null;
    if (!Number.isFinite(stakeAmount)) return 'Enter a valid amount.';
    if (stakeAmount < config.minStake) return 'Minimum trade is KSh ' + config.minStake + '.';
    if (stakeAmount > stakeCeiling) {
      return accountMode === 'real' && stakeCeiling < config.maxStake
        ? stakeCeiling < config.minStake
          ? 'Live trading is at capacity for the moment. Demo is open.'
          : 'Largest live trade right now is KSh ' + stakeCeiling.toLocaleString('en-KE') + '.'
        : 'Maximum trade is KSh ' + config.maxStake.toLocaleString('en-KE') + '.';
    }
    if (user && stakeAmount > balance) {
      return accountMode === 'demo'
        ? 'Demo balance is too low.'
        : 'Balance too low — deposit to continue.';
    }
    return null;
  })();

  const canTrade =
    Number.isFinite(stakeAmount) &&
    stakeAmount >= config.minStake &&
    stakeAmount <= stakeCeiling &&
    (!user || stakeAmount <= balance) &&
    price > 0;

  const submitTrade = useCallback(
    async (direction: Direction) => {
      if (!user) {
        setModal('login');
        return;
      }
      const amount = Number(stake);
      if (!Number.isFinite(amount) || tradeBusy) return;

      setTradeBusy(direction);
      setTradeError(null);
      try {
        const res = await api.post<{ trade: Trade; balance: number }>('/trades', {
          direction, stake: amount, durationSec: duration, accountMode,
          symbol: symbolRef.current,
        });
        setOpenTrades((prev) => [...prev, res.trade]);
        setUser((prev) => {
          if (!prev) return prev;
          return accountMode === 'demo'
            ? { ...prev, demoBalance: res.balance }
            : { ...prev, realBalance: res.balance };
        });
      } catch (err) {
        setTradeError(err instanceof ApiError ? err.message : 'Could not place the trade.');
      } finally {
        setTradeBusy(null);
      }
    },
    [user, stake, duration, accountMode, tradeBusy]
  );

  /** One tap: opens the whole batch, with the server choosing each leg's side. */
  const startAuto = useCallback(async () => {
    if (!user) {
      setModal('login');
      return;
    }
    const amount = Number(stake);
    if (!Number.isFinite(amount) || autoBusy) return;

    setAutoBusy(true);
    setTradeError(null);
    try {
      const res = await api.post<{ trade: Trade; balance: number; run: Run }>('/trades/run', {
        direction: 'AUTO',
        stake: amount,
        durationSec: duration,
        accountMode,
        count: autoRunCount,
        symbol: symbolRef.current,
      });
      setRun(res.run);
      setOpenTrades((prev) => [...prev, res.trade]);
      setUser((prev) => {
        if (!prev) return prev;
        return accountMode === 'demo'
          ? { ...prev, demoBalance: res.balance }
          : { ...prev, realBalance: res.balance };
      });
    } catch (err) {
      setTradeError(err instanceof ApiError ? err.message : 'Could not start the auto-trade.');
    } finally {
      setAutoBusy(false);
    }
  }, [user, stake, duration, accountMode, autoBusy, autoRunCount]);

  /**
   * Switches market. The socket subscription, the chart and the ticket all
   * follow from this one value, and the new price is fetched immediately rather
   * than waiting for the next tick so the panel never quotes the old market.
   */
  const setSymbol = useCallback(
    (next: string) => {
      if (next === symbolRef.current) return;
      symbolRef.current = next;
      setSymbolState(next);
      setTradeError(null);
      marketSocket.watch(next);
      try {
        window.localStorage.setItem('fpesa.symbol', next);
      } catch {
        // Private browsing: the choice simply does not persist.
      }

      // Show the switcher's last known price straight away, then confirm it.
      const known = instruments.find((i) => i.symbol === next);
      if (known) {
        setPrice(known.price);
        lastPrice.current = known.price;
      }
      setTickDir(null);

      void api
        .get<Quote>('/market/quote?symbol=' + next)
        .then((q) => {
          if (symbolRef.current !== next) return;
          setQuote(q);
          setPrice(q.price);
          lastPrice.current = q.price;
        })
        .catch(() => undefined);
    },
    [instruments]
  );

  const openModal = useCallback((kind: ModalKind) => setModal(kind), []);
  const closeModal = useCallback(() => setModal(null), []);

  const value = useMemo<AppValue>(
    () => ({
      ready,
      config,
      user,
      quote,
      price,
      tickDir,
      connected,
      online,
      instruments,
      symbol,
      setSymbol,
      instrument,
      multiplier,
      accountMode,
      setAccountMode,
      balance,
      openTrades,
      stake,
      setStake,
      duration,
      setDuration,
      tradeBusy,
      tradeError,
      setTradeError,
      stakeIssue,
      stakeCeiling,
      canTrade,
      submitTrade,
      desk,
      autoRunCount,
      run,
      autoBusy,
      startAuto,
      modal,
      openModal,
      closeModal,
      login,
      register,
      logout,
      refreshUser,
      resetDemo,
      toasts,
      pushToast,
    }),
    [
      ready, config, user, quote, price, tickDir, connected, online, accountMode,
      instruments, symbol, setSymbol, instrument, multiplier,
      balance, openTrades, stake, duration, tradeBusy, tradeError, stakeIssue,
      canTrade, stakeCeiling, submitTrade, desk, autoRunCount, run, autoBusy, startAuto, modal, openModal, closeModal, login, register,
      logout, refreshUser, resetDemo, toasts, pushToast,
    ]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export { ApiError };
