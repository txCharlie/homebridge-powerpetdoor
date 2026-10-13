'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildEntries, toWire, fromWire, sameEntries, parseTime } = require('../lib/schedule');

test('parseTime accepts HH:MM, HH:MM:00 and 24:00 only', () => {
  assert.deepStrictEqual(parseTime('6:30'), [6, 30]);
  assert.deepStrictEqual(parseTime('22:00:00'), [22, 0]);
  assert.deepStrictEqual(parseTime('24:00'), [24, 0]);
  assert.strictEqual(parseTime('24:30'), null);
  assert.strictEqual(parseTime('25:00'), null);
  assert.strictEqual(parseTime('noon'), null);
});

test('a window crossing midnight is split onto the following days', () => {
  const { entries, problems } = buildEntries([{ sensor: 'inside', days: ['fri', 'sat'], start: '22:00', end: '06:00' }]);
  assert.deepStrictEqual(problems, []);
  const inside = entries.filter((e) => e.sensor === 'inside');
  assert.deepStrictEqual(inside[0].end, [24, 0]);
  assert.deepStrictEqual(inside[0].days, [false, false, false, false, false, true, true]);
  // Friday and Saturday nights continue into Saturday and Sunday mornings.
  assert.deepStrictEqual(inside[1].days, [true, false, false, false, false, false, true]);
  assert.deepStrictEqual(inside[1].start, [0, 0]);
});

test('scheduling one sensor gives the other an all-day window', () => {
  const { entries } = buildEntries([{ sensor: 'inside', start: '06:00', end: '22:00' }]);
  const outside = entries.find((e) => e.sensor === 'outside');
  assert.ok(outside.automatic);
  assert.deepStrictEqual([outside.start, outside.end], [[0, 0], [24, 0]]);
});

test('"both" covers each sensor; no days means every day; blank rows are skipped', () => {
  const { entries, problems } = buildEntries([{ sensor: 'both', start: '07:00', end: '19:00' }, { sensor: 'inside' }]);
  assert.deepStrictEqual(problems, []);
  assert.deepStrictEqual(entries.map((e) => e.sensor).sort(), ['inside', 'outside']);
  assert.ok(entries.every((e) => e.days.every(Boolean)));
});

test('bad rows are reported', () => {
  assert.strictEqual(buildEntries([{ start: '25:00', end: '06:00' }]).problems.length, 1);
  assert.strictEqual(buildEntries([{ start: '06:00', end: '06:00' }]).problems.length, 1);
  assert.deepStrictEqual(buildEntries([]).entries, []);
});

test('entries survive the round trip to the door format', () => {
  const { entries } = buildEntries([{ sensor: 'outside', days: ['mon'], start: '08:15', end: '17:45' }]);
  const back = entries.map((e, i) => {
    const wire = toWire(e, i);
    // The door reports booleans as 1/0.
    const s = { ...wire.schedule, enabled: 1, inside: wire.schedule.inside ? 1 : 0, outside: wire.schedule.outside ? 1 : 0 };
    return fromWire(s);
  });
  assert.ok(sameEntries(back, entries));
  assert.ok(!sameEntries(back.slice(1), entries));
});
