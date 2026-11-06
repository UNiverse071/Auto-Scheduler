// Smart Scheduler - the user interface (shared by the website and the Chrome extension).
// All planning logic lives in scheduler.js; this file draws state, turns clicks into calls to the
// engine, and keeps each signed-in user's plan saved on the server (see "sync" below).
// Text is always inserted with textContent (via h()), never innerHTML, so task titles can't inject markup.

import {
  createState,
  addTask,
  updateTask,
  removeTask,
  addBusy,
  removeBusy,
  addDayOff,
  removeDayOff,
  updateSettings,
  replan,
  reportBlock,
  taskProgress,
  taskStatus,
  recommendations,
  applyRecommendation,
  toICS,
  formatMinutes,
} from './scheduler.js';
import { createClient, ApiError } from './api.js';
import { isExtension, defaultServer, storage, ensureServerPermission, openFullPlanner } from './platform.js';

const SESSION_KEY = 'smart-scheduler:session'; // { token, user: {id, username}, server }
const CACHE_PREFIX = 'smart-scheduler:cache:'; // + user id -> { state, rev, clockOffset, dirty }
const LEGACY_KEY = 'smart-scheduler:v1'; // plan saved before accounts existed (this device only)
const DAY = 86_400_000;
const MIN = 60_000;
const isPopup = document.body.classList.contains('popup');

// The ready-made planning styles. They are just named combinations of the three policy settings.
const PRESETS = {
  balanced: { priorityWeight: 0.5, protectDeadlines: true, spread: 'even' },
  deadline: { priorityWeight: 0, protectDeadlines: true, spread: 'even' },
  importance: { priorityWeight: 1, protectDeadlines: true, spread: 'even' },
  early: { priorityWeight: 0.5, protectDeadlines: true, spread: 'asap' },
};

let state = createState();
let session = null; // who is signed in
let client = null; // API client for that session
let rev = 0; // server revision our copy is based on
let dirty = false; // local changes not yet confirmed saved on the server
let pushing = false;
let pushTimer;
let clockOffset = 0; // "time travel": simulated now = real now + offset (per device, never synced)
let weekStart = 0;
let reportingId = null;
let editingId = null;
let authMode = 'login';
const dismissed = new Set();

// ------------------------------------------------------------- tiny helpers
const $ = (sel) => document.querySelector(sel);

function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') for (const [p, val] of Object.entries(v)) node.style.setProperty(p, val);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...kids.flat().filter((k) => k != null && k !== false));
  return node;
}

const now = () => new Date(Date.now() + clockOffset);
const startOfDay = (ms) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const addDays = (ms, n) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
};
const minuteOfDay = (ms) => new Date(ms).getHours() * 60 + new Date(ms).getMinutes();
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDay = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const durOf = (b) => (b.end - b.start) / MIN;
const pad = (n) => String(n).padStart(2, '0');
const dateValue = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const parseDate = (str, endOfDay) => {
  if (!str) return null;
  const [y, m, d] = str.split('-').map(Number);
  return endOfDay ? new Date(y, m - 1, d, 23, 59, 59).getTime() : new Date(y, m - 1, d).getTime();
};
const mondayOf = (ms) => addDays(startOfDay(ms), -((new Date(ms).getDay() + 6) % 7));
const taskHue = (taskId) => (parseInt(taskId.slice(1), 10) * 67 + 235) % 360;
const taskOf = (id) => state.tasks.find((t) => t.id === id);
const stars = (n = 3) => '★'.repeat(n) + '☆'.repeat(5 - n);
const isDayOff = (dayMs) => {
  const key = dateValue(dayMs);
  return (state.settings.daysOff ?? []).find((r) => key >= r.from && key <= r.to);
};

// ------------------------------------------------------------- saving & syncing
// Every change is (1) cached on this device at once, so the app works offline, and (2) sent to the
// server shortly after. `rev` is the server version our copy is based on: if another device saved in
// the meantime the server refuses our write (409) and we take its copy instead of overwriting it.
const cacheKey = () => CACHE_PREFIX + session.user.id;

function setSync(kind) {
  const el = $('#sync');
  const text = { saved: 'Saved ✓', saving: 'Saving…', offline: 'Offline - will retry' }[kind];
  el.hidden = !session || !text;
  el.textContent = text ?? '';
  el.classList.toggle('offline', kind === 'offline');
}

function persistCache() {
  if (session) storage.set(cacheKey(), { state, rev, clockOffset, dirty });
}

function save() {
  dirty = true;
  persistCache();
  setSync('saving');
  schedulePush(400);
}

function schedulePush(delay) {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(push, delay);
}

