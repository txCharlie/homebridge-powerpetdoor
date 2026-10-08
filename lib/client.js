'use strict';

const net = require('net');
const { EventEmitter } = require('events');
const { FrameScanner } = require('./framing');
const { DEFAULT_PORT, MOTION_COMMANDS } = require('./protocol');

const PRIORITY = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/**
 * Local TCP client for a Power Pet Door.
 *
 * - Sends one request at a time and waits for its reply, because the door
 *   answers commands sequentially and drops messages sent too quickly.
 * - Leaves a short quiet gap after each reply before sending the next.
 * - Pings the door when the link has been quiet, and reconnects with
 *   backoff when the connection drops.
 *
 * Events:
 *   'connected'           connection established
 *   'disconnected' (err)  connection lost (a reconnect is scheduled)
 *   'message' (msg)       every successful message from the door, including
 *                         unsolicited DOOR_STATUS pushes
 *   'error' is never emitted; problems are logged instead.
 */
class PowerPetDoorClient extends EventEmitter {
  constructor(options) {
    super();
    this.host = options.host;
    this.port = options.port || DEFAULT_PORT;
    this.log = options.log || console;
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.keepaliveMs = options.keepaliveMs ?? 30000;
    this.gapMs = options.gapMs ?? 50;
    this.minReconnectMs = options.reconnectMs ?? 5000;
    this.maxReconnectMs = options.maxReconnectMs ?? 60000;

    this.socket = null;
    this.connected = false;
    this.stopped = false;
    this.scanner = new FrameScanner();
    this.queue = [];
    this.inflight = null;
    this.msgId = 1;
    this.reconnectMs = this.minReconnectMs;
    this.reconnectTimer = null;
    this.keepaliveTimer = null;
    this.pumpTimer = null;
    this.lastRx = 0;
    this.failedPings = 0;
  }

