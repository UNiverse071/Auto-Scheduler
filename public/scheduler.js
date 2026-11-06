// Smart Scheduler - the planning engine.
//
// Everything here is a pure function of (state, input, now) -> new state.
// There is no DOM, no localStorage and no hidden clock: `now` is always passed
// in. That keeps the engine unit-testable (see test/scheduler.test.js) and lets
// the UI offer a "time travel" clock for trying out an end-of-day report.
//
// State shape (plain JSON, so it survives localStorage):
//   settings : working hours, block sizes, daily limit ...
//   tasks    : { id, title, estimateMin, deadline|null, createdAt }
//   busy     : { id, title, start, end }              fixed calendar events
//   blocks   : { id, taskId, start, end, status, completedMin, spentMin, auto, reportedAt }
//              status = 'planned' | 'done' | 'partial' | 'missed'
//
// Core idea: only *reported* blocks are history. Every call to replan() throws
// away the future part of the plan and rebuilds it from what is still left to do,
// so "adjusting the plan" is simply "plan again with the latest facts".

const MIN = 60_000;

export const DEFAULT_SETTINGS = Object.freeze({
  workStart: '09:00',
  workEnd: '17:00',
  workDays: [1, 2, 3, 4, 5], // 0 = Sunday
  maxBlockMin: 90, // longest single sitting
  minBlockMin: 25, // shortest sensible sitting
  breakMin: 10, // gap left after each block
  maxDailyMin: 360, // most focused work planned per day
  gridMin: 5, // blocks start on 5-minute marks
  horizonDays: 120, // how far ahead we are willing to plan

  // --- the scheduling policy (what to do first, and how to spread it) ---
  // 0 = strictly by deadline ... 1 = strictly by importance; in between blends the two.
  priorityWeight: 0.5,
  // Work that is due today (or overdue) always goes first, whatever its importance.
  protectDeadlines: true,
  // 'even' = spread a task over the days until its deadline; 'asap' = finish as early as possible.
  spread: 'even',
  // Specific dates with no work: [{ id, from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', label }]
  daysOff: [],
});

export const SPREAD_STYLES = ['even', 'asap'];

/** Data saved by an older version may lack newer settings; fill them in. */
function withDefaults(settings) {
  return { ...DEFAULT_SETTINGS, workDays: [...DEFAULT_SETTINGS.workDays], daysOff: [], ...settings };
}

export function createState(settings = {}) {
  return {
    version: 1,
    seq: 0,
    settings: { ...DEFAULT_SETTINGS, workDays: [...DEFAULT_SETTINGS.workDays], daysOff: [], ...settings },
    tasks: [],
    busy: [],
    blocks: [],
  };
}

// ------------------------------------------------------------ time helpers
// Local-time arithmetic via the Date constructor (not "+ 24h"), so days stay
// correct across daylight-saving changes.
const toMs = (x) => {
  const n = x instanceof Date ? x.getTime() : Number(x);
  if (!Number.isFinite(n)) throw new Error('Invalid date');
  return n;
};
const startOfDay = (ms) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const addDays = (dayMs, n) => {
  const d = new Date(dayMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
};
const atClock = (dayMs, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(dayMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
};
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const minutesOf = (b) => (b.end - b.start) / MIN;

export function formatMinutes(min) {
  const m = Math.round(min);
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h && r) return `${h}h ${r}m`;
  return h ? `${h}h` : `${r}m`;
}

const shortDate = (ms) =>
  new Date(ms).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

// ------------------------------------------------------------ validation
function cleanTaskFields(input, { partial = false } = {}) {
  const out = {};
  if (!partial || 'title' in input) {
    const title = String(input.title ?? '').trim();
    if (!title) throw new Error('A task needs a title');
    out.title = title;
  }
  if (!partial || 'estimateMin' in input) {
    const est = Number(input.estimateMin);
    if (!Number.isFinite(est) || est <= 0) throw new Error('Estimate must be a positive number of minutes');
    out.estimateMin = Math.max(1, Math.round(est));
  }
  if (!partial || 'deadline' in input) {
    out.deadline = input.deadline == null || input.deadline === '' ? null : toMs(input.deadline);
  }
  if (!partial || 'importance' in input) {
    const imp = input.importance == null ? 3 : Number(input.importance);
    if (!Number.isInteger(imp) || imp < 1 || imp > 5) throw new Error('Importance must be a whole number from 1 to 5');
    out.importance = imp;
  }
  return out;
}

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
function validYmd(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str));
  if (!m) return false;
  const [y, mo, d] = m.slice(1).map(Number);
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
}

