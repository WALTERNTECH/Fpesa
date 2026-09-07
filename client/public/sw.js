/* Fpesa service worker.
 *
 * Deliberately conservative: this app shows live money and live prices, so the
 * only things cached are the immutable build assets and a shell to fall back to
 * when the network is gone. Nothing under /api and no WebSocket traffic is ever
 * served from cache.
 */

const VERSION = 'fpesa-v2';
const SHELL = VERSION + '-shell';
const ASSETS = VERSION + '-assets';

const SHELL_URLS = ['/', '/favicon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(SHELL_URLS))
      // A failed precache must not block activation; runtime caching recovers.
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== SHELL && k !== ASSETS).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Live data must never come from a cache — a stale price or a stale balance
  // is worse than an error.
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;

  // Navigations: go to the network, fall back to the cached shell offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put('/', copy)).catch(() => undefined);
          return res;
        })
        .catch(() =>
          caches.match('/').then((hit) => hit ?? new Response('Offline', { status: 503 }))
        )
    );
    return;
  }

  // Build output is content-hashed, so a hit is always correct.
  //
  // The catch matters more than it looks: respondWith on a rejected promise
  // produces a bare network error, which for the app bundle means a blank page
  // stuck on the boot screen with nothing to explain it. On a mobile connection
  // that is a routine occurrence, not an edge case. Falling through to a real
  // Response lets the page render its own failure instead.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then((hit) => {
        if (hit) return hit;
        return fetch(req)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(ASSETS).then((c) => c.put(req, copy)).catch(() => undefined);
            }
            return res;
          })
          .catch(
            () =>
              new Response('/* offline */', {
                status: 504,
                headers: { 'Content-Type': 'text/plain' },
              })
          );
      })
    );
    return;
  }

  // Icons and other static files: serve from cache, refresh in the background.
  event.respondWith(
    caches.match(req).then((hit) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(ASSETS).then((c) => c.put(req, copy)).catch(() => undefined);
          }
          return res;
        })
        .catch(() => hit);
      return hit ?? network;
    })
  );
});
