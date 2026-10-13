'use strict';

/**
 * Door schedules, as set in the plugin settings.
 *
 * A door schedule entry covers ONE sensor and gives a window when that
 * sensor is allowed to open the door, on some days of the week. While the
 * door's schedule is on, a sensor works only inside its windows.
 *
 * Wire format (from pypowerpetdoor, MIT, Preston Elder):
 *   SET_SCHEDULE    {index, schedule: {index, enabled, daysOfWeek[Sun..Sat],
 *                    inside, outside, in_start_time{hour,min}, in_end_time,
 *                    out_start_time, out_end_time}}
 *   GET_SCHEDULE_LIST -> {schedules: [index, ...]}
 *   GET_SCHEDULE    {index} -> {schedule: {...}}
 *   DELETE_SCHEDULE {index}
 * Times run 00:00-24:00; 24:00 means the end of the day.
 */

const { toBool } = require('./protocol');

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const ALL_DAYS = [true, true, true, true, true, true, true];

/**
 * Parse "6:30", "06:30", "22:00", "24:00" (or "06:30:00", as a browser's
 * time field may send) into [hour, minute], or null.
 */
function parseTime(value) {
  const m = /^\s*(\d{1,2}):(\d{2})(?::00)?\s*$/.exec(String(value || ''));
  if (!m) {
    return null;
  }
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) {
    return null;
  }
  return [h, min];
}

function minutes([h, m]) {
  return h * 60 + m;
}

function fmt([h, m]) {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function daysFrom(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return ALL_DAYS.slice();
  }
  const wanted = new Set(list.map((d) => String(d).slice(0, 3).toLowerCase()));
  return DAY_KEYS.map((k) => wanted.has(k));
}

/** The same days, one day later (for the after-midnight half of a window). */
function nextDays(days) {
  return days.map((_, i) => days[(i + 6) % 7]);
}

/**
 * Turn the settings' schedule list into door entries.
 *
 * Returns { entries, problems }. Each entry is
 * { sensor, days[7], start[h,m], end[h,m] }.
 * - A window that crosses midnight (22:00-06:00) becomes two entries.
 * - If some sensors have windows and others don't, the others get an
 *   all-day window, so scheduling one sensor never locks out the other.
 */
function buildEntries(list) {
  const entries = [];
  const problems = [];
  (Array.isArray(list) ? list : []).forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') {
      return;
    }
    const n = i + 1;
    // A row added in the settings screen but never filled in.
    if (!String(raw.start || '').trim() && !String(raw.end || '').trim()) {
      return;
    }
    const sensors = raw.sensor === 'both' ? ['inside', 'outside'] : [raw.sensor === 'outside' ? 'outside' : 'inside'];
    const start = parseTime(raw.start);
    const end = parseTime(raw.end);
    if (!start || !end) {
      problems.push(`Schedule ${n}: times must look like 06:30 or 22:00 (got "${raw.start}" to "${raw.end}")`);
      return;
    }
    const days = daysFrom(raw.days);
    if (!days.some(Boolean)) {
      problems.push(`Schedule ${n}: no days selected`);
      return;
    }
    if (minutes(start) === minutes(end)) {
      problems.push(`Schedule ${n}: start and end are the same time`);
      return;
    }
    for (const sensor of sensors) {
      if (minutes(end) > minutes(start)) {
        entries.push({ sensor, days, start, end });
      } else {
        // Crosses midnight: until the end of the day, then from midnight
        // on the following days.
        entries.push({ sensor, days, start, end: [24, 0] });
        if (minutes(end) > 0) {
          entries.push({ sensor, days: nextDays(days), start: [0, 0], end });
        }
      }
    }
  });

  if (entries.length) {
    for (const sensor of ['inside', 'outside']) {
      if (!entries.some((e) => e.sensor === sensor)) {
        entries.push({ sensor, days: ALL_DAYS.slice(), start: [0, 0], end: [24, 0], automatic: true });
      }
    }
  }
  return { entries, problems };
}

/** The SET_SCHEDULE message fields for one entry at `index`. */
function toWire(entry, index) {
  const inside = entry.sensor === 'inside';
  const zero = { hour: 0, min: 0 };
  const t = ([hour, min]) => ({ hour, min });
  return {
    index,
    schedule: {
      index,
      enabled: true,
      daysOfWeek: entry.days.map((d) => (d ? 1 : 0)),
      inside,
      outside: !inside,
      in_start_time: inside ? t(entry.start) : zero,
      in_end_time: inside ? t(entry.end) : zero,
      out_start_time: inside ? zero : t(entry.start),
      out_end_time: inside ? zero : t(entry.end),
    },
  };
}

/** Normalize a schedule the door reports, for comparison. */
function fromWire(s) {
  if (!s || typeof s !== 'object') {
    return null;
  }
  const inside = toBool(s.inside) === true;
  const outside = toBool(s.outside) === true;
  if (inside === outside || toBool(s.enabled) !== true) {
    return { unusual: true };
  }
  const prefix = inside ? 'in' : 'out';
  const st = s[`${prefix}_start_time`] || {};
  const en = s[`${prefix}_end_time`] || {};
  return {
    sensor: inside ? 'inside' : 'outside',
    days: (Array.isArray(s.daysOfWeek) ? s.daysOfWeek : []).map((d) => toBool(d) === true),
    start: [Number(st.hour) || 0, Number(st.min) || 0],
    end: [Number(en.hour) || 0, Number(en.min) || 0],
  };
}

function key(e) {
  return `${e.sensor}|${e.days.map((d) => (d ? 1 : 0)).join('')}|${fmt(e.start)}-${fmt(e.end)}`;
}

/** Whether the door's current entries already match the wanted ones. */
function sameEntries(current, wanted) {
  if (current.length !== wanted.length || current.some((c) => !c || c.unusual)) {
    return false;
  }
  const a = current.map(key).sort();
  const b = wanted.map(key).sort();
  return a.every((k, i) => k === b[i]);
}

/** Short human description of an entry, for the log. */
function describe(e) {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = e.days.every(Boolean) ? 'every day' : names.filter((_, i) => e.days[i]).join(', ');
  return `${e.sensor} sensor ${fmt(e.start)}-${fmt(e.end)} ${days}${e.automatic ? ' (added automatically)' : ''}`;
}

module.exports = { buildEntries, toWire, fromWire, sameEntries, describe, parseTime, DAY_KEYS };