function nextId(s, prefix) {
  s.seq += 1;
  return `${prefix}${s.seq}`;
}

// ------------------------------------------------------------ state changes
export function addTask(state, input, now) {
  const s = structuredClone(state);
  // paceSince: reports made before this moment are ignored when judging the estimate
  s.tasks.push({ id: nextId(s, 't'), ...cleanTaskFields(input), createdAt: toMs(now), paceSince: 0 });
  return replan(s, now);
}

export function updateTask(state, taskId, patch, now) {
  const s = structuredClone(state);
  const t = s.tasks.find((x) => x.id === taskId);
  if (!t) throw new Error(`Unknown task ${taskId}`);
  const allowed = {};
  for (const k of ['title', 'estimateMin', 'deadline', 'importance']) if (k in patch) allowed[k] = patch[k];
  const before = t.estimateMin;
  Object.assign(t, cleanTaskFields({ ...t, ...allowed }));
  // A new estimate already reflects what the old sessions taught us, so only
  // sessions reported from now on count as evidence about the new one.
  if (t.estimateMin !== before) t.paceSince = toMs(now);
  return replan(s, now);
}

export function removeTask(state, taskId, now) {
  const s = structuredClone(state);
  s.tasks = s.tasks.filter((t) => t.id !== taskId);
  s.blocks = s.blocks.filter((b) => b.taskId !== taskId);
  return replan(s, now);
}

export function addBusy(state, input, now) {
  const s = structuredClone(state);
  const start = toMs(input.start);
  const end = toMs(input.end);
  if (end <= start) throw new Error('An event must end after it starts');
  s.busy.push({ id: nextId(s, 'e'), title: String(input.title ?? 'Busy').trim() || 'Busy', start, end });
  return replan(s, now);
}

export function removeBusy(state, busyId, now) {
  const s = structuredClone(state);
  s.busy = s.busy.filter((e) => e.id !== busyId);
  return replan(s, now);
}

/** Mark one date, or a range of dates, as days off. Dates are 'YYYY-MM-DD'. */
export function addDayOff(state, { from, to, label } = {}, now) {
  const s = structuredClone(state);
  to = to ?? from;
  if (!validYmd(from) || !validYmd(to)) throw new Error('A day off needs a valid date (YYYY-MM-DD)');
  if (to < from) throw new Error('A day off must end on or after the day it starts');
  s.settings.daysOff = [...(s.settings.daysOff ?? []), { id: nextId(s, 'o'), from, to, label: String(label ?? '').trim() }]
    .sort((a, b) => a.from.localeCompare(b.from));
  return replan(s, now);
}

export function removeDayOff(state, id, now) {
  const s = structuredClone(state);
  s.settings.daysOff = (s.settings.daysOff ?? []).filter((d) => d.id !== id);
  return replan(s, now);
}

export function updateSettings(state, patch, now) {
  const s = structuredClone(state);
  const { daysOff, ...rest } = patch; // days off have their own functions
  s.settings = withDefaults(s.settings);
  Object.assign(s.settings, rest);
  const c = s.settings;
  if (!(typeof c.priorityWeight === 'number' && c.priorityWeight >= 0 && c.priorityWeight <= 1)) {
    throw new Error('Invalid setting: priorityWeight must be between 0 and 1');
  }
  if (!SPREAD_STYLES.includes(c.spread)) throw new Error(`Invalid setting: spread must be one of ${SPREAD_STYLES.join(', ')}`);
  c.protectDeadlines = Boolean(c.protectDeadlines);
  if (!Array.isArray(c.workDays) || c.workDays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new Error('Invalid setting: workDays');
  }
  for (const k of ['maxBlockMin', 'minBlockMin', 'breakMin', 'maxDailyMin', 'gridMin']) {
    if (!Number.isFinite(c[k]) || c[k] < 0 || (k !== 'breakMin' && c[k] === 0)) {
      throw new Error(`Invalid setting: ${k}`);
    }
  }
  if (c.minBlockMin > c.maxBlockMin) throw new Error('Minimum block cannot exceed maximum block');
  if (atClock(0, c.workStart) >= atClock(0, c.workEnd)) throw new Error('Work must end after it starts');
  return replan(s, now);
}

