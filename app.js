/* PCT Atlas : official-mile progress, offline maps, GPS. Vanilla JS + MapLibre + PMTiles. */
'use strict';

const BASE = new URL('.', location.href).href;
const TILES = {
  overview: BASE + 'tiles/overview.pmtiles',
  section: (id) => BASE + 'tiles/' + id + '.pmtiles',
};
// Sections with a published offline tile pack
const PACKS = { CA_K: 16393751 };
const PACK_CACHE = 'pct-packs-v1';
const STATE_LABEL = { CA: 'California', OR: 'Oregon', WA: 'Washington' };
const KIND_COLORS = { water: '#0EA5E9', camp: '#10b981', road: '#f59e0b', landmark: '#A0937B' };
const EPS = 0.05; // miles tolerance for coverage/merging
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Trail milestones (official PCT miles). Icons are Lucide path data.
const MILESTONES = [
  { mile: 100, title: 'First Hundred', sub: 'One hundred miles on foot.', icon: '<path d="M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0Z"/><path d="M20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z"/><path d="M16 17h4"/><path d="M4 13h4"/>' },
  { mile: 500, title: 'Five Hundred', sub: 'The trail is starting to add up.', icon: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>' },
  { mile: 1000, title: 'The Thousand', sub: 'Four digits, one step at a time.', icon: '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>' },
  { mile: 1325, title: 'Midpoint Marker', sub: 'Half the trail is behind you.', icon: '<path d="M12 13v8"/><path d="M12 3v3"/><path d="M4 6a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h13a2 2 0 0 0 1.152-.365l3.424-2.317a1 1 0 0 0 0-1.635l-3.424-2.318A2 2 0 0 0 17 6z"/>' },
  { mile: 1720.4, title: 'Oregon Line', sub: 'California, complete.', icon: '<path d="M12 13v8"/><path d="M12 3v3"/><path d="M18 6a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H5a2 2 0 0 1-1.152-.365l-3.424-2.317a1 1 0 0 1 0-1.635l3.424-2.318A2 2 0 0 1 5 6z" transform="translate(2 0)"/>' },
  { mile: 2000, title: 'Two Thousand', sub: 'The last 650 begin.', icon: '<path d="m8 3 4 8 5-5 5 15H2L8 3z"/>' },
  { mile: 2150.3, title: 'Washington Line', sub: 'One state to go.', icon: '<path d="M12 13v8"/><path d="M12 3v3"/><path d="M4 6a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h13a2 2 0 0 0 1.152-.365l3.424-2.317a1 1 0 0 0 0-1.635l-3.424-2.318A2 2 0 0 0 17 6z"/>' },
  { mile: 2655.8, title: 'Northern Terminus', sub: 'Mexico to Canada. Done.', icon: '<path d="M17 22V2L7 7l10 5"/>' },
];

let map, basemapLayers, index, overviewGeo, geoCtl, demSource;
let TOTAL = 2655.8;
let mode = 'list';
let current = null;
let progress = []; // merged intervals: [startMile, endMile, dateStr]
const sectionCache = {};
let displayed = { miles: 0, pct: 0, secs: 0 }; // for count-up animation

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString('en-US');
const fmt1 = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
function today() { return new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }

/* ================= intervals ================= */
function mergeIntervals(list) {
  const sorted = list.filter((iv) => iv[1] - iv[0] > 0.001).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1] + EPS) {
      last[1] = Math.max(last[1], iv[1]);
      last[2] = iv[2] || last[2];
    } else out.push([iv[0], iv[1], iv[2]]);
  }
  return out;
}
function addInterval(s, e, date) { progress = mergeIntervals([...progress, [s, e, date]]); }
function subtractInterval(s, e) {
  const out = [];
  for (const [a, b, d] of progress) {
    if (b <= s || a >= e) { out.push([a, b, d]); continue; }
    if (a < s - 0.001) out.push([a, s, d]);
    if (b > e + 0.001) out.push([e, b, d]);
  }
  progress = out;
}
function coveredBetween(s, e) {
  let sum = 0;
  for (const [a, b] of progress) sum += Math.max(0, Math.min(b, e) - Math.max(a, s));
  return sum;
}
function totalCovered() { return coveredBetween(0, TOTAL); }
function sectionCoverage(meta) {
  const span = meta.mileEnd - meta.mileStart;
  const covered = coveredBetween(meta.mileStart, meta.mileEnd);
  return { covered, span, frac: covered / span, done: covered >= span - EPS };
}
function sectionDate(meta) {
  let d = '';
  for (const [a, b, dt] of progress) if (a < meta.mileEnd && b > meta.mileStart && dt) d = dt;
  return d;
}
function gapsIn(meta) {
  const gaps = [];
  let cursor = meta.mileStart;
  for (const [a, b] of progress) {
    if (b <= meta.mileStart || a >= meta.mileEnd) continue;
    if (a > cursor + EPS) gaps.push([cursor, Math.min(a, meta.mileEnd)]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < meta.mileEnd - EPS) gaps.push([cursor, meta.mileEnd]);
  return gaps;
}

/* ================= persistence + migration ================= */
function validIntervals(list) {
  return list.filter((iv) => Array.isArray(iv) && Number.isFinite(iv[0]) && Number.isFinite(iv[1]));
}
// v1 map ({SECTION_ID:{date}}) -> intervals; returns null when nothing usable migrated
function migrateV1Map(v1) {
  if (!v1 || typeof v1 !== 'object' || Array.isArray(v1)) return null;
  // a v2 payload parked in the v1 slot by an old client's importSync : recover it
  if (v1.v === 2 && Array.isArray(v1.intervals)) return validIntervals(v1.intervals);
  if (v1.__v2 && Array.isArray(v1.__v2.intervals)) return validIntervals(v1.__v2.intervals);
  const keys = Object.keys(v1);
  const ivs = [];
  for (const [id, val] of Object.entries(v1)) {
    const meta = index.find((s) => s.id === id);
    if (meta && Number.isFinite(meta.mileStart) && Number.isFinite(meta.mileEnd)) {
      ivs.push([meta.mileStart, meta.mileEnd, (val && val.date) || '']);
    }
  }
  // had entries but none resolved (stale index without mile data) -> signal failure, do not wipe
  if (keys.length && !ivs.length) return null;
  return ivs;
}
function loadProgress() {
  try {
    const v2 = JSON.parse(localStorage.getItem('pct-progress-v2'));
    if (v2 && v2.v === 2 && Array.isArray(v2.intervals)) {
      progress = mergeIntervals(validIntervals(v2.intervals));
      return;
    }
  } catch { }
  try {
    const ivs = migrateV1Map(JSON.parse(localStorage.getItem('pct-progress-v1')));
    if (ivs) {
      progress = mergeIntervals(ivs);
      if (ivs.length) saveProgress(true); // keep pct-progress-v1 in place as rollback
    }
  } catch { }
}
function saveProgress(silent) {
  localStorage.setItem('pct-progress-v2', JSON.stringify({ v: 2, intervals: progress }));
  if (!silent) { renderStats(true); renderList(); refreshOverviewProgress(); }
}

/* ================= geometry: slice a mile-annotated line ================= */
// coords: [[lon,lat],...], mi: parallel non-decreasing miles. Returns coords slice for [s,e] or null.
function sliceLineByMiles(coords, mi, s, e) {
  if (!mi || mi.length !== coords.length) return null;
  const lo = Math.max(s, mi[0]), hi = Math.min(e, mi[mi.length - 1]);
  if (hi - lo <= 0.001) return null;
  const out = [];
  const interp = (i, m) => {
    const m0 = mi[i], m1 = mi[i + 1];
    if (m1 - m0 < 1e-9) return coords[i];
    const t = (m - m0) / (m1 - m0);
    return [coords[i][0] + t * (coords[i + 1][0] - coords[i][0]), coords[i][1] + t * (coords[i + 1][1] - coords[i][1])];
  };
  for (let i = 0; i < coords.length; i++) {
    const m = mi[i];
    if (m < lo) {
      if (i + 1 < coords.length && mi[i + 1] > lo) out.push(interp(i, lo));
    } else if (m <= hi) {
      if (out.length === 0 && i > 0 && m > lo) out.push(interp(i - 1, lo));
      out.push(coords[i]);
    } else {
      if (out.length && mi[i - 1] < hi) out.push(interp(i - 1, hi));
      break;
    }
  }
  return out.length >= 2 ? out : null;
}
function pointAtMile(coords, mi, m) {
  const sl = sliceLineByMiles(coords, mi, Math.max(mi[0], m - 0.01), Math.min(mi[mi.length - 1], m + 0.01));
  return sl ? sl[0] : null;
}

function doneSlicesGeo() {
  const lines = [], ends = [];
  if (!overviewGeo) return { lines: { type: 'FeatureCollection', features: lines }, ends: { type: 'FeatureCollection', features: ends } };
  for (const f of overviewGeo.features) {
    const mi = f.properties.mi, coords = f.geometry.coordinates;
    for (const [a, b] of progress) {
      const sl = sliceLineByMiles(coords, mi, a, b);
      if (sl) lines.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: sl }, properties: {} });
    }
  }
  for (const [a, b] of progress) {
    for (const m of [a, b]) {
      if (m <= 0.1 || m >= TOTAL - 0.1) continue;
      const f = overviewGeo.features.find((ft) => {
        const mi = ft.properties.mi;
        return mi && mi[0] <= m && mi[mi.length - 1] >= m;
      });
      if (f) {
        const pt = pointAtMile(f.geometry.coordinates, f.properties.mi, m);
        if (pt) ends.push({ type: 'Feature', geometry: { type: 'Point', coordinates: pt }, properties: {} });
      }
    }
  }
  return { lines: { type: 'FeatureCollection', features: lines }, ends: { type: 'FeatureCollection', features: ends } };
}

