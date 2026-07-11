/* PCT Atlas — sections, offline maps, progress. Vanilla JS + MapLibre + PMTiles. */
'use strict';

const BASE = new URL('.', location.href).href; // works at domain root or subpath
const TILES = {
  overview: BASE + 'tiles/overview.pmtiles',
  section: (id) => BASE + 'tiles/' + id + '.pmtiles',
};
// Sections with a published offline tile pack (grow this list as packs are extracted)
const PACKS = { CA_K: 16393751 };
const PACK_CACHE = 'pct-packs-v1';
const TOTAL_MILES = 2593;
const STATE_LABEL = { CA: 'California', OR: 'Oregon', WA: 'Washington' };
const KIND_COLORS = { water: '#0EA5E9', camp: '#10b981', road: '#f59e0b', landmark: '#A0937B' };

let map, basemapLayers, index, overviewGeo;
let mode = 'list'; // 'list' | 'section'
let current = null; // current section data
let progress = loadProgress();
const sectionCache = {};

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString('en-US');

function loadProgress() {
  try { return JSON.parse(localStorage.getItem('pct-progress-v1')) || {}; } catch { return {}; }
}
function saveProgress() {
  localStorage.setItem('pct-progress-v1', JSON.stringify(progress));
  renderStats(); renderList(); refreshOverviewFilters();
}

/* ---------------- boot ---------------- */
(async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  const [layersRes, indexRes, overviewRes] = await Promise.all([
    fetch('assets/basemap-layers.json'), fetch('data/sections-index.json'), fetch('data/pct-overview.json'),
  ]);
  basemapLayers = await layersRes.json();
  index = await indexRes.json();
  overviewGeo = await overviewRes.json();

  const protocol = new pmtiles.Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);

  map = new maplibregl.Map({
    container: 'map',
    style: overviewStyle(),
    bounds: [[-124.8, 32.4], [-116.6, 49.1]],
    fitBoundsOptions: { padding: 40 },
    attributionControl: { compact: true },
  });
  window.__map = map;
  map.on('error', (e) => console.error('map error:', (e.error && e.error.message) || e));
  map.on('load', () => map.resize());
  new ResizeObserver(() => map.resize()).observe($('map-wrap'));

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showUserHeading: true,
  }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-right');

  map.on('click', 'trail-hit', (e) => {
    const id = e.features && e.features[0] && e.features[0].properties.id;
    if (id && mode === 'list') openSection(id);
  });
  map.on('mouseenter', 'trail-hit', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'trail-hit', () => { map.getCanvas().style.cursor = ''; });
  map.on('click', 'wpts', (e) => {
    const f = e.features && e.features[0];
    if (!f) return;
    const p = f.properties;
    new maplibregl.Popup({ offset: 10, closeButton: false })
      .setLngLat(f.geometry.coordinates)
      .setHTML(`<div class="wpt-kind">${p.kind}</div><strong>${esc(p.name)}</strong>${p.desc ? '<br>' + esc(p.desc) : ''}`)
      .addTo(map);
  });
  map.on('mouseenter', 'wpts', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'wpts', () => { map.getCanvas().style.cursor = ''; });

  renderStats(); renderList(); wireUI(); updateOnline();
})();

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

/* ---------------- styles ---------------- */
function styleBase(archiveUrl) {
  return {
    version: 8,
    glyphs: BASE + 'assets/fonts/{fontstack}/{range}.pbf',
    sprite: BASE + 'assets/sprites/light',
    sources: {
      basemap: {
        type: 'vector',
        url: 'pmtiles://' + archiveUrl,
        attribution: '<a href="https://openstreetmap.org">© OpenStreetMap</a> <a href="https://protomaps.com">Protomaps</a> · Trail data: Halfmile/PCTA',
      },
    },
    layers: basemapLayers.slice(),
  };
}

function doneIds() { return Object.keys(progress); }

function overviewStyle() {
  const s = styleBase(TILES.overview);
  s.sources['trail'] = { type: 'geojson', data: overviewGeo };
  s.layers.push(
    {
      id: 'trail-ghost', type: 'line', source: 'trail',
      filter: ['!', ['in', ['get', 'id'], ['literal', doneIds()]]],
      paint: { 'line-color': '#A0937B', 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.6, 10, 3.2], 'line-opacity': 0.65 },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    },
    {
      id: 'trail-done', type: 'line', source: 'trail',
      filter: ['in', ['get', 'id'], ['literal', doneIds()]],
      paint: { 'line-color': '#6366f1', 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 2.4, 10, 4.5] },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    },
    {
      id: 'trail-hit', type: 'line', source: 'trail',
      paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 18 },
    },
  );
  return s;
}

