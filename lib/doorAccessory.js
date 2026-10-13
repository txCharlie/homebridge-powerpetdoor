'use strict';

const { PowerPetDoorClient } = require('./client');
const { buildEntries, toWire, fromWire, sameEntries, describe } = require('./schedule');
const { ChatterGuard } = require('./chatterGuard');
const {
  CLOSED_STATES,
  FULLY_OPEN_STATES,
  OPENING_STATES,
  CLOSING_STATES,
  POSITIONS,
  toBool,
} = require('./protocol');

const SWITCHES = {
  inside: {
    field: 'inside',
    label: 'Inside Sensor',
    on: 'ENABLE_INSIDE',
    off: 'DISABLE_INSIDE',
    configKey: 'exposeInsideSensor',
    defaultExposed: true,
  },
  outside: {
    field: 'outside',
    label: 'Outside Sensor',
    on: 'ENABLE_OUTSIDE',
    off: 'DISABLE_OUTSIDE',
    configKey: 'exposeOutsideSensor',
    defaultExposed: true,
  },
  power: {
    field: 'power_state',
    label: 'Power',
    on: 'POWER_ON',
    off: 'POWER_OFF',
    configKey: 'exposePower',
    defaultExposed: false,
  },
  schedule: {
    field: 'timersEnabled',
    label: 'Schedule',
    on: 'ENABLE_TIMERS',
    off: 'DISABLE_TIMERS',
    configKey: 'exposeSchedule',
    defaultExposed: false,
  },
};

const LOW_BATTERY_PERCENT = 20;

/**
 * Labels the Home app makes up when it doesn't use a service's own name,
 * such as "Switch", "Switch 2" or "Contact Sensor".
 */
const GENERIC_NAME = /^(switch|contact sensor|door|battery|outlet|sensor)( \d+)?$/i;

function isGenericName(value, accessoryName) {
  const v = String(value || '').trim();
  return !v || GENERIC_NAME.test(v) || (accessoryName && v === accessoryName);
}

const ON_OFF_MODE_LABEL = {
  power: 'power',
  inside: 'inside sensor',
  sensors: 'both sensors',
};

/** "inside sensor", or "inside and outside sensors" for both. */
function sensorLabel(sensors) {
  return sensors.length > 1 ? `${sensors.join(' and ')} sensors` : `${sensors[0]} sensor`;
}

class PowerPetDoorAccessory {
  /**
   * @param switchAccessory optional separate accessory holding the on/off
   *   switch. It is kept apart from the main accessory so that "Hey Siri,
   *   turn off <name>" can only mean that one switch.
   */
  constructor(platform, accessory, config, switchAccessory = null) {
    this.platform = platform;
    this.api = platform.api;
    this.hap = platform.api.hap;
    this.log = platform.log;
    this.accessory = accessory;
    this.switchAccessory = switchAccessory;
    this.config = config;
    this.name = config.name || 'Pet Door';

    this.openCommand = config.openMode === 'hold' ? 'OPEN_AND_HOLD' : 'OPEN';
    this.statusPollMs = Math.max(5, config.statusPollSeconds ?? 30) * 1000;
    this.settingsPollMs = Math.max(15, config.settingsPollSeconds ?? 120) * 1000;
    this.batteryPollMs = Math.max(60, config.batteryPollSeconds ?? 600) * 1000;

    this.state = {
      doorStatus: undefined,
      target: 0,
      inside: undefined,
      outside: undefined,
      power_state: undefined,
      timersEnabled: undefined,
      batteryPercent: undefined,
      batteryPresent: undefined,
      acPresent: undefined,
    };

    // On/off switch: what "off" means.
    this.onOffMode = ['inside', 'sensors'].includes(config.onOffMode) ? config.onOffMode : 'power';

    // Chatter guard settings.
    this.chatterSensor = ['outside', 'both'].includes(config.chatterSensor) ? config.chatterSensor : 'inside';
    this.chatterPauseMs = Math.max(1, config.chatterPauseMinutes ?? 5) * 60000;
    this.chatter = new ChatterGuard({
      opens: config.chatterOpens ?? 5,
      windowMs: Math.max(5, config.chatterWindowSeconds ?? 60) * 1000,
    });
    this.chatterTimer = null;

    // What to do with the door's own schedule (see syncSchedule).
    // (0.3.0 used a `manageSchedule` checkbox for "Set it here".)
    const scheduleMode = config.scheduleMode || (config.manageSchedule === true ? 'manage' : 'leave');
    this.scheduleMode = ['off', 'manage'].includes(scheduleMode) ? scheduleMode : 'leave';
    this.lastCommandedOpen = 0;

    this.setupServices();

    this.client = new PowerPetDoorClient({
      host: config.host,
      port: config.port,
      log: this.prefixedLog(),
      timeoutMs: (config.timeoutSeconds ?? 10) * 1000,
    });
    this.client.on('message', (msg) => this.handleMessage(msg));
    this.client.on('connected', () => {
      this.refreshAll();
      this.resumeChatterPause();
      this.syncSchedule();
    });
    this.client.on('disconnected', () => this.markUnreachable());

    this.timers = [];
    this.client.start();
    this.timers.push(setInterval(() => this.refresh('GET_DOOR_STATUS'), this.statusPollMs));
    this.timers.push(setInterval(() => this.refresh('GET_SETTINGS'), this.settingsPollMs));
    this.timers.push(setInterval(() => this.refresh('GET_DOOR_BATTERY'), this.batteryPollMs));

    this.api.on('shutdown', () => this.shutdown());
  }