/* ================= boot ================= */
(async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    // when a new SW takes over a live page (data shape may have changed), reload once so code+data stay paired
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloaded) { reloaded = true; location.reload(); }
    });
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  const [layersRes, indexRes, overviewRes] = await Promise.all([
    fetch('assets/basemap-layers.json'), fetch('data/sections-index.json'), fetch('data/pct-overview.json'),
  ]);
  basemapLayers = await layersRes.json();
  const idx = await indexRes.json();
  index = idx.sections || idx; // tolerate old cached shape
  if (idx.totalMiles) TOTAL = idx.totalMiles;
  overviewGeo = await overviewRes.json();

  loadProgress();

  const protocol = new pmtiles.Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);

  // terrain: hillshade + contours from open elevation tiles (online enhancement;
  // offline the vector base still renders without it)
  try {
    if (window.mlcontour) {
      demSource = new mlcontour.DemSource({
        url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
        encoding: 'terrarium',
        maxzoom: 13,
        worker: true,
      });
      demSource.setupMaplibre(maplibregl);
    }
  } catch { demSource = null; }

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
  geoCtl = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showUserHeading: true,
  });
  map.addControl(geoCtl, 'top-right');
  geoCtl.on('geolocate', (e) => { if (navState.active) onFix(e.coords); });
  geoCtl.on('error', () => {
    if (navState.active) $('nav-status').textContent = 'Location unavailable. Check Location Services for your browser.';
  });
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
      .setHTML(`<div class="wpt-kind">${p.kind}${p.mile ? ' · mile ' + p.mile : ''}</div><strong>${esc(p.name)}</strong>${p.desc ? '<br>' + esc(p.desc) : ''}`)
      .addTo(map);
  });
  map.on('mouseenter', 'wpts', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'wpts', () => { map.getCanvas().style.cursor = ''; });

  buildHeroTicks();
  renderStats(false);
  renderList();
  wireUI();
  updateOnline();
})();