async function push() {
  if (!client || pushing) return;
  pushing = true;
  const sent = state;
  try {
    const res = await client.putState(sent, rev);
    rev = res.rev;
    if (state === sent) dirty = false;
    persistCache();
    setSync(dirty ? 'saving' : 'saved');
    if (dirty) schedulePush(0); // changed while we were sending
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && err.body?.state) {
      adopt(err.body);
      toast('Your plan was changed on another device, so it was reloaded. Please redo your last change.');
    } else if (err instanceof ApiError && err.status === 401) sessionExpired();
    else {
      setSync('offline');
      schedulePush(15_000);
    }
  } finally {
    pushing = false;
  }
}

/** Replace our copy with the server's. */
function adopt(remote) {
  state = replan(remote.state, now());
  rev = remote.rev;
  dirty = false;
  persistCache();
  setSync('saved');
  fillForms();
  render();
}

async function syncDown() {
  if (!client) return;
  try {
    const remote = await client.getState();
    if (remote.state == null) {
      // A brand-new account: start from the plan this device had before accounts existed, if any.
      if (!state.tasks.length) {
        const legacy = await storage.get(LEGACY_KEY);
        if (legacy?.state?.version === 1) {
          state = replan(legacy.state, now());
          fillForms();
          render();
        }
      }
      rev = remote.rev;
      dirty = true;
      await push();
    } else if (remote.rev !== rev) {
      if (dirty) await push(); // conflict: the server will answer 409 and we adopt its copy
      else adopt(remote);
    } else if (dirty) await push();
    else setSync('saved');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) sessionExpired();
    else setSync('offline');
  }
}

/** Apply an engine function to the state, then save and redraw. Returns false if the engine rejected it. */
function commit(fn) {
  try {
    state = fn(state, now());
  } catch (err) {
    toast(err.message);
    return false;
  }
  save();
  render();
  return true;
}

// ------------------------------------------------------------- accounts
function showAuth(message) {
  const dlg = $('#auth-dialog');
  $('#user').hidden = true;
  $('#sync').hidden = true;
  setAuthMode(authMode);
  const f = $('#auth-form');
  f.server.value = session?.server ?? defaultServer;
  showError('#auth-error', message);
  if (!dlg.open) dlg.showModal();
  f.username.focus();
}

function setAuthMode(mode) {
  authMode = mode;
  const login = mode === 'login';
  $('#tab-login').setAttribute('aria-selected', String(login));
  $('#tab-register').setAttribute('aria-selected', String(!login));
  $('#auth-submit').textContent = login ? 'Sign in' : 'Create account';
  $('#auth-form').password.autocomplete = login ? 'current-password' : 'new-password';
  $('#auth-hint').textContent = login
    ? 'No account yet? Choose "Create account".'
    : 'Passwords need at least 8 characters. Your plan is saved to your account, separate from everyone else’s.';
}

async function submitAuth(e) {
  e.preventDefault();
  const f = e.target;
  showError('#auth-error');
  const server = isExtension ? (f.server.value.trim() || defaultServer).replace(/\/+$/, '') : '';
  const submit = $('#auth-submit');
  submit.disabled = true;
  try {
    if (isExtension && !(await ensureServerPermission(server))) throw new Error('Chrome needs your permission to contact that server.');
    const c = createClient({ baseUrl: server });
    const res = authMode === 'login' ? await c.login(f.username.value, f.password.value) : await c.register(f.username.value, f.password.value);
    session = { token: res.token, user: res.user, server };
    await storage.set(SESSION_KEY, session);
    f.password.value = '';
    $('#auth-dialog').close();
    await enter();
  } catch (err) {
    showError(
      '#auth-error',
      err instanceof ApiError && err.status === 0
        ? `Can't reach the server${server ? ` at ${server}` : ''}. Is it running? (npm start)`
        : err instanceof TypeError
          ? 'That server address does not look right.'
          : err.message,
    );
  } finally {
    submit.disabled = false;
  }
}

/** Load this user's cached plan, show it, then bring it up to date from the server. */
async function enter() {
  client = createClient({ baseUrl: session.server ?? '', token: session.token });
  const cache = await storage.get(cacheKey());
  if (cache?.state?.version === 1) {
    state = cache.state;
    rev = cache.rev ?? 0;
    clockOffset = Number(cache.clockOffset) || 0;
    dirty = Boolean(cache.dirty);
  } else {
    state = createState();
    rev = 0;
    clockOffset = 0;
    dirty = false;
  }
  try {
    const before = JSON.stringify(state);
    state = replan(state, now());
    if (JSON.stringify(state) !== before) dirty = true;
  } catch {
    state = createState();
  }
  $('#user').hidden = false;
  $('#user-name').textContent = session.user.username;
  setSync(dirty ? 'saving' : 'saved');
  weekStart = pickWeek();
  fillForms();
  render();
  await syncDown();
}

function sessionExpired() {
  client = null;
  storage.remove(SESSION_KEY); // keep the cached plan: signing back in will sync it
  showAuth('Your session expired. Please sign in again.');
}

