// Tests for the scheduling engine. Written BEFORE the implementation (test-first).
//
// The engine is a set of pure functions: (state, input, now) -> new state.
// Passing `now` explicitly (instead of calling Date.now()) is what makes
// time-dependent behaviour testable: we can "travel" to any moment we like.
//
// All dates are built with local-time constructors so the tests behave the
// same in every time zone. November 2026: the 9th is a Monday.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createState,
  addTask,
  removeTask,
  updateTask,
  addBusy,
  replan,
  reportBlock,
  taskProgress,
  taskStatus,
  paceStats,
  recommendations,
  applyRecommendation,
  toICS,
} from '../public/scheduler.js';

// ---------------------------------------------------------------- helpers
const MIN = 60_000;
const at = (day, hour = 0, minute = 0) => new Date(2026, 10, day, hour, minute);
const endOfDay = (day) => new Date(2026, 10, day, 23, 59, 59);
const minutesOf = (b) => (b.end - b.start) / MIN;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const planned = (s) =>
  s.blocks.filter((b) => b.status === 'planned').sort((a, b) => a.start - b.start);
const plannedFor = (s, taskId) => planned(s).filter((b) => b.taskId === taskId);
const plannedMinutes = (s, taskId) =>
  sum((taskId ? plannedFor(s, taskId) : planned(s)).map(minutesOf));
const dayOf = (ms) => new Date(ms).getDate();
const minuteOfDay = (ms) => new Date(ms).getHours() * 60 + new Date(ms).getMinutes();
const shape = (s) => planned(s).map(({ taskId, start, end }) => ({ taskId, start, end }));

function assertNoOverlap(blocks) {
  const sorted = [...blocks].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(
      sorted[i].start >= sorted[i - 1].end,
      `blocks overlap: ${new Date(sorted[i - 1].start)} - ${new Date(sorted[i - 1].end)} vs ${new Date(sorted[i].start)}`,
    );
  }
}

/** Create a state with the given tasks, all added at `now`. */
function setup(tasks, { settings, now = at(9, 9) } = {}) {
  let s = createState(settings);
  for (const t of tasks) s = addTask(s, t, now);
  return s;
}

/**
 * Report the earliest planned block, "now" being its end.
 * Pass `null` as completedMin to mean "finished the whole block".
 */
function finishNext(s, completedMin, spentMin) {
  const b = planned(s)[0];
  return reportBlock(s, b.id, { completedMin: completedMin ?? minutesOf(b), spentMin }, new Date(b.end));
}

/** Push an already-reported block straight into the state (for pace tests). */
function withReported(s, taskId, start, durMin, completedMin, spentMin) {
  const copy = structuredClone(s);
  copy.blocks.push({
    id: `${taskId}@${+start}`,
    taskId,
    start: +start,
    end: +start + durMin * MIN,
    status: completedMin >= durMin ? 'done' : completedMin === 0 ? 'missed' : 'partial',
    completedMin,
    spentMin,
    auto: false,
    reportedAt: +start + durMin * MIN,
  });
  return copy;
}

test('sanity: the calendar the tests assume', () => {
  assert.equal(at(9).getDay(), 1, 'Nov 9 2026 should be a Monday');
  assert.equal(at(13).getDay(), 5, 'Nov 13 2026 should be a Friday');
});

