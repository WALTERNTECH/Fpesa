export type ServerMessage =
  | { type: 'tick'; symbol: string; price: number; ts: number }
  | { type: 'chat'; id: string; username: string; body: string; createdAt: string }
  | { type: 'feed'; kind: string; username: string; amount: number; createdAt: string }
  | { type: 'leaderboard'; rows: unknown[] }
  | { type: 'trade'; trade: unknown; balance: number }
  | { type: 'run'; run: unknown; trade?: unknown; balance?: number }
  | { type: 'balance'; demoBalance?: number; realBalance?: number }
  | { type: 'presence'; online: number }
  | {
      type: 'desk';
      open: boolean;
      reason: string | null;
      ratio: number;
      cap: number;
      reopenAt: number;
      minBase: number;
      armed: boolean;
    };

type Handler = (msg: ServerMessage) => void;
type StatusHandler = (connected: boolean) => void;

/**
 * Single socket for prices, chat, feeds and trade settlements. It authenticates
 * from the session cookie on the upgrade request, so nothing needs to be sent.
 * Reconnects with exponential backoff and resumes immediately when the tab is
 * brought back to the foreground.
 */
class MarketSocket {
  private socket: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private statusHandlers = new Set<StatusHandler>();
  private attempts = 0;
  private retryTimer: number | null = null;
  private closed = false;

  connect(): void {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN ||
                        this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.closed = false;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = proto + '//' + window.location.host + '/ws';

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
      this.emitStatus(true);
    };
    socket.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        return;
      }
      for (const fn of this.handlers) fn(msg);
    };
    socket.onclose = () => {
      this.emitStatus(false);
      if (!this.closed) this.scheduleRetry();
    };
    socket.onerror = () => {
      socket.close();
    };
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    // 1s, 2s, 4s … capped at 15s so a long outage does not hammer the server.
    const delay = Math.min(1000 * Math.pow(2, this.attempts), 15_000);
    this.attempts += 1;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  /** Called when the tab regains focus — skips the remaining backoff wait. */
  resume(): void {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.attempts = 0;
    this.connect();
  }

  disconnect(): void {
    this.closed = true;
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  private emitStatus(connected: boolean): void {
    for (const fn of this.statusHandlers) fn(connected);
  }

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }
}

export const marketSocket = new MarketSocket();