/* ================= map styles ================= */
function styleBase(archiveUrl) {
  const s = {
    version: 8,
    glyphs: BASE + 'assets/fonts/{fontstack}/{range}.pbf',
    sprite: BASE + 'assets/sprites/light',
    sources: {
      basemap: {
        type: 'vector',
        url: 'pmtiles://' + archiveUrl,
        attribution: '<a href="https://openstreetmap.org">© OpenStreetMap</a> <a href="https://protomaps.com">Protomaps</a> · Terrain: Mapzen · Trail: PCTA',
      },
    },
    layers: basemapLayers.slice(),
  };
  if (demSource) {
    s.sources['dem'] = {
      type: 'raster-dem', encoding: 'terrarium',
      tiles: [demSource.sharedDemProtocolUrl], maxzoom: 13, tileSize: 256,
    };
    s.sources['contours'] = {
      type: 'vector',
      tiles: [demSource.contourProtocolUrl({
        multiplier: 3.28084, // label elevations in feet
        thresholds: { 11: [200, 1000], 12: [100, 500], 13: [100, 500], 14: [50, 250] },
        elevationKey: 'ele', levelKey: 'level', contourLayer: 'contours',
      })],
      maxzoom: 15,
    };
    const terrainLayers = [
      { id: 'hillshade', type: 'hillshade', source: 'dem',
        paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#8A7C63', 'hillshade-highlight-color': '#FFFFFF', 'hillshade-accent-color': '#B9A98C' } },
      { id: 'contour-lines', type: 'line', source: 'contours', 'source-layer': 'contours', minzoom: 11,
        paint: {
          'line-color': '#A99878',
          'line-opacity': ['match', ['get', 'level'], 1, 0.5, 0.28],
          'line-width': ['match', ['get', 'level'], 1, 1.1, 0.6],
        } },
      { id: 'contour-labels', type: 'symbol', source: 'contours', 'source-layer': 'contours', minzoom: 12,
        filter: ['>', ['get', 'level'], 0],
        layout: {
          'symbol-placement': 'line',
          'text-field': ['concat', ['number-format', ['get', 'ele'], { 'max-fraction-digits': 0 }], ' ft'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 10,
        },
        paint: { 'text-color': '#8A7C63', 'text-halo-color': '#F7F3EE', 'text-halo-width': 1.4 } },
    ];
    // sit beneath water and everything built on top of it
    const at = s.layers.findIndex((l) => l.id === 'water');
    s.layers.splice(at > 0 ? at : s.layers.length, 0, ...terrainLayers);
  }
  return s;
}

function overviewStyle() {
  const s = styleBase(TILES.overview);
  const done = doneSlicesGeo();
  s.sources['trail'] = { type: 'geojson', data: overviewGeo };
  s.sources['trail-done-src'] = { type: 'geojson', data: done.lines };
  s.sources['trail-ends-src'] = { type: 'geojson', data: done.ends };
  const lineDefaults = { 'line-cap': 'round', 'line-join': 'round' };
  s.layers.push(
    { id: 'trail-ghost', type: 'line', source: 'trail', layout: lineDefaults,
      paint: { 'line-color': '#A0937B', 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.6, 10, 3.2], 'line-opacity': 0.55 } },
    { id: 'trail-done-glow', type: 'line', source: 'trail-done-src', layout: lineDefaults,
      paint: { 'line-color': '#6366f1', 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 6, 10, 10], 'line-opacity': 0.18, 'line-blur': 1 } },
    { id: 'trail-done-casing', type: 'line', source: 'trail-done-src', layout: lineDefaults,
      paint: { 'line-color': '#F7F3EE', 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 4, 10, 6.5], 'line-opacity': 0.9 } },
    { id: 'trail-done', type: 'line', source: 'trail-done-src', layout: lineDefaults,
      paint: { 'line-color': '#6366f1', 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 2.4, 10, 4.2] } },
    { id: 'trail-done-ends', type: 'circle', source: 'trail-ends-src',
      paint: { 'circle-radius': 4, 'circle-color': '#6366f1', 'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff' } },
    { id: 'trail-hit', type: 'line', source: 'trail',
      paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 18 } },
  );
  return s;
}

// point features at every whole trail mile along a section track
function mileMarkerPoints(sec) {
  const coords = sec.track.geometry.coordinates, mi = sec.track.properties.mi;
  const feats = [];
  if (!mi) return { type: 'FeatureCollection', features: feats };
  let target = Math.ceil(sec.mileStart);
  for (let i = 0; i < mi.length && target <= sec.mileEnd; i++) {
    if (mi[i] >= target) {
      feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: coords[i] }, properties: { m: target, m5: target % 5 === 0 } });
      target += 1;
    }
  }
  return { type: 'FeatureCollection', features: feats };
}

function sectionStyle(sec, archiveUrl) {
  const s = styleBase(archiveUrl);
  const mi = sec.track.properties.mi;
  const doneSlices = [];
  if (mi) for (const [a, b] of progress) {
    const sl = sliceLineByMiles(sec.track.geometry.coordinates, mi, a, b);
    if (sl) doneSlices.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: sl }, properties: {} });
  }
  s.sources['track'] = { type: 'geojson', data: sec.track };
  s.sources['track-done'] = { type: 'geojson', data: { type: 'FeatureCollection', features: doneSlices } };
  s.sources['anim'] = { type: 'geojson', data: { type: 'FeatureCollection', features: [] } };
  s.sources['wpts'] = { type: 'geojson', data: sec.waypoints };
  s.sources['miles'] = { type: 'geojson', data: mileMarkerPoints(sec) };
  const lineDefaults = { 'line-cap': 'round', 'line-join': 'round' };
  s.layers.push(
    { id: 'track-casing', type: 'line', source: 'track', layout: lineDefaults,
      paint: { 'line-color': '#FFFFFF', 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 5.5, 14, 8.5], 'line-opacity': 0.85 } },
    { id: 'track-line', type: 'line', source: 'track', layout: lineDefaults,
      paint: { 'line-color': '#6366f1', 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 3, 14, 5] } },
    { id: 'track-done', type: 'line', source: 'track-done', layout: lineDefaults,
      paint: { 'line-color': '#10b981', 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 3.5, 14, 5.5] } },
    { id: 'anim-line', type: 'line', source: 'anim', layout: lineDefaults,
      paint: { 'line-color': '#10b981', 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 4.5, 14, 6.5] } },
    { id: 'wpts', type: 'circle', source: 'wpts', filter: kindFilter(),
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3, 13, 6],
        'circle-color': ['match', ['get', 'kind'], 'water', KIND_COLORS.water, 'camp', KIND_COLORS.camp, 'road', KIND_COLORS.road, KIND_COLORS.landmark],
        'circle-stroke-width': 1.5, 'circle-stroke-color': '#FFFFFF',
      } },
    { id: 'mile-dots-5', type: 'circle', source: 'miles', minzoom: 10, filter: ['get', 'm5'],
      paint: { 'circle-radius': 2.5, 'circle-color': '#7C6F5A', 'circle-stroke-width': 1, 'circle-stroke-color': '#F7F3EE' } },
    { id: 'mile-dots-1', type: 'circle', source: 'miles', minzoom: 12, filter: ['!', ['get', 'm5']],
      paint: { 'circle-radius': 2.5, 'circle-color': '#7C6F5A', 'circle-stroke-width': 1, 'circle-stroke-color': '#F7F3EE' } },
    { id: 'mile-markers-5', type: 'symbol', source: 'miles', minzoom: 10, filter: ['get', 'm5'],
      layout: {
        'text-field': ['to-string', ['get', 'm']],
        'text-font': ['Noto Sans Medium'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10, 14, 12],
        'text-offset': [0, -0.9],
        'text-optional': true,
      },
      paint: { 'text-color': '#7C6F5A', 'text-halo-color': '#F7F3EE', 'text-halo-width': 1.6 } },
    { id: 'mile-markers-1', type: 'symbol', source: 'miles', minzoom: 12, filter: ['!', ['get', 'm5']],
      layout: {
        'text-field': ['to-string', ['get', 'm']],
        'text-font': ['Noto Sans Medium'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10, 14, 12],
        'text-offset': [0, -0.9],
        'text-optional': true,
      },
      paint: { 'text-color': '#7C6F5A', 'text-halo-color': '#F7F3EE', 'text-halo-width': 1.6 } },
  );
  return s;
}