// ------------------------------------------------------------ task input
describe('adding tasks', () => {
  test('rejects an empty title', () => {
    assert.throws(() => addTask(createState(), { title: '  ', estimateMin: 30 }, at(9, 9)));
  });

  test('rejects zero, negative and non-numeric estimates', () => {
    for (const estimateMin of [0, -15, NaN, 'abc', undefined]) {
      assert.throws(() => addTask(createState(), { title: 'x', estimateMin }, at(9, 9)));
    }
  });

  test('does not mutate the state it was given', () => {
    const before = createState();
    const snapshot = structuredClone(before);
    addTask(before, { title: 'x', estimateMin: 60 }, at(9, 9));
    assert.deepEqual(before, snapshot);
  });

  test('removing a task removes its blocks and keeps the others', () => {
    let s = setup([
      { title: 'A', estimateMin: 60 },
      { title: 'B', estimateMin: 60 },
    ]);
    const [a, b] = s.tasks;
    s = removeTask(s, a.id, at(9, 9));
    assert.equal(s.tasks.length, 1);
    assert.equal(plannedFor(s, a.id).length, 0);
    assert.equal(plannedMinutes(s, b.id), 60);
  });

  test('changing an estimate re-plans the task', () => {
    let s = setup([{ title: 'A', estimateMin: 60 }]);
    s = updateTask(s, s.tasks[0].id, { estimateMin: 150 }, at(9, 9));
    assert.equal(plannedMinutes(s), 150);
  });
});

// -------------------------------------------------- distributing the work
describe('distributing a task into time slots', () => {
  test('a short task becomes a single block of exactly its estimate, starting now', () => {
    const s = setup([{ title: 'Reply to email', estimateMin: 45 }]);
    const blocks = planned(s);
    assert.equal(blocks.length, 1);
    assert.equal(minutesOf(blocks[0]), 45);
    assert.equal(blocks[0].start, +at(9, 9));
  });

  test('a long task is split into parts that add up to the estimate', () => {
    const s = setup([{ title: 'Write report', estimateMin: 300 }]);
    const blocks = planned(s);
    assert.ok(blocks.length > 1, 'should be split');
    assert.equal(sum(blocks.map(minutesOf)), 300);
    for (const b of blocks) {
      assert.ok(minutesOf(b) <= s.settings.maxBlockMin, 'block longer than max');
      assert.ok(minutesOf(b) >= s.settings.minBlockMin, 'block shorter than min');
    }
  });

  test('never schedules outside working hours or on non-working days', () => {
    const s = setup([{ title: 'Big project', estimateMin: 1500 }], { now: at(13, 15) }); // Fri 3pm
    const blocks = planned(s);
    assert.equal(sum(blocks.map(minutesOf)), 1500);
    for (const b of blocks) {
      const dow = new Date(b.start).getDay();
      assert.ok(dow >= 1 && dow <= 5, 'scheduled on a weekend');
      assert.ok(minuteOfDay(b.start) >= 9 * 60, 'starts before work hours');
      assert.ok(minuteOfDay(b.end) <= 17 * 60, 'ends after work hours');
    }
    assert.ok(blocks.some((b) => dayOf(b.start) === 16), 'should continue on Monday the 16th');
  });

  test('leaves a break between consecutive blocks', () => {
    const s = setup([{ title: 'Deep work', estimateMin: 240 }]);
    const blocks = planned(s);
    assert.ok(blocks.length >= 2);
    for (let i = 1; i < blocks.length; i++) {
      if (dayOf(blocks[i].start) === dayOf(blocks[i - 1].end)) {
        assert.ok(blocks[i].start - blocks[i - 1].end >= s.settings.breakMin * MIN);
      }
    }
  });

  test('never schedules in the past (rounded up to the 5-minute grid)', () => {
    const s = setup([{ title: 'A', estimateMin: 60 }], { now: at(9, 11, 3) });
    assert.equal(planned(s)[0].start, +at(9, 11, 5));
  });

  test('after working hours, the first block is the next working morning', () => {
    const s = setup([{ title: 'A', estimateMin: 60 }], { now: at(13, 18) }); // Fri 6pm
    assert.equal(planned(s)[0].start, +at(16, 9));
  });

  test('respects the maximum amount of work per day', () => {
    const s = setup([{ title: 'Huge', estimateMin: 600 }]);
    const monday = planned(s).filter((b) => dayOf(b.start) === 9);
    assert.ok(sum(monday.map(minutesOf)) <= s.settings.maxDailyMin);
    assert.equal(plannedMinutes(s), 600);
    assert.ok(planned(s).some((b) => dayOf(b.start) === 10), 'spills to Tuesday');
  });

  test('plans around busy calendar events', () => {
    let s = setup([{ title: 'A', estimateMin: 60 }]); // 9:00-10:00
    s = addBusy(s, { title: 'Meeting', start: at(9, 9, 30), end: at(9, 10, 30) }, at(9, 9));
    const [block] = planned(s);
    assert.equal(block.start, +at(9, 10, 30));
    assert.equal(minutesOf(block), 60);
  });

  test('spreads a deadline task evenly over the days available', () => {
    const s = setup([{ title: 'Thesis chapter', estimateMin: 360, deadline: endOfDay(11) }]); // Mon-Wed
    const perDay = [9, 10, 11].map((d) =>
      sum(planned(s).filter((b) => dayOf(b.start) === d).map(minutesOf)),
    );
    assert.deepEqual(perDay, [120, 120, 120]);
    assert.equal(taskStatus(s, s.tasks[0].id).late, false);
  });

  test('earliest deadline goes first, regardless of the order tasks were added', () => {
    const s = setup([
      { title: 'B (later)', estimateMin: 60, deadline: endOfDay(10) },
      { title: 'A (sooner)', estimateMin: 60, deadline: endOfDay(9) },
    ]);
    const [a, b] = [s.tasks[1], s.tasks[0]];
    assert.equal(planned(s)[0].taskId, a.id);
    assert.equal(plannedMinutes(s, a.id), 60);
    assert.equal(plannedMinutes(s, b.id), 60);
  });

  test('no two blocks ever overlap, even with many tasks', () => {
    const s = setup([
      { title: 'A', estimateMin: 200, deadline: endOfDay(11) },
      { title: 'B', estimateMin: 330 },
      { title: 'C', estimateMin: 45, deadline: endOfDay(9) },
      { title: 'D', estimateMin: 500, deadline: endOfDay(13) },
    ]);
    assertNoOverlap(planned(s));
  });

  test('a task that cannot meet its deadline is flagged late (and still scheduled)', () => {
    const s = setup([{ title: 'Too much', estimateMin: 1200, deadline: endOfDay(10) }]); // Mon-Tue
    const status = taskStatus(s, s.tasks[0].id);
    assert.equal(status.late, true);
    assert.ok(status.lastEnd > +endOfDay(10));
    assert.equal(plannedMinutes(s), 1200);
  });

  test('re-planning is idempotent and survives a JSON round-trip (localStorage)', () => {
    const now = at(9, 9);
    const s = setup([
      { title: 'A', estimateMin: 300, deadline: endOfDay(12) },
      { title: 'B', estimateMin: 120 },
    ]);
    assert.deepEqual(shape(replan(s, now)), shape(s));
    const revived = JSON.parse(JSON.stringify(s));
    assert.deepEqual(replan(revived, now), s);
  });
});

