'use strict';

const { PowerPetDoorPlatform, PLATFORM_NAME } = require('./lib/platform');

module.exports = (api) => {
  api.registerPlatform(PLATFORM_NAME, PowerPetDoorPlatform);
};
