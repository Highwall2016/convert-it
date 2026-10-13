/* Service worker. scripts/build-sw.mjs fills in the __PLACEHOLDERS__ at
 * postbuild and writes out/sw.js, so the precache list always matches the
 * build it ships with.
 *
 * Strategy:
 *  - Install: precache the app shell (home and About pages, their JS/CSS,
 *    manifest, icons). Enough to open and use the app offline.
 *  - Hashed /_next/static/*: cache-first (content-hashed, never changes).
 *  - /wasm, /fonts, /icons, /ocr: stale-while-revalidate, cached on first use, so a
 *    conversion that worked once keeps working offline without a first visit
 *    downloading 20 MB of engines the person may never use.
 *  - FFmpeg cores (versioned CDN URLs): cache-first. The app still checks their
 *    SHA-256 on every load, so a cached copy gets the same integrity check.
 *  - Navigations: network-first; offline, the cached page, or a redirect to
 *    the home converter for pages never visited.
 *  - "offline-pack" message: caches everything, for people who want the whole
 *    app offline (Footer's "Save for offline use").
 *  - POST /share-target (the installed app in the share sheet): the shared
 *    files go into a cache the page reads on /?shared=1.
 *  - Everything that reaches the network is counted (bytes sent, received)
 *    for the page's network badge.
 *
 * A new version waits until every tab of the old one is closed instead of
 * taking over mid-conversion (no skipWaiting).
 */

const VERSION = __VERSION__;
const SHELL = __SHELL__;
const PACK = __PACK__;
const MEDIA_ORIGINS = __MEDIA_ORIGINS__;

const SHELL_CACHE = `shell-${VERSION}`;
const ASSET_CACHE = 'assets';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith('shell-') && name !== SHELL_CACHE) await caches.delete(name);
      }
      // Hashed chunks from older builds are dead weight once this one is live.
      const live = new Set(PACK);
      const assets = await caches.open(ASSET_CACHE);
      for (const request of await assets.keys()) {
        const url = new URL(request.url);
        if (url.origin === self.location.origin && url.pathname.startsWith('/_next/static/')) {
          if (!live.has(url.pathname)) await assets.delete(request);
        }
      }
      await self.clients.claim();
    })(),
  );
});

// Network log, for the page's "sent / received" badge: bytes that actually
// crossed the network (cache hits don't), counted here because every request
// from the pages and their workers passes through this worker. Kept across
// versions, so it covers the app's whole life in this browser.
const LOG_CACHE = 'network-log';
const LOG_URL = '/__network-log';
const logChannel = new BroadcastChannel('network-log');
let logReady = null;
let logSaving = null;

function readLog() {
  logReady ??= caches
    .match(LOG_URL)
    .then((saved) => (saved ? saved.json() : null))
    .catch(() => null)
    .then((saved) => ({ sent: 0, received: 0, ...saved }));
  return logReady;
}

async function record(sent, received) {
  if (!sent && !received) return;
  const log = await readLog();
  log.sent += sent;
  log.received += received;
  logChannel.postMessage(log);
  logSaving ??= new Promise((resolve) => setTimeout(resolve, 1000)).then(async () => {
    logSaving = null;
    await (await caches.open(LOG_CACHE)).put(LOG_URL, new Response(JSON.stringify(log)));
  });
  await logSaving;
}

/** fetch(), counted: the request body going out, the response coming in. */
async function net(request) {
  const sent =
    request.method === 'GET' || request.method === 'HEAD'
      ? 0
      : (await request.clone().arrayBuffer()).byteLength;
  const response = await fetch(request);
  // Content-Length is the size on the wire (compressed); without it, the body.
  const length = Number(response.headers.get('content-length'));
  const received =
    length > 0
      ? Promise.resolve(length)
      : response.type === 'opaque'
        ? Promise.resolve(0)
        : response
            .clone()
            .arrayBuffer()
            .then((body) => body.byteLength)
            .catch(() => 0);
  received.then((bytes) => record(sent, bytes)).catch(() => {});
  return response;
}

async function put(cacheName, request, response) {
  if (response.ok && (response.type === 'basic' || response.type === 'cors')) {
    const cache = await caches.open(cacheName);
    await cache.put(request, response.clone());
  }
  return response;
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  return put(ASSET_CACHE, request, await net(request));
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const network = net(request)
    .then((response) => put(ASSET_CACHE, request, response))
    .catch(() => cached);
  return cached ?? network;
}

