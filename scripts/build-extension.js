// Builds the Chrome extension: `npm run build:extension` -> dist/extension (load it with
// chrome://extensions -> Developer mode -> Load unpacked).
//
// The extension reuses the website's code byte-for-byte (scheduler, app, API client, styles) so the
// two can never drift apart; this script only copies files, generates the two HTML pages from the
// website's index.html, and draws the toolbar icons.
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = ['scheduler.js', 'app.js', 'api.js', 'platform.js', 'reminders.js', 'styles.css'];

// ----------------------------------------------------------------------- icons
/** A size x size PNG: indigo rounded square with a white check mark. */
export function makeIcon(size) {
  const dist = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // PNG filter type: none
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size, v = (y + 0.5) / size;
      // signed distance to a rounded square (radius 0.22), anti-aliased over one pixel
      const qx = Math.abs(u - 0.5) - (0.5 - 0.22), qy = Math.abs(v - 0.5) - (0.5 - 0.22);
      const sdf = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - 0.22;
      const box = Math.max(0, Math.min(1, 0.5 - sdf * size));
      const d = Math.min(dist(u, v, 0.27, 0.53, 0.44, 0.69), dist(u, v, 0.44, 0.69, 0.75, 0.33));
      const check = Math.max(0, Math.min(1, 0.5 - (d - 0.055) * size));
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = Math.round(0x4f + (255 - 0x4f) * check);
      raw[o + 1] = Math.round(0x46 + (255 - 0x46) * check);
      raw[o + 2] = Math.round(0xe5 + (255 - 0xe5) * check);
      raw[o + 3] = Math.round(255 * box);
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ----------------------------------------------------------------------- build
export async function buildExtension({ outDir = path.join(root, 'dist', 'extension') } = {}) {
  await fs.mkdir(path.join(outDir, 'icons'), { recursive: true });

  for (const f of SHARED) await fs.copyFile(path.join(root, 'public', f), path.join(outDir, f));
  await fs.copyFile(path.join(root, 'extension', 'background.js'), path.join(outDir, 'background.js'));

  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'extension', 'manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  // popup.html = compact layout in the toolbar popup; app.html = the full planner in a tab.
  const index = await fs.readFile(path.join(root, 'public', 'index.html'), 'utf8');
  if (!index.includes('<body>')) throw new Error('public/index.html must contain a plain <body> tag');
  await fs.writeFile(path.join(outDir, 'popup.html'), index.replace('<body>', '<body class="popup">'));
  await fs.writeFile(path.join(outDir, 'app.html'), index);

  for (const size of [16, 48, 128]) await fs.writeFile(path.join(outDir, 'icons', `icon${size}.png`), makeIcon(size));
  return outDir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildExtension().then((dir) => console.log(`Extension built in ${dir}\nLoad it: chrome://extensions -> Developer mode -> Load unpacked`));
}