  prefixedLog() {
    const prefix = `[${this.name}] `;
    return {
      info: (m) => this.log.info(prefix + m),
      warn: (m) => this.log.warn(prefix + m),
      error: (m) => this.log.error(prefix + m),
      debug: (m) => this.log.debug(prefix + m),
    };
  }

  shutdown() {
    this.timers.forEach(clearInterval);
    clearTimeout(this.chatterTimer);
    clearTimeout(this.overrideCheck);
    this.client.stop();
  }

  saveContext() {
    const accessories = [this.accessory];
    if (this.switchAccessory) {
      accessories.push(this.switchAccessory);
    }
    this.api.updatePlatformAccessories(accessories);
  }

  // --- service setup ---

  setupServices() {
    const { Service, Characteristic } = this.hap;
    const acc = this.accessory;

    acc
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'High Tech Pet')
      .setCharacteristic(Characteristic.Model, 'Power Pet Door (Wi-Fi)')
      .setCharacteristic(Characteristic.SerialNumber, `${this.config.host}`);

    // Main door. HomeKit's Door service models a powered door with a
    // position (0 = closed, 100 = open) and a direction of travel.
    this.door = acc.getService(Service.Door) || acc.addService(Service.Door, 'Door');
    this.setDisplayName(this.door, 'Door', [this.name]);
    this.door
      .getCharacteristic(Characteristic.CurrentPosition)
      .onGet(() => this.requireReachable(this.currentPosition()));
    this.door
      .getCharacteristic(Characteristic.PositionState)
      .onGet(() => this.requireReachable(this.positionState()));
    this.door
      .getCharacteristic(Characteristic.TargetPosition)
      .onGet(() => this.requireReachable(this.state.target))
      .onSet((value) => this.setTargetPosition(value));

    // Contact sensor: lets Apple Home send a notification whenever the
    // door opens ("the dog just went out").
    this.contact = this.syncOptionalService(
      Service.ContactSensor,
      'activity',
      'Activity',
      this.config.exposeActivitySensor !== false,
      [`${this.name} Activity`],
    );
    if (this.contact) {
      this.contact
        .getCharacteristic(Characteristic.ContactSensorState)
        .onGet(() => this.requireReachable(this.contactState()));
    }

