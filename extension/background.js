// Smart Scheduler - background service worker.
// Once a minute it looks at the planner data the popup/app cached in chrome.storage and
//   * shows a notification when a work session starts, and when one has ended unreported,
//   * keeps the toolbar badge equal to the number of sessions waiting for a report.
// It never talks to the server itself: the popup/app does the syncing and this just reads the cache.

import { dueReminders, pendingReports } from './reminders.js';

const SESSION_KEY = 'smart-scheduler:session';
const CACHE_PREFIX = 'smart-scheduler:cache:';
const META_KEY = 'smart-scheduler:reminders';
const MIN = 60_000;

function schedule() {
  chrome.alarms.create('tick', { periodInMinutes: 1 });
}
chrome.runtime.onInstalled.addListener(() => {
  schedule();
  check();
});
chrome.runtime.onStartup.addListener(() => {
  schedule();
  check();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'tick') check();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some((k) => k.startsWith(CACHE_PREFIX) || k === SESSION_KEY)) check();
});
chrome.notifications.onClicked.addListener((id) => {
  chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
  chrome.notifications.clear(id);
});

async function check() {
  const { [SESSION_KEY]: session } = await chrome.storage.local.get(SESSION_KEY);
  if (!session?.user) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  const cacheKey = CACHE_PREFIX + session.user.id;
  const { [cacheKey]: cache, [META_KEY]: meta = {} } = await chrome.storage.local.get([cacheKey, META_KEY]);
  if (!cache?.state) return;

  const now = Date.now();
  const simulated = Math.abs(cache.clockOffset ?? 0) > MIN; // "time travel" is active in the app

  const pending = simulated ? 0 : pendingReports(cache.state, now);
  await chrome.action.setBadgeText({ text: pending ? String(pending) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#b91c1c' });
  if (simulated) return;

  // After a long sleep, do not replay hours of old reminders.
  const since = Math.max(meta.since ?? now - MIN, now - 30 * MIN);
  const notified = meta.notified ?? [];
  const due = dueReminders(cache.state, { since, now, notified });
  for (const r of due) {
    chrome.notifications.create(r.id, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: r.title,
      message: r.body,
      priority: 1,
    });
  }
  await chrome.storage.local.set({
    [META_KEY]: { since: now, notified: [...notified, ...due.map((r) => r.id)].slice(-200) },
  });
}