async function signOut() {
  clearTimeout(pushTimer);
  if (dirty) await push(); // best effort: don't lose the last edits
  const user = session?.user;
  try {
    await client?.logout();
  } catch {
    /* the token is forgotten locally either way */
  }
  await storage.remove(SESSION_KEY);
  if (user) await storage.remove(CACHE_PREFIX + user.id); // don't leave someone's plan behind on a shared computer
  session = null;
  client = null;
  state = createState();
  rev = 0;
  dirty = false;
  clockOffset = 0;
  render();
  showAuth();
}

// ------------------------------------------------------------- toast
let toastTimer;
function toast(message, undo) {
  const t = $('#toast');
  t.replaceChildren(message);
  if (undo) {
    t.append(
      ' ',
      h('button', { class: 'link', type: 'button', onclick: () => { undo(); t.hidden = true; } }, 'Undo'),
    );
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), undo ? 7000 : 4500);
}

function showError(id, message) {
  const el = $(id);
  el.textContent = message ?? '';
  el.hidden = !message;
}

// ------------------------------------------------------------- rendering
function render() {
  renderClock();
  renderAdvice();
  renderToday();
  renderWeek();
  renderTasks();
  renderBusy();
  renderDaysOff();
}

function renderClock() {
  const el = $('#clock');
  const travelling = Math.abs(clockOffset) > 60_000;
  el.textContent = (travelling ? 'Simulated: ' : '') + now().toLocaleString([], {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  el.classList.toggle('travelling', travelling);
}

// ---- advice
function renderAdvice() {
  const box = $('#advice');
  const recs = recommendations(state, now()).filter((r) => !dismissed.has(`${r.type}:${r.taskId ?? ''}`));
  box.replaceChildren();
  box.hidden = recs.length === 0;
  const labels = { alert: 'Deadline at risk', warn: 'Suggestion', info: 'Insight' };

  for (const rec of recs) {
    let action = null;
    if (rec.type === 'rescale') {
      action = h('button', { class: 'btn small', type: 'button', onclick: () => {
        const before = state;
        if (commit((s, n) => applyRecommendation(s, rec, n))) {
          toast('Estimate updated and plan rebuilt.', () => { state = replan(before, now()); save(); render(); });
        }
      } }, `Set to ${formatMinutes(rec.suggestedEstimateMin)}`);
    } else if (rec.type === 'repeated-miss' && rec.patch) {
      action = h('button', { class: 'btn small', type: 'button', onclick: () => {
        if (commit((s, n) => applyRecommendation(s, rec, n))) { fillForms(); toast('Lighter plan applied.'); }
      } }, 'Use lighter plan');
    } else if (rec.type === 'deadline-risk') {
      action = h('button', { class: 'btn small', type: 'button', onclick: () => openEdit(rec.taskId) }, 'Edit task');
    }
    box.append(
      h('div', { class: `rec ${rec.severity}` },
        h('p', {}, h('strong', {}, labels[rec.severity]), rec.message),
        h('div', { class: 'slot-actions' },
          action,
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss', title: 'Dismiss for now',
            onclick: () => { dismissed.add(`${rec.type}:${rec.taskId ?? ''}`); renderAdvice(); } }, '✕'))),
    );
  }
}

// ---- today
function statusText(b) {
  if (b.status === 'done') return `✓ Done${b.spentMin > durOf(b) ? ` (took ${formatMinutes(b.spentMin)})` : ''}`;
  if (b.status === 'partial') return `◐ Partly: ${formatMinutes(b.completedMin)} of ${formatMinutes(durOf(b))}`;
  return b.auto ? 'Time passed with no report' : '✗ Not done, rescheduled';
}

function blockRow(b, { showDay = false } = {}) {
  const task = taskOf(b.taskId);
  const n = +now();
  const running = b.status === 'planned' && b.start <= n && n < b.end;
  const needsReport = b.auto;
  const left = taskProgress(state, b.taskId).remainingMin;

  let note;
  if (b.status === 'planned') note = running ? 'In progress now' : `${formatMinutes(left)} left on this task`;
  else note = statusText(b);

  let actions;
  if (b.status === 'planned' || needsReport) {
    actions = [
      h('button', { class: 'btn small', type: 'button', onclick: () => quickReport(b.id, 'full') }, '✓ Done'),
      h('button', { class: 'btn small', type: 'button', onclick: () => openReport(b.id, 'half') }, 'Partly…'),
      h('button', { class: 'btn small', type: 'button', onclick: () => quickReport(b.id, 'none') }, "✗ Couldn't"),
    ];
  } else {
    actions = [h('button', { class: 'btn small', type: 'button', onclick: () => openReport(b.id) }, 'Edit report')];
  }

  return h('div', { class: `slot${b.status !== 'planned' && !needsReport ? ' reported' : ''}${running ? ' now' : ''}`,
    style: { '--h': taskHue(b.taskId) } },
    h('span', { class: 'swatch' }),
    h('div', { class: 'slot-time' },
      `${fmtTime(b.start)} – ${fmtTime(b.end)}`,
      h('small', {}, showDay ? `${fmtDay(b.start)} · ${formatMinutes(durOf(b))}` : formatMinutes(durOf(b)))),
    h('div', {},
      h('div', { class: 'slot-title' }, task?.title ?? 'Task', ' ',
        h('span', { class: 'stars', 'aria-label': `Importance ${task?.importance ?? 3} of 5`, title: `Importance ${task?.importance ?? 3} of 5` }, stars(task?.importance))),
      h('div', { class: `slot-note${needsReport ? ' status needs' : ''}` }, note)),
    h('div', { class: 'slot-actions' }, ...actions),
  );
}

