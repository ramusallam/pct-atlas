// Build per-section GeoJSON packages + whole-trail overview from Halfmile GPX.
// Usage: node tools/build-data.mjs
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'data', 'raw');
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

// Douglas-Peucker on [lon,lat] using degree-space perpendicular distance (fine for simplification)
function simplify(points, tol) {
  if (points.length <= 2) return points;
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
  return points.filter((_, i) => keep[i]);
}

function parseTrackpointBlocks(xml) {
  const pts = [];
  const eleRe = /<ele>([-\d.]+)<\/ele>/;
  const blocks = xml.split('<trkpt');
  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i];
    const lat = b.match(/lat="([-\d.]+)"/), lon = b.match(/lon="([-\d.]+)"/);
    if (!lat || !lon) continue;
    const ele = b.match(eleRe);
    const p = [Number(Number(lon[1]).toFixed(5)), Number(Number(lat[1]).toFixed(5))];
    if (ele) p.push(Math.round(Number(ele[1])));
    pts.push(p);
  }
  return pts;
}

// Returns [{name, pts}] — one entry per <trk> in the file
function parseTracks(xml) {
  const tracks = [];
  const re = /<trk>([\s\S]*?)<\/trk>/g;
  let m;
  while ((m = re.exec(xml))) {
    const body = m[1];
    const name = (body.match(/<name>([\s\S]*?)<\/name>/) || [])[1]?.trim() || '';
    tracks.push({ name, pts: parseTrackpointBlocks(body) });
  }
  return tracks;
}

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
    wpts.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [Number(Number(lon[1]).toFixed(5)), Number(Number(lat[1]).toFixed(5))] },
      properties: { name, desc: desc.slice(0, 200), kind: type },
    });
  }
  return wpts;
}

const STATE_ORDER = { CA: 0, OR: 1, WA: 2 };
const files = [];
for (const dir of readdirSync(RAW)) {
  if (dir.endsWith('.zip')) continue;
  const walk = (d) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      if (f.isDirectory()) { if (!f.name.startsWith('__MACOSX')) walk(join(d, f.name)); }
      else if (f.name.endsWith('_tracks.gpx')) files.push(join(d, f.name));
    }
  };
  walk(join(RAW, dir));
}

const sections = [];
for (const trackFile of files) {
  const base = trackFile.split('/').pop(); // e.g. CA_Sec_K_tracks.gpx
  const m = base.match(/^(CA|OR|WA)_Sec_([A-Z])_tracks\.gpx$/);
  if (!m) { console.warn('skip', base); continue; }
  const [, state, letter] = m;
  const id = `${state}_${letter}`;
  const xml = readFileSync(trackFile, 'utf8');
  const allTracks = parseTracks(xml);
  const mainName = `${state} Sec ${letter}`;
  const main = allTracks.find(t => t.name === mainName) ||
    allTracks.reduce((a, b) => (b.pts.length > (a?.pts.length || 0) ? b : a), null);
  if (!main || main.pts.length < 2) { console.warn('no main track', id); continue; }
  const pts = main.pts;
  const sideTracks = allTracks.filter(t => t !== main && t.pts.length >= 2);

  let meters = 0, gain = 0;
  for (let i = 1; i < pts.length; i++) {
    meters += haversineMeters(pts[i - 1], pts[i]);
    if (pts[i].length > 2 && pts[i - 1].length > 2) {
      const d = pts[i][2] - pts[i - 1][2];
      if (d > 0) gain += d;
    }
  }
  const miles = Math.round(meters / 1609.344);
  const gainFt = Math.round(gain * 3.28084 / 100) * 100;

  const wptFile = trackFile.replace('_tracks.gpx', '_waypoints.gpx');
  let waypoints = [];
  try { waypoints = parseWaypoints(readFileSync(wptFile, 'utf8')); } catch { }

  const coords2d = pts.map(p => [p[0], p[1]]);
  const lons = coords2d.map(p => p[0]), lats = coords2d.map(p => p[1]);
  const bbox = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
  const [from, to] = SECTION_NAMES[id] || ['', ''];

  // Full-detail section file (lightly simplified — sub-meter tolerance keeps nav fidelity)
  const detail = simplify(coords2d, 0.00002);
  const elevProfile = [];
  // elevation profile: sample ~200 points along raw pts with cumulative miles
  let cum = 0; const step = Math.max(1, Math.floor(pts.length / 200));
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) cum += haversineMeters(pts[i - 1], pts[i]);
    if (i % step === 0 && pts[i].length > 2) elevProfile.push([Number((cum / 1609.344).toFixed(1)), pts[i][2]]);
  }

  const sideTrails = {
    type: 'FeatureCollection',
    features: sideTracks.map(t => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: simplify(t.pts.map(p => [p[0], p[1]]), 0.0001) },
      properties: { name: t.name.replace(`${mainName} - `, '') },
    })),
  };

  writeFileSync(join(OUT, `${id}.json`), JSON.stringify({
    id, state, letter, from, to, miles, gainFt, bbox,
    track: { type: 'Feature', geometry: { type: 'LineString', coordinates: detail }, properties: { id } },
    sideTrails,
    waypoints: { type: 'FeatureCollection', features: waypoints },
    elevProfile,
  }));

  sections.push({
    id, state, letter, from, to, miles, gainFt, bbox,
    overview: simplify(coords2d, 0.002), // coarse line for the whole-trail map
  });
  console.log(`${id}: ${pts.length} pts → ${detail.length} detail / ${miles} mi / +${gainFt} ft / ${waypoints.length} wpts`);
}

sections.sort((a, b) => (STATE_ORDER[a.state] - STATE_ORDER[b.state]) || a.letter.localeCompare(b.letter));

const overview = {
  type: 'FeatureCollection',
  features: sections.map(s => ({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: s.overview },
    properties: { id: s.id, state: s.state, letter: s.letter, from: s.from, to: s.to, miles: s.miles },
  })),
};
writeFileSync(join(ROOT, 'data', 'pct-overview.json'), JSON.stringify(overview));
writeFileSync(join(ROOT, 'data', 'sections-index.json'), JSON.stringify(
  sections.map(({ overview, ...meta }) => meta)
));
const total = sections.reduce((a, s) => a + s.miles, 0);
console.log(`\n${sections.length} sections, ${total} total miles`);
