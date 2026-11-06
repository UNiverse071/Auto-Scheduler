// Browser-side client for the accounts API (used by the website and the Chrome extension).
// It only talks HTTP; where the token is remembered is the caller's business.

export class ApiError extends Error {
  /** status 0 means the server could not be reached at all. */
  constructor(status, message, body = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export function createClient({ baseUrl = '', token = null, fetch: fetchImpl } = {}) {
  let current = token;
  // Wrapped so `fetch` is always called as window.fetch (calling it detached throws in browsers).
  const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));

  async function request(method, path, body) {
    let res;
    try {
      res = await doFetch(baseUrl + path, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(current ? { Authorization: `Bearer ${current}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, 'Cannot reach the server');
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText ?? 'Request failed', data);
    return data;
  }

  const startSession = (data) => {
    current = data.token;
    return data;
  };

  return {
    get token() {
      return current;
    },
    set token(value) {
      current = value;
    },
    register: async (username, password) => startSession(await request('POST', '/api/register', { username, password })),
    login: async (username, password) => startSession(await request('POST', '/api/login', { username, password })),
    async logout() {
      try {
        await request('POST', '/api/logout');
      } finally {
        current = null; // forget the token even if the server was unreachable
      }
    },
    me: () => request('GET', '/api/me'),
    getState: () => request('GET', '/api/state'),
    putState: (state, baseRev) => request('PUT', '/api/state', { baseRev, state }),
  };
}
