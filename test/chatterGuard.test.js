'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ChatterGuard } = require('../lib/chatterGuard');

function guardAt(times, opts) {
  let i = 0;
  const g = new ChatterGuard({ ...opts, now: () => times[i] });
  return {
    next() {
      const r = g.record();
      i++;
      return r;
    },
  };
}

test('triggers on the Nth opening inside the window', () => {
  const g = guardAt([0, 10, 20, 30, 40], { opens: 5, windowMs: 60000 });
  assert.deepStrictEqual([g.next(), g.next(), g.next(), g.next(), g.next()].map(Boolean), [
    false,
    false,
    false,
    false,
    true,
  ]);
});

test('openings spread beyond the window do not trigger', () => {
  const t = [0, 20000, 40000, 61000, 81000, 101000];
  const g = guardAt(t, { opens: 5, windowMs: 60000 });
  const results = t.map(() => g.next());
  assert.ok(results.every((r) => r === false));
});

test('history resets after a trigger', () => {
  const g = guardAt([0, 1, 2, 3, 4, 5], { opens: 3, windowMs: 60000 });
  assert.deepStrictEqual([g.next(), g.next(), g.next(), g.next(), g.next(), g.next()], [
    false,
    false,
    true,
    false,
    false,
    true,
  ]);
});
