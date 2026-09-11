import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env, assertEnv } from './env.js';
import { attachUser } from './lib/auth.js';
import { hub } from './realtime/hub.js';
import { priceFeed } from './services/prices.js';
import { tradingEngine } from './services/trading.js';
import { primeNews } from './services/news.js';
import { startReconciliation } from './services/wallet.js';
import { solvency } from './services/solvency.js';
import { startFx } from './services/fx.js';
import { exposureGuard } from './services/exposure.js';
import { authRouter } from './routes/auth.routes.js';
import { marketRouter } from './routes/market.routes.js';
import { tradeRouter } from './routes/trade.routes.js';
import { walletRouter } from './routes/wallet.routes.js';
import { socialRouter } from './routes/social.routes.js';
import { webhookRouter } from './routes/webhook.routes.js';
import { fairnessRouter } from './routes/fairness.routes.js';
import { adminRouter } from './routes/admin.routes.js';
import { internalRouter } from './routes/internal.routes.js';
import { sandboxRouter } from './routes/sandbox.routes.js';
import { settings } from './services/settings.js';
import { sandboxBook } from './services/sandbox.js';
import { shadowFeed } from './services/sandbox-mirror.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const isAdmin = env.appMode === 'admin';
const isSandbox = env.appMode === 'sandbox';
/**
 * Each mode serves exactly one bundle. The trader bundle is never served from
 * the console or the sandbox and vice versa, so a screen that shows the seed
 * cannot be reached from the host that takes deposits.
 */
const clientDist = path.resolve(
  here,
  isAdmin ? '../../client-admin/dist'
    : isSandbox ? '../../client-sandbox/dist'
      : '../../client/dist'
);

async function main(): Promise<void> {
  assertEnv();

  const app = express();
  // Render terminates TLS ahead of us; without this, secure cookies and the
  // rate limiter both see the wrong client address.
  app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'", 'ws:', 'wss:'],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          // Required for the installable app: the manifest and the service
          // worker are both same-origin and must be explicitly allowed.
          manifestSrc: ["'self'"],
          workerSrc: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    })
  );
  app.use(cors({ origin: env.publicUrl || true, credentials: true }));
  app.use(express.json({ limit: '64kb' }));
  app.use(cookieParser());
  // attachUser resolves a session against the users table. The sandbox has no
  // users table and no database, so it carries its own cookie check instead.
  if (!isSandbox) app.use(attachUser);

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      uptime: Math.round(process.uptime()),
      feed: priceFeed.health(),
      online: hub.onlineCount(),
    });
  });

  // No accounts exist in the sandbox, so the real auth surface — registration,
  // login, password changes, all of it backed by a database it does not have —
  // is not mounted there at all.
  if (!isSandbox) app.use('/api/auth', authRouter);

  if (isAdmin) {
    // Operations console: the trading, wallet, social and webhook surfaces are
    // not mounted at all, so a stolen admin session cannot reach them and the
    // payment callback has exactly one address in the world.
    app.use('/api/admin', adminRouter);
  } else if (isSandbox) {
    /**
     * The sandbox mounts its own API and nothing else — not even the public
     * market surface, because it runs its own market and the live price feed is
     * never started here. No wallet, no webhooks, no trades, no internal
     * channel, and no database behind any of it.
     */
    app.use('/api/sandbox', sandboxRouter);
  } else {
    app.use('/api/market', marketRouter);
    app.use('/api/trades', tradeRouter);
    app.use('/api/wallet', walletRouter);
    app.use('/api/social', socialRouter);
    app.use('/api/webhooks', webhookRouter);
    app.use('/api/fairness', fairnessRouter);
    // Reached only by the operations console, and only with a token signed
    // using the shared JWT secret.
    app.use('/api/internal', internalRouter);
  }

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Unknown endpoint.' });
  });

  // Static client. Hashed assets are immutable; index.html must never be cached
  // or users get stranded on an old bundle after a deploy.
  app.use(
    express.static(clientDist, {
      index: false,
      setHeaders: (res, filePath) => {
        const name = path.basename(filePath);
        if (name === 'sw.js') {
          // Revalidate on every request so a new worker rolls out promptly.
          // Deliberately not "no-store": some browsers refuse to register a
          // service worker whose script is served with it.
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Service-Worker-Allowed', '/');
        } else if (name === 'manifest.webmanifest') {
          res.setHeader('Cache-Control', 'public, max-age=3600');
        } else if (name === 'robots.txt' || name === 'sitemap.xml') {
          // Crawlers re-read these often; an hour is long enough to be cheap
          // and short enough that a correction is picked up the same day.
          res.setHeader('Cache-Control', 'public, max-age=3600');
        } else if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (/\.[0-9a-f]{8,}\./i.test(name)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    })
  );
  /**
   * Everything else is the app shell — but only "/" is a real page.
   *
   * The app has no client-side routing: login, register and the wallet are
   * dialogs on the same URL. Returning 200 for every path meant a crawler could
   * invent /pricing, /about, /anything and be told each one exists, which is a
   * soft 404 — Google indexes the duplicates and the real page competes with
   * its own shadows.
   *
   * The shell is still served so a mistyped link lands somewhere usable rather
   * than on a bare error, but the status tells the truth.
   */
  app.get('*', (req, res) => {
    const isRoot = req.path === '/' || req.path === '/index.html';
    res.status(isRoot ? 200 : 404);
    res.setHeader('Cache-Control', 'no-cache');
    if (!isRoot) res.setHeader('X-Robots-Tag', 'noindex');
    res.sendFile(path.join(clientDist, 'index.html'));
  });

  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ): void => {
      console.error('[server] unhandled error:', err);
      res.status(500).json({ error: 'SERVER_ERROR', message: 'Something went wrong.' });
    }
  );

  const server = createServer(app);

  if (isSandbox) {
    // Its own markets, seeded from this process's own random bytes at boot. The
    // live price feed is deliberately not started: the sandbox neither reads it
    // nor needs it, which is what makes it impossible to repoint at live.
    sandboxBook.start();
    // Follows production's public tick stream so the shadow book runs on the
    // prices production actually sent, not on a re-derivation of them.
    shadowFeed.start();
  } else if (!isAdmin) {
    await priceFeed.start();
    hub.attach(server);
    await tradingEngine.start();
    primeNews();
    startReconciliation();
    exposureGuard.start();
    // Reads the payout wallet and keeps the float honest without anyone
    // having to remember to update it.
    // Keeps the live house edge in step with the console without a redeploy.
    settings.start();
    solvency.startFloatSync();
    startFx();
  }

  server.listen(env.port, () => {
    const what = isAdmin ? 'operations console' : isSandbox ? 'sandbox' : 'trading app';
    console.log(
      '[fpesa] ' + what +
      ' listening on port ' + env.port + ' (' + env.nodeEnv + ')'
    );
  });

  const shutdown = (signal: string): void => {
    console.log('[fpesa] ' + signal + ' received, shutting down');
    // Publish the running epochs' seeds first. They are owed to anyone who
    // traded in them, and a restart used to strand one per instrument as
    // committed-but-never-revealed.
    if (!isAdmin && !isSandbox) priceFeed.closeForShutdown();
    if (isSandbox) {
      sandboxBook.stop();
      shadowFeed.stop();
    }
    tradingEngine.stop();
    exposureGuard.stop();
    priceFeed.stop();
    hub.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[fpesa] failed to start:', err);
  process.exit(1);
});