function kindFilter() {
  const on = [...document.querySelectorAll('.legend input:checked')].map((el) => el.dataset.kind);
  return ['in', ['get', 'kind'], ['literal', on]];
}

function refreshOverviewProgress() {
  if (mode !== 'list' || !map || !map.getSource('trail-done-src')) return;
  const done = doneSlicesGeo();
  map.getSource('trail-done-src').setData(done.lines);
  map.getSource('trail-ends-src').setData(done.ends);
}
function refreshSectionDone() {
  if (mode !== 'section' || !current || !map.getSource('track-done')) return;
  const mi = current.track.properties.mi;
  const feats = [];
  if (mi) for (const [a, b] of progress) {
    const sl = sliceLineByMiles(current.track.geometry.coordinates, mi, a, b);
    if (sl) feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: sl }, properties: {} });
  }
  map.getSource('track-done').setData({ type: 'FeatureCollection', features: feats });
}

/* ================= views ================= */
async function openSection(id) {
  const meta = index.find((s) => s.id === id);
  if (!meta) return;
  if (!sectionCache[id]) {
    try {
      let sec = await (await fetch('data/sections/' + id + '.json')).json();
      const stale = !Number.isFinite(sec.mileStart) || !(sec.track && sec.track.properties && sec.track.properties.mi);
      if (stale) {
        try { sec = await (await fetch('data/sections/' + id + '.json', { cache: 'reload' })).json(); } catch { }
      }
      // last-resort fallback: take mile bounds from the index so nothing downstream sees NaN
      if (!Number.isFinite(sec.mileStart)) sec.mileStart = meta.mileStart;
      if (!Number.isFinite(sec.mileEnd)) sec.mileEnd = meta.mileEnd;
      if (!Number.isFinite(sec.mileStart) || !Number.isFinite(sec.mileEnd)) return;
      sectionCache[id] = sec;
    } catch { return; }
  }
  current = sectionCache[id];
  mode = 'section';

  const archive = PACKS[id] ? TILES.section(id) : TILES.overview;
  map.setStyle(sectionStyle(current, archive));
  const b = current.bbox;
  map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 40, duration: 1200 });

  $('view-list').hidden = true;
  $('view-nav').hidden = true;
  $('view-section').hidden = false;
  $('btn-nav').hidden = !current.track.properties.mi;
  $('sec-eyebrow').textContent = `${STATE_LABEL[current.state]} · Section ${current.letter}`;
  $('sec-title').textContent = `${current.from} → ${current.to}`;
  $('chip-miles').textContent = `${fmt1(current.miles)} mi`;
  $('chip-gain').textContent = `+${fmt(current.gainFt)} ft`;
  $('chip-span').textContent = `mile ${fmt1(current.mileStart)} → ${fmt1(current.mileEnd)}`;
  closeLogger();
  renderSectionState();
  refreshPackUI();
  document.querySelector('#panel-body').scrollTop = 0;
}

function closeSection() {
  if (navState.active) exitNav();
  mode = 'list'; current = null;
  closeLogger();
  map.setStyle(overviewStyle());
  map.fitBounds([[-124.8, 32.4], [-116.6, 49.1]], { padding: 40, duration: 1000 });
  $('view-list').hidden = false;
  $('view-section').hidden = true;
}

function renderSectionState() {
  if (!current) return;
  const cov = sectionCoverage(current);
  $('chip-done').hidden = !cov.done;
  if (cov.done) $('chip-done-date').textContent = sectionDate(current) || 'complete';
  $('chip-progress').hidden = !(cov.covered > EPS && !cov.done);
  if (!$('chip-progress').hidden) $('chip-progress').textContent = `${fmt1(cov.covered)} / ${fmt1(cov.span)} mi`;
  $('btn-log').hidden = cov.done;
  $('btn-clear').hidden = cov.covered <= EPS;
  drawElevation();
  refreshSectionDone();
}

