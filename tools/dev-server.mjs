// Minimal static server with HTTP Range support (python http.server and `serve` both break pmtiles).
import { createServer } from 'http';
import { statSync, createReadStream, existsSync } from 'fs';
import { join, extname, normalize } from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || 4610;
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.pbf': 'application/x-protobuf',
  '.pmtiles': 'application/octet-stream',
};

createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  const size = statSync(file).size;
  const type = MIME[extname(file)] || 'application/octet-stream';
  const range = req.headers.range && /bytes=(\d+)-(\d+)?/.exec(req.headers.range);
  if (range) {
    const start = Number(range[1]);
    const end = range[2] !== undefined ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, {
      'Content-Type': type, 'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    });
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
    createReadStream(file).pipe(res);
  }
}).listen(PORT, () => console.log('dev server on :' + PORT));
