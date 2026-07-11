// Build per-section GeoJSON packages from OFFICIAL PCTA data (centerline + mile markers),
// enriched with Halfmile waypoints (water/camps) and elevation profiles.
// Every track vertex carries its official PCT mile so the app can slice geometry by mile.
// Usage: node --max-old-space-size=4096 tools/build-data.mjs
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'data', 'raw');
const PCTA = join(RAW, 'pcta', 'share', 'PCT_Data_Share_Public', 'GeoJSON');
const OUT = join(ROOT, 'data', 'sections');
mkdirSync(OUT, { recursive: true });

const SECTION_NAMES = {
  CA_A: ['Campo', 'Warner Springs'], CA_B: ['Warner Springs', 'San Gorgonio Pass (I-10)'],
  CA_C: ['San Gorgonio Pass', 'Cajon Pass (I-15)'], CA_D: ['Cajon Pass', 'Agua Dulce'],
  CA_E: ['Agua Dulce', 'Tehachapi Pass'], CA_F: ['Tehachapi Pass', 'Walker Pass'],
  CA_G: ['Walker Pass', 'Crabtree Meadow'], CA_H: ['Crabtree Meadow', 'Tuolumne Meadows'],
  CA_I: ['Tuolumne Meadows', 'Sonora Pass'], CA_J: ['Sonora Pass', 'Echo Lake'],
  CA_K: ['Echo Lake', 'Donner Pass (I-80)'], CA_L: ['Donner Pass', 'Sierra City'],
  CA_M: ['Sierra City', 'Belden'], CA_N: ['Belden', 'Burney Falls'],
  CA_O: ['Burney Falls', 'Castle Crags (I-5)'], CA_P: ['Castle Crags', 'Etna Summit'],
  CA_Q: ['Etna Summit', 'Seiad Valley'], CA_R: ['Seiad Valley', 'I-5 near Ashland'],
  OR_B: ['I-5 near Ashland', 'Fish Lake (Hwy 140)'], OR_C: ['Fish Lake', 'Cascade Crest (Hwy 138)'],
  OR_D: ['Hwy 138', 'Willamette Pass'], OR_E: ['Willamette Pass', 'McKenzie Pass'],
  OR_F: ['McKenzie Pass', 'Barlow Pass'], OR_G: ['Barlow Pass', 'Bridge of the Gods'],
  WA_H: ['Bridge of the Gods', 'White Pass'], WA_I: ['White Pass', 'Snoqualmie Pass'],
  WA_J: ['Snoqualmie Pass', 'Stevens Pass'], WA_K: ['Stevens Pass', 'Rainy Pass'],
  WA_L: ['Rainy Pass', 'Manning Park, BC'],
};