function sectionStyle(sec, archiveUrl) {
  const s = styleBase(archiveUrl);
  s.sources['side'] = { type: 'geojson', data: sec.sideTrails || { type: 'FeatureCollection', features: [] } };
  s.sources['track'] = { type: 'geojson', data: sec.track };
  s.sources['anim'] = { type: 'geojson', data: { type: 'FeatureCollection', features: [] } };
  s.sources['wpts'] = { type: 'geojson', data: sec.waypoints };
  s.layers.push(
    {
      id: 'side-trails', type: 'line', source: 'side',
      paint: { 'line-color': '#A0937B', 'line-width': 1.8, 'line-dasharray': [2, 2], 'line-opacity': 0.8 },
    },
    {
      id: 'track-line', type: 'line', source: 'track',
      paint: { 'line-color': progress[sec.id] ? '#10b981' : '#6366f1', 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 3, 14, 5] },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    },
    {
      id: 'anim-line', type: 'line', source: 'anim',
      paint: { 'line-color': '#10b981', 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 4, 14, 6] },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    },
    {
      id: 'wpts', type: 'circle', source: 'wpts',
      filter: kindFilter(),
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3, 13, 6],
        'circle-color': ['match', ['get', 'kind'],
          'water', KIND_COLORS.water, 'camp', KIND_COLORS.camp, 'road', KIND_COLORS.road, KIND_COLORS.landmark],
        'circle-stroke-width': 1.5, 'circle-stroke-color': '#FFFFFF',
      },
    },
  );
  return s;
}

function kindFilter() {
  const on = [...document.querySelectorAll('.legend input:checked')].map((el) => el.dataset.kind);
  return ['in', ['get', 'kind'], ['literal', on]];
}

function refreshOverviewFilters() {
  if (mode !== 'list' || !map || !map.getLayer('trail-done')) return;
  map.setFilter('trail-done', ['in', ['get', 'id'], ['literal', doneIds()]]);
  map.setFilter('trail-ghost', ['!', ['in', ['get', 'id'], ['literal', doneIds()]]]);
}

/* ---------------- views ---------------- */
async function openSection(id) {
  const meta = index.find((s) => s.id === id);
  if (!meta) return;
  if (!sectionCache[id]) {
    try { sectionCache[id] = await (await fetch('data/sections/' + id + '.json')).json(); }
    catch { return; }
  }
  current = sectionCache[id];
  mode = 'section';

  const archive = PACKS[id] ? TILES.section(id) : TILES.overview;
  map.setStyle(sectionStyle(current, archive));
  const b = current.bbox;
  map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: { top: 40, bottom: 40, left: 40, right: 40 }, duration: 1200 });

  $('view-list').hidden = true;
  $('view-section').hidden = false;
  $('sec-eyebrow').textContent = `${STATE_LABEL[current.state]} · Section ${current.letter}`;
  $('sec-title').textContent = `${current.from} → ${current.to}`;
  $('chip-miles').textContent = `${current.miles} mi`;
  $('chip-gain').textContent = `+${fmt(current.gainFt)} ft`;
  renderDoneState();
  drawElevation(current.elevProfile);
  refreshPackUI();
  document.querySelector('#panel-body').scrollTop = 0;
}

function closeSection() {
  mode = 'list'; current = null;
  map.setStyle(overviewStyle());
  map.fitBounds([[-124.8, 32.4], [-116.6, 49.1]], { padding: 40, duration: 1000 });
  $('view-list').hidden = false;
  $('view-section').hidden = true;
}

function renderDoneState() {
  const done = current && progress[current.id];
  const btn = $('btn-complete');
  btn.classList.toggle('completed', !!done);
  btn.querySelector('span').textContent = done ? 'Completed' : 'Mark complete';
  $('chip-done').hidden = !done;
  if (done) $('chip-done-date').textContent = done.date;
  if (map.getLayer('track-line')) map.setPaintProperty('track-line', 'line-color', done ? '#10b981' : '#6366f1');
}

