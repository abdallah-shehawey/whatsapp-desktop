/*
 * MprisService implementation for controlling media playback over D-Bus.
 */
'use strict';

const { Bus } = require('../dbus.js');
const {
  MPRIS_NAME,
  MPRIS_PATH,
  MPRIS_IFACE,
  PLAYER_IFACE,
  PROPS_IFACE,
  INTROSPECT_IFACE,
  vs,
  vb,
  vd,
  vx,
  vo,
  MPRIS_XML,
} = require('./constants.js');

class MprisService {
  constructor({ onRaise, onQuit, onPlayPause, onPlay, onPause, onStop, onSeek, onNext, onPrevious }) {
    this.handlers = {
      onRaise,
      onQuit,
      onPlayPause,
      onPlay,
      onPause,
      onStop,
      onSeek,
      onNext,
      onPrevious,
    };

    this.bus = null;
    this.busName = null;
    this.playbackStatus = 'Stopped'; // 'Playing' | 'Paused' | 'Stopped'
    this.title = 'WhatsApp Voice Message';
    this.artist = 'WhatsApp';
    this.durationSec = 0;
    this.positionSec = 0;
    this.rate = 1.0;
    this.volume = 1.0;
  }

  start(cb) {
    Bus.connect((err, bus) => {
      if (err) { if (cb) cb(err); return; }
      this.bus = bus;
      this.busName = MPRIS_NAME;

      bus.requestName(this.busName, nameErr => {
        if (nameErr) {
          // If already taken, try PID-suffixed name
          this.busName = `${MPRIS_NAME}.instance${process.pid}`;
          bus.requestName(this.busName, err2 => {
            if (err2) { if (cb) cb(err2); return; }
            this.exportService();
            if (cb) cb(null);
          });
          return;
        }
        this.exportService();
        if (cb) cb(null);
      });
    });
  }

  rootProperties() {
    return [
      ['CanQuit', vb(true)],
      ['CanRaise', vb(true)],
      ['HasTrackList', vb(false)],
      ['Identity', vs('WhatsApp')],
      ['DesktopEntry', vs('io.github.shehawey.whatsapp-desktop')],
      ['SupportedUriSchemes', ['as', []]],
      ['SupportedMimeTypes', ['as', []]],
    ];
  }

  playerProperties() {
    const metaEntries = [
      ['mpris:trackid', vo('/org/mpris/MediaPlayer2/Track/current')],
      ['xesam:title', vs(this.title)],
      ['xesam:artist', ['as', [this.artist]]],
      ['xesam:album', vs('WhatsApp Voice Note')],
      ['mpris:length', vx(this.durationSec * 1000000)],
    ];

    return [
      ['PlaybackStatus', vs(this.playbackStatus)],
      ['LoopStatus', vs('None')],
      ['Rate', vd(this.rate)],
      ['Metadata', ['a{sv}', metaEntries]],
      ['Volume', vd(this.volume)],
      ['Position', vx(this.positionSec * 1000000)],
      ['MinimumRate', vd(1.0)],
      ['MaximumRate', vd(2.5)],
      ['CanControl', vb(true)],
      ['CanPlay', vb(true)],
      ['CanPause', vb(true)],
      ['CanSeek', vb(true)],
      ['CanGoNext', vb(false)],
      ['CanGoPrevious', vb(true)], // Rewind
    ];
  }

