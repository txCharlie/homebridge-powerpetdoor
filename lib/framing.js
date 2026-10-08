'use strict';

/**
 * Stream framer for the Power Pet Door wire protocol.
 *
 * The door sends JSON objects back-to-back over TCP with no delimiter
 * (for example `{"CMD":"DOOR_STATUS",...}{"CMD":"OPEN",...}`), and a
 * single object may arrive split across several TCP chunks. This framer
 * matches braces while ignoring braces inside JSON strings, carries its
 * state between chunks, skips whitespace, resyncs on garbage, and caps
 * the retained buffer so a misbehaving door can't exhaust memory.
 */

const MAX_BUFFER = 64 * 1024;

class FrameScanner {
  constructor(maxBuffer = MAX_BUFFER) {
    this.maxBuffer = maxBuffer;
    this.reset();
  }

  reset() {
    this.buf = '';
    this.depth = 0;
    this.inString = false;
    this.escaped = false;
  }

  /**
   * Feed a chunk of text. Returns `{ frames, discarded, overflow }`:
   * `frames` is a list of complete JSON object strings (each may still
   * fail JSON.parse), `discarded` counts garbage characters skipped while
   * resyncing, and `overflow` is true if the buffer cap was hit.
   */
  feed(chunk) {
    const frames = [];
    let discarded = 0;
    // Resume scanning where the previous chunk stopped.
    let i = this.buf.length;
    let s = this.buf + chunk;
    let start = 0;

    while (i < s.length) {
      const c = s[i];
      if (this.depth === 0) {
        if (c === '{') {
          start = i;
          this.depth = 1;
          this.inString = false;
          this.escaped = false;
        } else if (!/\s/.test(c)) {
          discarded++;
        }
        i++;
        if (this.depth === 0) {
          start = i;
        }
        continue;
      }
      if (this.inString) {
        if (this.escaped) {
          this.escaped = false;
        } else if (c === '\\') {
          this.escaped = true;
        } else if (c === '"') {
          this.inString = false;
        }
      } else if (c === '"') {
        this.inString = true;
      } else if (c === '{') {
        this.depth++;
      } else if (c === '}') {
        this.depth--;
        if (this.depth === 0) {
          frames.push(s.slice(start, i + 1));
          start = i + 1;
        }
      }
      i++;
    }

    this.buf = this.depth > 0 ? s.slice(start) : '';
    let overflow = false;
    if (this.buf.length > this.maxBuffer) {
      this.reset();
      overflow = true;
    }
    return { frames, discarded, overflow };
  }
}

module.exports = { FrameScanner, MAX_BUFFER };
