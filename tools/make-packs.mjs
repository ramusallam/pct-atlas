// Extract offline tile packs for every section (skips ones already present),
// then write data/packs.json with byte sizes for the app.
// Usage: node tools/make-packs.mjs [--build YYYYMMDD]
import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = process.argv.includes('--build')
  ? process.argv[process.argv.indexOf('--build') + 1]
  : '20260710';
const SRC = `https://build.protomaps.com/${BUILD}.pmtiles`;
const PAD = 0.12;
const CONCURRENCY = 4;

const idx = JSON.parse(readFileSync(join(ROOT, 'data', 'sections-index.json'), 'utf8'));
const jobs = idx.sections.filter((s) => !existsSync(join(ROOT, 'tiles', s.id + '.pmtiles')));
console.log(`${jobs.length} sections need packs (of ${idx.sections.length})`);

let active = 0, i = 0;
async function worker() {
  while (i < jobs.length) {
    const s = jobs[i++];
    const [w, so, e, n] = s.bbox;
    const bbox = [w - PAD, so - PAD, e + PAD, n + PAD].map((x) => x.toFixed(4)).join(',');
    const out = join(ROOT, 'tiles', s.id + '.pmtiles');
    const t0 = Date.now();
    try {
      await run('pmtiles', ['extract', SRC, out, '--bbox=' + bbox, '--maxzoom=15'], { maxBuffer: 64 * 1024 * 1024 });
      const mb = statSync(out).size / 1048576;
      console.log(`${s.id}: ${mb.toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    } catch (err) {
      console.error(`${s.id} FAILED: ${String(err.message).slice(0, 200)}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// write packs manifest (only files that exist)
const packs = {};
for (const s of idx.sections) {
  const p = join(ROOT, 'tiles', s.id + '.pmtiles');
  if (existsSync(p)) packs[s.id] = statSync(p).size;
}
const ovp = join(ROOT, 'tiles', 'overview.pmtiles');
if (existsSync(ovp)) packs.overview = statSync(ovp).size;
writeFileSync(join(ROOT, 'data', 'packs.json'), JSON.stringify(packs));
const total = Object.values(packs).reduce((a, b) => a + b, 0);
console.log(`packs.json: ${Object.keys(packs).length} packs, total ${(total / 1048576).toFixed(0)} MB`);
