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

// The same applies to arrays nested inside a door (the schedule list).
test('nested arrays are wrapped in a single container too', () => {
  const arrays = [];
  const walk = (node) => {
    if (node && typeof node === 'object') {
      if (node.type === 'array' && node.key !== 'doors') {
        arrays.push(node);
      }
      (node.items || []).forEach(walk);
    }
  };
  walk(schema.layout.find((l) => l && l.key === 'doors'));
  assert.ok(arrays.length > 0);
  for (const a of arrays) {
    assert.strictEqual(a.items.length, 1, `${a.key} has one container`);
  }
});

test('every door field in the schema appears in the layout', () => {
  const props = Object.keys(schema.schema.properties.doors.items.properties);
  const keys = [];
  const walk = (node) => {
    if (typeof node === 'string') {
      keys.push(node);
      return;
    }
    if (node && node.key) {
      keys.push(node.key);
    }
    if (node && Array.isArray(node.items)) {
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

// Homebridge's verification checks want JSON Schema's standard form: a
// `required` array on the object, never `required: true` on a field.
test('required is only ever an array of field names', () => {
  const walk = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
    } else if (node && typeof node === 'object') {
      if ('required' in node) {
        assert.ok(Array.isArray(node.required), `${path}.required is an array`);
      }
      for (const [k, v] of Object.entries(node)) {
        if (k !== 'required') {
          walk(v, `${path}.${k}`);
        }
      }
    }
  };
  walk(schema.schema, 'schema');
  assert.deepStrictEqual(schema.schema.properties.doors.items.required, ['name', 'host']);
});