// ------------------------------------------------------------- reporting
describe('reporting progress and re-planning', () => {
  const twoHour = () => setup([{ title: 'Essay', estimateMin: 120 }]); // 60 + 60

  test('reporting a block as done reduces what is left', () => {
    let s = twoHour();
    s = finishNext(s, 60);
    const id = s.tasks[0].id;
    assert.deepEqual(
      { done: taskProgress(s, id).doneMin, left: taskProgress(s, id).remainingMin },
      { done: 60, left: 60 },
    );
    assert.equal(plannedMinutes(s, id), 60);
    assert.equal(s.blocks.filter((b) => b.status === 'done').length, 1);
  });

  test('a partly finished block carries the unfinished minutes forward', () => {
    let s = twoHour();
    s = finishNext(s, 30, 60); // did 30 of 60
    const id = s.tasks[0].id;
    assert.equal(taskProgress(s, id).remainingMin, 90);
    assert.equal(plannedMinutes(s, id), 90);
    assert.equal(s.blocks.find((b) => b.status === 'partial').completedMin, 30);
  });

  test('a missed block is remembered, and the work is rescheduled later', () => {
    let s = twoHour();
    const missedId = planned(s)[0].id;
    s = finishNext(s, 0);
    const id = s.tasks[0].id;
    assert.equal(s.blocks.find((b) => b.id === missedId).status, 'missed');
    assert.equal(taskProgress(s, id).remainingMin, 120);
    assert.equal(plannedMinutes(s, id), 120);
    assertNoOverlap(s.blocks);
    assert.ok(planned(s)[0].start >= s.blocks.find((b) => b.id === missedId).end);
  });

  test('reported blocks are never moved or overwritten by later re-plans', () => {
    let s = twoHour();
    s = finishNext(s, 60);
    const done = structuredClone(s.blocks.find((b) => b.status === 'done'));
    s = replan(s, at(9, 14));
    assert.deepEqual(s.blocks.find((b) => b.id === done.id), done);
  });

  test('re-reporting a block corrects progress instead of double counting', () => {
    let s = twoHour();
    const id = s.tasks[0].id;
    const blockId = planned(s)[0].id;
    s = reportBlock(s, blockId, { completedMin: 0 }, at(9, 10));
    assert.equal(taskProgress(s, id).remainingMin, 120);
    s = reportBlock(s, blockId, { completedMin: 60 }, at(9, 10, 5));
    assert.equal(taskProgress(s, id).doneMin, 60);
    assert.equal(taskProgress(s, id).remainingMin, 60);
    assert.equal(plannedMinutes(s, id), 60);
  });

  test('blocks that passed without any report are marked missed automatically', () => {
    let s = twoHour(); // 9:00-10:00 and 10:10-11:10
    s = replan(s, at(9, 12)); // user never reported anything
    const id = s.tasks[0].id;
    const old = s.blocks.filter((b) => b.status === 'missed');
    assert.equal(old.length, 2);
    assert.ok(old.every((b) => b.auto === true));
    assert.equal(taskProgress(s, id).remainingMin, 120);
    assert.equal(plannedMinutes(s, id), 120);
    assert.ok(planned(s)[0].start >= +at(9, 12));
  });

  test('a block that is in progress right now stays where it is', () => {
    let s = twoHour();
    const first = planned(s)[0];
    s = replan(s, at(9, 9, 30));
    const still = planned(s).find((b) => b.id === first.id);
    assert.ok(still, 'in-progress block should survive');
    assert.equal(still.start, first.start);
    assert.equal(plannedMinutes(s), 120);
    assertNoOverlap(planned(s));
  });

  test('a missed day raises the daily amount so the deadline is still met', () => {
    // 360 min over Mon-Wed = 120/day. Skip all of Monday's work.
    let s = setup([{ title: 'Thesis', estimateMin: 360, deadline: endOfDay(11) }]);
    s = replan(s, at(10, 9)); // Tuesday morning, nothing reported for Monday
    const tue = sum(planned(s).filter((b) => dayOf(b.start) === 10).map(minutesOf));
    const wed = sum(planned(s).filter((b) => dayOf(b.start) === 11).map(minutesOf));
    assert.equal(tue, 180);
    assert.equal(wed, 180);
    assert.equal(taskStatus(s, s.tasks[0].id).late, false);
  });

  test('rejects reports for unknown blocks or negative minutes', () => {
    const s = twoHour();
    assert.throws(() => reportBlock(s, 'nope', { completedMin: 10 }, at(9, 10)));
    assert.throws(() => reportBlock(s, planned(s)[0].id, { completedMin: -5 }, at(9, 10)));
  });
});