async function networkFirst(request, cacheName) {
  try {
    return await put(cacheName, request, await net(request));
  } catch (err) {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
}

async function navigate(request) {
  try {
    return await put(SHELL_CACHE, request, await net(request));
  } catch {
    const url = new URL(request.url);
    const cached =
      (await caches.match(request, { ignoreSearch: true })) ??
      (await caches.match(url.pathname.replace(/\/$/, '') || '/'));
    if (cached) return cached;
    // A converter page never opened online: the home page is the same
    // converter, so send the visitor there rather than to an error page.
    return Response.redirect('/', 302);
  }
}

// The share sheet POSTs here (manifest share_target). There's no server to
// receive it, so the worker does: the files (or the shared text, as a file)
// go into the share inbox cache, and the page picks them up from there
// (app/components/ConverterApp.tsx, ?shared=1) and empties it.
const SHARE_INBOX = 'share-inbox';
const MAX_SHARE_FILES = 10;
const MAX_SHARE_BYTES = 50 * 1024 * 1024;
const SHARE_TTL_MS = 15 * 60 * 1000;

async function purgeOldShares(inbox) {
  const now = Date.now();
  for (const request of await inbox.keys()) {
    const id = new URL(request.url).pathname.split('/').pop() || '';
    const created = Number(id.split('-')[0]);
    if (!Number.isFinite(created) || created <= 0 || now - created > SHARE_TTL_MS) {
      await inbox.delete(request);
    }
  }
}

async function receiveShare(request) {
  // Content-Length is not guaranteed, but reject known oversized requests
  // before formData() materialises their contents.
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_SHARE_BYTES + 128 * 1024) {
    return new Response('Share exceeds 50 MiB', { status: 413 });
  }
  const form = await request.formData();
  const files = form.getAll('files').filter((f) => typeof f !== 'string' && f.size > 0);
  if (
    files.length > MAX_SHARE_FILES ||
    files.reduce((total, f) => total + f.size, 0) > MAX_SHARE_BYTES
  ) {
    return new Response('Share exceeds size or file-count limit', { status: 413 });
  }
  const inbox = await caches.open(SHARE_INBOX);
  await purgeOldShares(inbox);
  let n = 0;
  const keep = (blob, name) =>
    inbox.put(
      `/share-inbox/${Date.now()}-${n++}`,
      new Response(blob, {
        headers: {
          'content-type': blob.type || 'application/octet-stream',
          'x-file-name': encodeURIComponent(name),
        },
      }),
    );
  for (const file of files) await keep(file, file.name);
  if (!files.length) {
    const text = [form.get('title'), form.get('text'), form.get('url')]
      .filter((part) => typeof part === 'string' && part.trim())
      .join('\n');
    if (text) await keep(new Blob([text], { type: 'text/plain' }), 'shared.txt');
  }
  return Response.redirect('/?shared=1', 303);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method === 'POST' && url.origin === self.location.origin) {
    if (url.pathname === '/share-target') return event.respondWith(receiveShare(request));
  }
  // Anything else that isn't a GET goes out as is, but counted.
  if (request.method !== 'GET') return event.respondWith(net(request));

  if (url.origin === self.location.origin) {
    if (request.mode === 'navigate') return event.respondWith(navigate(request));
    if (url.pathname.startsWith('/_next/static/')) return event.respondWith(cacheFirst(request));
    if (/^\/(wasm|fonts|icons|ocr)\//.test(url.pathname) || url.pathname === '/manifest.json') {
      return event.respondWith(staleWhileRevalidate(request));
    }
    // RSC payloads for client-side navigation (/about.txt?_rsc=…).
    if (url.pathname.endsWith('.txt')) return event.respondWith(networkFirst(request, SHELL_CACHE));
  } else if (MEDIA_ORIGINS.includes(url.origin)) {
    return event.respondWith(cacheFirst(request));
  }
  // The rest (and other origins, which the CSP limits) passes straight
  // through, counted.
  event.respondWith(net(request));
});

// Offline pack: fetch every app asset not cached yet, reporting progress.
self.addEventListener('message', (event) => {
  const port = event.ports[0];
  if (!port) return;
  if (event.data === 'network-log') {
    event.waitUntil(readLog().then((log) => port.postMessage(log)));
  }
  if (event.data === 'offline-pack-status') {
    event.waitUntil(
      missing().then((left) => port.postMessage({ total: PACK.length, left: left.length })),
    );
  }
  if (event.data === 'offline-pack') {
    event.waitUntil(
      (async () => {
        const left = await missing();
        const cache = await caches.open(ASSET_CACHE);
        let done = PACK.length - left.length;
        for (const path of left) {
          try {
            const response = await net(new Request(path));
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            await cache.put(path, response);
          } catch {
            port.postMessage({ error: path });
            return;
          }
          done++;
          port.postMessage({ total: PACK.length, done });
        }
        port.postMessage({ total: PACK.length, done: PACK.length, complete: true });
      })(),
    );
  }
});

async function missing() {
  const left = [];
  for (const path of PACK) {
    if (!(await caches.match(path))) left.push(path);
  }
  return left;
}
