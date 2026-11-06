// What the Chrome extension should tell the user, as pure functions of the planner state.
// (The background worker calls these once a minute; keeping them here makes them testable.)

const MIN = 60_000;
const DAY = 86_400_000;

const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtLen = (ms) => {
  const m = Math.round(ms / MIN);
  return m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`;
};

/** How many recent sessions are waiting for the user to say how they went (the badge number). */
export function pendingReports(state, now) {
  return state.blocks.filter(
    (b) => b.start >= now - 3 * DAY && ((b.status === 'planned' && b.end <= now) || (b.status === 'missed' && b.auto)),
  ).length;
}

/**
 * Notifications that became due in the window (since, now].
 * `notified` lists ids already shown, so a reminder is never repeated.
 */
export function dueReminders(state, { since, now, notified = [] }) {
  const seen = new Set(notified);
  const titleOf = (b) => state.tasks.find((t) => t.id === b.taskId)?.title ?? 'a task';
  const out = [];
  for (const b of state.blocks) {
    if (b.status !== 'planned') continue;
    const when = `${fmtTime(b.start)} – ${fmtTime(b.end)} (${fmtLen(b.end - b.start)})`;
    if (b.start > since && b.start <= now && b.end > now) {
      out.push({ id: `start:${b.id}`, kind: 'start', blockId: b.id, title: `Time to work on "${titleOf(b)}"`, body: when });
    }
    if (b.end > since && b.end <= now) {
      out.push({ id: `report:${b.id}`, kind: 'report', blockId: b.id, title: `How did "${titleOf(b)}" go?`, body: `${when} - open the planner to report.` });
    }
  }
  return out.filter((r) => !seen.has(r.id)).sort((a, b) => a.id.localeCompare(b.id));
}