function renderStats(animate) {
  const miles = totalCovered();
  const pct = (miles / TOTAL) * 100;
  const secs = index ? index.filter((s) => sectionCoverage(s).done).length : 0;
  const target = { miles, pct, secs };
  if (!animate || REDUCED_MOTION) {
    displayed = target;
    applyStats(target);
  } else {
    const from = { ...displayed };
    const t0 = performance.now();
    (function frame(t) {
      const raw = Math.min((t - t0) / 700, 1);
      const k = 1 - Math.pow(1 - raw, 3);
      applyStats({
        miles: from.miles + (target.miles - from.miles) * k,
        pct: from.pct + (target.pct - from.pct) * k,
        secs: raw === 1 ? target.secs : from.secs,
      });
      if (raw < 1) requestAnimationFrame(frame);
      else displayed = target;
    })(t0);
  }
  $('hero-bar-fill').style.width = Math.max(pct, miles > 0 ? 1.2 : 0) + '%';
  document.querySelectorAll('.hero-tick').forEach((el) => {
    el.classList.toggle('passed', miles >= Number(el.dataset.mile));
  });
  const next = MILESTONES.find((m) => m.mile > miles + EPS);
  $('hero-next').textContent = next
    ? `Next: ${next.title} in ${fmt1(next.mile - miles)} mi`
    : 'Trail complete';
}
function applyStats(v) {
  $('stat-miles').textContent = fmt1(v.miles);
  $('stat-pct').textContent = v.pct.toFixed(1) + '%';
  $('stat-secs').textContent = `${v.secs}/29`;
}
function buildHeroTicks() {
  const wrap = $('hero-ticks');
  wrap.innerHTML = '';
  for (const m of MILESTONES) {
    if (m.mile >= TOTAL - 1) continue;
    const t = document.createElement('div');
    t.className = 'hero-tick';
    t.dataset.mile = m.mile;
    t.style.left = (m.mile / TOTAL * 100) + '%';
    t.title = `MILE ${m.mile} · ${m.title}`;
    wrap.appendChild(t);
  }
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
      h.id = 'state-head-' + s.state;
      h.textContent = STATE_LABEL[s.state];
      wrap.appendChild(h);
    }
    const cov = sectionCoverage(s);
    const row = document.createElement('div');
    row.className = 'sec-row' + (cov.done ? ' done' : cov.covered > EPS ? ' partial' : '');
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-label', `Section ${s.letter}: ${s.from} to ${s.to}, ${s.miles} miles`);
    const sub = cov.done
      ? `${fmt1(s.miles)} mi · +${fmt(s.gainFt)} ft${sectionDate(s) ? ' · ' + sectionDate(s) : ''}`
      : cov.covered > EPS
        ? `${fmt1(s.miles)} mi · ${fmt1(cov.covered)} mi logged`
        : `${fmt1(s.miles)} mi · +${fmt(s.gainFt)} ft`;
    row.innerHTML = `
      <div class="letter">${s.letter}</div>
      <div class="meta">
        <div class="name">${esc(s.from)} → ${esc(s.to)}</div>
        <div class="sub">${sub}</div>
      </div>
      <div class="flags">
        ${PACKS[s.id] ? '<svg class="ic badge-pack" viewBox="0 0 24 24" aria-label="Offline pack available"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' : ''}
        ${cov.done ? '<svg class="ic badge-done" viewBox="0 0 24 24" aria-label="Completed"><path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/></svg>' : ''}
      </div>`;
    row.addEventListener('click', () => openSection(s.id));
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSection(s.id); } });
    wrap.appendChild(row);
  }
}

/* ================= elevation (with covered + selection shading) ================= */
function drawElevation() {
  const cv = $('elev'), ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  const profile = current && current.elevProfile;
  if (!profile || profile.length < 2) return;
  const x0 = current.mileStart, x1 = current.mileEnd;
  const ys = profile.map((p) => p[1]);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const px = (m) => 8 + ((m - x0) / (x1 - x0)) * (W - 16);
  const py = (y) => H - 14 - ((y - yMin) / Math.max(yMax - yMin, 1)) * (H - 30);

  const shadeRange = (a, b, fill) => {
    const lo = Math.max(a, x0), hi = Math.min(b, x1);
    if (hi <= lo) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(px(lo), 0, px(hi) - px(lo), H);
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(px(profile[0][0]), H - 14);
    profile.forEach((p) => ctx.lineTo(px(p[0]), py(p[1])));
    ctx.lineTo(px(profile[profile.length - 1][0]), H - 14);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.restore();
  };

  // base indigo wash
  shadeRange(x0, x1, 'rgba(99,102,241,0.10)');
  // covered = green
  for (const [a, b] of progress) shadeRange(a, b, 'rgba(16,185,129,0.20)');
  // live logger selection = indigo
  if (!$('logger').hidden) shadeRange(logSel.a, logSel.b, 'rgba(99,102,241,0.16)');

  ctx.beginPath();
  profile.forEach((p, i) => (i ? ctx.lineTo(px(p[0]), py(p[1])) : ctx.moveTo(px(p[0]), py(p[1]))));
  ctx.strokeStyle = '#6366f1'; ctx.lineWidth = 2; ctx.stroke();

  if (!$('logger').hidden) {
    for (const m of [logSel.a, logSel.b]) {
      ctx.beginPath();
      ctx.moveTo(px(m), 4); ctx.lineTo(px(m), H - 14);
      ctx.strokeStyle = '#6366f1'; ctx.lineWidth = 1.5; ctx.stroke();
    }
  }

  ctx.fillStyle = '#7C6F5A';
  ctx.font = '700 11px "Roboto Mono", monospace';
  ctx.fillText(`${fmt(Math.round(yMax * 3.281))} ft`, 8, 12);
  ctx.fillText(`${fmt(Math.round(yMin * 3.281))} ft`, 8, H - 3);
  ctx.textAlign = 'right';
  ctx.fillText(`mile ${fmt1(x1)}`, W - 8, H - 3);
  ctx.textAlign = 'left';
}

/* ================= stretch logger ================= */
const logSel = { a: 0, b: 0 };
let snapPoints = []; // {mile, name}

function landmarksFor(sec) {
  const feats = sec.waypoints ? sec.waypoints.features : [];
  const named = feats
    .filter((f) => {
      const p = f.properties;
      if (!(p.kind === 'landmark' || p.kind === 'road') || !p.mile || !p.name) return false;
      const name = p.name.trim();
      // real place names only: needs letters, not a numeric/mile code like "0041-5" or "1093"
      return /[A-Za-z]{3,}/.test(name) && !/^\d/.test(name);
    })
    .map((f) => ({ mile: f.properties.mile, name: f.properties.name.trim() }))
    .sort((a, b) => a.mile - b.mile);
  // thin to one per 0.3 mi so ticks stay readable
  const out = [];
  for (const p of named) {
    if (!out.length || p.mile - out[out.length - 1].mile > 0.3) out.push(p);
  }
  return out;
}