/**
 * Report how a block went.
 *   completedMin - minutes of the task's work actually finished
 *   spentMin     - minutes really spent (defaults to the block length, or 0 if nothing done)
 * Reporting the same block again simply overwrites the earlier report.
 */
export function reportBlock(state, blockId, { completedMin, spentMin } = {}, now) {
  const s = structuredClone(state);
  const b = s.blocks.find((x) => x.id === blockId);
  if (!b) throw new Error(`Unknown block ${blockId}`);
  const dur = minutesOf(b);
  const completed = Number(completedMin);
  if (!Number.isFinite(completed) || completed < 0) throw new Error('Completed minutes must be 0 or more');
  const done = Math.round(completed);
  let spent = spentMin == null ? (done === 0 ? 0 : dur) : Number(spentMin);
  if (!Number.isFinite(spent) || spent < 0) throw new Error('Spent minutes must be 0 or more');
  spent = Math.round(spent);

  b.completedMin = done;
  b.spentMin = spent;
  b.status = done >= dur ? 'done' : done === 0 ? 'missed' : 'partial';
  b.auto = false;
  b.reportedAt = toMs(now);
  return replan(s, now);
}

// ------------------------------------------------------------ derived facts
export function taskProgress(state, taskId) {
  const t = state.tasks.find((x) => x.id === taskId);
  if (!t) throw new Error(`Unknown task ${taskId}`);
  const doneMin = sum(
    state.blocks.filter((b) => b.taskId === taskId && b.status !== 'planned').map((b) => b.completedMin),
  );
  const remainingMin = Math.max(0, t.estimateMin - doneMin);
  return { doneMin, remainingMin, complete: remainingMin === 0 };
}

export function taskStatus(state, taskId) {
  const t = state.tasks.find((x) => x.id === taskId);
  const progress = taskProgress(state, taskId);
  const blocks = state.blocks.filter((b) => b.taskId === taskId && b.status === 'planned');
  const plannedMin = sum(blocks.map(minutesOf));
  const unscheduledMin = Math.max(0, progress.remainingMin - plannedMin);
  const lastEnd = blocks.length ? Math.max(...blocks.map((b) => b.end)) : null;
  const firstStart = blocks.length ? Math.min(...blocks.map((b) => b.start)) : null;
  const late =
    t.deadline != null &&
    progress.remainingMin > 0 &&
    (unscheduledMin > 0 || (lastEnd != null && lastEnd > t.deadline));
  return { ...progress, plannedMin, unscheduledMin, firstStart, lastEnd, late };
}

/** How fast has the user really been? Looks at explicit reports only. */
export function paceStats(state, { taskId, since = 0 } = {}) {
  const explicit = state.blocks
    .filter((b) => b.status !== 'planned' && !b.auto && b.reportedAt > since && (!taskId || b.taskId === taskId))
    .sort((a, b) => a.reportedAt - b.reportedAt)
    .slice(-10); // recent behaviour matters most
  const worked = explicit.filter((b) => b.spentMin > 0);
  const spent = sum(worked.map((b) => b.spentMin));
  return {
    reports: worked.length,
    efficiency: worked.length ? Math.round((sum(worked.map((b) => b.completedMin)) / spent) * 100) / 100 : null,
    missed: explicit.filter((b) => b.status === 'missed').length,
    sessions: explicit.length,
  };
}

// ------------------------------------------------------------ the planner
function subtract(windows, occupied) {
  let out = windows;
  for (const [os, oe] of occupied) {
    const next = [];
    for (const [ws, we] of out) {
      if (oe <= ws || os >= we) next.push([ws, we]);
      else {
        if (os > ws) next.push([ws, os]);
        if (oe < we) next.push([oe, we]);
      }
    }
    out = next;
  }
  return out;
}

/**
 * Rebuild the future plan. Steps:
 *  1. Settle the old plan: blocks that ended unreported become "missed" (auto),
 *     a block happening right now stays, future planned blocks are discarded.
 *  2. For each day, in order, for each unfinished task (earliest deadline first):
 *     work out today's share, cut it into similar-sized blocks, and drop them
 *     into the first free windows (after busy events and earlier blocks).
 */