// ------------------------------------------------------------ pace + advice
describe('pace tracking and recommendations', () => {
  test('efficiency is work completed divided by time actually spent', () => {
    let s = setup([{ title: 'A', estimateMin: 600 }]);
    s = withReported(s, s.tasks[0].id, at(9, 9), 60, 30, 60);
    s = withReported(s, s.tasks[0].id, at(9, 10, 10), 60, 60, 60);
    const pace = paceStats(s);
    assert.equal(pace.reports, 2);
    assert.equal(pace.efficiency, 0.75);
  });

  test('automatically-missed blocks do not count as evidence of being slow', () => {
    let s = setup([{ title: 'A', estimateMin: 120 }]);
    s = replan(s, at(9, 12));
    const pace = paceStats(s);
    assert.equal(pace.reports, 0);
    assert.equal(pace.efficiency, null);
  });

  test('no advice while the user is on track', () => {
    let s = setup([{ title: 'A', estimateMin: 240 }]);
    s = finishNext(s, null);
    s = finishNext(s, null);
    assert.deepEqual(recommendations(s, at(9, 12)), []);
  });

  test('a slow user is told the estimate is probably too low, with a new figure', () => {
    let s = setup([{ title: 'Slow task', estimateMin: 240 }], { settings: { maxBlockMin: 60 } });
    s = finishNext(s, 30, 60);
    s = finishNext(s, 30, 60); // efficiency 0.5, 60 done, 180 left
    const id = s.tasks[0].id;
    const rec = recommendations(s, at(9, 11, 10)).find((r) => r.type === 'rescale');
    assert.ok(rec, 'expected a rescale recommendation');
    assert.equal(rec.taskId, id);
    assert.equal(rec.efficiency, 0.5);
    assert.equal(rec.suggestedEstimateMin, 60 + 180 / 0.5); // 420

    const applied = applyRecommendation(s, rec, at(9, 11, 10));
    assert.equal(applied.tasks[0].estimateMin, 420);
    assert.equal(plannedMinutes(applied, id), 360);
  });

  test('after the estimate is raised, old slow sessions are not held against it again', () => {
    let s = setup([{ title: 'Slow task', estimateMin: 240 }], { settings: { maxBlockMin: 60 } });
    s = finishNext(s, 30, 60);
    s = finishNext(s, 30, 60);
    const now = at(9, 11, 10);
    const rec = recommendations(s, now).find((r) => r.type === 'rescale');
    s = applyRecommendation(s, rec, now);
    assert.equal(
      recommendations(s, now).filter((r) => r.type === 'rescale').length,
      0,
      'would compound: suggests raising an already-raised estimate',
    );

    // ...but fresh evidence of slowness after the change is taken seriously.
    s = finishNext(s, 30, 60);
    s = finishNext(s, 30, 60);
    assert.equal(recommendations(s, at(9, 14)).filter((r) => r.type === 'rescale').length, 1);
  });

  test('editing an estimate by hand also starts the pace measurement afresh', () => {
    let s = setup([{ title: 'Slow task', estimateMin: 240 }], { settings: { maxBlockMin: 60 } });
    s = finishNext(s, 30, 60);
    s = finishNext(s, 30, 60);
    s = updateTask(s, s.tasks[0].id, { estimateMin: 500 }, at(9, 11, 10));
    assert.equal(recommendations(s, at(9, 11, 10)).filter((r) => r.type === 'rescale').length, 0);
  });

  test('only tasks the user has actually started get a re-estimate suggestion', () => {
    let s = setup(
      [
        { title: 'Started', estimateMin: 240 },
        { title: 'Untouched', estimateMin: 240 },
      ],
      { settings: { maxBlockMin: 60 } },
    );
    const [started, untouched] = s.tasks;
    s = withReported(s, started.id, at(9, 9), 60, 30, 60);
    s = withReported(s, started.id, at(9, 10, 10), 60, 30, 60);
    s = replan(s, at(9, 11, 20));
    const recs = recommendations(s, at(9, 11, 20)).filter((r) => r.type === 'rescale');
    assert.deepEqual(recs.map((r) => r.taskId), [started.id]);
    assert.ok(!recs.some((r) => r.taskId === untouched.id));
  });

  test('one slow session is not enough to give advice', () => {
    let s = setup([{ title: 'A', estimateMin: 240 }], { settings: { maxBlockMin: 60 } });
    s = finishNext(s, 20, 60);
    assert.equal(recommendations(s, at(9, 10, 10)).filter((r) => r.type === 'rescale').length, 0);
  });

  test('warns when a deadline can no longer be met', () => {
    const s = setup([{ title: 'Too much', estimateMin: 1200, deadline: endOfDay(10) }]);
    const rec = recommendations(s, at(9, 9)).find((r) => r.type === 'deadline-risk');
    assert.ok(rec);
    assert.equal(rec.taskId, s.tasks[0].id);
    assert.ok(rec.extraMinNeeded > 0);
  });

  test('does not warn about a deadline that is comfortably met', () => {
    const s = setup([{ title: 'Easy', estimateMin: 60, deadline: endOfDay(12) }]);
    assert.equal(recommendations(s, at(9, 9)).filter((r) => r.type === 'deadline-risk').length, 0);
  });

  test('repeated misses suggest a lighter plan, and applying it shrinks the blocks', () => {
    let s = setup([{ title: 'Big', estimateMin: 720 }]);
    s = finishNext(s, 0);
    s = finishNext(s, 0);
    s = finishNext(s, null);
    const now = new Date(planned(s)[0].start - 30 * MIN);
    const rec = recommendations(s, now).find((r) => r.type === 'repeated-miss');
    assert.ok(rec, 'expected a repeated-miss recommendation');
    assert.ok(rec.patch.maxBlockMin < 90);
    assert.ok(rec.patch.maxBlockMin >= s.settings.minBlockMin);

    const applied = applyRecommendation(s, rec, now);
    assert.equal(applied.settings.maxBlockMin, rec.patch.maxBlockMin);
    assert.ok(planned(applied).every((b) => minutesOf(b) <= rec.patch.maxBlockMin));
  });

  test('notices when the user is much more productive at one time of day', () => {
    let s = setup([{ title: 'A', estimateMin: 900 }]);
    const id = s.tasks[0].id;
    s = withReported(s, id, at(9, 9), 60, 30, 60); // mornings: slow
    s = withReported(s, id, at(9, 10, 30), 60, 30, 60);
    s = withReported(s, id, at(9, 13), 60, 60, 60); // afternoons: on pace
    s = withReported(s, id, at(9, 14, 30), 60, 60, 60);
    s = replan(s, at(10, 9));
    const rec = recommendations(s, at(10, 9)).find((r) => r.type === 'best-time');
    assert.ok(rec);
    assert.equal(rec.better, 'afternoon');
  });
});

// ------------------------------------------------------------ calendar export
describe('exporting to a calendar app (.ics)', () => {
  test('contains one VEVENT per planned block, in UTC, with escaped titles', () => {
    const s = setup([
      { title: 'Write, edit; ship', estimateMin: 200 },
      { title: 'Plain', estimateMin: 30 },
    ]);
    const ics = toICS(s, at(9, 9));
    const blocks = planned(s);
    assert.ok(ics.startsWith('BEGIN:VCALENDAR'));
    assert.ok(ics.trimEnd().endsWith('END:VCALENDAR'));
    assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, blocks.length);
    assert.match(ics, /DTSTART:\d{8}T\d{6}Z/);
    assert.ok(ics.includes('SUMMARY:Write\\, edit\\; ship'));
    const stamp = new Date(blocks[0].start).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    assert.ok(ics.includes(`DTSTART:${stamp}`));
    assert.ok(ics.includes('\r\n'), 'iCalendar requires CRLF line endings');
  });

  test('does not export blocks that are already reported', () => {
    let s = setup([{ title: 'A', estimateMin: 120 }]);
    s = finishNext(s, 60);
    const ics = toICS(s, at(9, 10));
    assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
  });
});
