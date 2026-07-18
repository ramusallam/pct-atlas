/* PCT Atlas service worker — offline app shell + section data + tile-pack range serving */
'use strict';

const SHELL_CACHE = 'pct-shell-v6';
const RUNTIME_CACHE = 'pct-runtime-v6';
const PACK_CACHE = 'pct-packs-v1'; // written by the page, served here — never purge on upgrade

const SECTION_IDS = [
  'CA_A','CA_B','CA_C','CA_D','CA_E','CA_F','CA_G','CA_H','CA_I','CA_J','CA_K','CA_L','CA_M','CA_N','CA_O','CA_P','CA_Q','CA_R',
  'OR_B','OR_C','OR_D','OR_E','OR_F','OR_G',
  'WA_H','WA_I','WA_J','WA_K','WA_L',
];
const FONT_FACES = ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic'];
const FONT_RANGES = ['0-255', '256-511', '512-767', '768-1023', '8192-8447'];

const SHELL = [
  './', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest',
  'vendor/maplibre-gl.js', 'vendor/maplibre-gl.css', 'vendor/pmtiles.js', 'vendor/maplibre-contour.js',
  'assets/basemap-layers.json',
  'assets/sprites/light.json', 'assets/sprites/light.png', 'assets/sprites/light@2x.json', 'assets/sprites/light@2x.png',
  'assets/icons/icon-192.png', 'assets/icons/icon-512.png', 'assets/icons/apple-touch-icon.png',
  'data/pct-overview.json', 'data/sections-index.json', 'data/packs.json',
  ...SECTION_IDS.map((id) => 'data/sections/' + id + '.json'),
  ...FONT_FACES.flatMap((f) => FONT_RANGES.map((r) => 'assets/fonts/' + encodeURIComponent(f) + '/' + r + '.pbf')),
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE && k !== PACK_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Tile archives: serve byte ranges from a downloaded pack if present
  if (url.origin === location.origin && url.pathname.includes('/tiles/')) {
    e.respondWith(serveTiles(e.request));
    return;
  }

  // Google Fonts: cache after first use so type survives offline
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(
      caches.open(RUNTIME_CACHE).then(async (c) => {
        const hit = await c.match(e.request);
        const net = fetch(e.request).then((res) => { if (res.ok || res.type === 'opaque') c.put(e.request, res.clone()); return res; }).catch(() => hit);
        return hit || net;
      })
    );
    return;
  }

  if (url.origin !== location.origin || e.request.method !== 'GET') return;

  // App shell + data: cache-first, network fallback (and refresh cache when online)
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => {
        if (e.request.mode === 'navigate') return caches.match('index.html');
        return Response.error();
      });
    })
  );
});

async function serveTiles(request) {
  const cache = await caches.open(PACK_CACHE);
  // pack downloads bypass the cache read (the page stores the result itself)
  if (request.headers.get('x-pack-download')) return fetch(request);

  const hit = await cache.match(request.url);
  if (!hit) return fetch(request);

  const range = request.headers.get('range');
  const blob = await hit.blob();
  if (!range) return new Response(blob, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(blob.size) } });

  const m = /bytes=(\d+)-(\d+)?/.exec(range);
  if (!m) return new Response(blob);
  const start = Number(m[1]);
  const end = m[2] !== undefined ? Math.min(Number(m[2]), blob.size - 1) : blob.size - 1;
  const part = blob.slice(start, end + 1);
  return new Response(part, {
    status: 206,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${blob.size}`,
      'Content-Length': String(part.size),
      'Accept-Ranges': 'bytes',
    },
  });
}
