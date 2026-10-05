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

/* What the card says when there is no note to name. Nothing sets a title yet --
   a voice note has none to take -- so this is what it reads whenever it is up. */
const PLACEHOLDER_TITLE = 'WhatsApp Voice Message';

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
    /*
     * Whether the desktop is shown a card AT ALL, and false until a note is
     * actually loaded.
     *
     * This answered true from the moment the service registered, and the name
     * is taken at launch -- so the client put a media card in the notification
     * centre and left it there for the life of the process, carrying the
     * placeholder metadata two lines down because nothing ever replaced it.
     *
     * It is CanPlay and not PlaybackStatus that decides, which is worth being
     * exact about because the status is the obvious suspect and is not the
     * answer. From gnome-shell's own mpris.js, the line that builds the list it
     * draws:
     *
     *     return [...this._players.values()].filter(player => player.canPlay);
     *
     * PlaybackStatus is read only to pick which button to draw. So a player
     * parked at "Stopped" is still a card, and the only way to take one down is
     * to stop being able to play -- or to leave the bus.
     *
     * Measured on the live bus with the card stuck in the notification centre
     * after a call: PlaybackStatus "Paused", CanPlay true, Position 0, and
     * xesam:title still "WhatsApp Voice Message". Nothing had played. The card
     * had been there all along and the call was when somebody looked.
     */
    this.canPlay = false;
    this.title = PLACEHOLDER_TITLE;
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

  metadataEntries() {
    return [
      ['mpris:trackid', vo('/org/mpris/MediaPlayer2/Track/current')],
      ['xesam:title', vs(this.title)],
      ['xesam:artist', ['as', [this.artist]]],
      ['xesam:album', vs('WhatsApp Voice Note')],
      ['mpris:length', vx(this.durationSec * 1000000)],
    ];
  }

  playerProperties() {
    const metaEntries = this.metadataEntries();

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
      ['CanPlay', vb(this.canPlay)],
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

  /*
   * A note is loaded: raise a card for it. Playing or paused, there is now
   * something for a media key to reach and something worth drawing.
   */
  present({ title, durationSec, positionSec, state }) {
    if (title) this.title = title;
    if (typeof durationSec === 'number') this.durationSec = durationSec;
    if (typeof positionSec === 'number') this.positionSec = positionSec;
    if (state) this.playbackStatus = state;
    this.canPlay = true;
    this.notifyPropertiesChanged();
  }

  /*
   * Nothing is loaded any more -- the note played out, or the page let go of
   * its resource. The card goes, and the metadata goes back to the placeholder
   * so that whatever the shell caches is not a track that has gone.
   *
   * The bus name is deliberately KEPT. Dropping it would take the card down
   * too, and it would also take away the thing this service exists for: a name
   * on the bus is what a media key is routed to, and a client that only
   * registers once a note is already playing cannot be the one that starts it.
   */
  withdraw() {
    if (!this.canPlay && this.playbackStatus === 'Stopped') return;
    this.canPlay = false;
    this.playbackStatus = 'Stopped';
    this.positionSec = 0;
    this.durationSec = 0;
    this.title = PLACEHOLDER_TITLE;
    this.notifyPropertiesChanged();
  }

  notifyPropertiesChanged() {
    if (!this.bus) return;
    const changed = [
      ['PlaybackStatus', vs(this.playbackStatus)],
      ['Position', vx(this.positionSec * 1000000)],
      /* CanPlay is what the shell adds and drops a card on, so a change it is
         not told about is a card that never appears or never leaves. Metadata
         rides along for the same reason: the title is read when the card is
         built, and one sent after it is built is one nobody asked for again. */
      ['CanPlay', vb(this.canPlay)],
      ['Metadata', ['a{sv}', this.metadataEntries()]],
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
