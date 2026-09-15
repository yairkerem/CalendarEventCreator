/* Service worker — app shell only.
 *
 * Bump CACHE_VERSION on every deploy. That single number is what makes phones
 * pick up new code; nothing here revalidates on its own.
 *
 * Backend traffic is never cached: every call to the Apps Script endpoint is a
 * cross-origin POST, and the guard in fetch() below only ever handles
 * same-origin GETs. Responses from the backend never enter the cache.
 */
const CACHE_VERSION = 'v70';
const CACHE = 'event-creator-shell-' + CACHE_VERSION;

/* Where a share from another app is parked between the POST that delivers it
 * and the page that picks it up. Kept out of CACHE so that clearing the shell
 * on an update cannot throw away a photo mid-hand-off. */
const SHARE_CACHE = 'event-creator-share';
const SHARE_FILE  = './__shared-file';
const SHARE_TEXT  = './__shared-text';
/* What the share actually delivered, written down. A photo that goes missing
   between WhatsApp and the page otherwise leaves nothing behind to say whether
   it never arrived, arrived empty, or arrived and was dropped later. */
const SHARE_META  = './__shared-meta';

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
  const receipt = { at: new Date().toISOString(), fields: [], stored: '', error: '' };
  let cache = null;

  try {
    const form = await request.formData();
    cache = await caches.open(SHARE_CACHE);

    for (const [key, value] of form.entries()){
      receipt.fields.push(typeof value === 'string'
        ? key + ': text (' + value.length + ')'
        : key + ': file ' + (value.type || '(no type)') + ' ' + value.size +
          (value.name ? ' "' + value.name + '"' : ''));
    }

    /* Text first, so a file that fails to store cannot take the caption with it.
       WhatsApp sends the caption, and a forwarded text message arrives here with
       no file at all — both are worth keeping. */
    const text = ['title', 'text', 'url']
      .map(k => form.get(k))
      .filter(v => typeof v === 'string' && v.trim())
      .join('\n');
    if (text) await cache.put(SHARE_TEXT, new Response(text));

    /* One form field per accepted kind: Android builds its intent filter from
       these, and a single field mixing image/* with application/pdf did not get
       a scanner app to offer us. The named fields are tried first; after them,
       any non-empty file in the form is taken, whatever field it was put in. */
    let file = form.get('file') || form.get('pdf') || form.get('image');
    if (!(file && typeof file !== 'string' && file.size)){
      file = null;
      for (const [, value] of form.entries()){
        if (value && typeof value !== 'string' && value.size){ file = value; break; }
      }
    }

    if (file){
      try {
        /* A cached body comes back as a nameless blob, so the filename rides
           along in a header — it is all the page can show for a PDF. */
        await cache.put(SHARE_FILE, new Response(file, {
          headers: {
            'Content-Type': file.type || 'image/jpeg',
            'X-Shared-Name': encodeURIComponent(file.name || '')
          }
        }));
        receipt.stored = (file.type || '(no type)') + ' ' + file.size;
      } catch (err) {
        receipt.error = 'storing the file: ' + String(err && err.message || err);
      }
    }
  } catch (err) {
    // a share that cannot be read still has to land somewhere sensible
    receipt.error = receipt.error || ('reading the share: ' + String(err && err.message || err));
  }

  try {
    cache = cache || await caches.open(SHARE_CACHE);
    await cache.put(SHARE_META, new Response(JSON.stringify(receipt), {
      headers: { 'Content-Type': 'application/json' }
    }));
  } catch (err) {
    // the receipt is evidence, not a requirement
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

  /* The manifest is what Chrome reads when it rebuilds the installed app, share
     settings included. Served cache-first, a change to it reached a phone only
     after a whole app update had come and gone first — so it is fetched fresh,
     and the cached copy is kept only for when there is no network. */
  if (url.pathname.endsWith('/manifest.webmanifest')) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) {
          const cache = await caches.open(CACHE);
          await cache.put('./manifest.webmanifest', res.clone());
        }
        return res;
      } catch (err) {
        return (await caches.match('./manifest.webmanifest')) || Response.error();
      }
    })());
    return;
  }

  event.respondWith(
    caches.match(req).then(hit => hit || fetch(req))
  );
});
