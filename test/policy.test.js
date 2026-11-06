// Tests for: task importance, the scheduling policy, and days off.
// Written before the implementation. Nov 9 2026 is a Monday (see scheduler.test.js).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createState,
  addTask,
  updateTask,
  updateSettings,
  addDayOff,
  removeDayOff,
  replan,
} from '../public/scheduler.js';

const MIN = 60_000;
const at = (day, hour = 0, minute = 0) => new Date(2026, 10, day, hour, minute);
const endOfDay = (day) => new Date(2026, 10, day, 23, 59, 59);
const minutesOf = (b) => (b.end - b.start) / MIN;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const planned = (s) =>
  s.blocks.filter((b) => b.status === 'planned').sort((a, b) => a.start - b.start);
const dayOf = (ms) => new Date(ms).getDate();
const perDay = (s, days, taskId) =>
  days.map((d) =>
    sum(
      planned(s)
        .filter((b) => dayOf(b.start) === d && (!taskId || b.taskId === taskId))
        .map(minutesOf),
    ),
  );

function setup(tasks, settings = {}, now = at(9, 9)) {
  let s = createState(settings);
  for (const t of tasks) s = addTask(s, t, now);
  return s;
}
const titleOfFirst = (s) => s.tasks.find((t) => t.id === planned(s)[0].taskId).title;

// ------------------------------------------------------------- importance
describe('task importance', () => {
  test('defaults to 3 (normal)', () => {
    const s = setup([{ title: 'A', estimateMin: 60 }]);
    assert.equal(s.tasks[0].importance, 3);
  });

  test('accepts whole numbers 1 to 5 and rejects anything else', () => {
    for (const importance of [1, 2, 3, 4, 5]) {
      assert.equal(addTask(createState(), { title: 'x', estimateMin: 30, importance }, at(9, 9)).tasks[0].importance, importance);
    }
    for (const importance of [0, 6, 2.5, -1, 'high', NaN]) {
      assert.throws(() => addTask(createState(), { title: 'x', estimateMin: 30, importance }, at(9, 9)), /importance/i);
    }
  });

  test('can be changed later, and the plan follows', () => {
    let s = setup(
      [
        { title: 'A', estimateMin: 60, importance: 1 },
        { title: 'B', estimateMin: 60, importance: 1 },
      ],
      { priorityWeight: 1 },
    );
    assert.equal(titleOfFirst(s), 'A'); // tie: first added wins
    s = updateTask(s, s.tasks[1].id, { importance: 5 }, at(9, 9));
    assert.equal(titleOfFirst(s), 'B');
  });
});

// ------------------------------------------------------------- the policy
describe('scheduling policy', () => {
  test('importance-first (weight 1): the more important task gets the first slot', () => {
    const s = setup(
      [
        { title: 'Chore', estimateMin: 60, importance: 1, deadline: endOfDay(10) },
        { title: 'Big goal', estimateMin: 60, importance: 5 },
      ],
      { priorityWeight: 1, protectDeadlines: false },
    );
    assert.equal(titleOfFirst(s), 'Big goal');
  });

  test('deadline-first (weight 0): the earlier deadline wins even if less important', () => {
    const s = setup(
      [
        { title: 'Big goal', estimateMin: 60, importance: 5 },
        { title: 'Chore', estimateMin: 60, importance: 1, deadline: endOfDay(10) },
      ],
      { priorityWeight: 0 },
    );
    assert.equal(titleOfFirst(s), 'Chore');
  });

  test('balanced: a much more important task can outrank a slightly earlier deadline', () => {
    const tasks = [
      { title: 'Soon but minor', estimateMin: 60, importance: 1, deadline: endOfDay(11) }, // 3 working days
      { title: 'Later but vital', estimateMin: 60, importance: 5, deadline: endOfDay(18) }, // 8 working days
    ];
    assert.equal(titleOfFirst(setup(tasks, { priorityWeight: 0.5 })), 'Later but vital');
    assert.equal(titleOfFirst(setup(tasks, { priorityWeight: 0 })), 'Soon but minor');
  });

  test('ties on importance are broken by the earlier deadline, whatever the weight', () => {
    for (const priorityWeight of [0, 0.5, 1]) {
      const s = setup(
        [
          { title: 'Later', estimateMin: 60, deadline: endOfDay(12) },
          { title: 'Sooner', estimateMin: 60, deadline: endOfDay(10) },
        ],
        { priorityWeight },
      );
      assert.equal(titleOfFirst(s), 'Sooner', `weight ${priorityWeight}`);
    }
  });

  test('protect deadlines: work due today goes first even under importance-first', () => {
    const tasks = [
      { title: 'Vital, due Friday', estimateMin: 60, importance: 5, deadline: endOfDay(13) },
      { title: 'Minor, due today', estimateMin: 60, importance: 1, deadline: endOfDay(9) },
    ];
    assert.equal(titleOfFirst(setup(tasks, { priorityWeight: 1, protectDeadlines: true })), 'Minor, due today');
    assert.equal(titleOfFirst(setup(tasks, { priorityWeight: 1, protectDeadlines: false })), 'Vital, due Friday');
  });

  test('when the day is full, the important task gets the time and the other waits', () => {
    const s = setup(
      [
        { title: 'Low', estimateMin: 60, importance: 1 },
        { title: 'High', estimateMin: 60, importance: 5 },
      ],
      { priorityWeight: 1, maxDailyMin: 60 },
    );
    const [low, high] = s.tasks;
    assert.deepEqual(perDay(s, [9, 10], high.id), [60, 0]);
    assert.deepEqual(perDay(s, [9, 10], low.id), [0, 60]);
  });

  test('spread "even" divides work over the days; "asap" front-loads it', () => {
    const task = { title: 'Essay', estimateMin: 300, deadline: endOfDay(11) };
    const even = setup([task], { spread: 'even' });
    const asap = setup([task], { spread: 'asap' });
    assert.deepEqual(perDay(even, [9, 10, 11]), [100, 100, 100]);
    assert.deepEqual(perDay(asap, [9, 10, 11]), [300, 0, 0]);
  });

  test('changing the policy re-plans immediately', () => {
    let s = setup([
      { title: 'Low', estimateMin: 60, importance: 1, deadline: endOfDay(13) },
      { title: 'High', estimateMin: 60, importance: 5, deadline: endOfDay(13) },
    ]);
    s = updateSettings(s, { priorityWeight: 1 }, at(9, 9));
    assert.equal(titleOfFirst(s), 'High');
    s = updateSettings(s, { priorityWeight: 0 }, at(9, 9));
    assert.equal(titleOfFirst(s), 'Low'); // tie on deadline -> creation order
  });

  test('rejects nonsense policy values', () => {
    const s = createState();
    assert.throws(() => updateSettings(s, { priorityWeight: 1.5 }, at(9, 9)), /priorityWeight/);
    assert.throws(() => updateSettings(s, { priorityWeight: -0.1 }, at(9, 9)), /priorityWeight/);
    assert.throws(() => updateSettings(s, { spread: 'whenever' }, at(9, 9)), /spread/);
  });
});

