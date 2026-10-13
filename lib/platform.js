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

  /** Return the cached accessory for `uuid`, or create and register a new one. */
  getOrCreate(uuid, name, created) {
    let accessory = this.cached.get(uuid);
    if (!accessory) {
      accessory = new this.api.platformAccessory(name, uuid);
      created.push(accessory);
    }
    return accessory;
  }

  discover() {
    const doors = Array.isArray(this.config.doors) ? this.config.doors : [];
    const seen = new Set();
    const created = [];

    // Homebridge's settings screen can leave behind empty door entries.
    // Skip them with one clear message instead of a warning per entry.
    const blank = doors.filter((d) => !d || !String(d.host || '').trim()).length;
    if (blank) {
      this.log.warn(
        `Ignoring ${blank} door entr${blank === 1 ? 'y' : 'ies'} with no IP address. ` +
          'You can delete them in the plugin settings.',
      );
    }

    for (const raw of doors) {
      if (!raw || !String(raw.host || '').trim()) {
        continue;
      }
      const config = {
        ...raw,
        host: String(raw.host).trim(),
        port: raw.port || DEFAULT_PORT,
        name: (raw.name || 'Pet Door').trim(),
      };
      const id = `${PLUGIN_NAME}:${config.host}:${config.port}`;
      const uuid = this.api.hap.uuid.generate(id);
      if (seen.has(uuid)) {
        this.log.warn(`Door ${config.host} is listed more than once; using the first entry`);
        continue;
      }
      seen.add(uuid);

      const isNew = !this.cached.has(uuid);
      this.log.info(`${isNew ? 'Adding' : 'Restoring'} ${config.name} (${config.host})`);
      const accessory = this.getOrCreate(uuid, config.name, created);

      // Optional on/off switch, published as its own accessory.
      let switchAccessory = null;
      if (config.exposeOnOffSwitch !== false) {
        const switchUuid = this.api.hap.uuid.generate(`${id}:onoff`);
        config.onOffSwitchName = String(config.onOffSwitchName || `${config.name} Switch`).trim();
        switchAccessory = this.getOrCreate(switchUuid, config.onOffSwitchName, created);
        seen.add(switchUuid);
      }

      this.doors.push(new PowerPetDoorAccessory(this, accessory, config, switchAccessory));
    }

    if (created.length) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, created);
    }
    const restored = [...this.cached.values()].filter((a) => seen.has(a.UUID));
    if (restored.length) {
      this.api.updatePlatformAccessories(restored);
    }
    const stale = [...this.cached.values()].filter((a) => !seen.has(a.UUID));
    if (stale.length) {
      this.log.info(`Removing ${stale.length} accessor${stale.length === 1 ? 'y' : 'ies'} no longer in the config`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }
}

module.exports = { PowerPetDoorPlatform, PLUGIN_NAME, PLATFORM_NAME };