function renderToday() {
  const root = $('#today');
  root.replaceChildren();
  const n = +now();
  const day = startOfDay(n);
  const nextDay = addDays(day, 1);

  const needs = state.blocks
    .filter((b) => b.auto && b.start >= day - 3 * DAY)
    .sort((a, b) => a.start - b.start);
  const todays = [
    ...state.blocks.filter((b) => !b.auto && b.start >= day && b.start < nextDay).map((b) => ({ kind: 'block', start: b.start, b })),
    ...state.busy.filter((e) => e.end > day && e.start < nextDay).map((e) => ({ kind: 'busy', start: e.start, e })),
  ].sort((a, b) => a.start - b.start);

  const doneMin = todays.filter((x) => x.kind === 'block').reduce((s, x) => s + (x.b.status === 'planned' ? 0 : x.b.completedMin), 0);
  const plannedMin = todays.filter((x) => x.kind === 'block' && x.b.status === 'planned').reduce((s, x) => s + durOf(x.b), 0);
  $('#today-summary').textContent = fmtDay(n) + (doneMin || plannedMin ? ` · ${formatMinutes(doneMin)} done · ${formatMinutes(plannedMin)} still planned` : '');

  if (needs.length) {
    root.append(h('div', { class: 'group-label' }, 'Did you get these done? Tell the scheduler'));
    needs.forEach((b) => root.append(blockRow(b, { showDay: true })));
    root.append(h('div', { class: 'group-label' }, 'Coming up today'));
  }

  if (!todays.length) {
    const off = isDayOff(day);
    const next = state.blocks.filter((b) => b.status === 'planned' && b.start >= nextDay).sort((a, b) => a.start - b.start)[0];
    root.append(h('div', { class: 'empty' },
      off ? `Today is a day off${off.label ? ` (${off.label})` : ''}. Enjoy it!${next ? ` Next session: ${fmtDay(next.start)}, ${fmtTime(next.start)}.` : ''}`
        : state.tasks.length
          ? (next ? `Nothing scheduled for the rest of today. Next session: ${fmtDay(next.start)}, ${fmtTime(next.start)}.` : 'Nothing scheduled today. Add a task to get started.')
          : 'Add your first task and it will appear here, split into sessions.'));
    return;
  }

  for (const item of todays) {
    if (item.kind === 'block') root.append(blockRow(item.b));
    else {
      root.append(h('div', { class: 'slot is-busy' },
        h('span', { class: 'swatch' }),
        h('div', { class: 'slot-time' }, `${fmtTime(Math.max(item.e.start, day))} – ${fmtTime(Math.min(item.e.end, nextDay))}`),
        h('div', {}, h('div', { class: 'slot-title' }, item.e.title), h('div', { class: 'slot-note' }, 'Busy')),
        h('div')));
    }
  }
}

