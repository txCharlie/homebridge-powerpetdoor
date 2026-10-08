# homebridge-powerpetdoor

Control **High Tech Pet Power Pet** Wi-Fi doors from Apple Home, directly over your local network. No cloud account and no extra app.

> Not affiliated with or endorsed by High Tech Pet Products, Inc.

## What you get in Apple Home

| Accessory | What it does |
|---|---|
| **Door** | Open and close the door, and see its live position as it rises, holds, and closes. Works with Siri ("Hey Siri, open the dog door"). |
| **Activity sensor** | A contact sensor that opens whenever the door opens. Turn on notifications for it in the Home app to get a "the dog just went out" alert. |
| **Inside Sensor / Outside Sensor** switches | Turn the door's inside or outside collar sensor on or off, for example to keep the dog in at night. |
| **Power** switch *(optional)* | Turn the door's motor on or off. |
| **Schedule** switch *(optional)* | Turn the door's built-in schedule on or off. |
| **Battery** | Battery level, low-battery warning, and charging state. Added automatically only if the door has a battery installed. |

The door pushes its status to the plugin as it moves, so the Home app updates within a second. If the door drops off the network, its tiles show **No Response** until it reconnects, and the plugin keeps retrying on its own.

## Requirements

- A **Wi-Fi** Power Pet door (model numbers ending in **WF**, such as PX-1WFW or PX2-SRE-WF), already connected to your Wi-Fi with High Tech Pet's app.
- Homebridge 1.8 or newer (Homebridge 2.x supported).
- The Homebridge server and the door on the same network.

## Setup

1. **Give the door a fixed IP address.** In your router's settings, reserve the door's current address (often called a DHCP reservation). The door's name in your router's device list is usually its MAC address or something generic.
2. **Install the plugin.** In the Homebridge UI, open **Plugins**, search for **Power Pet Door**, and install it.
3. **Configure it.** Add a door, enter its **name** and **IP address**, and save. Everything else has sensible defaults.
4. **Restart Homebridge.** Running the plugin as a **child bridge** is recommended; pair the child bridge with the QR code under the plugin's *Bridge Settings*.

### Example configuration

```json
{
  "platform": "PowerPetDoor",
  "name": "Power Pet Door",
  "doors": [
    {
      "name": "Dog Door",
      "host": "192.168.1.50",
      "openMode": "timed"
    }
  ]
}
```

### Options (per door)

| Option | Default | Description |
|---|---|---|
| `name` | `Pet Door` | Name shown in Apple Home. |
| `host` | *(required)* | The door's IP address. |
| `port` | `3000` | The door's local control port. You shouldn't need to change this. |
| `openMode` | `timed` | `timed` opens the door and lets it close after its normal hold time. `hold` opens it and keeps it open until you close it. |
| `exposeActivitySensor` | `true` | Show the activity (contact) sensor. |
| `exposeInsideSensor` | `true` | Show the inside sensor switch. |
| `exposeOutsideSensor` | `true` | Show the outside sensor switch. |
| `exposePower` | `false` | Show the power switch. |
| `exposeSchedule` | `false` | Show the schedule switch. |
| `exposeBattery` | `true` | Show battery status when a battery is installed. |
| `statusPollSeconds` | `30` | Backup status check. Status normally arrives instantly from the door. |
| `settingsPollSeconds` | `120` | How often to re-read sensor, power, and schedule settings, to catch changes made in the door's own app or keypad. |
| `batteryPollSeconds` | `600` | How often to read the battery. |
| `timeoutSeconds` | `10` | How long to wait for the door to answer a command. |

## A word on safety

This plugin can open your door remotely, and Apple Home automations can open it on a schedule. Think through what happens if an automation fires while you're away or the door is left open overnight. The **Outside Sensor** switch is a safer tool than opening the door for most "let the dog out" or "keep the dog in" automations.

## Troubleshooting

- **"Could not connect" in the log:** check the IP address, and make sure the door shows as online in High Tech Pet's app. The door only accepts local connections on your own network.
- **"Door refused OPEN: Power is OFF":** the door's power is off. Turn it on with the power button, the High Tech Pet app, or the optional Power switch.
- **Tiles show No Response:** the door is offline or rebooting. The plugin reconnects automatically, backing off up to once a minute.
- For detailed logs, start Homebridge in debug mode.

## Credits

The door's local protocol was documented by Preston Elder in the MIT-licensed [pypowerpetdoor](https://github.com/corporategoth/py-powerpetdoor) library and the [ha-powerpetdoor](https://github.com/corporategoth/ha-powerpetdoor) Home Assistant integration. This plugin is an independent JavaScript implementation built on that work, and was tested against the door simulator included with pypowerpetdoor.

## Development

```sh
npm install
npm test                      # unit tests
pip install pypowerpetdoor     # provides a door simulator
ppd-simulator --port 3300 &
PPD_SIM_PORT=3300 npm test     # also runs the tests against the simulator
```

## License

MIT