function openLogger() {
  if (!current) return;
  const gaps = gapsIn(current);
  const target = gaps.length ? gaps.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a)) : [current.mileStart, current.mileEnd];
  logSel.a = target[0]; logSel.b = target[1];
  snapPoints = landmarksFor(current);
  buildLoggerStatic();
  $('logger').hidden = false;
  $('btn-log').hidden = true;
  if (window.matchMedia('(max-width: 760px)').matches) $('panel').classList.add('expanded');
  renderLogger();
  drawElevation();
}
function closeLogger() {
  $('logger').hidden = true;
  if (current) {
    const cov = sectionCoverage(current);
    $('btn-log').hidden = cov.done;
  }
  drawElevation();
}
function buildLoggerStatic() {
  // done spans + landmark ticks
  const spanWrap = $('range-done-spans');
  spanWrap.innerHTML = '';
  const toPct = (m) => ((m - current.mileStart) / (current.mileEnd - current.mileStart)) * 100;
  for (const [a, b] of progress) {
    const lo = Math.max(a, current.mileStart), hi = Math.min(b, current.mileEnd);
    if (hi <= lo) continue;
    const el = document.createElement('div');
    el.className = 'range-done';
    el.style.left = toPct(lo) + '%';
    el.style.width = (toPct(hi) - toPct(lo)) + '%';
    spanWrap.appendChild(el);
  }
  const ticks = $('range-ticks');
  ticks.innerHTML = '';
  for (const p of snapPoints) {
    const t = document.createElement('i');
    t.className = 'range-tick';
    t.style.left = toPct(p.mile) + '%';
    ticks.appendChild(t);
  }
}
function snapName(m) {
  const hit = snapPoints.find((p) => Math.abs(p.mile - m) < 0.01);
  return hit ? hit.name : null;
}
function renderLogger() {
  const span = current.mileEnd - current.mileStart;
  const toPct = (m) => ((m - current.mileStart) / span) * 100;
  $('handle-a').style.left = toPct(logSel.a) + '%';
  $('handle-b').style.left = toPct(logSel.b) + '%';
  $('range-fill').style.left = toPct(logSel.a) + '%';
  $('range-fill').style.width = (toPct(logSel.b) - toPct(logSel.a)) + '%';
  $('readout-a').textContent = snapName(logSel.a) || fmt1(logSel.a);
  $('readout-b').textContent = snapName(logSel.b) || fmt1(logSel.b);
  $('log-from').textContent = snapName(logSel.a) || `Mile ${fmt1(logSel.a)}`;
  $('log-to').textContent = snapName(logSel.b) || `Mile ${fmt1(logSel.b)}`;
  const dist = logSel.b - logSel.a;
  $('log-dist').textContent = fmt1(dist) + ' mi';
  const whole = Math.abs(logSel.a - current.mileStart) < EPS && Math.abs(logSel.b - current.mileEnd) < EPS;
  $('log-confirm-label').textContent = whole ? `Log all ${fmt1(dist)} miles` : `Log ${fmt1(dist)} miles`;
  for (const h of ['handle-a', 'handle-b']) {
    const el = $(h), m = h === 'handle-a' ? logSel.a : logSel.b;
    el.setAttribute('aria-valuemin', current.mileStart);
    el.setAttribute('aria-valuemax', current.mileEnd);
    el.setAttribute('aria-valuenow', m.toFixed(1));
    el.setAttribute('aria-valuetext', `Mile ${fmt1(m)}${snapName(m) ? ', ' + snapName(m) : ''}`);
  }
  drawElevation();
}
function setHandle(which, mile, snap) {
  let m = Math.max(current.mileStart, Math.min(current.mileEnd, mile));
  if (snap) {
    let best = null, bd = 0.35;
    for (const p of snapPoints) {
      const d = Math.abs(p.mile - m);
      if (d < bd) { bd = d; best = p; }
    }
    if (best) {
      if (navigator.vibrate && Math.abs(best.mile - (which === 'a' ? logSel.a : logSel.b)) > 0.01) navigator.vibrate(8);
      m = best.mile;
    }
  }
  m = Math.round(m * 10) / 10;
  if (which === 'a') logSel.a = Math.min(m, logSel.b - 0.1);
  else logSel.b = Math.max(m, logSel.a + 0.1);
  renderLogger();
}
function wireLogger() {
  const range = $('range');
  const mileFromEvent = (ev) => {
    const r = range.getBoundingClientRect();
    const x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
    return current.mileStart + Math.max(0, Math.min(1, x / r.width)) * (current.mileEnd - current.mileStart);
  };
  for (const which of ['a', 'b']) {
    const el = $('handle-' + which);
    el.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      el.setPointerCapture(ev.pointerId);
      const move = (e2) => { e2.preventDefault(); setHandle(which, mileFromEvent(e2), true); };
      const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
    el.addEventListener('keydown', (ev) => {
      const step = ev.shiftKey ? 1.0 : 0.1;
      const cur = which === 'a' ? logSel.a : logSel.b;
      if (ev.key === 'ArrowLeft') { ev.preventDefault(); setHandle(which, cur - step, false); }
      if (ev.key === 'ArrowRight') { ev.preventDefault(); setHandle(which, cur + step, false); }
      if (ev.key === 'Home') { ev.preventDefault(); setHandle(which, current.mileStart, false); }
      if (ev.key === 'End') { ev.preventDefault(); setHandle(which, current.mileEnd, false); }
    });
  }
  $('btn-log-confirm').addEventListener('click', confirmLog);
  $('btn-log-cancel').addEventListener('click', closeLogger);
}

function confirmLog() {
  if (!current || $('logger').hidden) return;
  const beforeMiles = totalCovered();
  const wasDone = sectionCoverage(current).done;
  addInterval(logSel.a, logSel.b, today());
  saveProgress();
  const afterMiles = totalCovered();
  const nowDone = sectionCoverage(current).done;

  celebrate($('btn-log-confirm'));
  animateStretch(logSel.a, logSel.b);
  renderSectionState();
  closeLogger();

  // toasts: milestones crossed, then section completion
  const toasts = [];
  for (const m of MILESTONES) {
    if (beforeMiles < m.mile && afterMiles >= m.mile) {
      toasts.push({ kind: 'milestone', eyebrow: `Milestone · Mile ${m.mile >= TOTAL - 1 ? fmt(Math.round(m.mile)) : fmt(m.mile)}`, title: m.title, sub: m.sub, icon: m.icon });
    }
  }
  if (!wasDone && nowDone) {
    toasts.push({
      kind: 'section',
      eyebrow: 'Section complete',
      title: `${current.from} to ${current.to}`,
      sub: `${fmt1(current.miles)} miles. Section ${current.letter} is yours.`,
      icon: '<path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/>',
    });
  }
  queueToasts(toasts);
}

