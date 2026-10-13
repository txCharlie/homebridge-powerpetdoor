# Changelog

## 0.2.7

- Chatter guard: new "Both sensors" choice for which sensor to pause
  (`chatterSensor: "both"`). Use it when the outside sensor picks up a
  collar through the door, so pausing only the inside sensor isn't enough.
- Chatter guard: only sensors that are on when a pause starts are paused,
  so a pause never turns on a sensor that was off.
- Chatter guard: taking over one paused sensor by hand leaves the other
  paused until the pause ends.

## 0.2.6

- Chatter guard: a report that the paused sensor is back on is now
  double-checked with the door a few seconds later before the pause is
  cancelled. Doors can briefly report a stale value right after a change.
  The log now says which message reported it.
- Chatter guard: reads the door's settings fresh before pausing, so it
  knows whether the door's schedule is on.
- README: new section on the door's own schedule, including when to turn
  it off.

## 0.2.5

- Fix: on a door with its schedule turned on, a chatter guard pause ended
  within seconds ("pause cancelled (sensor turned back on outside Apple
  Home)"). The door enforces its schedule by switching the sensors itself,
  so the guard now pauses the door's schedule along with the sensor and
  resumes both afterwards.
- The same applies to the on/off switch in the inside-sensor and
  both-sensors modes: "off" pauses the door's schedule, "on" resumes it.

## 0.2.4

- Fix: switch names could get stuck as "Switch", "Switch 2", and so on. The
  Home app can save its own generic labels back into the accessory, and
  earlier versions kept them as if you'd chosen them. Generic labels are now
  replaced with the real names (including on existing installs, at the next
  restart), while names you pick in the Home app are still kept.

## 0.2.3

- Fix: the Home app showed the door's switches as "Switch", "Switch 2", and
  so on. Controls are now named on their own ("Inside Sensor", "Power",
  "Chatter Guard"), since the Home app already shows them under the
  accessory's name. Existing installs are renamed automatically, except for
  any control you've renamed yourself in the Home app.

## 0.2.2

- The port setting is now a number box instead of a slider. An invalid port
  falls back to the door's default (3000).

## 0.2.1

- Fix: opening and saving the plugin settings added a blank door for each
  collapsible section. The door's settings are now kept together in one
  card, so they always save to the right door.
- The chatter guard checkbox is now labeled "Turn on chatter guard".

## 0.2.0

- New on/off switch for "Hey Siri, turn the dog door off/on", published as
  its own accessory, with a choice of what "off" means (power, inside
  sensor, or both sensors).
- New chatter guard: pauses a sensor when the door keeps opening, for
  example while a pet eats next to it. Survives restarts, and manual
  changes always take over from it.
- Blank door entries left by the settings screen are now ignored with a
  single clear message.
- The command timeout setting is now a number box instead of a slider.

## 0.1.0

- First release: open and close the door, live position, activity sensor for
  notifications, inside/outside sensor switches, optional power and schedule
  switches, battery status, automatic reconnection.
