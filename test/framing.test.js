'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { FrameScanner } = require('../lib/framing');

test('splits back-to-back objects', () => {
  const s = new FrameScanner();
  const { frames } = s.feed('{"a":1}{"b":2}  {"c":{"d":3}}');
  assert.deepStrictEqual(frames.map((f) => JSON.parse(f)), [{ a: 1 }, { b: 2 }, { c: { d: 3 } }]);
});

test('reassembles an object split across chunks, one character at a time', () => {
  const s = new FrameScanner();
  const text = '{"CMD":"GET_SETTINGS","settings":{"tz":"EST5EDT"}}{"x":1}';
  const frames = [];
  for (const ch of text) {
    frames.push(...s.feed(ch).frames);
  }
  assert.strictEqual(frames.length, 2);
  assert.strictEqual(JSON.parse(frames[0]).settings.tz, 'EST5EDT');
});

test('ignores braces and escaped quotes inside strings', () => {
  const s = new FrameScanner();
  const { frames } = s.feed('{"reason":"bad } \\" {"}{"ok":true}');
  assert.strictEqual(frames.length, 2);
  assert.strictEqual(JSON.parse(frames[0]).reason, 'bad } " {');
});

test('discards garbage and resyncs', () => {
  const s = new FrameScanner();
  const { frames, discarded } = s.feed('xx\n{"a":1}junk{"b":2}');
  assert.strictEqual(frames.length, 2);
  assert.strictEqual(discarded, 6);
});

test('caps the buffer for an object that never ends', () => {
  const s = new FrameScanner(100);
  const r = s.feed('{"a":"' + 'x'.repeat(200));
  assert.strictEqual(r.overflow, true);
  assert.deepStrictEqual(s.feed('{"ok":1}').frames, ['{"ok":1}']);
});
