/* Service worker — app shell only.
 *
 * Bump CACHE_VERSION on every deploy. That single number is what makes phones
 * pick up new code; nothing here revalidates on its own.
 *
 * Backend traffic is never cached: every call to the Apps Script endpoint is a
 * cross-origin POST, and the guard in fetch() below only ever handles
 * same-origin GETs. Responses from the backend never enter the cache.
 */
const CACHE_VERSION = 'v21';
const CACHE = 'event-creator-shell-' + CACHE_VERSION;

/* Where a share from another app is parked between the POST that delivers it
 * and the page that picks it up. Kept out of CACHE so that clearing the shell
 * on an update cannot throw away a photo mid-hand-off. */
const SHARE_CACHE = 'event-creator-share';
const SHARE_FILE  = './__shared-image';
const SHARE_TEXT  = './__shared-text';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

/* No skipWaiting() here on purpose. A new worker installs and then waits, so
 * the app can offer the update instead of reloading out from under someone
 * who is halfway through typing a message. The page sends SKIP_WAITING when
 * the user accepts. */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(SHELL))
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(k => k !== CACHE && k !== SHARE_CACHE)
        .map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Android hands a shared photo over as a POST from the system share sheet.
 * Nothing can be passed straight to the page — a POST has no window yet — so
 * the file is parked in a cache and the browser is redirected to the app,
 * which picks it up on boot and clears it. */
async function receiveShare(request){
  try {
    const form = await request.formData();
    const cache = await caches.open(SHARE_CACHE);

    const file = form.get('image');
    if (file && file.size){
      await cache.put(SHARE_FILE, new Response(file, {
        headers: { 'Content-Type': file.type || 'image/jpeg' }
      }));
    }

    /* WhatsApp sends the caption, and a forwarded text message arrives here
       with no file at all — both are worth keeping. */
    const text = ['title', 'text', 'url']
      .map(k => form.get(k))
      .filter(v => typeof v === 'string' && v.trim())
      .join('\n');
    if (text) await cache.put(SHARE_TEXT, new Response(text));
  } catch (err) {
    // a share that cannot be read still has to land somewhere sensible
  }
  /* 303 so the browser follows with a GET; the query is how the page knows */
  return Response.redirect('./?shared=1', 303);
}

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // the share sheet's POST — must be caught before the GET-only guard below
  if (req.method === 'POST' &&
      url.origin === self.location.origin &&
      url.pathname.endsWith('/share')) {
    event.respondWith(receiveShare(req));
    return;
  }

  // POSTs to the backend fall straight through to the network, uncached.
  if (req.method !== 'GET') return;

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