function renderStats() {
  const done = doneIds();
  const miles = done.reduce((a, id) => a + ((index || []).find((s) => s.id === id)?.miles || 0), 0);
  const pct = Math.round((miles / TOTAL_MILES) * 1000) / 10;
  $('stat-miles').textContent = fmt(miles);
  $('stat-pct').textContent = (pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(1)) + '%';
  $('stat-secs').textContent = `${done.length}/29`;
  $('hero-bar-fill').style.width = Math.max(pct, done.length ? 1.5 : 0) + '%';
}

function renderList() {
  if (!index) return;
  const wrap = $('section-list');
  wrap.innerHTML = '';
  let lastState = null;
  for (const s of index) {
    if (s.state !== lastState) {
      lastState = s.state;
      const h = document.createElement('div');
      h.className = 'state-head';
      h.textContent = STATE_LABEL[s.state];
      wrap.appendChild(h);
    }
    const row = document.createElement('div');
    row.className = 'sec-row' + (progress[s.id] ? ' done' : '');
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-label', `Section ${s.letter}: ${s.from} to ${s.to}, ${s.miles} miles`);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSection(s.id); } });
    row.innerHTML = `
      <div class="letter">${s.letter}</div>
      <div class="meta">
        <div class="name">${esc(s.from)} → ${esc(s.to)}</div>
        <div class="sub">${s.miles} mi · +${fmt(s.gainFt)} ft${progress[s.id] ? ' · ' + progress[s.id].date : ''}</div>
      </div>
      <div class="flags">
        ${PACKS[s.id] ? '<svg class="ic badge-pack" viewBox="0 0 24 24" aria-label="Offline pack available"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' : ''}
        ${progress[s.id] ? '<svg class="ic badge-done" viewBox="0 0 24 24" aria-label="Completed"><path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/></svg>' : ''}
      </div>`;
    row.addEventListener('click', () => openSection(s.id));
    wrap.appendChild(row);
  }
}

/* ---------------- elevation ---------------- */
function drawElevation(profile) {
  const cv = $('elev'), ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  if (!profile || profile.length < 2) return;
  const xs = profile.map((p) => p[0]), ys = profile.map((p) => p[1]);
  const xMax = Math.max(...xs), yMin = Math.min(...ys), yMax = Math.max(...ys);
  const px = (x) => 8 + (x / xMax) * (W - 16);
  const py = (y) => H - 14 - ((y - yMin) / Math.max(yMax - yMin, 1)) * (H - 30);
  ctx.beginPath();
  ctx.moveTo(px(xs[0]), H - 14);
  profile.forEach((p) => ctx.lineTo(px(p[0]), py(p[1])));
  ctx.lineTo(px(xs[xs.length - 1]), H - 14);
  ctx.closePath();
  ctx.fillStyle = 'rgba(99,102,241,0.10)';
  ctx.fill();
  ctx.beginPath();
  profile.forEach((p, i) => (i ? ctx.lineTo(px(p[0]), py(p[1])) : ctx.moveTo(px(p[0]), py(p[1]))));
  ctx.strokeStyle = '#6366f1'; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = '#7C6F5A';
  ctx.font = '700 11px "Roboto Mono", monospace';
  ctx.fillText(`${Math.round(yMax * 3.281).toLocaleString()} ft`, 8, 12);
  ctx.fillText(`${Math.round(yMin * 3.281).toLocaleString()} ft`, 8, H - 3);
  ctx.textAlign = 'right';
  ctx.fillText(`${Math.round(xMax)} mi`, W - 8, H - 3);
  ctx.textAlign = 'left';
}

/* ---------------- completion + animation ---------------- */
function toggleComplete() {
  if (!current) return;
  if (progress[current.id]) {
    if (!confirm('Un-mark this section as completed?')) return;
    delete progress[current.id];
    saveProgress(); renderDoneState();
    return;
  }
  const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  progress[current.id] = { date };
  saveProgress();
  animateCompletion();
}

function animateCompletion() {
  const coords = current.track.geometry.coordinates;
  const src = map.getSource('anim');
  if (!src) { renderDoneState(); return; }
  const b = current.bbox;
  map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 60, duration: 800 });
  const DURATION = 2400;
  const t0 = performance.now();
  function frame(t) {
    const raw = Math.min((t - t0) / DURATION, 1);
    const eased = 1 - Math.pow(1 - raw, 3);
    const n = Math.max(2, Math.floor(eased * coords.length));
    src.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords.slice(0, n) } });
    if (raw < 1) requestAnimationFrame(frame);
    else { renderDoneState(); }
  }
  requestAnimationFrame(frame);
}

