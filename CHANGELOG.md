# Changelog

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