const R = 6371e3;
function haversineMeters(a, b) {
  const dLat = (b[1] - a[1]) * Math.PI / 180, dLon = (b[0] - a[0]) * Math.PI / 180;
  const la1 = a[1] * Math.PI / 180, la2 = b[1] * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const M2MI = 1 / 1609.344;

// Douglas-Peucker returning KEPT INDICES so parallel arrays (miles) stay in sync
function simplifyIndices(points, tol) {
  if (points.length <= 2) return points.map((_, i) => i);
  const keep = new Uint8Array(points.length); keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    const [x1, y1] = points[s], [x2, y2] = points[e];
    const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
    for (let i = s + 1; i < e; i++) {
      const [px, py] = points[i];
      let d;
      if (len2 === 0) d = Math.hypot(px - x1, py - y1);
      else {
        const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
        d = Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
      }
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(i);
  return out;
}

/* ---------- 1. Official centerline: group 94 chunks into 29 ordered sections ---------- */
console.log('loading PCTA centerline…');
const centerline = JSON.parse(readFileSync(join(PCTA, 'Full_PCT.geojson'), 'utf8'));
const REGION_ORDER = /Track\/(\d) - /;
const secKey = (name) => name.replace(/^(CA|OR|WA) Section ([A-Z])$/, '$1_$2');

const bySection = new Map();
for (const f of centerline.features) {
  const name = f.properties.Section_Name;
  if (!bySection.has(name)) bySection.set(name, []);
  bySection.get(name).push(f);
}
const sectionOrder = [...bySection.keys()].sort((a, b) => {
  const fa = bySection.get(a)[0].properties.FolderPath, fb = bySection.get(b)[0].properties.FolderPath;
  const ra = Number(REGION_ORDER.exec(fa)[1]), rb = Number(REGION_ORDER.exec(fb)[1]);
  if (ra !== rb) return ra - rb;
  return a.slice(-1).localeCompare(b.slice(-1));
});
console.log('sections:', sectionOrder.length);

// concat chunks (drop duplicated junction vertex), build one continuous line
const sectionCoords = new Map(); // name -> [[lon,lat],...]
for (const name of sectionOrder) {
  const chunks = bySection.get(name).sort((a, b) => a.properties.OBJECTID - b.properties.OBJECTID);
  const coords = [];
  for (const ch of chunks) {
    const cs = ch.geometry.coordinates;
    const start = coords.length && coords[coords.length - 1][0] === cs[0][0] && coords[coords.length - 1][1] === cs[0][1] ? 1 : 0;
    for (let i = start; i < cs.length; i++) coords.push(cs[i]);
  }
  sectionCoords.set(name, coords);
}

// cumulative geodesic distance across the whole trail (meters)
console.log('cumulative distance…');
const secStartIdx = new Map();
const flat = [];
for (const name of sectionOrder) {
  const coords = sectionCoords.get(name);
  const startI = flat.length && flat[flat.length - 1][0] === coords[0][0] && flat[flat.length - 1][1] === coords[0][1] ? 1 : 0;
  secStartIdx.set(name, flat.length - startI); // index of this section's first vertex in flat
  for (let i = startI; i < coords.length; i++) flat.push(coords[i]);
}
const cum = new Float64Array(flat.length);
for (let i = 1; i < flat.length; i++) cum[i] = cum[i - 1] + haversineMeters(flat[i - 1], flat[i]);
console.log('vertices:', flat.length, 'geodesic length mi:', (cum[flat.length - 1] * M2MI).toFixed(1));

/* ---------- 2. Snap official mile markers -> cumdist, build mile calibration ---------- */
console.log('snapping mile markers…');
const markersRaw = JSON.parse(readFileSync(join(PCTA, 'Full_PCT_Mile_Marker.geojson'), 'utf8'));
const markers = markersRaw.features
  .map((f) => ({ mile: Number(f.properties.Mile), sec: f.properties.Section_Name.replace(' Mile Marker', ''), pt: f.geometry.coordinates }))
  .sort((a, b) => a.mile - b.mile);

// per-section vertex windows in flat[]
const secWindow = new Map();
for (let s = 0; s < sectionOrder.length; s++) {
  const name = sectionOrder[s];
  const start = secStartIdx.get(name);
  const end = s + 1 < sectionOrder.length ? secStartIdx.get(sectionOrder[s + 1]) : flat.length - 1;
  secWindow.set(name, [Math.max(0, start), Math.min(flat.length - 1, end)]);
}

function projectToLine(pt, i0, i1) {
  // nearest point on segments flat[i..i+1] within window; returns cumdist
  let best = Infinity, bestCum = 0;
  const px = pt[0], py = pt[1];
  const cosLat = Math.cos(py * Math.PI / 180);
  for (let i = i0; i < i1; i++) {
    const [x1, y1] = flat[i], [x2, y2] = flat[i + 1];
    // planar approx in degree space scaled by cosLat (fine at ~50m scale)
    const ax = (x1 - px) * cosLat, ay = y1 - py;
    const bx = (x2 - px) * cosLat, by = y2 - py;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const cx = ax + t * dx, cy = ay + t * dy;
    const d2 = cx * cx + cy * cy;
    if (d2 < best) {
      best = d2;
      bestCum = cum[i] + t * (cum[i + 1] - cum[i]);
    }
  }
  return bestCum;
}

const calib = [{ mile: 0, cd: 0 }];
for (const m of markers) {
  const w = secWindow.get(m.sec);
  if (!w) continue;
  const cd = projectToLine(m.pt, w[0], w[1]);
  calib.push({ mile: m.mile, cd });
}
calib.sort((a, b) => a.mile - b.mile);
// enforce monotonic cumdist (kill any mis-snaps)
let dropped = 0;
const mono = [calib[0]];
for (let i = 1; i < calib.length; i++) {
  if (calib[i].cd > mono[mono.length - 1].cd) mono.push(calib[i]);
  else dropped++;
}
console.log('calibration points:', mono.length, 'dropped non-monotonic:', dropped);

// per-vertex official mile via piecewise-linear interp of mile vs cumdist
console.log('assigning per-vertex miles…');
const vMile = new Float64Array(flat.length);
{
  let k = 0;
  const last = mono[mono.length - 1];
  const rate = (last.mile - mono[mono.length - 2].mile) / (last.cd - mono[mono.length - 2].cd);
  for (let i = 0; i < flat.length; i++) {
    const cd = cum[i];
    while (k < mono.length - 2 && mono[k + 1].cd <= cd) k++;
    if (cd >= last.cd) vMile[i] = last.mile + (cd - last.cd) * rate;
    else {
      const a = mono[k], b = mono[k + 1];
      vMile[i] = a.mile + ((cd - a.cd) / (b.cd - a.cd)) * (b.mile - a.mile);
    }
  }
}
const TOTAL_MILES = vMile[flat.length - 1];
console.log('official total miles:', TOTAL_MILES.toFixed(1));

/* ---------- 3. Halfmile waypoints + elevation profiles (per section) ---------- */
function parseWaypoints(xml) {
  const wpts = [];
  const blocks = xml.split('<wpt');
  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i];
    const lat = b.match(/lat="([-\d.]+)"/), lon = b.match(/lon="([-\d.]+)"/);
    if (!lat || !lon) continue;
    const name = (b.match(/<name>([\s\S]*?)<\/name>/) || [])[1]?.trim() || '';
    const desc = (b.match(/<desc>([\s\S]*?)<\/desc>/) || [])[1]?.trim() || '';
    const sym = (b.match(/<sym>([\s\S]*?)<\/sym>/) || [])[1]?.trim() || '';
    let type = 'landmark';
    const blob = (name + ' ' + sym).toLowerCase();
    if (/^wr?[a-z]?\d/i.test(name) || blob.includes('water')) type = 'water';
    else if (/^cs\d/i.test(name) || blob.includes('camp')) type = 'camp';
    else if (/^(hwy|rd|road)/i.test(name) || blob.includes('trailhead') || blob.includes('road')) type = 'road';
    wpts.push({ lon: Number(lon[1]), lat: Number(lat[1]), name, desc: desc.slice(0, 200), kind: type });
  }
  return wpts;
}
function parseMainTrackEles(xml, mainName) {
  // returns [[lon,lat,ele],...] of the main track for elevation profile
  const re = /<trk>([\s\S]*?)<\/trk>/g;
  let m;
  while ((m = re.exec(xml))) {
    const body = m[1];
    const name = (body.match(/<name>([\s\S]*?)<\/name>/) || [])[1]?.trim() || '';
    if (name !== mainName) continue;
    const pts = [];
    const blocks = body.split('<trkpt');
    for (let i = 1; i < blocks.length; i++) {
      const b = blocks[i];
      const lat = b.match(/lat="([-\d.]+)"/), lon = b.match(/lon="([-\d.]+)"/);
      const ele = b.match(/<ele>([-\d.]+)<\/ele>/);
      if (lat && lon) pts.push([Number(lon[1]), Number(lat[1]), ele ? Number(ele[1]) : 0]);
    }
    return pts;
  }
  return [];
}

