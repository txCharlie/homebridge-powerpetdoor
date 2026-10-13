'use strict';

const { PowerPetDoorClient } = require('./client');
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
    this.chatterSensor = config.chatterSensor === 'outside' ? 'outside' : 'inside';
    this.chatterPauseMs = Math.max(1, config.chatterPauseMinutes ?? 5) * 60000;
    this.chatter = new ChatterGuard({
      opens: config.chatterOpens ?? 5,
      windowMs: Math.max(5, config.chatterWindowSeconds ?? 60) * 1000,
    });
    this.chatterTimer = null;
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
      if (this.chatterPause() && def.field === this.chatterPause().sensor) {
        this.clearChatterPause(`${def.label} turned ${value ? 'on' : 'off'} manually`);
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
    try {
      for (const cmd of this.onOffCommands(on)) {
        await this.client.send(cmd);
      }
      // A manual on/off takes over from the chatter guard. Hand the paused
      // sensor back now, unless the "off" just asked for turns that same
      // sensor off on purpose; otherwise it would stay off after the door
      // is next turned on.
      const pause = this.chatterPause();
      if (pause) {
        const keepOff = !on && this.onOffCommands(false).includes(`DISABLE_${pause.sensor.toUpperCase()}`);
        if (keepOff) {
          this.clearChatterPause(`door turned off manually`);
        } else {
          this.log.info(`[${this.name}] Chatter guard: pause cancelled (door turned ${on ? 'on' : 'off'} manually)`);
          await this.endChatterPause();
        }
      }
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
    const sensor = this.chatterSensor;
    const label = sensor === 'inside' ? 'inside sensor' : 'outside sensor';
    if (this.state[sensor] !== true) {
      this.log.info(`[${this.name}] Chatter guard: door is busy, but the ${label} is already off`);
      return;
    }
    const minutes = Math.round(this.chatterPauseMs / 60000);
    this.log.info(
      `[${this.name}] Chatter guard: door opened ${this.chatter.opens} times within ` +
        `${Math.round(this.chatter.windowMs / 1000)}s; turning the ${label} off for ${minutes} min`,
    );
    try {
      await this.client.send(sensor === 'inside' ? 'DISABLE_INSIDE' : 'DISABLE_OUTSIDE');
    } catch (err) {
      this.log.warn(`[${this.name}] Chatter guard could not pause the door: ${err.message}`);
      return;
    }
    this.accessory.context.chatterPause = { sensor, until: Date.now() + this.chatterPauseMs };
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

  async endChatterPause() {
    clearTimeout(this.chatterTimer);
    const pause = this.chatterPause();
    if (!pause) {
      return;
    }
    if (!this.client.connected) {
      // Try again as soon as the door is reachable.
      return;
    }
    const label = pause.sensor === 'inside' ? 'inside sensor' : 'outside sensor';
    // Clear the pause before sending, so the door's reply (sensor on) isn't
    // mistaken for someone overriding the pause by hand.
    delete this.accessory.context.chatterPause;
    try {
      await this.client.send(pause.sensor === 'inside' ? 'ENABLE_INSIDE' : 'ENABLE_OUTSIDE');
      this.log.info(`[${this.name}] Chatter guard: pause over; ${label} back on`);
      this.chatter.reset();
      this.saveContext();
    } catch (err) {
      this.accessory.context.chatterPause = pause;
      this.log.warn(`[${this.name}] Chatter guard could not turn the ${label} back on: ${err.message}`);
      // Retry in a minute.
      this.chatterTimer = setTimeout(() => this.endChatterPause(), 60000);
    }
  }

  clearChatterPause(reason) {
    if (!this.chatterPause()) {
      return;
    }
    clearTimeout(this.chatterTimer);
    delete this.accessory.context.chatterPause;
    this.chatter.reset();
    if (reason) {
      this.log.info(`[${this.name}] Chatter guard: pause cancelled (${reason})`);
    }
    this.saveContext();
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
      // The paused sensor was turned back on somewhere else (the door's
      // keypad or app): respect that and end the pause.
      const pause = this.chatterPause();
      if (pause && this.state[pause.sensor] === true) {
        this.clearChatterPause('sensor turned back on outside Apple Home');
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