    // Setting switches.
    this.switches = {};
    for (const [subtype, def] of Object.entries(SWITCHES)) {
      const exposed = this.config[def.configKey] ?? def.defaultExposed;
      const svc = this.syncOptionalService(Service.Switch, subtype, def.label, exposed, [
        `${this.name} ${def.label}`,
      ]);
      if (!svc) {
        continue;
      }
      this.switches[subtype] = svc;
      svc
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.requireReachable(this.state[def.field] === true))
        .onSet((value) => this.setSwitch(def, value));
    }

    // The battery service is only added once the door reports that a
    // battery is installed, so a mains-only door doesn't show a 0% warning.
    this.battery = acc.getService(Service.Battery);
    if (this.battery) {
      this.setDisplayName(this.battery, 'Battery', [`${this.name} Battery`]);
      this.attachBatteryHandlers();
    }

    // Chatter guard on/off switch (only when the guard is configured).
    const chatterConfigured = this.config.chatterGuard === true;
    this.chatterSwitch = this.syncOptionalService(
      Service.Switch,
      'chatterguard',
      'Chatter Guard',
      chatterConfigured && this.config.exposeChatterGuardSwitch !== false,
      [`${this.name} Chatter Guard`],
    );
    if (!chatterConfigured) {
      delete acc.context.chatterEnabled;
    }
    if (this.chatterSwitch) {
      this.chatterSwitch
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.chatterEnabled())
        .onSet((value) => this.setChatterEnabled(value === true));
    }

    // The on/off switch lives on its own accessory (see constructor).
    if (this.switchAccessory) {
      const sacc = this.switchAccessory;
      const switchName = this.config.onOffSwitchName;
      sacc
        .getService(Service.AccessoryInformation)
        .setCharacteristic(Characteristic.Manufacturer, 'High Tech Pet')
        .setCharacteristic(Characteristic.Model, 'Power Pet Door On/Off')
        .setCharacteristic(Characteristic.SerialNumber, `${this.config.host}-switch`);
      this.onOffSwitch = sacc.getService(Service.Switch) || sacc.addService(Service.Switch, switchName);
      this.setDisplayName(this.onOffSwitch, switchName, [], sacc);
      this.onOffSwitch
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.requireReachable(this.onOffState()))
        .onSet((value) => this.setOnOff(value === true));
    }
  }

  /**
   * Name a service. Service names deliberately don't repeat the accessory's
   * name: the Home app already shows them under it.
   *
   * The Home app displays ConfiguredName, and it can write that
   * characteristic too: when a user renames a tile, and also on its own,
   * for example saving a generic label like "Switch 2" while pairing. So:
   *
   * - a rename that looks like a real name is remembered as the user's
   *   choice and kept across restarts;
   * - a generic label the Home app made up is never treated as a choice,
   *   and the plugin's name replaces it;
   * - names set by this plugin (now or by an earlier version, listed in
   *   `legacyNames`) are updated freely.
   */
  setDisplayName(service, name, legacyNames = [], accessory = this.accessory) {
    const { Characteristic } = this.hap;
    service.setCharacteristic(Characteristic.Name, name);
    if (!service.testCharacteristic(Characteristic.ConfiguredName)) {
      service.addOptionalCharacteristic(Characteristic.ConfiguredName);
    }
    const ctx = accessory.context;
    const key = `${service.UUID}:${service.subtype || ''}`;
    const defaults = (ctx.defaultNames = ctx.defaultNames || {});
    const userNames = (ctx.userNames = ctx.userNames || {});
    const configured = service.getCharacteristic(Characteristic.ConfiguredName);
    const current = configured.value;

    // A name from before this version that isn't ours or a generic label
    // must have been chosen by the user: adopt it as theirs.
    if (
      !(key in userNames) &&
      current &&
      current !== defaults[key] &&
      !legacyNames.includes(current) &&
      !isGenericName(current, accessory.displayName)
    ) {
      userNames[key] = current;
    }

    const wanted = userNames[key] || name;
    if (current !== wanted) {
      configured.updateValue(wanted);
    }
    defaults[key] = name;

    // Watch for renames from the Home app.
    if (!configured.__ppdWatching) {
      configured.__ppdWatching = true;
      configured.on('change', ({ newValue, reason }) => {
        if (reason !== 'write') {
          return;
        }
        const value = String(newValue || '').trim();
        if (isGenericName(value, accessory.displayName) || value === defaults[key]) {
          // Not a real choice: drop any saved rename and restore our name
          // if the Home app tried to replace it with a generic label.
          delete userNames[key];
          if (value !== defaults[key]) {
            setImmediate(() => configured.updateValue(defaults[key]));
          }
        } else {
          userNames[key] = value;
        }
        this.saveContext();
      });
    }
  }

  syncOptionalService(type, subtype, name, exposed, legacyNames = []) {
    const existing = this.accessory.getServiceById(type, subtype);
    if (!exposed) {
      if (existing) {
        this.accessory.removeService(existing);
      }
      return null;
    }
    const svc = existing || this.accessory.addService(type, name, subtype);
    this.setDisplayName(svc, name, legacyNames);
    return svc;
  }

  attachBatteryHandlers() {
    const { Characteristic } = this.hap;
    this.battery
      .getCharacteristic(Characteristic.BatteryLevel)
      .onGet(() => this.requireReachable(this.state.batteryPercent ?? 0));
    this.battery
      .getCharacteristic(Characteristic.StatusLowBattery)
      .onGet(() => this.requireReachable(this.lowBatteryState()));
    this.battery
      .getCharacteristic(Characteristic.ChargingState)
      .onGet(() => this.requireReachable(this.chargingState()));
  }

  // --- derived values ---

  currentPosition() {
    return POSITIONS[this.state.doorStatus] ?? 0;
  }

  positionState() {
    const { PositionState } = this.hap.Characteristic;
    if (OPENING_STATES.has(this.state.doorStatus)) {
      return PositionState.INCREASING;
    }
    if (CLOSING_STATES.has(this.state.doorStatus)) {
      return PositionState.DECREASING;
    }
    return PositionState.STOPPED;
  }

  contactState() {
    const { ContactSensorState } = this.hap.Characteristic;
    const closed = this.state.doorStatus === undefined || CLOSED_STATES.has(this.state.doorStatus);
    return closed ? ContactSensorState.CONTACT_DETECTED : ContactSensorState.CONTACT_NOT_DETECTED;
  }

  lowBatteryState() {
    const { StatusLowBattery } = this.hap.Characteristic;
    const low = (this.state.batteryPercent ?? 100) <= LOW_BATTERY_PERCENT;
    return low ? StatusLowBattery.BATTERY_LEVEL_LOW : StatusLowBattery.BATTERY_LEVEL_NORMAL;
  }

  chargingState() {
    const { ChargingState } = this.hap.Characteristic;
    if (!this.state.batteryPresent) {
      return ChargingState.NOT_CHARGEABLE;
    }
    if (this.state.acPresent && (this.state.batteryPercent ?? 100) < 100) {
      return ChargingState.CHARGING;
    }
    return ChargingState.NOT_CHARGING;
  }

  requireReachable(value) {
    if (!this.client.connected) {
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return value;
  }

  // --- commands from HomeKit ---

  async setTargetPosition(value) {
    const open = value >= 50;
    const command = open ? this.openCommand : 'CLOSE';
    this.log.info(`[${this.name}] ${open ? 'Opening' : 'Closing'} door`);
    if (open) {
      // Openings we were asked to make don't count toward the chatter guard.
      this.lastCommandedOpen = Date.now();
    }
    try {
      await this.client.send(command);
      this.state.target = open ? 100 : 0;
    } catch (err) {
      if (open) {
        // The door didn't open for us, so don't ignore the next real opening.
        this.lastCommandedOpen = 0;
      }
      this.log.warn(`[${this.name}] ${err.message}`);
      // Put the Home app's target back where the door actually is.
      setImmediate(() => this.pushDoorState());
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async setSwitch(def, value) {
    const command = value ? def.on : def.off;
    this.log.info(`[${this.name}] ${def.label} ${value ? 'on' : 'off'}`);
    try {
      await this.client.send(command);
      // Changing the paused sensor by hand takes over from the chatter guard.
      if (this.pausedSensors().includes(def.field)) {
        this.releasePausedSensors([def.field], `${def.label} turned ${value ? 'on' : 'off'} manually`);
      }
    } catch (err) {
      this.log.warn(`[${this.name}] ${err.message}`);
      setImmediate(() => this.pushSwitches());
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  // --- on/off switch ---

  onOffState() {
    const s = this.state;
    if (s.power_state !== true) {
      return false;
    }
    if (this.onOffMode === 'inside') {
      return s.inside === true;
    }
    if (this.onOffMode === 'sensors') {
      return s.inside === true && s.outside === true;
    }
    return true;
  }

  onOffCommands(on) {
    if (this.onOffMode === 'power') {
      return [on ? 'POWER_ON' : 'POWER_OFF'];
    }
    const sensors = this.onOffMode === 'sensors' ? ['INSIDE', 'OUTSIDE'] : ['INSIDE'];
    if (!on) {
      return sensors.map((s) => `DISABLE_${s}`);
    }
    // Turning on also makes sure the door has power.
    const cmds = this.state.power_state === false ? ['POWER_ON'] : [];
    return cmds.concat(sensors.map((s) => `ENABLE_${s}`));
  }

  async setOnOff(on) {
    this.log.info(`[${this.name}] Turning door ${on ? 'on' : 'off'} (${ON_OFF_MODE_LABEL[this.onOffMode]})`);
    const ctx = this.accessory.context;
    const sensorMode = this.onOffMode !== 'power';
    const pause = this.chatterPause();
    try {
      if (!on && sensorMode) {
        // As with the chatter guard: a door with its schedule on would turn
        // the sensors back on by itself, so "off" pauses the schedule too,
        // and "on" resumes it.
        if (this.state.timersEnabled === true) {
          await this.client.send('DISABLE_TIMERS');
          ctx.onOffSchedule = true;
        } else if (pause && pause.schedule) {
          ctx.onOffSchedule = true;
        }
      }
      for (const cmd of this.onOffCommands(on)) {
        await this.client.send(cmd);
      }
      if (on && ctx.onOffSchedule) {
        await this.client.send('ENABLE_TIMERS');
        delete ctx.onOffSchedule;
        this.log.info(`[${this.name}] Door's schedule resumed`);
      }
      // A manual on/off takes over from the chatter guard. Hand the paused
      // sensors back now, except any the "off" just turned off on purpose;
      // otherwise they would stay off after the door is next turned on.
      if (pause) {
        const offNow = on ? [] : this.onOffCommands(false);
        const handBack = this.pausedSensors(pause).filter((s) => !offNow.includes(`DISABLE_${s.toUpperCase()}`));
        // In the sensor modes, "off" made the on/off switch responsible for
        // resuming the schedule.
        const restoreSchedule = on || !sensorMode;
        if (!handBack.length) {
          this.clearChatterPause('door turned off manually', { restoreSchedule });
        } else {
          pause.sensors = handBack;
          delete pause.sensor;
          this.log.info(`[${this.name}] Chatter guard: pause cancelled (door turned ${on ? 'on' : 'off'} manually)`);
          await this.endChatterPause({ restoreSchedule });
        }
      }
      this.saveContext();
    } catch (err) {
      this.log.warn(`[${this.name}] ${err.message}`);
      // Re-read so the switch reflects whatever actually changed.
      this.refresh('GET_SETTINGS');
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  pushOnOff() {
    if (this.onOffSwitch && this.state.power_state !== undefined) {
      this.onOffSwitch.updateCharacteristic(this.hap.Characteristic.On, this.onOffState());
    }
  }

  // --- chatter guard ---
  //
  // When the door opens many times in a short window (for example a dog
  // eating next to it), turn one sensor off for a while, then back on.
  // The pause is saved in the accessory's context so a restart mid-pause
  // still ends it on time.

  chatterEnabled() {
    if (this.config.chatterGuard !== true) {
      return false;
    }
    return this.accessory.context.chatterEnabled !== false;
  }

  setChatterEnabled(enabled) {
    this.accessory.context.chatterEnabled = enabled;
    this.chatter.reset();
    this.log.info(`[${this.name}] Chatter guard ${enabled ? 'enabled' : 'disabled'}`);
    if (!enabled && this.chatterPause()) {
      this.endChatterPause();
    }
    this.saveContext();
  }

  chatterPause() {
    return this.accessory.context.chatterPause || null;
  }

  /** Sensors the current pause covers. Pauses saved by 0.2.x have a single `sensor`. */
  pausedSensors(pause = this.chatterPause()) {
    if (!pause) {
      return [];
    }
    if (Array.isArray(pause.sensors)) {
      return pause.sensors;
    }
    return pause.sensor ? [pause.sensor] : [];
  }

  /**
   * Someone took over some paused sensors (by hand, or on the door). Stop
   * managing those; any others stay paused until the pause ends.
   */
  releasePausedSensors(sensors, reason) {
    const pause = this.chatterPause();
    const rest = this.pausedSensors(pause).filter((s) => !sensors.includes(s));
    if (!rest.length) {
      this.clearChatterPause(reason);
      return;
    }
    pause.sensors = rest;
    delete pause.sensor;
    this.log.info(`[${this.name}] Chatter guard: ${reason}; the ${sensorLabel(rest)} stays paused`);
    this.saveContext();
  }

  onDoorOpening() {
    if (!this.chatterEnabled() || this.chatterPause()) {
      return;
    }
    if (Date.now() - this.lastCommandedOpen < 10000) {
      return;
    }
    if (this.chatter.record()) {
      this.startChatterPause();
    }
  }

  async startChatterPause() {
    const wanted = this.chatterSensor === 'both' ? ['inside', 'outside'] : [this.chatterSensor];
    // Read the door's settings fresh, so the sensor and schedule state used
    // below are current rather than from the last periodic check.
    try {
      await this.client.send('GET_SETTINGS');
    } catch (err) {
      this.log.debug(`[${this.name}] Chatter guard: could not read settings first: ${err.message}`);
    }
    // Only pause sensors that are on, so the pause never turns on a sensor
    // that was off before it started.
    const sensors = wanted.filter((s) => this.state[s] === true);
    if (!sensors.length) {
      this.log.info(
        `[${this.name}] Chatter guard: door is busy, but the ${sensorLabel(wanted)} ` +
          `${wanted.length > 1 ? 'are' : 'is'} already off`,
      );
      return;
    }
    const label = sensorLabel(sensors);
    const minutes = Math.round(this.chatterPauseMs / 60000);
    // A door with its schedule on enforces that schedule by switching the
    // sensors itself, which would turn the paused sensor straight back on.
    // So the schedule is paused too, and restored afterwards.
    const schedule = this.state.timersEnabled === true;
    this.log.info(
      `[${this.name}] Chatter guard: door opened ${this.chatter.opens} times within ` +
        `${Math.round(this.chatter.windowMs / 1000)}s; turning the ${label} off for ${minutes} min` +
        (schedule ? " (and pausing the door's schedule)" : ''),
    );
    const done = [];
    try {
      if (schedule) {
        await this.client.send('DISABLE_TIMERS');
      }
      for (const s of sensors) {
        await this.client.send(`DISABLE_${s.toUpperCase()}`);
        done.push(s);
      }
    } catch (err) {
      this.log.warn(`[${this.name}] Chatter guard could not pause the door: ${err.message}`);
      // Put back whatever was already changed.
      for (const s of done) {
        this.refresh(`ENABLE_${s.toUpperCase()}`);
      }
      if (schedule) {
        this.restoreSchedule('chatter guard');
      }
      return;
    }
    this.accessory.context.chatterPause = { sensors, until: Date.now() + this.chatterPauseMs, schedule };
    this.saveContext();
    this.scheduleChatterEnd();
  }

  scheduleChatterEnd() {
    clearTimeout(this.chatterTimer);
    const pause = this.chatterPause();
    if (!pause) {
      return;
    }
    const wait = Math.max(0, pause.until - Date.now());
    this.chatterTimer = setTimeout(() => this.endChatterPause(), wait);
  }

  /** Called on every (re)connect: finish or re-arm a pause from before. */
  resumeChatterPause() {
    const pause = this.chatterPause();
    if (!pause) {
      return;
    }
    if (pause.until <= Date.now()) {
      this.endChatterPause();
    } else {
      this.scheduleChatterEnd();
    }
  }

  async endChatterPause({ restoreSchedule = true } = {}) {
    clearTimeout(this.chatterTimer);
    const pause = this.chatterPause();
    if (!pause) {
      return;
    }
    if (!this.client.connected) {
      // Try again as soon as the door is reachable.
      return;
    }
    const sensors = this.pausedSensors(pause);
    const label = sensorLabel(sensors);
    const schedule = pause.schedule && restoreSchedule;
    // Clear the pause before sending, so the door's reply (sensor on) isn't
    // mistaken for someone overriding the pause by hand.
    delete this.accessory.context.chatterPause;
    try {
      for (const s of sensors) {
        await this.client.send(`ENABLE_${s.toUpperCase()}`);
      }
      if (schedule) {
        await this.client.send('ENABLE_TIMERS');
      }
      this.log.info(
        `[${this.name}] Chatter guard: pause over; ${label} back on` +
          (schedule ? " and the door's schedule resumed" : ''),
      );
      this.chatter.reset();
      this.saveContext();
    } catch (err) {
      this.accessory.context.chatterPause = { ...pause, schedule };
      this.log.warn(`[${this.name}] Chatter guard could not turn the ${label} back on: ${err.message}`);
      // Retry in a minute.
      this.chatterTimer = setTimeout(() => this.endChatterPause(), 60000);
    }
  }

  clearChatterPause(reason, { restoreSchedule = true } = {}) {
    const pause = this.chatterPause();
    if (!pause) {
      return;
    }
    clearTimeout(this.chatterTimer);
    delete this.accessory.context.chatterPause;
    if (pause.schedule && restoreSchedule) {
      this.restoreSchedule('chatter guard');
    }
    this.chatter.reset();
    if (reason) {
      this.log.info(`[${this.name}] Chatter guard: pause cancelled (${reason})`);
    }
    this.saveContext();
  }

  /**
   * The door reported a paused sensor as on. Wait a moment, read the
   * settings again, and only stop pausing it if it's still on. Logs which
   * message reported it, to make an unexpected cause easy to find.
   */
  confirmOverride(pause, msg) {
    if (this.overrideCheck) {
      return;
    }
    const source = msg.CMD || 'a door message';
    const reported = this.pausedSensors(pause).filter((s) => this.state[s] === true);
    this.log.debug(`[${this.name}] Chatter guard: ${source} reported the ${sensorLabel(reported)} on; checking again`);
    this.overrideCheck = setTimeout(async () => {
      try {
        const reply = await this.client.send('GET_SETTINGS');
        const settings = reply.settings || {};
        const still = this.chatterPause();
        if (!still || still.until !== pause.until) {
          return;
        }
        // Sensors taken over by hand in the meantime are no longer ours to check.
        const watched = reported.filter((s) => this.pausedSensors(still).includes(s));
        if (!watched.length) {
          return;
        }
        const on = watched.filter((s) => toBool(settings[s]) === true);
        if (on.length) {
          const schedule = toBool(settings.timersEnabled) === true;
          this.releasePausedSensors(
            on,
            `${sensorLabel(on)} turned back on outside Apple Home; first reported by ${source}` +
              (schedule ? ", and the door's schedule is on" : ''),
          );
        } else {
          this.log.info(
            `[${this.name}] Chatter guard: ignored a report that the ${sensorLabel(watched)} ` +
              `${watched.length > 1 ? 'were' : 'was'} on (from ${source}); the door confirms ` +
              `${watched.length > 1 ? 'they are' : 'it is'} still off`,
          );
        }
      } catch (err) {
        this.log.debug(`[${this.name}] Chatter guard: could not re-check the door: ${err.message}`);
      } finally {
        this.overrideCheck = null;
      }
    }, 3000);
  }

  /** Turn the door's schedule back on after the plugin paused it. */
  restoreSchedule(owner) {
    this.client
      .send('ENABLE_TIMERS')
      .then(() => this.log.info(`[${this.name}] Door's schedule resumed (${owner})`))
      .catch((err) => this.log.warn(`[${this.name}] Could not resume the door's schedule: ${err.message}`));
  }

  // --- door schedule ---
  //
  // `scheduleMode` decides what the plugin does with the door's own schedule:
  //   leave  (default) never touch it
  //   off    turn the door's schedule off (for Apple Home automations)
  //   manage the plugin settings are the door's schedule. On each
  //          connection the door's entries are read and rewritten only if
  //          they differ.
  // The master switch is set once per Homebridge start, so turning the
  // Schedule switch on or off in Apple Home holds until the next restart
  // instead of being undone by a Wi-Fi blip.

  async syncSchedule() {
    const mode = this.scheduleMode;
    if (mode === 'leave' || this.scheduleSyncing) {
      return;
    }
    this.scheduleSyncing = true;
    try {
      if (mode === 'off') {
        if (!this.scheduleSwitchSet) {
          await this.setScheduleOn(false, 'set to "Turn it off" in the plugin settings');
          this.scheduleSwitchSet = true;
        }
        return;
      }
      const { entries, problems } = buildEntries(this.config.schedules);
      if (problems.length) {
        for (const p of problems) {
          this.log.warn(`[${this.name}] ${p}`);
        }
        this.log.warn(`[${this.name}] Leaving the door's schedule unchanged until the plugin settings are fixed`);
        return;
      }
      if (!entries.length) {
        this.log.warn(
          `[${this.name}] Door schedule is set to "Set it here" but no times are listed; ` +
            'leaving the door\'s schedule unchanged',
        );
        return;
      }
      const list = await this.client.send('GET_SCHEDULE_LIST');
      const ids = (Array.isArray(list.schedules) ? list.schedules : [])
        .map((x) => (x && typeof x === 'object' ? x.index : x))
        .filter((x) => Number.isInteger(x));
      const current = [];
      for (const index of ids) {
        const reply = await this.client.send('GET_SCHEDULE', { index });
        current.push(fromWire(reply.schedule));
      }
      if (sameEntries(current, entries)) {
        this.log.debug(`[${this.name}] Door's schedule already matches the plugin settings`);
      } else {
        for (const index of ids) {
          await this.client.send('DELETE_SCHEDULE', { index });
        }
        for (let i = 0; i < entries.length; i++) {
          await this.client.send('SET_SCHEDULE', toWire(entries[i], i));
        }
        this.log.info(`[${this.name}] Door's schedule updated: ${entries.map(describe).join('; ')}`);
      }
      if (!this.scheduleSwitchSet) {
        await this.setScheduleOn(true);
        this.scheduleSwitchSet = true;
      }
    } catch (err) {
      this.log.warn(`[${this.name}] Could not update the door's schedule: ${err.message}`);
    } finally {
      this.scheduleSyncing = false;
    }
  }

  /**
   * Turn the door's schedule master switch on or off for the plugin
   * settings, without fighting a chatter pause or the on/off switch that
   * has it paused right now: those resume it (or not) when they finish.
   */
  async setScheduleOn(on, why = 'plugin settings') {
    const ctx = this.accessory.context;
    const pause = this.chatterPause();
    await this.client.send('GET_SETTINGS');
    if (on) {
      if (pause) {
        pause.schedule = true;
        this.saveContext();
      } else if (!ctx.onOffSchedule && this.state.timersEnabled !== true) {
        await this.client.send('ENABLE_TIMERS');
        this.log.info(`[${this.name}] Door's schedule turned on`);
      }
    } else {
      if (pause && pause.schedule) {
        pause.schedule = false;
      }
      if (ctx.onOffSchedule) {
        delete ctx.onOffSchedule;
      }
      this.saveContext();
      if (this.state.timersEnabled === true) {
        await this.client.send('DISABLE_TIMERS');
        this.log.info(`[${this.name}] Door's schedule turned off (${why})`);
      }
    }
  }

  // --- updates from the door ---

  refresh(command) {
    if (!this.client.connected) {
      return;
    }
    this.client.send(command).catch((err) => {
      this.log.debug(`[${this.name}] ${command} failed: ${err.message}`);
    });
  }

  refreshAll() {
    this.refresh('GET_DOOR_STATUS');
    this.refresh('GET_SETTINGS');
    this.refresh('GET_DOOR_BATTERY');
    this.client
      .send('GET_HW_INFO')
      .then((msg) => {
        const fw = msg.fwInfo;
        if (fw && typeof fw === 'object' && fw.fw_maj !== undefined) {
          const version = `${fw.fw_maj}.${fw.fw_min ?? 0}.${fw.fw_pat ?? 0}`;
          this.accessory
            .getService(this.hap.Service.AccessoryInformation)
            .updateCharacteristic(this.hap.Characteristic.FirmwareRevision, version);
        }
      })
      .catch(() => {});
  }

  handleMessage(msg) {
    if (typeof msg.door_status === 'string') {
      this.updateDoorStatus(msg.door_status);
    }

    // Settings arrive nested under "settings" (GET_SETTINGS) or at the top
    // level (GET_SENSORS, ENABLE_INSIDE, POWER_ON, ...).
    const sources = [msg];
    if (msg.settings && typeof msg.settings === 'object') {
      sources.push(msg.settings);
    }
    let switchesChanged = false;
    for (const src of sources) {
      for (const def of Object.values(SWITCHES)) {
        if (def.field in src) {
          const v = toBool(src[def.field]);
          if (v !== undefined && v !== this.state[def.field]) {
            this.state[def.field] = v;
            switchesChanged = true;
          }
        }
      }
    }
    if (switchesChanged) {
      this.pushSwitches();
      this.pushOnOff();
      // The paused sensor looks like it was turned back on somewhere else
      // (the door's keypad or app). Doors sometimes report a stale value
      // right after a change, so confirm with a fresh read before giving up.
      const pause = this.chatterPause();
      if (pause && this.pausedSensors(pause).some((s) => this.state[s] === true)) {
        this.confirmOverride(pause, msg);
      }
    }

    if ('batteryPercent' in msg || 'batteryPresent' in msg) {
      const pct = Number(msg.batteryPercent);
      this.state.batteryPercent = Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : undefined;
      this.state.batteryPresent = toBool(msg.batteryPresent) === true;
      this.state.acPresent = toBool(msg.acPresent) === true;
      this.syncBatteryService();
    }
  }

  updateDoorStatus(status) {
    const previous = this.state.doorStatus;
    this.state.doorStatus = status;
    if (OPENING_STATES.has(status) || FULLY_OPEN_STATES.has(status)) {
      this.state.target = 100;
    } else if (CLOSING_STATES.has(status) || CLOSED_STATES.has(status)) {
      this.state.target = 0;
    }
    if (previous !== status) {
      this.log.debug(`[${this.name}] Door status: ${status}`);
      const wasOpen = OPENING_STATES.has(previous) || FULLY_OPEN_STATES.has(previous);
      const isOpen = OPENING_STATES.has(status) || FULLY_OPEN_STATES.has(status);
      if (previous !== undefined && !wasOpen && isOpen) {
        this.onDoorOpening();
      }
    }
    this.pushDoorState();
  }

  pushDoorState() {
    const { Characteristic } = this.hap;
    if (this.state.doorStatus === undefined) {
      return;
    }
    this.door.updateCharacteristic(Characteristic.CurrentPosition, this.currentPosition());
    this.door.updateCharacteristic(Characteristic.PositionState, this.positionState());
    this.door.updateCharacteristic(Characteristic.TargetPosition, this.state.target);
    if (this.contact) {
      this.contact.updateCharacteristic(Characteristic.ContactSensorState, this.contactState());
    }
  }

  pushSwitches() {
    const { Characteristic } = this.hap;
    for (const [subtype, svc] of Object.entries(this.switches)) {
      const value = this.state[SWITCHES[subtype].field];
      if (value !== undefined) {
        svc.updateCharacteristic(Characteristic.On, value);
      }
    }
  }

  syncBatteryService() {
    const { Service, Characteristic } = this.hap;
    const wanted = this.state.batteryPresent && this.config.exposeBattery !== false;
    if (wanted && !this.battery) {
      this.battery = this.accessory.addService(Service.Battery, 'Battery');
      this.setDisplayName(this.battery, 'Battery', [`${this.name} Battery`]);
      this.attachBatteryHandlers();
      this.log.info(`[${this.name}] Battery detected; added battery status`);
    } else if (!wanted && this.battery) {
      this.accessory.removeService(this.battery);
      this.battery = null;
    }
    if (this.battery) {
      this.battery.updateCharacteristic(Characteristic.BatteryLevel, this.state.batteryPercent ?? 0);
      this.battery.updateCharacteristic(Characteristic.StatusLowBattery, this.lowBatteryState());
      this.battery.updateCharacteristic(Characteristic.ChargingState, this.chargingState());
    }
  }

  markUnreachable() {
    // Pushing a communication failure makes the Home app show "No Response"
    // right away instead of waiting for its next read.
    const err = new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    this.door.getCharacteristic(this.hap.Characteristic.CurrentPosition).updateValue(err);
    if (this.onOffSwitch) {
      this.onOffSwitch.getCharacteristic(this.hap.Characteristic.On).updateValue(err);
    }
  }
}

module.exports = { PowerPetDoorAccessory, SWITCHES, isGenericName };