export function replan(state, now) {
  const s = structuredClone(state);
  const nowMs = toMs(now);
  s.settings = withDefaults(s.settings);
  for (const t of s.tasks) t.importance ??= 3;
  const cfg = s.settings;
  const gridMs = cfg.gridMin * MIN;
  const breakMs = cfg.breakMin * MIN;
  const ceilTo = (ms) => Math.ceil(ms / gridMs) * gridMs;
  const ceilGrid = (min) => Math.ceil(min / cfg.gridMin - 1e-9) * cfg.gridMin;
  const floorGrid = (min) => Math.floor(min / cfg.gridMin + 1e-9) * cfg.gridMin;

  // 1. settle the old plan
  const taskIds = new Set(s.tasks.map((t) => t.id));
  const base = [];
  for (const b of s.blocks) {
    if (!taskIds.has(b.taskId)) continue;
    if (b.status !== 'planned') base.push(b);
    else if (b.end <= nowMs) {
      base.push({ ...b, status: 'missed', completedMin: 0, spentMin: 0, auto: true, reportedAt: nowMs });
    } else if (b.start < nowMs) base.push(b); // in progress: leave it alone
  }

  const dayOf = (b) => startOfDay(b.start);
  const reportedOrRunning = base;
  const doneOnDay = (taskId, day) =>
    sum(
      reportedOrRunning
        .filter((b) => b.taskId === taskId && dayOf(b) === day)
        .map((b) => (b.status === 'planned' ? minutesOf(b) : b.completedMin)),
    );
  const workedOnDay = (day) =>
    sum(
      reportedOrRunning
        .filter((b) => dayOf(b) === day)
        .map((b) => (b.status === 'planned' ? minutesOf(b) : b.spentMin)),
    );

  // what still has to be placed
  const active = s.tasks
    .map((task) => {
      const mine = base.filter((b) => b.taskId === task.id);
      const done = sum(mine.filter((b) => b.status !== 'planned').map((b) => b.completedMin));
      const running = sum(mine.filter((b) => b.status === 'planned').map(minutesOf));
      return { task, left: Math.max(0, task.estimateMin - done - running) };
    })
    .filter((a) => a.left > 0)
    .sort(
      (a, b) =>
        (a.task.deadline ?? Infinity) - (b.task.deadline ?? Infinity) ||
        a.task.createdAt - b.task.createdAt ||
        a.task.id.localeCompare(b.task.id, undefined, { numeric: true }),
    );

  // time that is already taken: calendar events and our own earlier blocks (+ break)
  const occupied = [
    ...s.busy.map((e) => [e.start, e.end]),
    ...base.map((b) => [b.start, b.end + breakMs]),
  ];

  const day0 = startOfDay(nowMs);
  const isDayOff = (d) => {
    const key = ymd(d);
    return cfg.daysOff.some((r) => key >= r.from && key <= r.to);
  };
  const days = [];
  for (let i = 0; i <= cfg.horizonDays; i++) {
    const d = addDays(day0, i);
    if (cfg.workDays.includes(new Date(d).getDay()) && !isDayOff(d)) days.push(d);
  }
  // Working days from `d` up to and including the deadline's day (0 once overdue, Infinity if no deadline).
  const workDaysUntil = (d, deadline) => {
    if (deadline == null) return Infinity;
    const last = startOfDay(deadline);
    return days.filter((x) => x >= d && x <= last).length;
  };

  // What to work on first today: a blend of urgency (working days to the deadline) and
  // importance, controlled by priorityWeight; work due today is protected if asked.
  const w = cfg.priorityWeight;
  const orderFor = (day) =>
    active
      .map((a) => {
        const left = workDaysUntil(day, a.task.deadline);
        const urgency = left === Infinity ? 1 : Math.min(left, 30) / 30; // 0 = due now
        const unimportance = 1 - ((a.task.importance ?? 3) - 1) / 4; // 0 = most important
        return {
          a,
          key: (1 - w) * urgency + w * unimportance,
          protect: cfg.protectDeadlines && a.task.deadline != null && left <= 1 ? 1 : 0,
        };
      })
      .sort(
        (x, y) =>
          y.protect - x.protect ||
          x.key - y.key ||
          (x.a.task.deadline ?? Infinity) - (y.a.task.deadline ?? Infinity) ||
          x.a.task.createdAt - y.a.task.createdAt ||
          x.a.task.id.localeCompare(y.a.task.id, undefined, { numeric: true }),
      )
      .map((x) => x.a);

  // 2. place the work
  const created = [];
  for (const day of days) {
    if (active.every((a) => a.left <= 0)) break;

    const from = Math.max(atClock(day, cfg.workStart), ceilTo(nowMs));
    let windows = subtract([[from, atClock(day, cfg.workEnd)]], occupied)
      .map(([a, b]) => [ceilTo(a), b])
      .filter(([a, b]) => b - a >= gridMs)
      .sort((x, y) => x[0] - y[0]);
    let budget = cfg.maxDailyMin - workedOnDay(day);

    for (const a of orderFor(day)) {
      if (a.left <= 0 || budget <= 0) continue;

      // today's share: spread what is left evenly over the working days until the deadline
      let quota = a.left;
      if (a.task.deadline != null && cfg.spread === 'even') {
        const doneToday = doneOnDay(a.task.id, day);
        const n = Math.max(1, workDaysUntil(day, a.task.deadline));
        quota = ceilGrid((a.left + doneToday) / n) - doneToday;
      }
      if (quota <= 0) continue;
      quota = Math.min(quota, a.left);
      quota = Math.max(quota, Math.min(a.left, cfg.minBlockMin)); // no slivers
      if (a.left - quota > 0 && a.left - quota < cfg.minBlockMin) quota = a.left; // absorb a tiny tail
      if (budget < Math.min(cfg.minBlockMin, quota)) continue;
      quota = Math.min(quota, budget);

      // cut the share into similar-sized blocks, e.g. 100 -> 50 + 50 rather than 90 + 10
      while (quota > 0) {
        const parts = Math.ceil(quota / cfg.maxBlockMin);
        const size = Math.min(cfg.maxBlockMin, quota, ceilGrid(quota / parts));
        const need = Math.min(cfg.minBlockMin, size);

        let w = windows.find(([x, y]) => (y - x) / MIN >= size);
        let len = size;
        if (!w) {
          w = windows.find(([x, y]) => floorGrid((y - x) / MIN) >= need);
          if (!w) break; // nowhere left today
          len = floorGrid((w[1] - w[0]) / MIN);
        }

        const start = w[0];
        created.push({
          id: `${a.task.id}@${start}`,
          taskId: a.task.id,
          start,
          end: start + len * MIN,
          status: 'planned',
          completedMin: 0,
          spentMin: 0,
          auto: false,
          reportedAt: null,
        });
        w[0] = ceilTo(start + len * MIN + breakMs);
        windows = windows.filter(([x, y]) => y - x >= gridMs);
        quota -= len;
        budget -= len;
        a.left -= len;
      }
    }
  }

  s.blocks = [...base, ...created].sort((x, y) => x.start - y.start || x.id.localeCompare(y.id));
  return s;
}

