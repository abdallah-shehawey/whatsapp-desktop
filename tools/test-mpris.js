/*
 * The media card: what a key press reaches, and what the desktop is told after.
 *
 * The card itself cannot be tested -- it needs a session bus and a shell to
 * draw it -- but everything that decides what the shell sees is ordinary code
 * and this is all of it. The service is driven here the way a host drives it:
 * the method is called, and what came back out of the bus is read.
 *
 * The PropertiesChanged checks are not decoration. A signal sent with its path
 * and interface passed positionally instead of in the message marshals into a
 * message with no member at all: the service still registers, the keys still
 * work, and the card simply never changes what it says -- which is the "it
 * still reads Playing after the note ended" report, and the only sign anything
 * is wrong.
 */
'use strict';

/* The service asks for a bus and nothing else, so a bus that writes down what
   it was handed is the whole of what it needs. */
const dbus = require.resolve('../src/dbus.js');
const sent = [];
let exported = null;
require.cache[dbus] = {
  id: dbus, filename: dbus, loaded: true, children: [], paths: [],
  exports: {
    Bus: {
      connect(cb) {
        cb(null, {
          requestName: (name, done) => done(null),
          export: (path, interfaces) => { exported = { path, interfaces }; },
          signal: msg => sent.push(msg),
          close: () => {},
        });
      },
    },
  },
};

const { MprisService } = require('../src/mpris.js');
const { MPRIS_PATH, PLAYER_IFACE, PROPS_IFACE } = require('../src/mpris/constants.js');

let failures = 0;
const check = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { console.log('  ok   ' + label); return; }
  failures++;
  console.log('  FAIL ' + label +
              '\n         got  ' + JSON.stringify(got) +
              '\n         want ' + JSON.stringify(want));
};

const pressed = [];
const service = new MprisService({
  onRaise: () => pressed.push('raise'),
  onQuit: () => pressed.push('quit'),
  onPlayPause: () => pressed.push('playPause'),
  onPlay: () => pressed.push('play'),
  onPause: () => pressed.push('pause'),
  onStop: () => pressed.push('stop'),
});
service.start(() => {});

/* What a host finds when it looks at the object. */
check('the player is exported where the spec says to look for it',
      exported && exported.path, MPRIS_PATH);
check('and it answers on the Player interface',
      !!(exported && exported.interfaces[PLAYER_IFACE]), true);

/* A key press reaches the page. */
const player = exported.interfaces[PLAYER_IFACE];
player.Play([], () => {});
check('Play reaches the page', pressed[pressed.length - 1], 'play');
player.Pause([], () => {});
check('Pause reaches the page', pressed[pressed.length - 1], 'pause');
player.PlayPause([], () => {});
check('PlayPause reaches the page', pressed[pressed.length - 1], 'playPause');
player.Stop([], () => {});
check('Stop reaches the page', pressed[pressed.length - 1], 'stop');

/* And the desktop is told what changed, in a message it can actually read. */
sent.length = 0;
service.setPlaybackStatus('Playing');
const told = sent[0] || {};
check('a status change is announced once', sent.length, 1);
check('the announcement carries the object it is about', told.path, MPRIS_PATH);
check('on the properties interface', told.interface, PROPS_IFACE);
check('as PropertiesChanged', told.member, 'PropertiesChanged');
check('naming the interface whose properties moved', told.body && told.body[0], PLAYER_IFACE);
check('and the new status is in it',
      !!(told.body && told.body[1].find(p => p[0] === 'PlaybackStatus')), true);

/* Saying the same thing twice is not news. */
sent.length = 0;
service.setPlaybackStatus('Playing');
check('a status that has not changed is not announced again', sent.length, 0);

/* Raise and Quit, which are what the card's own buttons are. */
const root = exported.interfaces['org.mpris.MediaPlayer2'];
root.Raise([], () => {});
check('the card can ask for the window', pressed[pressed.length - 1], 'raise');
root.Quit([], () => {});
check('and it can ask the client to go', pressed[pressed.length - 1], 'quit');

console.log(failures ? `\n${failures} media card check(s) failed` : '\nmedia card checks pass');
process.exit(failures ? 1 : 0);