// ---- week grid
function renderWeek() {
  const root = $('#week');
  root.replaceChildren();
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const today = startOfDay(+now());
  const workDays = state.settings.workDays;
  const worksOn = (day) => workDays.includes(new Date(day).getDay()) && !isDayOff(day);

  $('#week-title').textContent =
    `${new Date(days[0]).toLocaleDateString([], { month: 'short', day: 'numeric' })} – ` +
    `${new Date(days[6]).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`;

  const [wsH, wsM] = state.settings.workStart.split(':').map(Number);
  const [weH, weM] = state.settings.workEnd.split(':').map(Number);
  let startH = Math.floor((wsH * 60 + wsM) / 60);
  let endH = Math.ceil((weH * 60 + weM) / 60);

  const itemsByDay = days.map((day) => {
    const next = addDays(day, 1);
    const blocks = state.blocks.filter((b) => b.start >= day && b.start < next);
    const busy = state.busy
      .filter((e) => e.end > day && e.start < next)
      .map((e) => ({ ...e, start: Math.max(e.start, day), end: Math.min(e.end, next) }));
    for (const x of [...blocks, ...busy]) {
      startH = Math.min(startH, Math.floor(minuteOfDay(x.start) / 60));
      endH = Math.max(endH, x.end >= next ? 24 : Math.ceil(minuteOfDay(x.end) / 60));
    }
    return { blocks, busy };
  });

  const hours = Math.max(1, endH - startH);
  const pct = (min) => `${(Math.min(Math.max(min - startH * 60, 0), hours * 60) / (hours * 60)) * 100}%`;
  const span = (a, b) => `${((b - a) / (hours * 60)) * 100}%`;

  const inner = h('div', { class: 'week-inner', style: { '--hours': hours } });
  inner.append(h('div', { class: 'week-head' }));
  days.forEach((day) => {
    inner.append(h('div', { class: `week-head${day === today ? ' today' : ''}${worksOn(day) ? '' : ' off'}` },
      new Date(day).toLocaleDateString([], { weekday: 'short' }), h('b', {}, String(new Date(day).getDate()))));
  });

  inner.append(h('div', { class: 'gutter' },
    ...Array.from({ length: hours + 1 }, (_, i) =>
      h('span', { style: { top: `${(i / hours) * 100}%` } }, new Date(2000, 0, 1, startH + i).toLocaleTimeString([], { hour: 'numeric' })))));

  days.forEach((day, i) => {
    const off = isDayOff(day);
    const col = h('div', { class: `col${day === today ? ' today' : ''}${worksOn(day) ? '' : ' off'}` },
      off ? h('div', { class: 'dayoff-tag' }, off.label || 'Day off') : null);

    for (const e of itemsByDay[i].busy) {
      const a = minuteOfDay(e.start);
      const b = e.end >= addDays(day, 1) ? 24 * 60 : minuteOfDay(e.end);
      col.append(h('div', { class: 'block busy', style: { top: pct(a), height: span(a, b) }, title: `${e.title} (busy)` },
        h('b', {}, e.title)));
    }

    for (const b of itemsByDay[i].blocks) {
      const a = minuteOfDay(b.start);
      const z = minuteOfDay(b.end);
      const task = taskOf(b.taskId);
      const label = `${task?.title ?? 'Task'} · ${fmtTime(b.start)}–${fmtTime(b.end)}`;
      col.append(h('button', {
        class: `block ${b.status}${b.auto ? ' needs' : ''}`, type: 'button',
        style: { top: pct(a), height: span(a, z), '--h': taskHue(b.taskId), 'min-height': '16px' },
        title: `${label}${b.status === 'planned' ? ' - click to report' : ` - ${statusText(b)}`}`,
        'aria-label': label,
        onclick: () => openReport(b.id),
      }, h('b', {}, task?.title ?? 'Task'), `${fmtTime(b.start)}`));
    }

    if (day === today) {
      const nm = minuteOfDay(+now());
      if (nm >= startH * 60 && nm <= endH * 60) col.append(h('div', { class: 'nowline', style: { top: pct(nm) } }));
    }
    inner.append(col);
  });
  root.append(inner);
}

// ---- tasks, busy times, days off
function renderTasks() {
  const list = $('#task-list');
  list.replaceChildren();
  $('#task-empty').hidden = state.tasks.length > 0;

  for (const t of state.tasks) {
    const st = taskStatus(state, t.id);
    const pctDone = Math.min(100, Math.round((st.doneMin / t.estimateMin) * 100));
    list.append(h('li', { class: 'task', style: { '--h': taskHue(t.id) } },
      h('span', { class: 'swatch' }),
      h('div', {},
        h('div', { class: 'task-title' }, t.title, ' ',
          st.complete ? h('span', { class: 'tag done' }, 'Done') : null,
          st.late ? h('span', { class: 'tag late' }, 'Late') : null),
        h('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': pctDone, 'aria-valuemin': 0, 'aria-valuemax': 100 },
          h('span', { style: { width: `${pctDone}%` } })),
        h('div', { class: 'task-meta' },
          h('span', { class: 'stars', title: `Importance ${t.importance ?? 3} of 5` }, stars(t.importance)),
          ` ${formatMinutes(st.doneMin)} of ${formatMinutes(t.estimateMin)} done` +
          (t.deadline ? ` · due ${fmtDay(t.deadline)}` : '') +
          (st.lastEnd && !st.complete ? ` · finishes ${fmtDay(st.lastEnd)}` : ''))),
      h('div', { class: 'task-actions' },
        h('button', { class: 'icon-btn', type: 'button', title: 'Edit', 'aria-label': `Edit ${t.title}`, onclick: () => openEdit(t.id) }, '✎'),
        h('button', { class: 'icon-btn', type: 'button', title: 'Delete', 'aria-label': `Delete ${t.title}`, onclick: () => {
          const before = state;
          if (commit((s, n) => removeTask(s, t.id, n))) toast(`Deleted "${t.title}".`, () => { state = replan(before, now()); save(); render(); });
        } }, '✕'))));
  }
}