function clearSection() {
  if (!current) return;
  if (!confirm(`Clear all logged miles in Section ${current.letter}? Stretches that cross into neighboring sections are trimmed to this section.`)) return;
  subtractInterval(current.mileStart, current.mileEnd);
  saveProgress();
  renderSectionState();
  closeLogger();
}

/* ================= navigate mode ================= */
const navState = { active: false, dir: 1, gotFix: false, watchdog: null };

// nearest point on the section track: returns trail mile + distance off-trail in meters
function projectToTrack(lon, lat) {
  const coords = current.track.geometry.coordinates, mi = current.track.properties.mi;
  if (!mi) return null;
  let best = Infinity, bI = 0, bT = 0;
  const cosLat = Math.cos(lat * Math.PI / 180);
  for (let i = 0; i < coords.length - 1; i++) {
    const ax = (coords[i][0] - lon) * cosLat, ay = coords[i][1] - lat;
    const bx = (coords[i + 1][0] - lon) * cosLat, by = coords[i + 1][1] - lat;
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
    const cx = ax + t * dx, cy = ay + t * dy;
    const d2 = cx * cx + cy * cy;
    if (d2 < best) { best = d2; bI = i; bT = t; }
  }
  return { mile: mi[bI] + bT * (mi[bI + 1] - mi[bI]), offMeters: Math.sqrt(best) * 111320 };
}

// readable label for a waypoint (Halfmile names are often codes like WR1104)
function wptLabel(p) {
  const name = (p.name || '').trim();
  if (/^[A-Z]{1,4}\d/.test(name) && p.desc) return p.desc.slice(0, 34);
  return name || (p.desc || '').slice(0, 34) || 'Unnamed';
}

function nextAhead(kind, mile) {
  let best = null, bd = Infinity;
  for (const f of current.waypoints.features) {
    const p = f.properties;
    if (p.kind !== kind || !p.mile) continue;
    const d = (p.mile - mile) * navState.dir;
    if (d > 0.02 && d < bd) { bd = d; best = p; }
  }
  return best ? { label: wptLabel(best), dist: bd } : null;
}

function fmtDist(mi) { return mi >= 0.19 ? fmt1(mi) + ' mi' : Math.round(mi * 5280 / 10) * 10 + ' ft'; }

