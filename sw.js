/* Service worker — app shell only.
 *
 * Bump CACHE_VERSION on every deploy. That single number is what makes phones
 * pick up new code; nothing here revalidates on its own.
 *
 * Backend traffic is never cached: every call to the Apps Script endpoint is a
 * cross-origin POST, and the guard in fetch() below only ever handles
 * same-origin GETs. Responses from the backend never enter the cache.
 */
const CACHE_VERSION = 'v2';
const CACHE = 'event-creator-shell-' + CACHE_VERSION;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;

  // POSTs to the backend fall straight through to the network, uncached.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: serve the cached shell so the app opens instantly and still
  // shows a sane screen with no network.
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then(hit => hit || fetch(req))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(hit => hit || fetch(req))
  );
});
