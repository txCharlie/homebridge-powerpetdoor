'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isGenericName } = require('../lib/doorAccessory');

test('labels the Home app makes up are recognized as generic', () => {
  for (const v of ['Switch', 'Switch 2', 'switch 14', 'Contact Sensor', 'Door', 'Battery', '', '  ']) {
    assert.ok(isGenericName(v), `${JSON.stringify(v)} is generic`);
  }
  assert.ok(isGenericName('Dog Door Controls', 'Dog Door Controls'), 'the accessory name itself');
});

test('real names chosen by a person are not generic', () => {
  for (const v of ['Inside Sensor', 'Back Porch Sensor', 'Kitchen Side', 'Switchboard', 'Door Power']) {
    assert.ok(!isGenericName(v, 'Dog Door Controls'), `${v} is a real name`);
  }
});
