// Tests for the logic behind the Chrome extension's notifications and toolbar badge.
// It lives in public/reminders.js (pure functions) so it can be tested without Chrome.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createState, addTask, reportBlock, replan } from '../public/scheduler.js';
import { dueReminders, pendingReports } from '../public/reminders.js';

const at = (day, hour = 0, minute = 0) => new Date(2026, 10, day, hour, minute);
const planned = (s) => s.blocks.filter((b) => b.status === 'planned').sort((a, b) => a.start - b.start);

// Two 60-minute sessions: 9:00-10:00 and 10:10-11:10
const twoSessions = () => addTask(createState(), { title: 'Essay', estimateMin: 120 }, at(9, 9));

describe('dueReminders', () => {
  test('announces a session that starts inside the window', () => {
    const s = twoSessions();
    const r = dueReminders(s, { since: +at(9, 8, 59), now: +at(9, 9, 1) });
    assert.equal(r.length, 1);
    assert.equal(r[0].kind, 'start');
    assert.equal(r[0].blockId, planned(s)[0].id);
    assert.match(r[0].title, /Essay/);
  });

  test('asks how a session went once it has ended unreported', () => {
    const s = twoSessions();
    const r = dueReminders(s, { since: +at(9, 9, 59), now: +at(9, 10, 1) });
    assert.deepEqual(r.map((x) => x.kind), ['report']);
    assert.match(r[0].title, /Essay/);
  });

  test('does not repeat what was already announced', () => {
    const s = twoSessions();
    const first = dueReminders(s, { since: +at(9, 8, 59), now: +at(9, 9, 1) });
    const again = dueReminders(s, { since: +at(9, 8, 59), now: +at(9, 9, 1), notified: first.map((x) => x.id) });
    assert.deepEqual(again, []);
  });

  test('stays quiet about sessions the user already reported', () => {
    let s = twoSessions();
    s = reportBlock(s, planned(s)[0].id, { completedMin: 60 }, at(9, 9, 30));
    assert.deepEqual(dueReminders(s, { since: +at(9, 9, 59), now: +at(9, 10, 1) }), []);
  });

  test('ignores things that happened before the window', () => {
    const s = twoSessions();
    assert.deepEqual(dueReminders(s, { since: +at(9, 12), now: +at(9, 12, 1) }), []);
  });

  test('can announce several things at once', () => {
    const s = twoSessions();
    const r = dueReminders(s, { since: +at(9, 9, 59), now: +at(9, 10, 11) });
    assert.deepEqual(r.map((x) => x.kind).sort(), ['report', 'start']);
  });
});

describe('pendingReports (the badge number)', () => {
  test('counts sessions that are over but unreported', () => {
    const s = twoSessions();
    assert.equal(pendingReports(s, +at(9, 9, 30)), 0);
    assert.equal(pendingReports(s, +at(9, 10, 30)), 1);
    assert.equal(pendingReports(s, +at(9, 11, 30)), 2);
  });

  test('includes sessions the planner already auto-marked as missed', () => {
    const s = replan(twoSessions(), at(9, 12));
    assert.equal(pendingReports(s, +at(9, 12)), 2);
  });

  test('drops to zero once everything is reported', () => {
    let s = twoSessions();
    s = reportBlock(s, planned(s)[0].id, { completedMin: 60 }, at(9, 10, 5));
    s = reportBlock(s, planned(s)[0].id, { completedMin: 60 }, at(9, 11, 15));
    assert.equal(pendingReports(s, +at(9, 12)), 0);
  });

  test('forgets about sessions older than three days', () => {
    const s = replan(twoSessions(), at(9, 12));
    assert.equal(pendingReports(s, +at(14, 12)), 0);
  });
});