  exportService() {
    if (!this.bus) return;

    this.bus.export(MPRIS_PATH, {
      [MPRIS_IFACE]: {
        Raise: (args, reply) => {
          if (this.handlers.onRaise) this.handlers.onRaise();
          reply();
        },
        Quit: (args, reply) => {
          if (this.handlers.onQuit) this.handlers.onQuit();
          reply();
        },
      },
      [PLAYER_IFACE]: {
        Next: (args, reply) => {
          if (this.handlers.onNext) this.handlers.onNext();
          reply();
        },
        Previous: (args, reply) => {
          if (this.handlers.onPrevious) this.handlers.onPrevious();
          reply();
        },
        Pause: (args, reply) => {
          if (this.handlers.onPause) this.handlers.onPause();
          this.setPlaybackStatus('Paused');
          reply();
        },
        PlayPause: (args, reply) => {
          if (this.handlers.onPlayPause) this.handlers.onPlayPause();
          this.setPlaybackStatus(this.playbackStatus === 'Playing' ? 'Paused' : 'Playing');
          reply();
        },
        Stop: (args, reply) => {
          if (this.handlers.onStop) this.handlers.onStop();
          this.setPlaybackStatus('Stopped');
          reply();
        },
        Play: (args, reply) => {
          if (this.handlers.onPlay) this.handlers.onPlay();
          this.setPlaybackStatus('Playing');
          reply();
        },
        Seek: ([offsetMicro], reply) => {
          const offsetSec = Number(offsetMicro) / 1000000;
          if (this.handlers.onSeek) this.handlers.onSeek(offsetSec);
          reply();
        },
        SetPosition: ([, posMicro], reply) => {
          const posSec = Number(posMicro) / 1000000;
          if (this.handlers.onSeek) this.handlers.onSeek(posSec - this.positionSec);
          reply();
        },
      },
      [PROPS_IFACE]: {
        Get: ([iface, name], reply, fail) => {
          let props = [];
          if (iface === MPRIS_IFACE) props = this.rootProperties();
          else if (iface === PLAYER_IFACE) props = this.playerProperties();
          else { fail('org.freedesktop.DBus.Error.InvalidArgs', `unknown interface ${iface}`); return; }

          const found = props.find(p => p[0] === name);
          if (!found) { fail('org.freedesktop.DBus.Error.InvalidArgs', `no property ${name}`); return; }
          reply('v', [found[1]]);
        },
        GetAll: ([iface], reply) => {
          if (iface === MPRIS_IFACE) reply('a{sv}', [this.rootProperties()]);
          else if (iface === PLAYER_IFACE) reply('a{sv}', [this.playerProperties()]);
          else reply('a{sv}', [[]]);
        },
        Set: (args, reply) => reply(),
      },
      [INTROSPECT_IFACE]: {
        Introspect: (args, reply) => reply('s', [MPRIS_XML]),
      },
    });
  }

  updateTrack({ title, artist, durationSec, positionSec, state }) {
    if (title) this.title = title;
    if (artist) this.artist = artist;
    if (typeof durationSec === 'number') this.durationSec = durationSec;
    if (typeof positionSec === 'number') this.positionSec = positionSec;
    if (state) this.playbackStatus = state;
    this.notifyPropertiesChanged();
  }

  setPlaybackStatus(status) {
    if (this.playbackStatus === status) return;
    this.playbackStatus = status;
    this.notifyPropertiesChanged();
  }

  notifyPropertiesChanged() {
    if (!this.bus) return;
    const changed = [
      ['PlaybackStatus', vs(this.playbackStatus)],
      ['Position', vx(this.positionSec * 1000000)],
    ];
    /* Bus.signal takes the whole message as one object -- passing the path,
       interface and member positionally puts the path's own characters on the
       message as numbered fields and sends nothing a host can read. The card
       then sits on whatever status it was first told, which is the "it says
       Playing after the note ended" report. */
    try {
      this.bus.signal({
        path: MPRIS_PATH, interface: PROPS_IFACE, member: 'PropertiesChanged',
        signature: 'sa{sv}as', body: [PLAYER_IFACE, changed, []],
      });
    } catch (e) {
      /* The bus is tearing down: there is nobody left to tell. */
    }
  }

  destroy() {
    if (this.bus) {
      try { this.bus.close(); } catch (e) {}
      this.bus = null;
    }
  }
}

module.exports = {
  MprisService,
};
