# Changelog

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
