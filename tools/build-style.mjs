// Generate warm-topo basemap layers (Spark palette) from protomaps light theme.
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { namedTheme, layersWithCustomTheme } = require('protomaps-themes-base');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const theme = {
  ...namedTheme('light'),
  // warm parchment ground
  background: '#F7F3EE',
  earth: '#F3EDE2',
  // sage greens for parks/forest (the trail lives here)
  park_a: '#E0E9D0',
  park_b: '#D8E3C5',
  wood_a: '#DCE6CB',
  wood_b: '#D3DFC0',
  scrub_a: '#E8EDD8',
  scrub_b: '#E0E7CC',
  // terrain accents
  glacier: '#FBFAF6',
  sand: '#F1E8D2',
  beach: '#F1E8D2',
  // soft alpine water
  water: '#A9CFDF',
  // warm built environment
  buildings: '#E9E1D2',
  pedestrian: '#EFE9DD',
  pier: '#EFE9DD',
  // peaks matter on a trail map
  peak_label: '#8A7C63',
};

const layers = layersWithCustomTheme('basemap', theme, 'en');
writeFileSync(join(ROOT, 'assets', 'basemap-layers.json'), JSON.stringify(layers));
console.log('wrote warm basemap-layers.json:', layers.length, 'layers');