// ------------------------------------------------------------ advice
const SEVERITY = { alert: 0, warn: 1, info: 2 };

export function recommendations(state, now) {
  const cfg = state.settings;
  const recs = [];
  const grid = (min) => Math.round(min / cfg.gridMin) * cfg.gridMin;
  const ceilGrid = (min) => Math.ceil(min / cfg.gridMin - 1e-9) * cfg.gridMin;

  for (const t of state.tasks) {
    const st = taskStatus(state, t.id);
    if (st.remainingMin <= 0) continue;

    // 1. a deadline we cannot meet
    if (st.late) {
      const after = sum(
        state.blocks
          .filter((b) => b.taskId === t.id && b.status === 'planned' && b.end > t.deadline)
          .map((b) => (b.end - Math.max(b.start, t.deadline)) / MIN),
      );
      const extraMinNeeded = Math.round(after + st.unscheduledMin);
      recs.push({
        type: 'deadline-risk',
        severity: 'alert',
        taskId: t.id,
        extraMinNeeded,
        message:
          `"${t.title}" won't be finished by ${shortDate(t.deadline)}: about ${formatMinutes(extraMinNeeded)} ` +
          `would spill past it. Extend the deadline, clear some calendar time, or raise your daily work limit.`,
      });
    }

    // 2. estimates that look too optimistic. Only for tasks the user has started:
    //    their own pace if we have enough data on them, otherwise their overall pace.
    const since = t.paceSince ?? 0;
    const own = paceStats(state, { taskId: t.id, since });
    const overall = paceStats(state, { since });
    const pace = own.reports >= 2 ? own : overall.reports >= 2 && own.sessions > 0 ? overall : null;
    if (pace && pace.efficiency < 0.85) {
      const eff = Math.max(0.25, pace.efficiency);
      const suggestedEstimateMin = ceilGrid(st.doneMin + st.remainingMin / eff);
      if (suggestedEstimateMin > t.estimateMin) {
        recs.push({
          type: 'rescale',
          severity: 'warn',
          taskId: t.id,
          efficiency: pace.efficiency,
          suggestedEstimateMin,
          message:
            `You're getting through about ${Math.round(pace.efficiency * 100)}% of what you plan in each session. ` +
            `At that pace "${t.title}" needs roughly ${formatMinutes(suggestedEstimateMin)} in total, not ${formatMinutes(t.estimateMin)}.`,
        });
      }
    }
  }

  // 3. several recent sessions missed
  const recent = state.blocks
    .filter((b) => b.status !== 'planned' && !b.auto)
    .sort((a, b) => a.reportedAt - b.reportedAt)
    .slice(-4);
  const misses = recent.filter((b) => b.status === 'missed').length;
  if (recent.length >= 3 && misses >= 2) {
    const maxBlockMin = Math.max(cfg.minBlockMin, grid((cfg.maxBlockMin * 2) / 3));
    const maxDailyMin = Math.max(maxBlockMin, grid(cfg.maxDailyMin * 0.8));
    const patch = {};
    if (maxBlockMin < cfg.maxBlockMin) patch.maxBlockMin = maxBlockMin;
    if (maxDailyMin < cfg.maxDailyMin) patch.maxDailyMin = maxDailyMin;
    recs.push({
      type: 'repeated-miss',
      severity: 'warn',
      patch: Object.keys(patch).length ? patch : null,
      message:
        `You couldn't do ${misses} of your last ${recent.length} sessions. A lighter plan tends to stick better` +
        (Object.keys(patch).length
          ? `: shorter sittings (${formatMinutes(maxBlockMin)} max) and about ${formatMinutes(maxDailyMin)} of focused work a day.`
          : ' - consider adding free time to your calendar or trimming your task list.'),
    });
  }

  // 4. time-of-day pattern
  const worked = state.blocks.filter((b) => b.status !== 'planned' && !b.auto && b.spentMin > 0);
  const eff = (list) => sum(list.map((b) => b.completedMin)) / sum(list.map((b) => b.spentMin));
  const morning = worked.filter((b) => new Date(b.start).getHours() < 12);
  const afternoon = worked.filter((b) => new Date(b.start).getHours() >= 12);
  if (morning.length >= 2 && afternoon.length >= 2) {
    const m = eff(morning);
    const a = eff(afternoon);
    if (Math.abs(m - a) >= 0.2) {
      const better = a > m ? 'afternoon' : 'morning';
      recs.push({
        type: 'best-time',
        severity: 'info',
        better,
        morningEfficiency: Math.round(m * 100) / 100,
        afternoonEfficiency: Math.round(a * 100) / 100,
        message:
          `You get far more done in the ${better} (${Math.round(Math.max(m, a) * 100)}% vs ` +
          `${Math.round(Math.min(m, a) * 100)}%). Keep your hardest work there and consider shifting your work hours.`,
      });
    }
  }

  return recs.sort((x, y) => SEVERITY[x.severity] - SEVERITY[y.severity]);
}

