// Generate PWA icons (pure node, no deps): indigo rounded square + white trail line + summit dot.
import { writeFileSync, mkdirSync } from 'fs';
import { deflateSync } from 'zlib';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'assets', 'icons'), { recursive: true });

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const lerp = (a, b, t) => a + (b - a) * t;
function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l2)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function drawIcon(S, opaqueCorners = false) {
  const buf = Buffer.alloc(S * S * 4);
  const r = opaqueCorners ? 0 : S * 0.22; // apple-touch-icon gets square corners (iOS rounds it)
  // trail polyline in unit coords, a rising switchback ending at a summit dot
  const pts = [[0.18, 0.80], [0.38, 0.62], [0.30, 0.50], [0.52, 0.40], [0.46, 0.30], [0.70, 0.26]].map(([x, y]) => [x * S, y * S]);
  const dot = [0.76 * S, 0.245 * S];
  const lw = S * 0.045, dotR = S * 0.055;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      // rounded-rect mask
      const cx = Math.max(r - x, x - (S - 1 - r), 0), cy = Math.max(r - y, y - (S - 1 - r), 0);
      const outside = Math.hypot(cx, cy) - r;
      let alpha = Math.max(0, Math.min(1, 0.5 - outside));
      if (alpha <= 0) { buf[i + 3] = 0; continue; }
      // indigo gradient 150deg: #4F46E5 -> #6366F1
      const t = (x / S + y / S) / 2;
      let R = lerp(0x4f, 0x63, t), G = lerp(0x46, 0x66, t), B = lerp(0xe5, 0xf1, t);
      // subtle dot texture
      if ((x % Math.round(S / 12) < 2) && (y % Math.round(S / 12) < 2)) { R += 10; G += 10; B += 6; }
      // white trail line
      let d = Infinity;
      for (let s = 0; s < pts.length - 1; s++) d = Math.min(d, distToSeg(x, y, pts[s][0], pts[s][1], pts[s + 1][0], pts[s + 1][1]));
      const line = Math.max(0, Math.min(1, lw / 2 + 0.75 - d));
      const dd = Math.hypot(x - dot[0], y - dot[1]);
      const dotA = Math.max(0, Math.min(1, dotR + 0.75 - dd));
      const ring = Math.max(0, Math.min(1, dotR * 1.8 + 0.75 - dd)) * 0.35;
      const white = Math.min(1, line + dotA + ring);
      R = lerp(R, 255, white); G = lerp(G, 255, white); B = lerp(B, 255, white);
      buf[i] = R; buf[i + 1] = G; buf[i + 2] = B; buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return png(S, S, buf);
}

for (const [name, size, opaque] of [['icon-512.png', 512, false], ['icon-192.png', 192, false], ['apple-touch-icon.png', 180, true]]) {
  writeFileSync(join(ROOT, 'assets', 'icons', name), drawIcon(size, opaque));
  console.log('wrote', name);
}
