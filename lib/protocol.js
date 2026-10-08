'use strict';

/**
 * Power Pet Door local protocol constants.
 *
 * Protocol details are based on the MIT-licensed pypowerpetdoor library by
 * Preston Elder (https://github.com/corporategoth/py-powerpetdoor), which
 * documents the door's local TCP/JSON interface.
 */

const DEFAULT_PORT = 3000;

// Door motion commands go under the "cmd" envelope key. Everything else
// (reads and setting changes) must go under "config"; the door rejects
// setting changes sent as "cmd".
const MOTION_COMMANDS = new Set(['OPEN', 'OPEN_AND_HOLD', 'CLOSE']);

const STATE = {
  IDLE: 'DOOR_IDLE',
  CLOSED: 'DOOR_CLOSED',
  HOLDING: 'DOOR_HOLDING',
  KEEPUP: 'DOOR_KEEPUP',
  RISING: 'DOOR_RISING',
  SLOWING: 'DOOR_SLOWING',
  CLOSING: 'DOOR_CLOSING',
  CLOSING_TOP_OPEN: 'DOOR_CLOSING_TOP_OPEN',
  CLOSING_MID_OPEN: 'DOOR_CLOSING_MID_OPEN',
  POWEROFF: 'DOOR_POWEROFF',
};

// A powered-off door is physically closed and can't open.
const CLOSED_STATES = new Set([STATE.IDLE, STATE.CLOSED, STATE.POWEROFF]);
const FULLY_OPEN_STATES = new Set([STATE.HOLDING, STATE.KEEPUP]);
const OPENING_STATES = new Set([STATE.RISING, STATE.SLOWING]);
const CLOSING_STATES = new Set([STATE.CLOSING, STATE.CLOSING_TOP_OPEN, STATE.CLOSING_MID_OPEN]);

// Approximate flap position (percent open) for each state.
const POSITIONS = {
  [STATE.IDLE]: 0,
  [STATE.CLOSED]: 0,
  [STATE.RISING]: 33,
  [STATE.SLOWING]: 66,
  [STATE.HOLDING]: 100,
  [STATE.KEEPUP]: 100,
  [STATE.CLOSING]: 100,
  [STATE.CLOSING_TOP_OPEN]: 66,
  [STATE.CLOSING_MID_OPEN]: 33,
  [STATE.POWEROFF]: 0,
};

/**
 * The door reports booleans inconsistently: the strings "true"/"false"
 * in some replies and the integers 1/0 in others.
 */
function toBool(v) {
  if (typeof v === 'boolean') {
    return v;
  }
  if (typeof v === 'number') {
    return v !== 0;
  }
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(s)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(s)) {
      return false;
    }
  }
  return undefined;
}

module.exports = {
  DEFAULT_PORT,
  MOTION_COMMANDS,
  STATE,
  CLOSED_STATES,
  FULLY_OPEN_STATES,
  OPENING_STATES,
  CLOSING_STATES,
  POSITIONS,
  toBool,
};
