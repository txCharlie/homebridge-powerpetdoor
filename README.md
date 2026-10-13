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
| **On/off switch** | One switch for "Hey Siri, turn the dog door off" (or on). It's a separate accessory, so Siri can't confuse it with the other switches. You choose what "off" means: power off, inside sensor off, or both sensors off. |
| **Chatter Guard** switch *(when enabled)* | Turns the chatter guard (below) on or off. |

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
| `exposeOnOffSwitch` | `true` | Show the on/off switch. |
| `onOffSwitchName` | *door name* + " Switch" | Name for the on/off switch (what you say to Siri). |
| `onOffMode` | `power` | What "off" means: `power`, `inside`, or `sensors`. |
| `chatterGuard` | `false` | Turn on the chatter guard. |
| `chatterOpens` | `5` | Openings that trigger a pause. |
| `chatterWindowSeconds` | `60` | ...within this many seconds. |
| `chatterPauseMinutes` | `5` | How long to pause. |
| `chatterSensor` | `inside` | Which sensor to pause: `inside`, `outside`, or `both`. |
| `exposeChatterGuardSwitch` | `true` | Show a switch to turn the chatter guard on and off. |
| `statusPollSeconds` | `30` | Backup status check. Status normally arrives instantly from the door. |
| `settingsPollSeconds` | `120` | How often to re-read sensor, power, and schedule settings, to catch changes made in the door's own app or keypad. |
| `batteryPollSeconds` | `600` | How often to read the battery. |
| `timeoutSeconds` | `10` | How long to wait for the door to answer a command. |

## The on/off switch and Siri

Give the switch the name you'll say to Siri, such as **Dog Door**, in the plugin settings (`onOffSwitchName`). Then "Hey Siri, turn off the dog door" and "turn on the dog door" do exactly one thing.

Use a different name for the door's main accessory in the Home app (for example **Pet Door**). If both share a name, Siri may act on the wrong one.

| `onOffMode` | When off |
|---|---|
| `power` *(default)* | The door's power is off. Nothing goes in or out. |
| `inside` | The inside sensor is off. Pets stay in, but a pet outside can still come back in. |
| `sensors` | Both sensors are off. The door won't open for any collar. |

Turning the switch on always restores power as well. In the `inside` and `sensors` modes, turning the switch off also pauses the door's own schedule (if it's on), so the schedule can't turn the sensors back on; turning it on resumes it.

## Chatter guard

If a pet lingers near the door, for example while eating at a bowl next to it, the door can cycle up and down over and over. The chatter guard notices and pauses one sensor for a while:

- If the door opens **5 times within 60 seconds** (`chatterOpens`, `chatterWindowSeconds`), the **inside sensor** (`chatterSensor`) is turned off for **5 minutes** (`chatterPauseMinutes`), then turned back on.
- If your pet can still open the door during a pause, the outside sensor is probably picking up the collar through the door. Lower the outside sensor's range in High Tech Pet's app, or set `chatterSensor` to `both`. With `both`, a pet that's outside when a pause starts has to wait for it to end to come back in.
- Openings you trigger from Apple Home don't count. A door held open by a pet standing in the doorway counts as one opening, not many.
- The pause survives restarts: if Homebridge restarts mid-pause, it still ends on time.
- Changing a paused sensor yourself, or using the on/off switch, takes over from the guard, so a pause never undoes something you asked for.
- Each pause is logged, so you can see how often it happens.
- If the door's own schedule is on, it's paused along with the sensor and resumed afterwards. A door enforces its schedule by switching the sensors itself, which would otherwise undo the pause within seconds.

Turn it on with **Chatter guard** in the plugin settings (`chatterGuard: true`).

## The door's own schedule

Power Pet doors have a built-in schedule that decides when each sensor works. It has a master switch, and **on many doors that switch is on from the factory, even if no schedule was ever set up.**

While the master switch is on, the door enforces its schedule by turning the sensors on and off itself. That can undo changes made from Apple Home: for example, the door may turn a sensor you switched off straight back on.

**If you'd rather run schedules with Apple Home automations, turn the door's schedule off.** Show the **Schedule** switch (`exposeSchedule: true`), turn it off once, then hide it again if you like. You can also turn it off in High Tech Pet's app. Then build schedules as Home app automations, for example "At 10:00 PM, turn off Outside Sensor" and "At 6:30 AM, turn it on". Automations can also use sunrise, sunset, or whether anyone is home.

Keep the door's schedule on if you'd rather it run on the door itself, which keeps working even if Homebridge or your Wi-Fi is down. The chatter guard and the on/off switch both work either way: when they need a sensor off, they pause the door's schedule for that time and resume it afterwards.

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
