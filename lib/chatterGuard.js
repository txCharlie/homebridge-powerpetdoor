'use strict';

/**
 * Counts door openings in a sliding time window.
 *
 * `record()` returns true when the latest opening brings the count within
 * the window up to the threshold, for example the 5th opening inside 60
 * seconds. The history is cleared when that happens, so the next trigger
 * needs a fresh run of openings.
 */
class ChatterGuard {
  constructor({ opens = 5, windowMs = 60000, now = () => Date.now() } = {}) {
    this.opens = Math.max(2, Math.floor(opens));
    this.windowMs = Math.max(1000, windowMs);
    this.now = now;
    this.times = [];
  }

  record() {
    const t = this.now();
    this.times = this.times.filter((x) => t - x < this.windowMs);
    this.times.push(t);
    if (this.times.length >= this.opens) {
      this.times = [];
      return true;
    }
    return false;
  }

  reset() {
    this.times = [];
  }
}

module.exports = { ChatterGuard };
