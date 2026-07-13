// Render a showcase card: minimal line-art map of the PCT with demo progress, Spark palette.
// Emits SVG; rasterize with: qlmanage -t -s 1200 -o <dir> card.svg
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const overview = JSON.parse(readFileSync(join(ROOT, 'data', 'pct-overview.json'), 'utf8'));

const W = 1200, H = 1200;
const DEMO = [[0, 209.5], [1017.7, 1158.2], [2396.4, 2655.8]];

// mercator-ish projection fitted to trail bbox with padding
const allPts = overview.features.flatMap((f) => f.geometry.coordinates);
const lons = allPts.map((p) => p[0]), lats = allPts.map((p) => p[1]);
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * 180 / Math.PI;
const x0 = Math.min(...lons), x1 = Math.max(...lons);
const y0 = mercY(Math.min(...lats)), y1 = mercY(Math.max(...lats));
const PAD = 70;
const scale = Math.min((W - 2 * PAD) / (x1 - x0), (H - 2 * PAD) / (y1 - y0));
const px = (lon) => (W - (x1 - x0) * scale) / 2 + (lon - x0) * scale;
const py = (lat) => H - ((H - (y1 - y0) * scale) / 2 + (mercY(lat) - y0) * scale);

const path = (coords) => 'M' + coords.map((c) => px(c[0]).toFixed(1) + ',' + py(c[1]).toFixed(1)).join('L');

function sliceByMiles(coords, mi, s, e) {
  const out = [];
  for (let i = 0; i < coords.length; i++) {
    if (mi[i] >= s && mi[i] <= e) out.push(coords[i]);
  }
  return out.length >= 2 ? out : null;
}

let ghost = '', done = '', dots = '';
for (const f of overview.features) {
  ghost += `<path d="${path(f.geometry.coordinates)}" />`;
}
for (const [a, b] of DEMO) {
  for (const f of overview.features) {
    const sl = sliceByMiles(f.geometry.coordinates, f.properties.mi, a, b);
    if (sl) done += `<path d="${path(sl)}" />`;
  }
}
// endpoint dots at interval ends (not trail termini)
for (const [a, b] of DEMO) {
  for (const m of [a, b]) {
    if (m <= 0.1 || m >= 2655.7) continue;
    for (const f of overview.features) {
      const mi = f.properties.mi;
      if (mi[0] <= m && mi[mi.length - 1] >= m) {
        let bi = 0, bd = Infinity;
        for (let i = 0; i < mi.length; i++) { const d = Math.abs(mi[i] - m); if (d < bd) { bd = d; bi = i; } }
        const c = f.geometry.coordinates[bi];
        dots += `<circle cx="${px(c[0]).toFixed(1)}" cy="${py(c[1]).toFixed(1)}" r="7" fill="#6366f1" stroke="#fff" stroke-width="3"/>`;
        break;
      }
    }
  }
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#F7F3EE"/>
  <defs>
    <pattern id="dots" width="34" height="34" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="1.4" fill="#E8E0D2"/>
    </pattern>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#dots)"/>
  <g fill="none" stroke="#D8CDBB" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">${ghost}</g>
  <g fill="none" stroke="#6366f1" stroke-width="13" stroke-opacity="0.16" stroke-linecap="round" stroke-linejoin="round">${done}</g>
  <g fill="none" stroke="#F7F3EE" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">${done}</g>
  <g fill="none" stroke="#6366f1" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round">${done}</g>
  ${dots}
  <g font-family="Menlo, monospace" font-size="17" letter-spacing="5" fill="#A0937B">
    <text x="${px(-120.8) + 30}" y="${py(49.0) + 6}">CANADA</text>
    <text x="${px(-116.47) - 34}" y="${py(32.59) + 26}" text-anchor="end">MEXICO</text>
  </g>
  <g font-family="Menlo, monospace" font-size="15" letter-spacing="4" fill="#6366f1">
    <text x="76" y="${H - 64}">PACIFIC CREST TRAIL</text>
  </g>
  <g font-family="Georgia, serif" font-size="44" fill="#2A2520">
    <text x="74" y="${H - 108}">2,655 miles, logged</text>
  </g>
  <g font-family="Menlo, monospace" font-size="15" letter-spacing="1" fill="#7C6F5A">
    <text x="76" y="${H - 36}">609.4 MI · 22.9% · MEXICO → CANADA</text>
  </g>
</svg>`;
writeFileSync(join(ROOT, 'tools', 'card.svg'), svg);
console.log('wrote card.svg', (svg.length / 1024).toFixed(0) + 'KB');
