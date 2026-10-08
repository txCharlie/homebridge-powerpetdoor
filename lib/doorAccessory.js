'use strict';

const { PowerPetDoorClient } = require('./client');
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

class PowerPetDoorAccessory {
  constructor(platform, accessory, config) {
    this.platform = platform;
    this.api = platform.api;
    this.hap = platform.api.hap;
    this.log = platform.log;
    this.accessory = accessory;
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

    this.setupServices();

    this.client = new PowerPetDoorClient({
      host: config.host,
      port: config.port,
      log: this.prefixedLog(),
      timeoutMs: (config.timeoutSeconds ?? 10) * 1000,
    });
    this.client.on('message', (msg) => this.handleMessage(msg));
    this.client.on('connected', () => this.refreshAll());
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
    this.client.stop();
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
    this.door = acc.getService(Service.Door) || acc.addService(Service.Door, this.name);
    this.setDisplayName(this.door, this.name);
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
      `${this.name} Activity`,
      this.config.exposeActivitySensor !== false,
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
      const svc = this.syncOptionalService(Service.Switch, subtype, `${this.name} ${def.label}`, exposed);
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
      this.attachBatteryHandlers();
    }
  }

  setDisplayName(service, name) {
    const { Characteristic } = this.hap;
    service.setCharacteristic(Characteristic.Name, name);
    if (!service.testCharacteristic(Characteristic.ConfiguredName)) {
      service.addOptionalCharacteristic(Characteristic.ConfiguredName);
    }
    // Only set ConfiguredName the first time, so a name the user changes
    // in the Home app isn't overwritten on every restart.
    const configured = service.getCharacteristic(Characteristic.ConfiguredName);
    if (!configured.value) {
      configured.updateValue(name);
    }
  }

  syncOptionalService(type, subtype, name, exposed) {
    const existing = this.accessory.getServiceById(type, subtype);
    if (!exposed) {
      if (existing) {
        this.accessory.removeService(existing);
      }
      return null;
    }
    const svc = existing || this.accessory.addService(type, name, subtype);
    this.setDisplayName(svc, name);
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
    try {
      await this.client.send(command);
      this.state.target = open ? 100 : 0;
    } catch (err) {
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
    } catch (err) {
      this.log.warn(`[${this.name}] ${err.message}`);
      setImmediate(() => this.pushSwitches());
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
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
      this.battery = this.accessory.addService(Service.Battery, `${this.name} Battery`);
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
  }
}

module.exports = { PowerPetDoorAccessory, SWITCHES };
