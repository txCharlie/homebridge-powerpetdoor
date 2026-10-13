'use strict';

const test = require('node:test');
const assert = require('node:assert');
const schema = require('../config.schema.json');

// Homebridge's settings form treats each top-level entry inside an array's
// layout "items" as a separate array item. Several sibling fieldsets there
// made every open-and-save add a blank door per fieldset (0.1.0, 0.2.0).
test('door layout is wrapped in a single container', () => {
  const doors = schema.layout.find((l) => l && l.key === 'doors');
  assert.ok(doors, 'doors layout exists');
  assert.strictEqual(doors.items.length, 1, 'exactly one container in doors.items');
  assert.ok(Array.isArray(doors.items[0].items), 'container holds the door fields');
});

test('every door field in the schema appears in the layout', () => {
  const props = Object.keys(schema.schema.properties.doors.items.properties);
  const keys = [];
  const walk = (node) => {
    if (typeof node === 'string') {
      keys.push(node);
    } else if (node && Array.isArray(node.items)) {
      node.items.forEach(walk);
    }
  };
  walk(schema.layout.find((l) => l && l.key === 'doors'));
  for (const p of props) {
    assert.ok(keys.includes(`doors[].${p}`), `${p} is in the layout`);
  }
});

// A number with both a minimum and a maximum renders as a slider in the
// Homebridge settings screen; keep them all as plain number boxes.
test('no number field renders as a slider', () => {
  const props = schema.schema.properties.doors.items.properties;
  for (const [key, def] of Object.entries(props)) {
    assert.ok(!('minimum' in def && 'maximum' in def), `${key} has both minimum and maximum`);
  }
});
