import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import jwt from 'jsonwebtoken';
import { env } from '../env.js';
import { SESSION_COOKIE } from '../lib/auth.js';
import { priceFeed, SYMBOL } from '../services/prices.js';

type Client = WebSocket & {
  userId?: string;
  isAlive?: boolean;
  /** Which instrument's ticks this socket wants. */
  watching?: string;
};

/** Pulls the Fpesa session out of an upgrade request's Cookie header. */
function readSessionCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [rawName, ...rest] = part.trim().split('=');
    if (rawName !== SESSION_COOKIE) continue;
    try {
      const token = decodeURIComponent(rest.join('='));
      const payload = jwt.verify(token, env.jwtSecret) as { sub?: string };
      return payload.sub ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

export type OutboundMessage =
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
    };

class Hub {
  private wss: WebSocketServer | null = null;
  private clients = new Set<Client>();
  private heartbeat: NodeJS.Timeout | null = null;
  private presenceTimer: NodeJS.Timeout | null = null;

  attach(server: Server): void {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (socket: Client, request) => {
      this.clients.add(socket);
      socket.isAlive = true;

      // The upgrade request carries the same-origin session cookie, so the
      // socket identifies itself without the browser ever handling a raw token.
      const fromCookie = readSessionCookie(request.headers.cookie);
      if (fromCookie) socket.userId = fromCookie;

      socket.on('pong', () => {
        socket.isAlive = true;
      });

      socket.on('message', (raw) => {
        let msg: { type?: string; token?: string; symbol?: string };
        try {
          msg = JSON.parse(String(raw)) as { type?: string; token?: string; symbol?: string };
        } catch {
          return;
        }
        // A client may tell us two things over the socket: who it is, and which
        // market it is looking at. Everything that changes state — money above
        // all — goes through the authenticated REST API.
        if (msg.type === 'auth' && typeof msg.token === 'string') {
          try {
            const payload = jwt.verify(msg.token, env.jwtSecret) as { sub?: string };
            if (payload.sub) socket.userId = payload.sub;
          } catch {
            socket.userId = undefined;
          }
          return;
        }
        if (msg.type === 'watch' && typeof msg.symbol === 'string') {
          // Unknown symbols are ignored rather than errored: the socket carries
          // no authority, so the worst a bad value can do is show nothing.
          if (!priceFeed.has(msg.symbol)) return;
          socket.watching = msg.symbol;
          const t = priceFeed.current(msg.symbol);
          this.send(socket, { type: 'tick', symbol: t.symbol, price: t.price, ts: t.ts });
        }
      });

      socket.on('close', () => {
        this.clients.delete(socket);
      });
      socket.on('error', () => {
        this.clients.delete(socket);
      });

      // Immediate snapshot so the UI paints without waiting for the next tick.
      const t = priceFeed.current();
      this.send(socket, { type: 'tick', symbol: t.symbol, price: t.price, ts: t.ts });
    });

    // Drop half-open connections (mobile networks, sleeping laptops).
    this.heartbeat = setInterval(() => {
      for (const socket of this.clients) {
        if (socket.isAlive === false) {
          socket.terminate();
          this.clients.delete(socket);
          continue;
        }
        socket.isAlive = false;
        try {
          socket.ping();
        } catch {
          this.clients.delete(socket);
        }
      }
    }, 30_000);

    this.presenceTimer = setInterval(() => {
      this.broadcast({ type: 'presence', online: this.clients.size });
    }, 15_000);

    // Five instruments at four ticks a second is twenty messages a second per
    // client if every tick goes everywhere. A socket only receives the market
    // it is actually displaying; positions on the others still settle, because
    // settlement watches the feed directly rather than the socket.
    priceFeed.subscribe((tick) => {
      const payload = JSON.stringify({
        type: 'tick', symbol: tick.symbol, price: tick.price, ts: tick.ts,
      });
      for (const socket of this.clients) {
        if (socket.readyState !== WebSocket.OPEN) continue;
        if ((socket.watching ?? SYMBOL) !== tick.symbol) continue;
        try {
          socket.send(payload);
        } catch {
          this.clients.delete(socket);
        }
      }
    });
  }

  private send(socket: Client, msg: OutboundMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(msg));
    } catch {
      // Socket died mid-write; the close handler will clean it up.
    }
  }

  broadcast(msg: OutboundMessage): void {
    const payload = JSON.stringify(msg);
    for (const socket of this.clients) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      try {
        socket.send(payload);
      } catch {
        this.clients.delete(socket);
      }
    }
  }

  /** Delivers to every socket belonging to one user (multiple tabs/devices). */
  toUser(userId: string, msg: OutboundMessage): void {
    for (const socket of this.clients) {
      if (socket.userId === userId) this.send(socket, msg);
    }
  }

  onlineCount(): number {
    return this.clients.size;
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.wss?.close();
  }
}

export const hub = new Hub();
