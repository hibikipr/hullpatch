// Hullpatch service worker: lets the installed app open and repair files offline.
// The build (vite.config.js) fills in VERSION and PRECACHE and writes this to /sw.js.
//
// - The page, its script, styles, fonts and the repair worker are cached on install.
// - The 3D viewer (F3D, ~12 MB compressed) is cached the first time it is used, so it
//   only costs a download for people who actually repair something.
// - Pages are fetched from the network first, so a new release shows up on the next
//   visit; the cached copy is only used when the network is down.
// - Files shared to the installed app (Android share sheet) arrive here as a POST to
//   /share-target and are handed to the page through the cache.

const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;

const PAGES = 'hullpatch-pages-' + VERSION;
// Files under /assets/ have a content hash in their name, so they can be kept across
// releases; on activate anything the new release no longer uses is dropped.
const ASSETS = 'hullpatch-assets';
const SHARED = 'hullpatch-shared';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const pages = await caches.open(PAGES);
    const assets = await caches.open(ASSETS);
    await Promise.all(PRECACHE.map(async (url) => {
      const cache = url.startsWith('/assets/') ? assets : pages;
      if (cache === assets && await cache.match(url)) return; // kept from the last release
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`${url}: ${res.status}`);
      await cache.put(url, res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('hullpatch-pages-') && name !== PAGES) await caches.delete(name);
    }
    // Keep the viewer even though it isn't precached: same F3D release, same file name.
    const keep = new Set(PRECACHE.filter((u) => u.startsWith('/assets/')));
    const assets = await caches.open(ASSETS);
    for (const req of await assets.keys()) {
      const path = new URL(req.url).pathname;
      if (!keep.has(path) && !/\/f3d-[^/]+\.(js|wasm)$/.test(path)) await assets.delete(req);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== 'GET') return;
  if (url.pathname === '/healthz' || url.pathname === '/version.txt') return;

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(req));
  } else {
    event.respondWith(networkFirst(req));
  }
});

async function cacheFirst(req) {
  const cache = await caches.open(ASSETS);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) await cache.put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(PAGES);
  // The page is cached as "/", whatever query string it was opened with.
  const key = req.mode === 'navigate' ? '/' : req;
  try {
    const res = await fetch(req);
    if (res.ok && (req.mode === 'navigate' || PRECACHE.includes(new URL(req.url).pathname))) {
      await cache.put(key, res.clone());
    }
    return res;
  } catch (err) {
    const hit = await cache.match(key, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

async function receiveShare(req) {
  try {
    const form = await req.formData();
    const file = form.getAll('stl').find((f) => f && typeof f === 'object' && 'size' in f);
    if (file) {
      const cache = await caches.open(SHARED);
      await cache.put('/shared-file', new Response(file, {
        headers: { 'x-file-name': encodeURIComponent(file.name || 'shared.stl') },
      }));
    }
  } catch {
    // Fall through: the page opens without a file and says nothing arrived.
  }
  return Response.redirect('/?shared=1', 303);
}