const halfmileFiles = new Map(); // id -> {trackFile, wptFile}
(function walk(d) {
  for (const f of readdirSync(d, { withFileTypes: true })) {
    if (f.isDirectory()) { if (!f.name.startsWith('__MACOSX') && f.name !== 'pcta') walk(join(d, f.name)); }
    else {
      const m = f.name.match(/^(CA|OR|WA)_Sec_([A-Z])_(tracks|waypoints)\.gpx$/);
      if (m) {
        const id = `${m[1]}_${m[2]}`;
        if (!halfmileFiles.has(id)) halfmileFiles.set(id, {});
        halfmileFiles.get(id)[m[3]] = join(d, f.name);
      }
    }
  }
})(RAW);

/* ---------- 4. Emit per-section files + overview + index ---------- */
console.log('writing sections…');
const indexOut = [];
const overviewFeatures = [];
for (const name of sectionOrder) {
  const id = secKey(name);
  const [w0, w1] = secWindow.get(name);
  const coords = [];
  const miles = [];
  for (let i = w0; i <= w1; i++) { coords.push(flat[i]); miles.push(vMile[i]); }

  const mileStart = miles[0], mileEnd = miles[miles.length - 1];
  const exactMiles = mileEnd - mileStart;

  // detail track (~0.00002 deg tol keeps nav fidelity)
  const keepIdx = simplifyIndices(coords, 0.00002);
  const dCoords = keepIdx.map((i) => [Number(coords[i][0].toFixed(5)), Number(coords[i][1].toFixed(5))]);
  const dMiles = keepIdx.map((i) => Number(miles[i].toFixed(2)));
  if (dCoords.length !== dMiles.length) throw new Error('parity fail detail ' + id);

  // overview line (coarse) with miles
  const oIdx = simplifyIndices(coords, 0.002);
  const oCoords = oIdx.map((i) => [Number(coords[i][0].toFixed(4)), Number(coords[i][1].toFixed(4))]);
  const oMiles = oIdx.map((i) => Number(miles[i].toFixed(1)));
  if (oCoords.length !== oMiles.length) throw new Error('parity fail overview ' + id);

  const lons = dCoords.map((p) => p[0]), lats = dCoords.map((p) => p[1]);
  const bbox = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
  const [from, to] = SECTION_NAMES[id] || ['', ''];
  const [state, letter] = id.split('_');

  // waypoints: project onto detail track -> official mile
  const hm = halfmileFiles.get(id) || {};
  let waypoints = [];
  let gainFt = 0;
  let elevProfile = [];
  if (hm.waypoints) {
    const raw = parseWaypoints(readFileSync(hm.waypoints, 'utf8'));
    waypoints = raw.map((w) => {
      // nearest detail vertex (detail track is dense enough for snapping waypoints)
      let best = Infinity, bi = 0;
      const cosLat = Math.cos(w.lat * Math.PI / 180);
      for (let i = 0; i < dCoords.length; i++) {
        const dx = (dCoords[i][0] - w.lon) * cosLat, dy = dCoords[i][1] - w.lat;
        const d2 = dx * dx + dy * dy;
        if (d2 < best) { best = d2; bi = i; }
      }
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [Number(w.lon.toFixed(5)), Number(w.lat.toFixed(5))] },
        properties: { name: w.name, desc: w.desc, kind: w.kind, mile: dMiles[bi] },
      };
    });
  }
  if (hm.tracks) {
    const xml = readFileSync(hm.tracks, 'utf8');
    const elePts = parseMainTrackEles(xml, `${state} Sec ${letter}`);
    if (elePts.length > 2) {
      let gain = 0;
      for (let i = 1; i < elePts.length; i++) {
        const d = elePts[i][2] - elePts[i - 1][2];
        if (d > 0) gain += d;
      }
      gainFt = Math.round(gain * 3.28084 / 100) * 100;
      // profile sampled ~200 pts, x = OFFICIAL mile (linear rescale of halfmile cum distance to [mileStart, mileEnd])
      let hcum = 0;
      const hc = [0];
      for (let i = 1; i < elePts.length; i++) { hcum += haversineMeters(elePts[i - 1], elePts[i]); hc.push(hcum); }
      const step = Math.max(1, Math.floor(elePts.length / 200));
      for (let i = 0; i < elePts.length; i += step) {
        const frac = hc[i] / hcum;
        elevProfile.push([Number((mileStart + frac * exactMiles).toFixed(1)), Math.round(elePts[i][2])]);
      }
    }
  }

  writeFileSync(join(OUT, `${id}.json`), JSON.stringify({
    id, state, letter, from, to,
    miles: Number(exactMiles.toFixed(1)), gainFt, bbox,
    mileStart: Number(mileStart.toFixed(2)), mileEnd: Number(mileEnd.toFixed(2)),
    track: { type: 'Feature', geometry: { type: 'LineString', coordinates: dCoords }, properties: { id, mi: dMiles } },
    waypoints: { type: 'FeatureCollection', features: waypoints },
    elevProfile,
  }));

  indexOut.push({
    id, state, letter, from, to,
    miles: Number(exactMiles.toFixed(1)), gainFt, bbox,
    mileStart: Number(mileStart.toFixed(2)), mileEnd: Number(mileEnd.toFixed(2)),
  });
  overviewFeatures.push({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: oCoords },
    properties: { id, state, letter, from, to, miles: Number(exactMiles.toFixed(1)), mi: oMiles },
  });
  console.log(`${id}: ${dCoords.length} pts | mile ${mileStart.toFixed(1)} -> ${mileEnd.toFixed(1)} (${exactMiles.toFixed(1)} mi) | +${gainFt} ft | ${waypoints.length} wpts`);
}

writeFileSync(join(ROOT, 'data', 'pct-overview.json'), JSON.stringify({ type: 'FeatureCollection', features: overviewFeatures }));
writeFileSync(join(ROOT, 'data', 'sections-index.json'), JSON.stringify({
  totalMiles: Number(TOTAL_MILES.toFixed(1)),
  sections: indexOut,
}));
console.log(`\nDONE: ${indexOut.length} sections, official total ${TOTAL_MILES.toFixed(1)} mi`);