function onFix(c) {
  if (!current) return;
  navState.lastFix = c;
  const proj = projectToTrack(c.longitude, c.latitude);
  if (!proj) return;
  if (!navState.gotFix) {
    navState.gotFix = true;
    if (map.getZoom() < 12.5) map.easeTo({ center: [c.longitude, c.latitude], zoom: 13.5, duration: 800 });
  }
  $('nav-mile').textContent = fmt1(proj.mile);
  const off = proj.offMeters;
  $('nav-offtrail').hidden = off <= 90;
  if (off > 90) $('nav-offtrail-text').textContent = fmtDist(off / 1609.344) + ' from the trail';

  const water = nextAhead('water', proj.mile);
  $('nav-water-name').textContent = water ? water.label : 'None ahead in section';
  $('nav-water-dist').textContent = water ? fmtDist(water.dist) : '·';
  const camp = nextAhead('camp', proj.mile);
  $('nav-camp-name').textContent = camp ? camp.label : 'None ahead in section';
  $('nav-camp-dist').textContent = camp ? fmtDist(camp.dist) : '·';

  const endMile = navState.dir === 1 ? current.mileEnd : current.mileStart;
  const endName = navState.dir === 1 ? current.to : current.from;
  const endDist = (endMile - proj.mile) * navState.dir;
  $('nav-end-name').textContent = endName;
  $('nav-end-dist').textContent = endDist > 0.02 ? fmtDist(endDist) : 'Here';

  const acc = c.accuracy ? '±' + Math.round(c.accuracy * 3.281) + ' ft' : '';
  $('nav-status').textContent = `GPS ${acc} · updated ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

function setDir(dir) {
  navState.dir = dir;
  $('dir-nobo').classList.toggle('active', dir === 1);
  $('dir-sobo').classList.toggle('active', dir === -1);
  if (navState.lastFix) onFix(navState.lastFix);
}

function enterNav() {
  if (!current || !current.track.properties.mi) return;
  navState.active = true;
  navState.gotFix = false;
  closeLogger();
  $('view-section').hidden = true;
  $('view-nav').hidden = false;
  $('nav-eyebrow').textContent = `Section ${current.letter} · Navigating`;
  $('nav-mile').textContent = '····';
  $('nav-status').textContent = 'Waiting for GPS…';
  document.getElementById('panel').classList.remove('expanded');
  try { geoCtl.trigger(); } catch { }
  clearTimeout(navState.watchdog);
  navState.watchdog = setTimeout(() => {
    if (navState.active && !navState.gotFix) $('nav-status').textContent = 'Still waiting for GPS. Make sure Location is allowed, and that you are outdoors or near a window.';
  }, 15000);
}

function exitNav() {
  navState.active = false;
  clearTimeout(navState.watchdog);
  $('view-nav').hidden = true;
  $('view-section').hidden = false;
  renderSectionState();
}

/* ================= celebration ================= */
function celebrate(btn) {
  btn.classList.add('saved');
  setTimeout(() => btn.classList.remove('saved'), 900);
  if (REDUCED_MOTION) return;
  const r = btn.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const colors = ['#818CF8', '#818CF8', '#818CF8', '#818CF8', '#f59e0b', '#f59e0b'];
  for (let i = 0; i < 6; i++) {
    const p = document.createElement('span');
    p.className = 'particle';
    p.style.background = colors[i];
    p.style.left = cx + 'px';
    p.style.top = cy + 'px';
    const ang = (i / 6) * Math.PI * 2 + 0.4;
    p.style.transform = `rotate(${ang}rad)`;
    document.body.appendChild(p);
    p.animate([
      { transform: `translate(0,0) rotate(${ang}rad)`, opacity: 1 },
      { transform: `translate(${Math.cos(ang) * 24}px, ${Math.sin(ang) * 24}px) rotate(${ang}rad)`, opacity: 0 },
    ], { duration: 450, easing: 'ease-out' }).onfinish = () => p.remove();
  }
}

function animateStretch(a, b) {
  if (!current || !map.getSource('anim')) return;
  const mi = current.track.properties.mi;
  const coords = mi && sliceLineByMiles(current.track.geometry.coordinates, mi, a, b);
  if (!coords) return;
  const src = map.getSource('anim');
  const DURATION = REDUCED_MOTION ? 0 : 2000;
  if (!DURATION) { refreshSectionDone(); return; }
  const t0 = performance.now();
  (function frame(t) {
    const raw = Math.min((t - t0) / DURATION, 1);
    const eased = 1 - Math.pow(1 - raw, 3);
    const n = Math.max(2, Math.floor(eased * coords.length));
    src.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords.slice(0, n) } });
    if (raw < 1) requestAnimationFrame(frame);
    else setTimeout(() => { src.setData({ type: 'FeatureCollection', features: [] }); refreshSectionDone(); }, 300);
  })(t0);
}

/* ================= toasts ================= */
const toastQueue = [];
let toastActive = false;
function queueToasts(items) {
  toastQueue.push(...items);
  if (!toastActive) nextToast();
}
function nextToast() {
  const item = toastQueue.shift();
  if (!item) { toastActive = false; return; }
  toastActive = true;
  const el = document.createElement('div');
  el.className = 'toast' + (item.kind === 'section' ? ' section-toast' : '');
  el.innerHTML = `
    <div class="toast-ic"><svg class="ic" viewBox="0 0 24 24">${item.icon}</svg></div>
    <div>
      <div class="toast-eyebrow">${esc(item.eyebrow)}</div>
      <div class="toast-title">${esc(item.title)}</div>
      <div class="toast-sub">${esc(item.sub)}</div>
    </div>`;
  const dismiss = () => {
    el.classList.add('hiding');
    setTimeout(() => { el.remove(); nextToast(); }, 260);
  };
  el.addEventListener('click', dismiss);
  $('toast-root').appendChild(el);
  setTimeout(dismiss, 4000);
}

/* ================= offline packs ================= */
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
    status.innerHTML = '<span class="ok">Offline pack stored on this device ✓</span> · map works with no service';
  } else {
    label.textContent = `Download offline map (${(PACKS[id] / 1048576).toFixed(0)} MB)`;
    status.innerHTML = navigator.onLine
      ? 'Download on wifi before your trip'
      : '<span class="warn">Not downloaded. Connect to wifi first</span>';
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
    map.setStyle(sectionStyle(current, TILES.section(id)));
  } catch (err) {
    status.innerHTML = `<span class="warn">Download failed (${esc(err.message)}). Try again on wifi</span>`;
  }
  btn.disabled = false;
  setTimeout(() => { bar.hidden = true; refreshPackUI(); }, 600);
}

/* ================= sync ================= */
// Sync codes stay readable by not-yet-updated devices: a v1-style map of fully
// completed sections, with the exact intervals riding along under __v2.
function syncCode() {
  const payload = {};
  for (const s of index) {
    const cov = sectionCoverage(s);
    if (cov.done) payload[s.id] = { date: sectionDate(s) || today() };
  }
  payload.__v2 = { v: 2, intervals: progress };
  return btoa(JSON.stringify(payload));
}
function openSync() {
  $('modal').hidden = false;
  $('sync-code').value = syncCode();
}
function importSync() {
  try {
    const val = JSON.parse(atob($('sync-code').value.trim()));
    let ivs = null;
    if (val && val.__v2 && Array.isArray(val.__v2.intervals)) ivs = validIntervals(val.__v2.intervals);
    else if (val && val.v === 2 && Array.isArray(val.intervals)) ivs = validIntervals(val.intervals);
    else ivs = migrateV1Map(val); // plain v1 code from a not-yet-updated device
    if (!ivs) throw new Error('unusable');
    progress = mergeIntervals(ivs);
    saveProgress();
    $('modal').hidden = true;
    if (mode === 'section') renderSectionState();
  } catch {
    alert('That code did not parse. Paste the exact code from your other device.');
  }
}

/* ================= ui wiring ================= */
function wireUI() {
  $('btn-back').addEventListener('click', closeSection);
  $('btn-nav').addEventListener('click', enterNav);
  $('btn-nav-end').addEventListener('click', exitNav);
  $('dir-nobo').addEventListener('click', () => setDir(1));
  $('dir-sobo').addEventListener('click', () => setDir(-1));
  $('btn-log').addEventListener('click', openLogger);
  $('btn-clear').addEventListener('click', clearSection);
  $('btn-pack').addEventListener('click', downloadPack);
  $('btn-sync').addEventListener('click', openSync);
  $('btn-close-modal').addEventListener('click', () => { $('modal').hidden = true; });
  $('btn-copy-code').addEventListener('click', async () => {
    $('sync-code').value = syncCode();
    try { await navigator.clipboard.writeText($('sync-code').value); $('btn-copy-code').textContent = 'Copied ✓'; }
    catch { $('sync-code').select(); document.execCommand('copy'); }
    setTimeout(() => { $('btn-copy-code').textContent = 'Copy my code'; }, 1500);
  });
  $('btn-import-code').addEventListener('click', importSync);
  wireLogger();

  document.querySelectorAll('.legend input').forEach((el) =>
    el.addEventListener('change', () => { if (map.getLayer('wpts')) map.setFilter('wpts', kindFilter()); })
  );

  const panel = $('panel');
  $('sheet-handle').addEventListener('click', () => panel.classList.toggle('expanded'));

  document.querySelectorAll('.state-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const st = tab.dataset.state;
      document.querySelectorAll('.state-tab').forEach((t) => t.classList.toggle('active', t === tab));
      if (window.matchMedia('(max-width: 760px)').matches) panel.classList.add('expanded');
      const head = $('state-head-' + st);
      if (head) head.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // fly the map to that state's stretch of trail
      const secs = index.filter((s) => s.state === st);
      if (secs.length && mode === 'list') {
        const b = secs.reduce((acc, s) => [
          Math.min(acc[0], s.bbox[0]), Math.min(acc[1], s.bbox[1]),
          Math.max(acc[2], s.bbox[2]), Math.max(acc[3], s.bbox[3]),
        ], [Infinity, Infinity, -Infinity, -Infinity]);
        map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 40, duration: 900 });
      }
    });
  });

  window.addEventListener('online', updateOnline);
  window.addEventListener('offline', updateOnline);

  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (isIOS && !standalone) $('install-hint').hidden = false;
}

function updateOnline() {
  $('offline-badge').hidden = navigator.onLine;
}
