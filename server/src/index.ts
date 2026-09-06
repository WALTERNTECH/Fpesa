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
import { exposureGuard } from './services/exposure.js';
import { authRouter } from './routes/auth.routes.js';
import { marketRouter } from './routes/market.routes.js';
import { tradeRouter } from './routes/trade.routes.js';
import { walletRouter } from './routes/wallet.routes.js';
import { socialRouter } from './routes/social.routes.js';
import { webhookRouter } from './routes/webhook.routes.js';
import { fairnessRouter } from './routes/fairness.routes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(here, '../../client/dist');

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
  app.use(attachUser);

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      uptime: Math.round(process.uptime()),
      feed: priceFeed.health(),
      online: hub.onlineCount(),
    });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/market', marketRouter);
  app.use('/api/trades', tradeRouter);
  app.use('/api/wallet', walletRouter);
  app.use('/api/social', socialRouter);
  app.use('/api/webhooks', webhookRouter);
  app.use('/api/fairness', fairnessRouter);

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
        } else if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (/\.[0-9a-f]{8,}\./i.test(name)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    })
  );
  app.get('*', (_req, res) => {
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

  await priceFeed.start();
  hub.attach(server);
  await tradingEngine.start();
  primeNews();
  startReconciliation();
  exposureGuard.start();

  server.listen(env.port, () => {
    console.log('[fpesa] listening on port ' + env.port + ' (' + env.nodeEnv + ')');
  });

  const shutdown = (signal: string): void => {
    console.log('[fpesa] ' + signal + ' received, shutting down');
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
