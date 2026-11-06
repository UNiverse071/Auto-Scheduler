// Tests for user accounts: the HTTP API (server/app.js) and the browser-side client (public/api.js).
// Written before the implementation. Each test starts a real server on a random port with a
// throw-away data directory, so these exercise the same code path the website and extension use.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../server/app.js';
import { createClient, ApiError } from '../public/api.js';

const DAY = 86_400_000;
const emptyState = () => ({ version: 1, seq: 0, settings: {}, tasks: [], busy: [], blocks: [] });

let server, base, dataDir;
const tick = { now: Date.UTC(2026, 10, 9, 9, 0) };

async function start(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-test-'))) {
  dataDir = dir;
  server = createServer({ dataDir, now: () => tick.now });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
}
const stop = () => new Promise((r) => server.close(() => r()));

async function call(method, url, { token, body, headers = {}, raw } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}
const register = async (username = 'alice', password = 'correct horse battery') =>
  (await call('POST', '/api/register', { body: { username, password } }));

describe('accounts API', () => {
  beforeEach(async () => { tick.now = Date.UTC(2026, 10, 9, 9, 0); await start(); });

  const withServer = (name, fn) =>
    test(name, async () => {
      try { await fn(); } finally { await stop(); }
    });

  withServer('registers a user and returns a session token', async () => {
    const r = await register();
    assert.equal(r.status, 201);
    assert.ok(r.json.token.length >= 32);
    assert.equal(r.json.user.username, 'alice');
    assert.equal(r.json.user.password, undefined);
    assert.equal((await call('GET', '/api/me', { token: r.json.token })).json.user.username, 'alice');
  });

  withServer('usernames are unique, ignoring case', async () => {
    await register('Alice');
    const again = await register('aLiCe');
    assert.equal(again.status, 409);
  });

  withServer('rejects weak passwords and odd usernames', async () => {
    assert.equal((await register('alice', 'short')).status, 400);
    assert.equal((await register('al', 'correct horse battery')).status, 400);
    assert.equal((await register('bad name!', 'correct horse battery')).status, 400);
    assert.equal((await register('../etc', 'correct horse battery')).status, 400);
    assert.equal((await call('POST', '/api/register', { body: { username: 'bob' } })).status, 400);
  });

  withServer('never stores the password in plain text', async () => {
    await register('alice', 'my very secret passphrase');
    const files = fs.readdirSync(dataDir, { recursive: true }).map((f) => path.join(dataDir, String(f)));
    for (const f of files.filter((f) => fs.statSync(f).isFile())) {
      assert.ok(!fs.readFileSync(f, 'utf8').includes('my very secret passphrase'), `${f} leaks the password`);
    }
    const users = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8'));
    assert.ok(users.users[0].hash && users.users[0].salt);
  });

  withServer('logs in with the right password only; errors do not reveal which part was wrong', async () => {
    await register('alice', 'correct horse battery');
    const ok = await call('POST', '/api/login', { body: { username: 'ALICE', password: 'correct horse battery' } });
    assert.equal(ok.status, 200);
    assert.ok(ok.json.token);
    const wrongPw = await call('POST', '/api/login', { body: { username: 'alice', password: 'nope nope nope' } });
    const noUser = await call('POST', '/api/login', { body: { username: 'ghost', password: 'nope nope nope' } });
    assert.equal(wrongPw.status, 401);
    assert.equal(noUser.status, 401);
    assert.equal(wrongPw.json.error, noUser.json.error);
  });

  withServer('state endpoints need a valid token', async () => {
    assert.equal((await call('GET', '/api/state')).status, 401);
    assert.equal((await call('GET', '/api/state', { token: 'garbage' })).status, 401);
    assert.equal((await call('PUT', '/api/state', { body: { baseRev: 0, state: emptyState() } })).status, 401);
  });

  withServer('a new account has no state; saving and reading it back works', async () => {
    const { token } = (await register()).json;
    const first = await call('GET', '/api/state', { token });
    assert.deepEqual(first.json, { rev: 0, state: null });
    const st = { ...emptyState(), tasks: [{ id: 't1', title: 'Hello' }] };
    const put = await call('PUT', '/api/state', { token, body: { baseRev: 0, state: st } });
    assert.equal(put.status, 200);
    assert.equal(put.json.rev, 1);
    const back = await call('GET', '/api/state', { token });
    assert.equal(back.json.rev, 1);
    assert.equal(back.json.state.tasks[0].title, 'Hello');
  });

  withServer('every user only ever sees their own data', async () => {
    const a = (await register('alice')).json.token;
    const b = (await register('bobby')).json.token;
    await call('PUT', '/api/state', { token: a, body: { baseRev: 0, state: { ...emptyState(), tasks: [{ id: 't1', title: 'Alice secret' }] } } });
    const bobs = await call('GET', '/api/state', { token: b });
    assert.equal(bobs.json.state, null);
    assert.ok(!bobs.text.includes('Alice secret'));
  });

  withServer('a stale write is refused with 409 and the current data', async () => {
    const { token } = (await register()).json;
    await call('PUT', '/api/state', { token, body: { baseRev: 0, state: { ...emptyState(), seq: 1 } } });
    const stale = await call('PUT', '/api/state', { token, body: { baseRev: 0, state: { ...emptyState(), seq: 99 } } });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.rev, 1);
    assert.equal(stale.json.state.seq, 1);
  });

  withServer('rejects malformed state and oversized bodies', async () => {
    const { token } = (await register()).json;
    assert.equal((await call('PUT', '/api/state', { token, body: { baseRev: 0, state: { nope: true } } })).status, 400);
    assert.equal((await call('PUT', '/api/state', { token, body: { baseRev: 0, state: 'x' } })).status, 400);
    assert.equal((await call('PUT', '/api/state', { token, raw: '{not json', headers: { 'Content-Type': 'application/json' } })).status, 400);
    const big = JSON.stringify({ baseRev: 0, state: { ...emptyState(), pad: 'x'.repeat(6_000_000) } });
    assert.equal((await call('PUT', '/api/state', { token, raw: big, headers: { 'Content-Type': 'application/json' } })).status, 413);
  });

  withServer('logging out invalidates the token', async () => {
    const { token } = (await register()).json;
    assert.equal((await call('POST', '/api/logout', { token })).status, 204);
    assert.equal((await call('GET', '/api/me', { token })).status, 401);
  });

  withServer('sessions expire after 30 days', async () => {
    const { token } = (await register()).json;
    tick.now += 29 * DAY;
    assert.equal((await call('GET', '/api/me', { token })).status, 200);
    tick.now += 2 * DAY;
    assert.equal((await call('GET', '/api/me', { token })).status, 401);
  });

  withServer('too many wrong passwords locks that account for a while', async () => {
    await register('alice', 'correct horse battery');
    await register('bobby', 'correct horse battery');
    let last;
    for (let i = 0; i < 8; i++) last = await call('POST', '/api/login', { body: { username: 'alice', password: 'wrong wrong wrong' } });
    assert.equal(last.status, 401);
    const locked = await call('POST', '/api/login', { body: { username: 'alice', password: 'correct horse battery' } });
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
    const other = await call('POST', '/api/login', { body: { username: 'bobby', password: 'correct horse battery' } });
    assert.equal(other.status, 200, 'other accounts are unaffected');
    tick.now += 11 * 60_000;
    const later = await call('POST', '/api/login', { body: { username: 'alice', password: 'correct horse battery' } });
    assert.equal(later.status, 200);
  });

  withServer('data survives a server restart', async () => {
    const { token } = (await register('alice', 'correct horse battery')).json;
    await call('PUT', '/api/state', { token, body: { baseRev: 0, state: { ...emptyState(), seq: 7 } } });
    const dir = dataDir;
    await stop();
    await start(dir);
    assert.equal((await call('GET', '/api/state', { token })).json.state.seq, 7);
    assert.equal((await call('POST', '/api/login', { body: { username: 'alice', password: 'correct horse battery' } })).status, 200);
  });

  withServer('allows the Chrome extension (and localhost) cross-origin, but not random sites', async () => {
    const ext = await call('OPTIONS', '/api/login', { headers: { Origin: 'chrome-extension://abcdefghijklmnop', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    assert.equal(ext.status, 204);
    assert.equal(ext.headers.get('access-control-allow-origin'), 'chrome-extension://abcdefghijklmnop');
    assert.match(ext.headers.get('access-control-allow-headers'), /authorization/i);
    const evil = await call('OPTIONS', '/api/login', { headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
  });

  withServer('serves the website with a strict Content-Security-Policy and blocks path traversal', async () => {
    const page = await call('GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.text, /Smart Scheduler/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    const evil = await call('GET', '/..%2f..%2fpackage.json');
    assert.ok([400, 403, 404].includes(evil.status));
    assert.ok(!evil.text.includes('"name": "smart-scheduler"'));
    assert.equal((await call('GET', '/%2e%2e/%2e%2e/package.json')).text.includes('"name": "smart-scheduler"'), false);
  });
});

describe('browser-side API client', () => {
  beforeEach(async () => { tick.now = Date.UTC(2026, 10, 9, 9, 0); await start(); });
  const withServer = (name, fn) =>
    test(name, async () => {
      try { await fn(); } finally { await stop(); }
    });

  withServer('register, save, sign out and sign in again', async () => {
    const c = createClient({ baseUrl: base });
    const { user } = await c.register('carol', 'correct horse battery');
    assert.equal(user.username, 'carol');
    assert.ok(c.token);
    assert.deepEqual(await c.getState(), { rev: 0, state: null });
    const { rev } = await c.putState({ ...emptyState(), seq: 3 }, 0);
    assert.equal(rev, 1);
    await c.logout();
    assert.equal(c.token, null);

    const c2 = createClient({ baseUrl: base });
    await c2.login('carol', 'correct horse battery');
    assert.equal((await c2.getState()).state.seq, 3);
  });

  withServer('failures become ApiError with the HTTP status', async () => {
    const c = createClient({ baseUrl: base });
    await assert.rejects(() => c.login('nobody', 'whatever whatever'), (e) => e instanceof ApiError && e.status === 401);
    await assert.rejects(() => c.getState(), (e) => e instanceof ApiError && e.status === 401);
  });

  withServer('a conflicting save carries the server copy so the app can adopt it', async () => {
    const c = createClient({ baseUrl: base });
    await c.register('dave', 'correct horse battery');
    await c.putState({ ...emptyState(), seq: 1 }, 0);
    await assert.rejects(
      () => c.putState({ ...emptyState(), seq: 2 }, 0),
      (e) => e.status === 409 && e.body.rev === 1 && e.body.state.seq === 1,
    );
  });

  withServer('an unreachable server gives status 0 (so the app can say "offline")', async () => {
    const c = createClient({ baseUrl: 'http://127.0.0.1:9' });
    await assert.rejects(() => c.login('x', 'yyyyyyyy'), (e) => e instanceof ApiError && e.status === 0);
  });
});
