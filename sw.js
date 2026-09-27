/* RECOVERY PLOT — service worker
   ==============================
   Makes the app open in a field with no signal.

   Three kinds of thing, three rules:

   1. The app itself (index.html, physics.js, support.js, manifest)
      NETWORK FIRST, cache as the fallback. You always get the newest deploy
      when you have signal; you still get the app when you don't. This is the
      opposite of "cache first" on purpose — cache-first is how a page ends up
      running last week's code after a refresh.

   2. Libraries (React, ReactDOM, Leaflet, fonts)
      CACHE FIRST. Their URLs carry a version number, so a cached copy is
      never stale. Fetched once, kept.

   3. Map tiles
      STALE-WHILE-REVALIDATE with a cap. Any tile you have looked at is kept
      (up to about 900 tiles, ~20 MB), so a field you have opened the map on
      at home is still drawn at the pad. Older tiles fall off the end.

   Weather is not touched here. It goes straight to the network and the app
   keeps its own last-good copy, labelled with its age, for when that fails.

   Bump VERSION when you deploy; the old caches are dropped on activate. */

const VERSION = 'rp-13';
const SHELL = VERSION + '-shell';
const LIBS = VERSION + '-libs';
const TILES = 'rp-tiles';               /* survives versions; tiles don't change */
const TILE_CAP = 900;

const SHELL_URLS = [
  './',
  './index.html',
  './physics.js',
  './support.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

const LIB_HOSTS = ['unpkg.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const TILE_HOSTS = [
  'tile.openstreetmap.org',
  'server.arcgisonline.com', 'services.arcgisonline.com',
  'basemap.nationalmap.gov',
  'mt0.google.com', 'mt1.google.com', 'mt2.google.com', 'mt3.google.com',
  'tiles.stadiamaps.com'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL)
      .then(c => Promise.all(SHELL_URLS.map(u => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== SHELL && k !== LIBS && k !== TILES).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

/* the app's own "clear everything" button talks to us */
self.addEventListener('message', e => {
  if (e.data === 'rp-clear') {
    e.waitUntil(caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))));
  }
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    e.respondWith(networkFirst(req, SHELL));
    return;
  }
  if (LIB_HOSTS.indexOf(url.hostname) >= 0) {
    e.respondWith(cacheFirst(req, LIBS));
    return;
  }
  if (TILE_HOSTS.indexOf(url.hostname) >= 0) {
    e.respondWith(tile(req));
    return;
  }
  /* weather and everything else: straight through */
});

/* ---- strategies ---- */

async function networkFirst(req, cacheName) {
  const c = await caches.open(cacheName);
  /* strip cache-busters so ?cb=… still matches the stored copy when offline */
  const key = stripQuery(req);
  try {
    const res = await withTimeout(fetch(req), 4000);
    if (res && res.ok) c.put(key, res.clone());
    return res;
  } catch (err) {
    const hit = await c.match(key, { ignoreSearch: true });
    if (hit) return hit;
    /* a navigation with nothing cached: hand back the shell if we have it */
    if (req.mode === 'navigate') {
      const shell = await c.match('./index.html');
      if (shell) return shell;
    }
    throw err;
  }
}

async function cacheFirst(req, cacheName) {
  const c = await caches.open(cacheName);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone());
  return res;
}

async function tile(req) {
  const c = await caches.open(TILES);
  const hit = await c.match(req);
  const refresh = fetch(req).then(res => {
    if (res && (res.ok || res.type === 'opaque')) {
      c.put(req, res.clone()).then(() => trim(c, TILE_CAP));
    }
    return res;
  }).catch(() => null);
  if (hit) { refresh.catch(() => null); return hit; }
  const res = await refresh;
  if (res) return res;
  /* offline and never seen: a transparent tile, so the map stays readable */
  return new Response(BLANK_PNG, { headers: { 'Content-Type': 'image/png' } });
}

/* ---- helpers ---- */

function stripQuery(req) {
  const u = new URL(req.url);
  if (u.search && /(^|[?&])cb=/.test(u.search)) { u.search = ''; return new Request(u.toString(), { mode: req.mode === 'navigate' ? 'same-origin' : req.mode }); }
  return req;
}

function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

let trimming = false;
async function trim(c, cap) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await c.keys();
    if (keys.length > cap) {
      /* oldest entries come first */
      const drop = keys.slice(0, keys.length - cap);
      await Promise.all(drop.map(k => c.delete(k)));
    }
  } finally { trimming = false; }
}

/* 1x1 transparent PNG */
const BLANK_PNG = Uint8Array.from(atob(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
), ch => ch.charCodeAt(0));
