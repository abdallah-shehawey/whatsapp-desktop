/*
 * The desktop's media card, for the voice notes this client plays.
 *
 * A voice note is audio the desktop never hears about: it is played by a page,
 * and the shell's media controls only know what an MPRIS2 player tells them.
 * Without this, pressing the headset button while a note is playing reaches
 * whatever else is registered -- a music player in another workspace -- and the
 * note carries on. With it, the note is what the keys are holding, the lock
 * screen names it, and pausing from there actually pauses it.
 *
 * It speaks the same hand-rolled D-Bus as the tray does (src/dbus.js), for the
 * same reason: one socket and no dependency, rather than a library to carry an
 * app that already talks to the bus.
 *
 *   org.mpris.MediaPlayer2         -- Raise and Quit, so the card can reach the window
 *   org.mpris.MediaPlayer2.Player  -- Play, Pause, PlayPause, Stop, and the status
 *
 * The name is taken per spec, and a second copy of the client falls back to a
 * name with its pid in it rather than failing to register at all.
 */
'use strict';

const {
  MPRIS_NAME,
  MPRIS_PATH,
  MPRIS_IFACE,
  PLAYER_IFACE,
  PROPS_IFACE,
  INTROSPECT_IFACE,
} = require('./mpris/constants.js');
const { MprisService } = require('./mpris/service.js');

module.exports = {
  MprisService,
  MPRIS_NAME,
  MPRIS_PATH,
  MPRIS_IFACE,
  PLAYER_IFACE,
  PROPS_IFACE,
  INTROSPECT_IFACE,
};