export function applyRecommendation(state, rec, now) {
  if (rec.type === 'rescale') {
    return updateTask(state, rec.taskId, { estimateMin: rec.suggestedEstimateMin }, now);
  }
  if (rec.type === 'repeated-miss' && rec.patch) return updateSettings(state, rec.patch, now);
  return state;
}

// ------------------------------------------------------------ calendar export
const icsStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsEscape = (t) =>
  String(t).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// RFC 5545: lines longer than 75 characters are folded with CRLF + space.
const icsFold = (line) => (line.length <= 75 ? line : line.match(/.{1,74}/g).join('\r\n '));

/** An .ics file of the still-to-do blocks. Import it into Google, Outlook or Apple Calendar. */
export function toICS(state, now) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Smart Scheduler//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  const upcoming = state.blocks.filter((b) => b.status === 'planned').sort((a, b) => a.start - b.start);
  for (const b of upcoming) {
    const task = state.tasks.find((t) => t.id === b.taskId);
    const siblings = upcoming.filter((x) => x.taskId === b.taskId);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${b.id}@smart-scheduler`,
      `DTSTAMP:${icsStamp(toMs(now))}`,
      `DTSTART:${icsStamp(b.start)}`,
      `DTEND:${icsStamp(b.end)}`,
      `SUMMARY:${icsEscape(task.title)}`,
      `DESCRIPTION:${icsEscape(`Work session ${siblings.indexOf(b) + 1} of ${siblings.length} (${formatMinutes(minutesOf(b))})`)}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}
