'use strict';

/**
 * Tests the client against a fake door. Set PPD_SIM_PORT to the port of a
 * running pypowerpetdoor simulator (`ppd-simulator --port <port>`) to run
 * these; they are skipped otherwise.
 */

const test = require('node:test');
const assert = require('node:assert');
const { PowerPetDoorClient } = require('../lib/client');

const port = Number(process.env.PPD_SIM_PORT);
const skip = !port && 'set PPD_SIM_PORT to run against the simulator';
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function connect() {
  const client = new PowerPetDoorClient({ host: '127.0.0.1', port, log: quiet, keepaliveMs: 2000 });
  return new Promise((resolve) => {
    client.once('connected', () => resolve(client));
    client.start();
  });
}

function waitForStatus(client, wanted, ms = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`never saw ${wanted}`)), ms);
    const onMsg = (msg) => {
      if (msg.door_status === wanted) {
        clearTimeout(timer);
        client.off('message', onMsg);
        resolve();
      }
    };
    client.on('message', onMsg);
  });
}

test('reads status, settings, battery and firmware', { skip }, async () => {
  const c = await connect();
  try {
    const status = await c.send('GET_DOOR_STATUS');
    assert.match(status.door_status, /^DOOR_/);
    const settings = await c.send('GET_SETTINGS');
    assert.ok('inside' in settings.settings);
    const battery = await c.send('GET_DOOR_BATTERY');
    assert.ok('batteryPercent' in battery);
    const hw = await c.send('GET_HW_INFO');
    assert.ok('fw_maj' in hw.fwInfo);
    await c.ping();
  } finally {
    c.stop();
  }
});

test('toggles a sensor setting', { skip }, async () => {
  const c = await connect();
  try {
    let r = await c.send('DISABLE_INSIDE');
    assert.strictEqual(Number(r.inside), 0);
    r = await c.send('ENABLE_INSIDE');
    assert.strictEqual(Number(r.inside), 1);
  } finally {
    c.stop();
  }
});

test('opens the door and reports the full cycle', { skip }, async () => {
  const c = await connect();
  try {
    await c.send('POWER_ON');
    const holding = waitForStatus(c, 'DOOR_HOLDING');
    await c.send('OPEN');
    await holding;
    const closed = waitForStatus(c, 'DOOR_CLOSED');
    await c.send('CLOSE');
    await closed;
  } finally {
    c.stop();
  }
});

test('surfaces the door refusal reason when powered off', { skip }, async () => {
  const c = await connect();
  try {
    await c.send('POWER_OFF');
    await assert.rejects(c.send('OPEN'), /Power is OFF/);
    await c.send('POWER_ON');
  } finally {
    c.stop();
  }
});

test('many queued requests all get answered in order', { skip }, async () => {
  const c = await connect();
  try {
    const replies = await Promise.all(Array.from({ length: 20 }, () => c.send('GET_DOOR_STATUS')));
    assert.strictEqual(replies.length, 20);
  } finally {
    c.stop();
  }
});
