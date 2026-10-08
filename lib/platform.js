'use strict';

const { PowerPetDoorAccessory } = require('./doorAccessory');
const { DEFAULT_PORT } = require('./protocol');

const PLUGIN_NAME = 'homebridge-powerpetdoor';
const PLATFORM_NAME = 'PowerPetDoor';

class PowerPetDoorPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.cached = new Map();
    this.doors = [];

    this.api.on('didFinishLaunching', () => this.discover());
  }

  configureAccessory(accessory) {
    this.cached.set(accessory.UUID, accessory);
  }

  discover() {
    const doors = Array.isArray(this.config.doors) ? this.config.doors : [];
    const seen = new Set();

    for (const raw of doors) {
      if (!raw || !raw.host) {
        this.log.warn('Skipping a door with no "host" (IP address) configured');
        continue;
      }
      const config = { ...raw, port: raw.port || DEFAULT_PORT, name: raw.name || 'Pet Door' };
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${config.host}:${config.port}`);
      if (seen.has(uuid)) {
        this.log.warn(`Door ${config.host}:${config.port} is listed twice; ignoring the duplicate`);
        continue;
      }
      seen.add(uuid);

      let accessory = this.cached.get(uuid);
      if (accessory) {
        this.log.info(`Restoring ${config.name} (${config.host})`);
        this.doors.push(new PowerPetDoorAccessory(this, accessory, config));
        this.api.updatePlatformAccessories([accessory]);
      } else {
        this.log.info(`Adding ${config.name} (${config.host})`);
        accessory = new this.api.platformAccessory(config.name, uuid);
        this.doors.push(new PowerPetDoorAccessory(this, accessory, config));
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }

    const stale = [...this.cached.values()].filter((a) => !seen.has(a.UUID));
    if (stale.length) {
      this.log.info(`Removing ${stale.length} door(s) no longer in the config`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }
}

module.exports = { PowerPetDoorPlatform, PLUGIN_NAME, PLATFORM_NAME };