  get label() {
    return `${this.host}:${this.port}`;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.keepaliveTimer);
    clearTimeout(this.pumpTimer);
    if (this.socket) {
      this.socket.destroy();
    }
    this._failAll(new Error('Client stopped'));
  }

  /**
   * Send a command and resolve with the door's reply message. Rejects if
   * the door reports failure (with its reason), the reply times out, or
   * the connection drops.
   */
  send(command, extra = {}, priority) {
    if (priority === undefined) {
      if (MOTION_COMMANDS.has(command)) {
        priority = PRIORITY.HIGH;
      } else if (command.startsWith('GET_')) {
        priority = PRIORITY.LOW;
      } else {
        priority = PRIORITY.MEDIUM;
      }
    }
    if (!this.connected) {
      return Promise.reject(new Error(`Not connected to door at ${this.label}`));
    }
    return new Promise((resolve, reject) => {
      const id = this.msgId++;
      const key = MOTION_COMMANDS.has(command) ? 'cmd' : 'config';
      const item = {
        id,
        expect: command,
        payload: { [key]: command, msgId: id, dir: 'p2d', ...extra },
        priority,
        resolve,
        reject,
      };
      this._enqueue(item);
    });
  }

  ping() {
    if (!this.connected) {
      return Promise.reject(new Error('Not connected'));
    }
    return new Promise((resolve, reject) => {
      const id = this.msgId++;
      const token = String(Date.now());
      this._enqueue({
        id,
        expect: 'PONG',
        payload: { PING: token, msgId: id, dir: 'p2d' },
        priority: PRIORITY.HIGH,
        resolve,
        reject,
      });
    });
  }

  // --- internals ---

  _connect() {
    if (this.stopped) {
      return;
    }
    this.scanner.reset();
    const socket = net.createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setEncoding('latin1');

    const connectTimer = setTimeout(() => {
      socket.destroy(new Error('Connection timed out'));
    }, this.timeoutMs);

    socket.on('connect', () => {
      clearTimeout(connectTimer);
      this.connected = true;
      this.reconnectMs = this.minReconnectMs;
      this.lastRx = Date.now();
      this.failedPings = 0;
      this._startKeepalive();
      this.log.info(`Connected to Power Pet Door at ${this.label}`);
      this.emit('connected');
      this._pump();
    });

    socket.on('data', (chunk) => this._onData(chunk));

    socket.on('error', (err) => {
      // 'close' always follows; log here so the reason is visible.
      if (!this.stopped) {
        this.log.debug(`Socket error for ${this.label}: ${err.message}`);
      }
      socket.lastError = err;
    });

    socket.on('close', () => {
      clearTimeout(connectTimer);
      if (this.socket !== socket) {
        return;
      }
      const wasConnected = this.connected;
      this.connected = false;
      this.socket = null;
      clearInterval(this.keepaliveTimer);
      this._failAll(new Error('Connection to door lost'));
      if (this.stopped) {
        return;
      }
      const reason = socket.lastError ? socket.lastError.message : 'connection closed';
      if (wasConnected) {
        this.log.warn(`Lost connection to Power Pet Door at ${this.label} (${reason}); reconnecting`);
        this.emit('disconnected', socket.lastError);
      } else {
        this.log.warn(
          `Could not connect to Power Pet Door at ${this.label} (${reason}); ` +
            `retrying in ${Math.round(this.reconnectMs / 1000)}s`,
        );
      }
      this.reconnectTimer = setTimeout(() => this._connect(), this.reconnectMs);
      this.reconnectMs = Math.min(this.reconnectMs * 2, this.maxReconnectMs);
    });
  }

  _startKeepalive() {
    clearInterval(this.keepaliveTimer);
    if (!this.keepaliveMs) {
      return;
    }
    this.keepaliveTimer = setInterval(() => {
      if (!this.connected || Date.now() - this.lastRx < this.keepaliveMs) {
        return;
      }
      this.ping().then(
        () => {
          this.failedPings = 0;
        },
        () => {
          this.failedPings++;
          if (this.failedPings >= 2 && this.socket) {
            this.log.warn(`Door at ${this.label} stopped answering pings; reconnecting`);
            this.socket.destroy(new Error('Keepalive failed'));
          }
        },
      );
    }, Math.max(1000, Math.floor(this.keepaliveMs / 2)));
  }

  _enqueue(item) {
    // Keep the queue ordered by priority, FIFO within a priority.
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].priority > item.priority) {
      i--;
    }
    this.queue.splice(i, 0, item);
    this._pump();
  }

  _pump() {
    if (this.inflight || !this.connected || this.pumpTimer || this.queue.length === 0) {
      return;
    }
    const item = this.queue.shift();
    this.inflight = item;
    item.timer = setTimeout(() => {
      if (this.inflight === item) {
        this.inflight = null;
        item.reject(new Error(`Door did not answer ${item.expect} within ${this.timeoutMs / 1000}s`));
        this._schedulePump();
      }
    }, this.timeoutMs);
    try {
      this.socket.write(JSON.stringify(item.payload));
    } catch (err) {
      clearTimeout(item.timer);
      this.inflight = null;
      item.reject(err);
      this._schedulePump();
    }
  }

  _schedulePump() {
    if (this.pumpTimer) {
      return;
    }
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this._pump();
    }, this.gapMs);
  }

  _onData(chunk) {
    this.lastRx = Date.now();
    const { frames, discarded, overflow } = this.scanner.feed(chunk);
    if (discarded) {
      this.log.debug(`Discarded ${discarded} unexpected characters from ${this.label}`);
    }
    if (overflow) {
      this.log.warn(`Door at ${this.label} sent an oversized message; reconnecting`);
      if (this.socket) {
        this.socket.destroy(new Error('Receive buffer overflow'));
      }
      return;
    }
    for (const frame of frames) {
      let msg;
      try {
        msg = JSON.parse(frame);
      } catch {
        this.log.debug(`Ignoring malformed message from ${this.label}: ${frame.slice(0, 200)}`);
        continue;
      }
      if (msg && typeof msg === 'object' && !Array.isArray(msg)) {
        this._onMessage(msg);
      }
    }
  }

  _onMessage(msg) {
    const ok = msg.success === 'true' || msg.success === true;
    if (ok) {
      try {
        this.emit('message', msg);
      } catch (err) {
        this.log.error(`Error handling message from ${this.label}: ${err.stack || err}`);
      }
    }

    const item = this.inflight;
    if (!item || msg.CMD === 'DOOR_STATUS') {
      return;
    }
    // Successful replies echo our msgId as "msgID". Failure replies carry
    // no msgID at all, so they are matched by the echoed command instead
    // (the door handles one command at a time).
    const matches =
      msg.msgID !== undefined ? String(msg.msgID) === String(item.id) : msg.CMD === item.expect;
    if (!matches) {
      return;
    }
    clearTimeout(item.timer);
    this.inflight = null;
    if (ok) {
      item.resolve(msg);
    } else {
      const err = new Error(`Door refused ${item.expect}: ${msg.reason || 'unknown reason'}`);
      err.reason = msg.reason;
      item.reject(err);
    }
    this._schedulePump();
  }

  _failAll(err) {
    if (this.inflight) {
      clearTimeout(this.inflight.timer);
      this.inflight.reject(err);
      this.inflight = null;
    }
    const pending = this.queue;
    this.queue = [];
    for (const item of pending) {
      item.reject(err);
    }
  }
}

module.exports = { PowerPetDoorClient, PRIORITY };
