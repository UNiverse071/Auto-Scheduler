// Smart Scheduler server: user accounts, per-user data storage, and the static website.
// Zero dependencies - only Node's standard library.
//
// Security notes (the reasoning, since this is the part that must not be wrong):
//  * Passwords are hashed with scrypt and a random per-user salt; they are never stored or logged.
//  * Login errors are identical for "no such user" and "wrong password", and an unknown user still
//    costs one scrypt run, so response time does not reveal which usernames exist.
//  * Session tokens are 256 random bits sent as `Authorization: Bearer ...` (not cookies, so there
//    is no CSRF to defend against). Only a SHA-256 hash of each token is stored on disk.
//  * Repeated wrong passwords lock that username for a while (HTTP 429).
//  * Each user's data lives in its own file, addressed by an opaque id from the session - never by
//    anything the client sends - so one user cannot read another's data.
//  * CORS is limited to localhost and chrome-extension:// origins; static files cannot escape ./public.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const scrypt = promisify(crypto.scrypt);
const DAY = 86_400_000;
const SESSION_MS = 30 * DAY;
const MAX_BODY = 5_000_000; // bytes
const LOCK_AFTER = 8; // wrong passwords...
const LOCK_WINDOW_MS = 10 * 60_000; // ...within this window lock the account
const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]{2,31}$/;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// ------------------------------------------------------------------ storage
function createStore(dataDir, now) {
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
  const usersFile = path.join(dataDir, 'users.json');
  const sessionsFile = path.join(dataDir, 'sessions.json');

  const readJson = (file, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  };
  // Write to a temp file, then rename: a crash can never leave a half-written file behind.
  const writeJson = (file, value) => {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
  };

  let users = readJson(usersFile, { users: [] }).users;
  let sessions = readJson(sessionsFile, {});
  const failures = new Map(); // username -> [timestamps of recent wrong passwords]

  const sha = (token) => crypto.createHash('sha256').update(token).digest('hex');
  const stateFile = (userId) => path.join(dataDir, 'state', `${userId}.json`);

  return {
    findUser: (username) => users.find((u) => u.username === username),
    findUserById: (id) => users.find((u) => u.id === id),
    addUser(user) {
      users.push(user);
      writeJson(usersFile, { users });
    },

    createSession(userId) {
      const token = crypto.randomBytes(32).toString('base64url');
      sessions[sha(token)] = { userId, expires: now() + SESSION_MS };
      writeJson(sessionsFile, sessions);
      return token;
    },
    userIdForToken(token) {
      const s = sessions[sha(token)];
      if (!s) return null;
      if (s.expires <= now()) {
        delete sessions[sha(token)];
        writeJson(sessionsFile, sessions);
        return null;
      }
      return s.userId;
    },
    endSession(token) {
      delete sessions[sha(token)];
      writeJson(sessionsFile, sessions);
    },

    readState: (userId) => readJson(stateFile(userId), { rev: 0, state: null }),
    writeState: (userId, rev, state) => writeJson(stateFile(userId), { rev, state }),

    lockedFor(username) {
      const recent = (failures.get(username) ?? []).filter((t) => now() - t < LOCK_WINDOW_MS);
      failures.set(username, recent);
      return recent.length >= LOCK_AFTER ? Math.ceil((recent[0] + LOCK_WINDOW_MS - now()) / 1000) : 0;
    },
    recordFailure(username) {
      failures.set(username, [...(failures.get(username) ?? []), now()]);
    },
    clearFailures: (username) => failures.delete(username),
  };
}

