// Everything that differs between "a web page" and "a Chrome extension page" lives here,
// so the rest of the app does not care which one it is running in.

export const isExtension = typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);

/** Where the accounts server is by default: the same site for the web app, localhost for the extension. */
export const defaultServer = isExtension ? 'http://localhost:5173' : '';

/** Small async key/value store: chrome.storage.local in the extension, localStorage on the web. */
export const storage = {
  async get(key) {
    try {
      if (isExtension) return (await chrome.storage.local.get(key))[key] ?? null;
      const raw = localStorage.getItem(key);
      return raw == null ? null : JSON.parse(raw);
    } catch {
      return null; // unavailable or corrupted: behave as if empty
    }
  },
  async set(key, value) {
    try {
      if (isExtension) await chrome.storage.local.set({ [key]: value });
      else localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode or quota: the app keeps working for this session */
    }
  },
  async remove(key) {
    try {
      if (isExtension) await chrome.storage.local.remove(key);
      else localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

/**
 * Chrome only lets an extension call servers it has permission for. localhost is built in;
 * any other server is requested from the user (must be called from a click/submit handler).
 */
export async function ensureServerPermission(serverUrl) {
  if (!isExtension || !serverUrl) return true;
  const { hostname, origin } = new URL(serverUrl);
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
  return chrome.permissions.request({ origins: [`${origin}/*`] });
}

/** In the extension popup, open the full planner in a tab. */
export function openFullPlanner() {
  if (isExtension) chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
}
