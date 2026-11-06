// Tests that the Chrome extension builds into something Chrome will accept.
// We cannot launch Chrome here, so we check the things that most often break an unpacked
// extension: a valid Manifest V3 file, every referenced file present, no inline scripts
// (Manifest V3 forbids them), real PNG icons, and that the app code is copied, not forked.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildExtension } from '../scripts/build-extension.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let out;
const read = (f) => fs.readFileSync(path.join(out, f), 'utf8');
const exists = (f) => fs.existsSync(path.join(out, f));

describe('Chrome extension build', () => {
  before(async () => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-ext-'));
    await buildExtension({ outDir: out });
  });

  test('has a valid Manifest V3 with the permissions it needs', () => {
    const m = JSON.parse(read('manifest.json'));
    assert.equal(m.manifest_version, 3);
    assert.ok(m.name && m.version && m.description);
    assert.match(m.version, /^\d+(\.\d+){0,3}$/);
    for (const p of ['storage', 'alarms', 'notifications']) assert.ok(m.permissions.includes(p), `missing permission ${p}`);
    assert.ok(m.host_permissions.some((h) => h.includes('localhost')), 'must reach the local server');
    assert.ok(m.optional_host_permissions?.length, 'a remote server needs an optional host permission');
    assert.equal(m.action.default_popup, 'popup.html');
    assert.equal(m.background.service_worker, 'background.js');
    assert.equal(m.background.type, 'module');
  });

  test('every file the manifest points at exists', () => {
    const m = JSON.parse(read('manifest.json'));
    const files = [m.action.default_popup, m.background.service_worker, ...Object.values(m.icons), ...Object.values(m.action.default_icon ?? {})];
    for (const f of files) assert.ok(exists(f), `${f} is referenced but missing`);
  });

  test('icons are real PNGs of the declared sizes', () => {
    const m = JSON.parse(read('manifest.json'));
    for (const size of [16, 48, 128]) {
      const buf = fs.readFileSync(path.join(out, m.icons[size]));
      assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${size}: not a PNG`);
      assert.equal(buf.readUInt32BE(16), size, `${size}: wrong width`);
      assert.equal(buf.readUInt32BE(20), size, `${size}: wrong height`);
    }
  });

  test('popup and full-page planner exist and use only external scripts', () => {
    for (const page of ['popup.html', 'app.html']) {
      const html = read(page);
      assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), `${page} has an inline script`);
      assert.ok(!/\son[a-z]+\s*=/i.test(html), `${page} has an inline event handler`);
      for (const [, src] of html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)) assert.ok(exists(src), `${page}: ${src} missing`);
      for (const [, href] of html.matchAll(/<link[^>]*\bhref="([^"]+\.css)"/g)) assert.ok(exists(href), `${page}: ${href} missing`);
    }
    assert.match(read('popup.html'), /<body[^>]*class="[^"]*\bpopup\b/);
    assert.doesNotMatch(read('app.html'), /<body[^>]*class="[^"]*\bpopup\b/);
  });

  test('ships the same app code as the website (copied, not forked)', () => {
    for (const f of ['scheduler.js', 'app.js', 'api.js', 'platform.js', 'reminders.js', 'styles.css']) {
      assert.ok(exists(f), `${f} missing`);
      assert.equal(read(f), fs.readFileSync(path.join(root, 'public', f), 'utf8'), `${f} differs from public/${f}`);
    }
  });

  test('the background worker only imports files that were shipped', () => {
    const src = read('background.js');
    for (const [, spec] of src.matchAll(/import[^'"]*['"]\.\/([^'"]+)['"]/g)) assert.ok(exists(spec), `background imports missing ${spec}`);
    assert.match(src, /chrome\.alarms/);
    assert.match(src, /chrome\.notifications/);
  });

  test('building twice into the same folder is safe', async () => {
    await buildExtension({ outDir: out });
    assert.ok(exists('manifest.json'));
  });
});