// --------------------------------------------------------------- days off
describe('days off', () => {
  test('nothing is scheduled on a day off', () => {
    let s = setup([{ title: 'Big', estimateMin: 900 }]);
    s = addDayOff(s, { from: '2026-11-10', label: 'Dentist' }, at(9, 9));
    assert.ok(planned(s).every((b) => dayOf(b.start) !== 10));
    assert.equal(sum(planned(s).map(minutesOf)), 900);
  });

  test('a deadline task is spread over the remaining days (Tuesday off)', () => {
    let s = setup([{ title: 'Thesis', estimateMin: 360, deadline: endOfDay(11) }]);
    s = addDayOff(s, { from: '2026-11-10' }, at(9, 9));
    assert.deepEqual(perDay(s, [9, 10, 11]), [180, 0, 180]);
    assert.equal(s.blocks.length, planned(s).length);
  });

  test('a range of days off (a holiday) is skipped entirely', () => {
    let s = setup([{ title: 'Big', estimateMin: 1500 }]);
    s = addDayOff(s, { from: '2026-11-10', to: '2026-11-12', label: 'Trip' }, at(9, 9));
    const days = new Set(planned(s).map((b) => dayOf(b.start)));
    for (const d of [10, 11, 12]) assert.ok(!days.has(d), `day ${d} should be free`);
    assert.ok(days.has(13), 'work resumes on Friday');
  });

  test('adding a day off today moves already-planned sessions away', () => {
    let s = setup([{ title: 'A', estimateMin: 60 }]);
    assert.equal(dayOf(planned(s)[0].start), 9);
    s = addDayOff(s, { from: '2026-11-09' }, at(9, 9));
    assert.equal(dayOf(planned(s)[0].start), 10);
  });

  test('removing a day off puts the day back into play', () => {
    let s = setup([{ title: 'A', estimateMin: 60 }]);
    s = addDayOff(s, { from: '2026-11-09' }, at(9, 9));
    s = removeDayOff(s, s.settings.daysOff[0].id, at(9, 9));
    assert.equal(dayOf(planned(s)[0].start), 9);
    assert.equal(s.settings.daysOff.length, 0);
  });

  test('a day off that is also unreachable pushes a tight deadline into "late"', () => {
    let s = setup([{ title: 'Tight', estimateMin: 700, deadline: endOfDay(10) }]); // Mon+Tue = 720 max
    s = addDayOff(s, { from: '2026-11-10' }, at(9, 9));
    const last = Math.max(...planned(s).map((b) => b.end));
    assert.ok(last > +endOfDay(10), 'work should overflow past the deadline');
  });

  test('validates dates', () => {
    const s = createState();
    for (const bad of [{ from: 'tomorrow' }, { from: '2026-13-01' }, { from: '2026-02-30' }, { from: '2026-11-12', to: '2026-11-10' }, {}]) {
      assert.throws(() => addDayOff(s, bad, at(9, 9)), /date|day off/i);
    }
  });

  test('works through a JSON round-trip', () => {
    let s = setup([{ title: 'A', estimateMin: 600 }]);
    s = addDayOff(s, { from: '2026-11-10', label: 'x' }, at(9, 9));
    const revived = JSON.parse(JSON.stringify(s));
    assert.deepEqual(replan(revived, at(9, 9)), s);
  });
});

// ------------------------------------------------- older saved data still works
describe('older saved data (before priorities existed)', () => {
  test('state without the new settings or importance is upgraded on re-plan', () => {
    let s = setup([
      { title: 'A', estimateMin: 120 },
      { title: 'B', estimateMin: 60, deadline: endOfDay(12) },
    ]);
    const old = JSON.parse(JSON.stringify(s));
    for (const k of ['priorityWeight', 'protectDeadlines', 'spread', 'daysOff']) delete old.settings[k];
    for (const t of old.tasks) delete t.importance;
    const upgraded = replan(old, at(9, 9));
    assert.equal(upgraded.settings.priorityWeight, 0.5);
    assert.deepEqual(upgraded.settings.daysOff, []);
    assert.ok(upgraded.tasks.every((t) => t.importance === 3));
    assert.equal(sum(planned(upgraded).map(minutesOf)), 180);
  });
});