function renderBusy() {
  const list = $('#busy-list');
  list.replaceChildren();
  const upcoming = state.busy.filter((e) => e.end > +now()).sort((a, b) => a.start - b.start);
  for (const e of upcoming) {
    list.append(h('li', { class: 'task', style: { '--h': 220 } },
      h('span', { class: 'swatch', style: { background: 'var(--muted)' } }),
      h('div', {}, h('div', { class: 'task-title' }, e.title), h('div', { class: 'task-meta' }, `${fmtDay(e.start)}, ${fmtTime(e.start)} – ${fmtTime(e.end)}`)),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remove ${e.title}`, onclick: () => commit((s, n) => removeBusy(s, e.id, n)) }, '✕')));
  }
}

function renderDaysOff() {
  const list = $('#dayoff-list');
  list.replaceChildren();
  const today = dateValue(+now());
  for (const r of (state.settings.daysOff ?? []).filter((r) => r.to >= today)) {
    const from = parseDate(r.from);
    const to = parseDate(r.to);
    list.append(h('li', { class: 'task', style: { '--h': 150 } },
      h('span', { class: 'swatch', style: { background: 'var(--ok)' } }),
      h('div', {},
        h('div', { class: 'task-title' }, r.label || 'Day off'),
        h('div', { class: 'task-meta' }, r.from === r.to ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`)),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remove day off ${r.label || r.from}`,
        onclick: () => commit((s, n) => removeDayOff(s, r.id, n)) }, '✕')));
  }
}

// ------------------------------------------------------------- reporting
function quickReport(blockId, kind) {
  const b = state.blocks.find((x) => x.id === blockId);
  if (!b) return;
  submitReport(blockId, kind === 'full' ? durOf(b) : 0, kind === 'full' ? durOf(b) : 0);
}

function submitReport(blockId, completedMin, spentMin) {
  const b = state.blocks.find((x) => x.id === blockId);
  const taskId = b.taskId;
  if (!commit((s, n) => reportBlock(s, blockId, { completedMin, spentMin }, n))) return;

  const st = taskStatus(state, taskId);
  const title = taskOf(taskId).title;
  if (st.complete) toast(`"${title}" is finished. Nice work!`);
  else if (completedMin >= durOf(b)) toast(`Logged. ${formatMinutes(st.remainingMin)} left on "${title}".`);
  else {
    const next = state.blocks.filter((x) => x.taskId === taskId && x.status === 'planned').sort((p, q) => p.start - q.start)[0];
    toast(`Noted. ${formatMinutes(st.remainingMin)} left on "${title}"` +
      (next ? `, next session ${fmtDay(next.start)} at ${fmtTime(next.start)}.` : ', but nothing fits yet - check your preferences.'));
  }
}

function openReport(blockId, preset) {
  const b = state.blocks.find((x) => x.id === blockId);
  if (!b) return;
  reportingId = blockId;
  const dur = durOf(b);
  const reported = b.status !== 'planned' && !b.auto;
  const form = $('#report-form');
  $('#report-title').textContent = taskOf(b.taskId)?.title ?? 'Session';
  $('#report-when').textContent = `${fmtDay(b.start)}, ${fmtTime(b.start)} – ${fmtTime(b.end)} (${formatMinutes(dur)} planned)`;
  fill(form, reported ? { completed: b.completedMin, spent: b.spentMin } : preset === 'half' ? { completed: Math.round(dur / 2 / 5) * 5, spent: dur } : { completed: dur, spent: dur });
  $('#report-dialog').showModal();
  form.completed.focus();
  form.completed.select();
}

function fill(form, { completed, spent }) {
  form.completed.value = completed;
  form.spent.value = spent;
}

function openEdit(taskId) {
  const t = taskOf(taskId);
  if (!t) return;
  editingId = taskId;
  const f = $('#edit-form');
  f.title.value = t.title;
  f.estimate.value = t.estimateMin;
  f.importance.value = String(t.importance ?? 3);
  f.deadline.value = t.deadline ? dateValue(t.deadline) : '';
  $('#task-dialog').showModal();
}

// ------------------------------------------------------------- settings forms
function fillForms() {
  const f = $('#settings-form');
  const c = state.settings;
  f.workStart.value = c.workStart;
  f.workEnd.value = c.workEnd;
  f.maxBlockMin.value = c.maxBlockMin;
  f.minBlockMin.value = c.minBlockMin;
  f.breakMin.value = c.breakMin;
  f.maxDailyMin.value = c.maxDailyMin;
  f.querySelectorAll('[name=day]').forEach((cb) => (cb.checked = c.workDays.includes(Number(cb.value))));
  fillPolicy();
}

function fillPolicy() {
  const f = $('#policy-form');
  const c = state.settings;
  f.priorityWeight.value = Math.round((c.priorityWeight ?? 0.5) * 100);
  f.protectDeadlines.checked = c.protectDeadlines ?? true;
  f.spread.value = c.spread ?? 'even';
  explainPolicy();
  document.querySelectorAll('[data-preset]').forEach((chip) => {
    const p = PRESETS[chip.dataset.preset];
    chip.setAttribute('aria-pressed', String(p.priorityWeight === (c.priorityWeight ?? 0.5) && p.protectDeadlines === (c.protectDeadlines ?? true) && p.spread === (c.spread ?? 'even')));
  });
}

/** Say in plain words what the sliders currently mean. */
function explainPolicy() {
  const f = $('#policy-form');
  const imp = Number(f.priorityWeight.value);
  const order =
    imp === 0 ? 'Tasks are ordered strictly by deadline: whatever is due soonest comes first.'
      : imp === 100 ? 'Tasks are ordered strictly by importance: your most important work comes first, whatever its deadline.'
        : `Tasks are ordered by a blend: ${imp}% importance, ${100 - imp}% deadline.`;
  const protect = f.protectDeadlines.checked ? ' Anything due today is always done first.' : '';
  const spread = f.spread.value === 'asap' ? ' Work is finished as early as possible.' : ' Work is spread evenly until each deadline.';
  $('#policy-explain').textContent = order + protect + spread;
}

// ------------------------------------------------------------- events
function wire() {
  document.body.classList.toggle('is-extension', isExtension);
  $('#open-full').addEventListener('click', openFullPlanner);

  // accounts
  $('#auth-form').addEventListener('submit', submitAuth);
  $('#tab-login').addEventListener('click', () => setAuthMode('login'));
  $('#tab-register').addEventListener('click', () => setAuthMode('register'));
  $('#auth-dialog').addEventListener('cancel', (e) => e.preventDefault()); // you can't skip signing in
  $('#signout').addEventListener('click', signOut);

  $('#task-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const estimateMin = (Number(f.hours.value) || 0) * 60 + (Number(f.minutes.value) || 0);
    showError('#task-error');
    try {
      state = addTask(state, { title: f.title.value, estimateMin, importance: Number(f.importance.value), deadline: parseDate(f.deadline.value, true) }, now());
    } catch (err) {
      showError('#task-error', err.message);
      return;
    }
    save();
    render();
    const t = state.tasks.at(-1);
    const st = taskStatus(state, t.id);
    const nSessions = state.blocks.filter((b) => b.taskId === t.id && b.status === 'planned').length;
    toast(
      st.late
        ? `Scheduled "${t.title}" in ${nSessions} sessions - but it won't fit before the deadline.`
        : `Scheduled "${t.title}" in ${nSessions} session${nSessions === 1 ? '' : 's'}, starting ${st.firstStart ? `${fmtDay(st.firstStart)} at ${fmtTime(st.firstStart)}` : 'soon'}.`,
    );
    f.title.value = '';
    f.title.focus();
  });

  $('#demo').addEventListener('click', () => {
    const base = startOfDay(+now());
    commit((s, n) => {
      s = addTask(s, { title: 'Write project report', estimateMin: 240, importance: 4, deadline: addDays(base, 4) + DAY - 1000 }, n);
      s = addTask(s, { title: 'Study for exam', estimateMin: 360, importance: 5, deadline: addDays(base, 7) + DAY - 1000 }, n);
      return addTask(s, { title: 'Clear email inbox', estimateMin: 45, importance: 2 }, n);
    });
  });

  // planning style
  const pf = $('#policy-form');
  pf.addEventListener('input', explainPolicy);
  pf.addEventListener('submit', (e) => {
    e.preventDefault();
    const patch = { priorityWeight: Number(pf.priorityWeight.value) / 100, protectDeadlines: pf.protectDeadlines.checked, spread: pf.spread.value };
    if (commit((s, n) => updateSettings(s, patch, n))) { fillPolicy(); toast('Planning style applied. Your plan was rebuilt.'); }
  });
  document.querySelectorAll('[data-preset]').forEach((chip) =>
    chip.addEventListener('click', () => {
      if (commit((s, n) => updateSettings(s, PRESETS[chip.dataset.preset], n))) {
        fillPolicy();
        toast(`${chip.textContent} style applied.`);
      }
    }),
  );

  // days off
  $('#dayoff-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    showError('#dayoff-error');
    try {
      state = addDayOff(state, { from: f.from.value, to: f.to.value || f.from.value, label: f.label.value }, now());
    } catch (err) {
      showError('#dayoff-error', err.message);
      return;
    }
    save();
    render();
    f.reset();
    toast('Day off added. Your sessions were moved to other days.');
  });

  $('#busy-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    showError('#busy-error');
    const day = parseDate(f.date.value, false);
    const [fh, fm] = f.from.value.split(':').map(Number);
    const [th, tm] = f.to.value.split(':').map(Number);
    const d = new Date(day);
    const input = {
      title: f.title.value || 'Busy',
      start: new Date(d.getFullYear(), d.getMonth(), d.getDate(), fh, fm).getTime(),
      end: new Date(d.getFullYear(), d.getMonth(), d.getDate(), th, tm).getTime(),
    };
    try {
      state = addBusy(state, input, now());
    } catch (err) {
      showError('#busy-error', err.message);
      return;
    }
    save();
    render();
    f.title.value = '';
    toast('Time blocked. Your sessions were moved around it.');
  });

  $('#settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    showError('#settings-error');
    const patch = {
      workStart: f.workStart.value,
      workEnd: f.workEnd.value,
      workDays: [...f.querySelectorAll('[name=day]:checked')].map((cb) => Number(cb.value)),
      maxBlockMin: Number(f.maxBlockMin.value),
      minBlockMin: Number(f.minBlockMin.value),
      breakMin: Number(f.breakMin.value),
      maxDailyMin: Number(f.maxDailyMin.value),
    };
    try {
      state = updateSettings(state, patch, now());
    } catch (err) {
      showError('#settings-error', err.message);
      return;
    }
    save();
    render();
    toast('Preferences saved and the plan rebuilt.');
  });

  $('#clock-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const target = new Date(e.target.when.value).getTime();
    if (!Number.isFinite(target)) return;
    clockOffset = target - Date.now();
    commit((s, n) => replan(s, n));
    weekStart = pickWeek();
    renderWeek();
    toast('Time travelled. Overdue sessions now ask for a report.');
  });
  $('#clock-reset').addEventListener('click', () => {
    clockOffset = 0;
    commit((s, n) => replan(s, n));
    weekStart = pickWeek();
    renderWeek();
  });

  $('#export').addEventListener('click', () => {
    const count = state.blocks.filter((b) => b.status === 'planned').length;
    if (!count) return toast('Nothing to export yet - add a task first.');
    const blob = new Blob([toICS(state, now())], { type: 'text/calendar' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'smart-scheduler.ics' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`Exported ${count} session${count === 1 ? '' : 's'}. Open the file to add them to your calendar.`);
  });

  // week navigation
  $('#week-prev').addEventListener('click', () => { weekStart = addDays(weekStart, -7); renderWeek(); });
  $('#week-next').addEventListener('click', () => { weekStart = addDays(weekStart, 7); renderWeek(); });
  $('#week-today').addEventListener('click', () => { weekStart = mondayOf(+now()); renderWeek(); });

  // report dialog
  const rf = $('#report-form');
  rf.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = reportingId;
    $('#report-dialog').close();
    submitReport(id, Number(rf.completed.value), Number(rf.spent.value));
  });
  $('#report-cancel').addEventListener('click', () => $('#report-dialog').close());
  document.querySelectorAll('[data-fill]').forEach((chip) =>
    chip.addEventListener('click', () => {
      const b = state.blocks.find((x) => x.id === reportingId);
      const dur = durOf(b);
      const kind = chip.dataset.fill;
      fill(rf, kind === 'full' ? { completed: dur, spent: dur } : kind === 'half' ? { completed: Math.round(dur / 2 / 5) * 5, spent: dur } : { completed: 0, spent: 0 });
    }),
  );

  // edit dialog
  const ef = $('#edit-form');
  ef.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = editingId;
    const ok = commit((s, n) => updateTask(s, id, {
      title: ef.title.value,
      estimateMin: Number(ef.estimate.value),
      importance: Number(ef.importance.value),
      deadline: parseDate(ef.deadline.value, true),
    }, n));
    if (ok) $('#task-dialog').close();
  });
  $('#edit-cancel').addEventListener('click', () => $('#task-dialog').close());

  // keep the clock, "now" line and overdue sessions fresh; keep syncing with the server
  let ticks = 0;
  setInterval(() => {
    if (!session) return;
    const overdue = state.blocks.some((b) => b.status === 'planned' && b.end <= +now());
    if (overdue) {
      state = replan(state, now());
      save();
    }
    render();
    ticks += 1;
    if (dirty) push();
    else if (ticks % 2 === 0) syncDown(); // pick up changes made on another device
  }, 30_000);
}

/** Show the week that has something in it: this one, or else the week of the next planned session. */
function pickWeek() {
  const thisWeek = mondayOf(+now());
  const inThisWeek = state.blocks.some((b) => b.start >= thisWeek && b.start < addDays(thisWeek, 7));
  const next = state.blocks.filter((b) => b.status === 'planned').sort((a, b) => a.start - b.start)[0];
  return !inThisWeek && next ? mondayOf(next.start) : thisWeek;
}

// ------------------------------------------------------------- start
async function boot() {
  wire();
  weekStart = mondayOf(+now());
  $('#busy-form').date.value = dateValue(+now());
  $('#dayoff-form').from.value = dateValue(addDays(+now(), 1));
  $('#clock-form').when.value = `${dateValue(+now())}T${pad(now().getHours())}:${pad(now().getMinutes())}`;
  fillForms();
  render();

  session = await storage.get(SESSION_KEY);
  if (session?.token && session?.user) await enter();
  else {
    session = null;
    showAuth();
  }
}

boot();
