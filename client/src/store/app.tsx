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

  accountMode: AccountMode;
  setAccountMode: (mode: AccountMode) => void;
  balance: number;

  openTrades: Trade[];
  placeTrade: (direction: Direction, stake: number, durationSec: number) => Promise<void>;

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
  maxStake: 20000,
  payoutRate: 0.87,
  durations: [5, 10, 15, 30, 60],
  minDeposit: 50,
  minWithdrawal: 100,
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

  const lastPrice = useRef(0);
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
      const [cfg, me, q] = await Promise.allSettled([
        api.get<PlatformConfig>('/market/config'),
        api.get<{ user: User | null }>('/auth/me'),
        api.get<Quote>('/market/quote'),
      ]);
      if (cancelled) return;

      if (cfg.status === 'fulfilled') setConfig(cfg.value);
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

  useEffect(() => marketSocket.onStatus(setConnected), []);

  // --------------------------------------------------------- socket routing
  useEffect(() => {
    return marketSocket.on((msg: ServerMessage) => {
      if (msg.type === 'tick') {
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
        if (trade.status === 'WON') {
          pushToast({
            tone: 'win',
            icon: '▲',
            title: 'Trade won  +KSh ' + profit.toFixed(2),
            detail: trade.direction + ' · closed at ' + trade.exitPrice?.toFixed(2),
          });
        } else if (trade.status === 'LOST') {
          pushToast({
            tone: 'lose',
            icon: '▼',
            title: 'Trade lost  −KSh ' + trade.stake.toFixed(2),
            detail: trade.direction + ' · closed at ' + trade.exitPrice?.toFixed(2),
          });
        } else if (trade.status === 'TIE') {
          pushToast({
            tone: 'info',
            icon: '=',
            title: 'Tie — stake returned',
            detail: 'Price closed exactly at entry.',
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

  const placeTrade = useCallback(
    async (direction: Direction, stake: number, durationSec: number) => {
      const res = await api.post<{ trade: Trade; balance: number }>('/trades', {
        direction,
        stake,
        durationSec,
        accountMode,
      });
      setOpenTrades((prev) => [...prev, res.trade]);
      setUser((prev) => {
        if (!prev) return prev;
        return accountMode === 'demo'
          ? { ...prev, demoBalance: res.balance }
          : { ...prev, realBalance: res.balance };
      });
    },
    [accountMode]
  );

  const openModal = useCallback((kind: ModalKind) => setModal(kind), []);
  const closeModal = useCallback(() => setModal(null), []);

  const balance = user ? (accountMode === 'demo' ? user.demoBalance : user.realBalance) : 0;

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
      accountMode,
      setAccountMode,
      balance,
      openTrades,
      placeTrade,
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
      balance, openTrades, placeTrade, modal, openModal, closeModal, login,
      register, logout, refreshUser, resetDemo, toasts, pushToast,
    ]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export { ApiError };