/* ---------------- offline packs ---------------- */
async function hasPack(id) {
  if (!('caches' in window)) return false;
  const cache = await caches.open(PACK_CACHE);
  return !!(await cache.match(TILES.section(id)));
}

async function refreshPackUI() {
  if (!current) return;
  const id = current.id;
  const btn = $('btn-pack'), label = $('pack-label'), status = $('pack-status');
  $('pack-progress').hidden = true;
  if (!PACKS[id]) {
    btn.disabled = true;
    label.textContent = 'Offline map pack coming soon';
    status.innerHTML = '';
    return;
  }
  btn.disabled = false;
  if (await hasPack(id)) {
    label.textContent = 'Re-download offline map';
    status.innerHTML = '<span class="ok">Offline pack stored on this device ✓</span> — map works with no service';
  } else {
    label.textContent = `Download offline map (${(PACKS[id] / 1048576).toFixed(0)} MB)`;
    status.innerHTML = navigator.onLine
      ? 'Download on wifi before your trip'
      : '<span class="warn">⚠ Not downloaded — connect to wifi first</span>';
  }
}

async function downloadPack() {
  if (!current || !PACKS[current.id]) return;
  const id = current.id;
  const url = TILES.section(id);
  const btn = $('btn-pack'), bar = $('pack-progress'), fill = $('pack-progress-fill'), status = $('pack-status');
  btn.disabled = true; bar.hidden = false; fill.style.width = '0%';
  try {
    const res = await fetch(url, { cache: 'no-store', headers: { 'x-pack-download': '1' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const total = Number(res.headers.get('content-length')) || PACKS[id];
    const reader = res.body.getReader();
    const chunks = []; let got = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      fill.style.width = Math.min(100, (got / total) * 100).toFixed(1) + '%';
      status.textContent = `Downloading… ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(0)} MB`;
    }
    const blob = new Blob(chunks);
    const cache = await caches.open(PACK_CACHE);
    await cache.put(url, new Response(blob, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(blob.size) } }));
    fill.style.width = '100%';
    // reload style through the pack so the map immediately proves it works
    map.setStyle(sectionStyle(current, TILES.section(id)));
  } catch (err) {
    status.innerHTML = `<span class="warn">Download failed (${esc(err.message)}) — try again on wifi</span>`;
  }
  btn.disabled = false;
  setTimeout(() => { bar.hidden = true; refreshPackUI(); }, 600);
}

/* ---------------- sync ---------------- */
function openSync() {
  $('modal').hidden = false;
  $('sync-code').value = btoa(JSON.stringify(progress));
}
function importSync() {
  try {
    const val = JSON.parse(atob($('sync-code').value.trim()));
    if (typeof val !== 'object' || Array.isArray(val)) throw new Error();
    progress = val;
    saveProgress();
    $('modal').hidden = true;
    if (mode === 'section') renderDoneState();
  } catch {
    alert('That code did not parse — paste the exact code from your other device.');
  }
}

/* ---------------- ui wiring ---------------- */
function wireUI() {
  $('btn-back').addEventListener('click', closeSection);
  $('btn-complete').addEventListener('click', toggleComplete);
  $('btn-pack').addEventListener('click', downloadPack);
  $('btn-sync').addEventListener('click', openSync);
  $('btn-close-modal').addEventListener('click', () => { $('modal').hidden = true; });
  $('btn-copy-code').addEventListener('click', async () => {
    $('sync-code').value = btoa(JSON.stringify(progress));
    try { await navigator.clipboard.writeText($('sync-code').value); $('btn-copy-code').textContent = 'Copied ✓'; }
    catch { $('sync-code').select(); document.execCommand('copy'); }
    setTimeout(() => { $('btn-copy-code').textContent = 'Copy my code'; }, 1500);
  });
  $('btn-import-code').addEventListener('click', importSync);

  document.querySelectorAll('.legend input').forEach((el) =>
    el.addEventListener('change', () => { if (map.getLayer('wpts')) map.setFilter('wpts', kindFilter()); })
  );

  const panel = $('panel');
  $('sheet-handle').addEventListener('click', () => panel.classList.toggle('expanded'));

  window.addEventListener('online', updateOnline);
  window.addEventListener('offline', updateOnline);

  // install hint: only on iOS Safari, not already installed
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (isIOS && !standalone) $('install-hint').hidden = false;
}

function updateOnline() {
  $('offline-badge').hidden = navigator.onLine;
}