// ------------------------------------------------------------------ passwords
async function hashPassword(password, saltHex = crypto.randomBytes(16).toString('hex')) {
  const hash = (await scrypt(password, Buffer.from(saltHex, 'hex'), 64)).toString('hex');
  return { salt: saltHex, hash };
}
async function verifyPassword(password, user) {
  const { hash } = await hashPassword(password, user.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');

// ------------------------------------------------------------------ helpers
function allowedOrigin(origin) {
  if (!origin) return false;
  if (origin.startsWith('chrome-extension://')) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) tooBig = true; // keep draining so the client gets a clean 413
      else chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return reject(new HttpError(413, 'Request too large'));
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function looksLikeState(s) {
  return (
    s && typeof s === 'object' && !Array.isArray(s) && s.version === 1 &&
    s.settings && typeof s.settings === 'object' &&
    Array.isArray(s.tasks) && Array.isArray(s.busy) && Array.isArray(s.blocks)
  );
}

const publicUser = (u) => ({ id: u.id, username: u.username });

// ------------------------------------------------------------------ the server
export function createServer({
  dataDir,
  publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public'),
  now = Date.now,
} = {}) {
  if (!dataDir) throw new Error('createServer needs a dataDir');
  const store = createStore(dataDir, now);
  const root = path.resolve(publicDir);

  async function handleApi(req, res, pathname, json) {
    const method = req.method;

    const authUser = () => {
      const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
      const userId = m && store.userIdForToken(m[1]);
      const user = userId && store.findUserById(userId);
      if (!user) throw new HttpError(401, 'Please sign in');
      return { user, token: m[1] };
    };

    if (method === 'POST' && pathname === '/api/register') {
      const body = await readBody(req);
      const username = String(body.username ?? '').trim().toLowerCase();
      const password = body.password;
      if (!USERNAME_RE.test(username)) {
        throw new HttpError(400, 'Username must be 3-32 characters: letters, numbers, dot, dash or underscore');
      }
      if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
        throw new HttpError(400, 'Password must be at least 8 characters');
      }
      if (store.findUser(username)) throw new HttpError(409, 'That username is taken');
      const user = { id: `u${crypto.randomBytes(8).toString('hex')}`, username, ...(await hashPassword(password)), createdAt: now() };
      store.addUser(user);
      return json(201, { token: store.createSession(user.id), user: publicUser(user) });
    }

    if (method === 'POST' && pathname === '/api/login') {
      const body = await readBody(req);
      const username = String(body.username ?? '').trim().toLowerCase();
      const password = typeof body.password === 'string' ? body.password : '';
      const wait = store.lockedFor(username);
      if (wait) throw new HttpError(429, 'Too many attempts. Try again later.', { headers: { 'Retry-After': String(wait) } });
      const user = store.findUser(username);
      const ok = user ? await verifyPassword(password, user) : (await hashPassword(password, DUMMY_SALT), false);
      if (!ok) {
        store.recordFailure(username);
        throw new HttpError(401, 'Wrong username or password');
      }
      store.clearFailures(username);
      return json(200, { token: store.createSession(user.id), user: publicUser(user) });
    }

    if (method === 'POST' && pathname === '/api/logout') {
      store.endSession(authUser().token);
      return json(204);
    }

    if (method === 'GET' && pathname === '/api/me') return json(200, { user: publicUser(authUser().user) });

    if (pathname === '/api/state') {
      const { user } = authUser();
      if (method === 'GET') return json(200, store.readState(user.id));
      if (method === 'PUT') {
        const body = await readBody(req);
        if (!looksLikeState(body.state)) throw new HttpError(400, 'That is not a valid planner state');
        const current = store.readState(user.id);
        if (body.baseRev !== current.rev) throw new HttpError(409, 'Out of date', { body: current });
        store.writeState(user.id, current.rev + 1, body.state);
        return json(200, { rev: current.rev + 1 });
      }
    }

    throw new HttpError(404, 'No such API route');
  }

  async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    let rel;
    try {
      rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    } catch {
      throw new HttpError(400, 'Bad path');
    }
    if (rel.includes('\0')) throw new HttpError(400, 'Bad path');
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root + path.sep)) throw new HttpError(403, 'Forbidden');
    let body;
    try {
      body = await fs.promises.readFile(file);
    } catch {
      throw new HttpError(404, 'Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const cors = allowedOrigin(origin)
      ? {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Max-Age': '600',
          Vary: 'Origin',
        }
      : { Vary: 'Origin' };

    const json = (status, body, headers = {}) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      res.writeHead(status, {
        ...cors,
        ...headers,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...(payload ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
      });
      res.end(payload);
    };

    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname.startsWith('/api/')) {
        if (req.method === 'OPTIONS') return json(204);
        return await handleApi(req, res, pathname, json);
      }
      return await serveStatic(req, res, pathname);
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) {
        return json(err.status, err.extra.body ?? { error: err.message }, err.extra.headers);
      }
      console.error(err); // a bug, not the client's fault - never leak details
      return json(500, { error: 'Something went wrong' });
    }
  });
}
