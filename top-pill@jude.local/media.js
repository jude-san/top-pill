// MPRIS media players: track info, artwork, position and controls.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {Emitter, cacheDir, timeout, clearSource, report} from './util.js';

const PREFIX = 'org.mpris.MediaPlayer2.';
const PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

const RootProxy = Gio.DBusProxy.makeProxyWrapper(`<node>
<interface name="org.mpris.MediaPlayer2">
  <method name="Raise"/>
  <property name="Identity" type="s" access="read"/>
  <property name="DesktopEntry" type="s" access="read"/>
</interface></node>`);

const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(`<node>
<interface name="org.mpris.MediaPlayer2.Player">
  <method name="PlayPause"/>
  <method name="Next"/>
  <method name="Previous"/>
  <method name="SetPosition"><arg type="o" direction="in"/><arg type="x" direction="in"/></method>
  <property name="PlaybackStatus" type="s" access="read"/>
  <property name="Metadata" type="a{sv}" access="read"/>
  <property name="CanGoNext" type="b" access="read"/>
  <property name="CanGoPrevious" type="b" access="read"/>
  <property name="CanPlay" type="b" access="read"/>
  <property name="CanSeek" type="b" access="read"/>
  <signal name="Seeked"><arg type="x" name="pos"/></signal>
</interface></node>`);

const VIDEO_APPS = ['vlc', 'mpv', 'totem', 'celluloid', 'showtime', 'clapper', 'smplayer', 'haruna', 'kodi'];
// Video calls also publish a media player (the call's audio). They aren't
// something to play or skip, so they're left out of Media; the microphone
// and camera indicators already show a call is on.
const CALL_APPS = ['teams', 'zoom', 'skype', 'webex'];
const CALL_URL = /(teams\.(microsoft|live|cloud\.microsoft)|teams\.cloud|meet\.google\.com|zoom\.us|webex\.com|whereby\.com|meet\.jit\.si|app\.slack\.com\/huddle|discord\.com\/channels)/i;
const CALL_TITLE = /(microsoft teams|google meet|zoom meeting|zoom workplace|webex|whereby|jitsi|huddle|^\s*(meet|calendar|chat|call(ing)?|meeting)\s*[|·–-])/i;
const BROWSERS = ['firefox', 'chromium', 'chrome', 'brave', 'edge', 'vivaldi', 'opera', 'epiphany', 'zen'];
const VIDEO_EXT = /\.(mp4|mkv|webm|avi|mov|m4v|flv|wmv|ogv)(\?|$)/i;

function unpack(v) {
    return v instanceof GLib.Variant ? v.deepUnpack() : v;
}

let _soup = null;
async function soupSession() {
    if (_soup)
        return _soup;
    const {default: Soup} = await import('gi://Soup?version=3.0');
    _soup = {Soup, session: new Soup.Session({timeout: 15, user_agent: 'TopPill/1.0 (GNOME Shell extension)'})};
    return _soup;
}

export async function httpGet(url, {maxBytes = 2 * 1024 * 1024, headers = {}} = {}) {
    const {Soup, session} = await soupSession();
    const msg = Soup.Message.new('GET', url);
    for (const [k, v] of Object.entries(headers))
        msg.get_request_headers().append(k, v);
    const bytes = await new Promise((resolve, reject) => {
        session.send_and_read_async(msg, GLib.PRIORITY_LOW, null, (s, res) => {
            try {
                resolve(s.send_and_read_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
    const status = msg.get_status();
    if (status < 200 || status >= 300)
        throw new Error(`HTTP ${status} for ${url}`);
    if (bytes.get_size() > maxBytes)
        throw new Error(`Response too large for ${url}`);
    return bytes;
}

export function abortHttp() {
    _soup?.session.abort();
}

class Player {
    constructor(manager, busName) {
        this.manager = manager;
        this.busName = busName;
        this.id = busName;
        this.identity = busName.slice(PREFIX.length).split('.')[0];
        this.app = null;
        this.title = '';
        this.artists = [];
        this.album = '';
        this.artUrl = '';
        this.artPath = null;
        this.tint = null;
        this.length = 0;
        this.position = 0;
        this._posStamp = GLib.get_monotonic_time();
        this.status = 'Stopped';
        this.canNext = false;
        this.canPrev = false;
        this.canSeek = false;
        this.isVideo = false;
        this.trackId = null;
        this.lastActive = 0;
        this._cancel = new Gio.Cancellable();
        this._init();
    }

    async _init() {
        try {
            this._root = await new Promise((resolve, reject) => {
                // eslint-disable-next-line no-new
                new RootProxy(Gio.DBus.session, this.busName, PATH, (p, e) => (e ? reject(e) : resolve(p)), this._cancel);
            });
            this._player = await new Promise((resolve, reject) => {
                // eslint-disable-next-line no-new
                new PlayerProxy(Gio.DBus.session, this.busName, PATH, (p, e) => (e ? reject(e) : resolve(p)), this._cancel);
            });
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`Top Pill: MPRIS ${this.busName}: ${e.message}`);
            return;
        }
        if (this._cancel.is_cancelled())
            return;
        this.identity = this._root.Identity || this.identity;
        const entry = this._root.DesktopEntry;
        if (entry)
            this.app = Shell.AppSystem.get_default().lookup_app(`${entry}.desktop`);
        this._propsId = this._player.connect('g-properties-changed', () => this._sync());
        this._seekedId = this._player.connectSignal('Seeked', (_p, _s, [pos]) => {
            this._setPosition(pos);
            this.manager._changed();
        });
        this._sync();
        this.refreshPosition();
    }

    get ready() {
        return !!this._player && !!this.title && !this.isCall;
    }

    get appKey() {
        return `${this._root?.DesktopEntry ?? ''} ${this.identity}`.toLowerCase();
    }

    get gicon() {
        return this.app?.get_icon() ?? null;
    }

    get playing() {
        return this.status === 'Playing';
    }

    _sync() {
        const p = this._player;
        const md = unpack(p.Metadata) ?? {};
        const get = k => unpack(md[k]);
        const oldStatus = this.status;
        this.status = p.PlaybackStatus ?? 'Stopped';
        this.canNext = !!p.CanGoNext;
        this.canPrev = !!p.CanGoPrevious;
        this.canSeek = !!p.CanSeek;
        const title = get('xesam:title') ?? '';
        const artists = get('xesam:artist');
        const trackId = get('mpris:trackid') ?? null;
        const trackChanged = title !== this.title || trackId !== this.trackId;
        this.title = typeof title === 'string' ? title : '';
        this.artists = Array.isArray(artists) ? artists.filter(a => typeof a === 'string') : (typeof artists === 'string' ? [artists] : []);
        this.album = get('xesam:album') ?? '';
        this.trackId = trackId;
        const len = Number(get('mpris:length') ?? 0);
        this.length = Number.isFinite(len) ? len : 0;
        const url = get('xesam:url') ?? '';
        const key = this.appKey;
        this.isVideo = VIDEO_EXT.test(url) ||
            VIDEO_APPS.some(a => key.includes(a)) ||
            (BROWSERS.some(b => key.includes(b)) && this.artists.length === 0);
        const browser = BROWSERS.some(b => key.includes(b));
        this.isCall = CALL_APPS.some(a => key.includes(a)) ||
            (browser && this.artists.length === 0 && (
                CALL_URL.test(url) || CALL_TITLE.test(this.title) ||
                (this.length > 0 && this.length < 10e6))); // a call or a short sound, not a track
        const art = get('mpris:artUrl') ?? '';
        if (art !== this.artUrl) {
            this.artUrl = art;
            this.artPath = null;
            this.tint = null;
            this._loadArt(art);
        }
        if (this.status === 'Playing')
            this.lastActive = GLib.get_monotonic_time();
        if (trackChanged || oldStatus !== this.status)
            this.refreshPosition();
        this.manager._changed();
    }

    async _loadArt(url) {
        if (!url)
            return;
        let path = null;
        try {
            if (url.startsWith('file://')) {
                path = Gio.File.new_for_uri(url).get_path();
            } else if (/^https?:\/\//.test(url)) {
                const name = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, url, -1);
                path = GLib.build_filenamev([cacheDir('art'), name]);
                if (!GLib.file_test(path, GLib.FileTest.EXISTS)) {
                    const bytes = await httpGet(url);
                    GLib.file_set_contents(path, bytes.get_data());
                }
            }
        } catch (e) {
            console.debug(`Top Pill: artwork ${url}: ${e.message}`);
            path = null;
        }
        if (url !== this.artUrl)
            return;
        this.artPath = path && GLib.file_test(path, GLib.FileTest.EXISTS) ? path : null;
        this.tint = this.artPath ? await averageColor(this.artPath) : null;
        this.manager._changed();
    }

    _setPosition(us) {
        this.position = Number(us) || 0;
        this._posStamp = GLib.get_monotonic_time();
    }

    // Interpolated position in microseconds.
    get currentPosition() {
        let pos = this.position;
        if (this.playing)
            pos += GLib.get_monotonic_time() - this._posStamp;
        return this.length > 0 ? Math.min(pos, this.length) : pos;
    }

    refreshPosition() {
        // Position is not announced by PropertiesChanged, so read it directly.
        Gio.DBus.session.call(this.busName, PATH, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']), null,
            Gio.DBusCallFlags.NONE, 2000, this._cancel, (c, res) => {
                try {
                    const [v] = c.call_finish(res).deepUnpack();
                    this._setPosition(unpack(v));
                    this.manager._changed();
                } catch {}
            });
    }

    playPause() {
        this._player?.PlayPauseAsync().catch(() => {});
    }

    next() {
        this._player?.NextAsync().catch(() => {});
    }

    previous() {
        this._player?.PreviousAsync().catch(() => {});
    }

    seekFraction(f) {
        if (!this.canSeek || !this.length || !this.trackId)
            return;
        const pos = Math.round(f * this.length);
        this._player?.SetPositionAsync(this.trackId, pos).catch(() => {});
        this._setPosition(pos);
    }

    raise() {
        if (this.app)
            this.app.activate();
        else
            this._root?.RaiseAsync().catch(() => {});
    }

    destroy() {
        this._cancel.cancel();
        if (this._player) {
            if (this._propsId)
                this._player.disconnect(this._propsId);
            if (this._seekedId)
                this._player.disconnectSignal(this._seekedId);
        }
        this._player = null;
        this._root = null;
    }
}

let _pixbuf;
async function averageColor(path) {
    try {
        if (_pixbuf === undefined) {
            try {
                _pixbuf = (await import('gi://GdkPixbuf')).default;
            } catch {
                _pixbuf = null;
            }
        }
        if (!_pixbuf)
            return null;
        const pb = _pixbuf.Pixbuf.new_from_file_at_scale(path, 12, 12, false);
        const px = pb.get_pixels();
        const n = pb.get_n_channels();
        const stride = pb.get_rowstride();
        let r = 0, g = 0, b = 0, c = 0;
        for (let y = 0; y < pb.get_height(); y++) {
            for (let x = 0; x < pb.get_width(); x++) {
                const i = y * stride + x * n;
                const R = px[i], G = px[i + 1], B = px[i + 2];
                const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
                const w = 0.25 + (mx - mn) / 255; // favour colourful pixels
                r += R * w; g += G * w; b += B * w; c += w;
            }
        }
        if (!c)
            return null;
        r /= c; g /= c; b /= c;
        // Lift very dark art so the tint stays visible.
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (lum < 90) {
            const k = 90 / Math.max(lum, 1);
            r = Math.min(255, r * k); g = Math.min(255, g * k); b = Math.min(255, b * k);
        }
        return [r / 255, g / 255, b / 255];
    } catch {
        return null;
    }
}

export class MediaManager extends Emitter {
    constructor() {
        super();
        this._players = new Map();
        this.selectedId = null;
        this._changeIdle = 0;
        this._ownerId = Gio.DBus.session.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus',
            'NameOwnerChanged', '/org/freedesktop/DBus', 'org.mpris.MediaPlayer2', Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
            (_c, _s, _p, _i, _n, params) => {
                const [name, , newOwner] = params.deepUnpack();
                if (!name.startsWith(PREFIX))
                    return;
                if (newOwner)
                    this._add(name);
                else
                    this._remove(name);
            });
        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'ListNames', null, null, Gio.DBusCallFlags.NONE, -1, null, (c, res) => {
                try {
                    const [names] = c.call_finish(res).deepUnpack();
                    names.filter(n => n.startsWith(PREFIX)).forEach(n => this._add(n));
                } catch (e) {
                    report(e, 'ListNames');
                }
            });
    }

    _add(name) {
        if (this._players.has(name))
            return;
        this._players.set(name, new Player(this, name));
    }

    _remove(name) {
        this._players.get(name)?.destroy();
        this._players.delete(name);
        if (this.selectedId === name)
            this.selectedId = null;
        this._changed();
    }

    _changed() {
        if (this._changeIdle)
            return;
        this._changeIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._changeIdle = 0;
            this.emit('changed');
            return GLib.SOURCE_REMOVE;
        });
    }

    // Players with a track, most relevant first.
    get players() {
        const list = [...this._players.values()].filter(p => p.ready);
        // Browsers can expose duplicate instances; keep one per identity+title.
        const seen = new Set();
        return list.filter(p => {
            const k = `${p.identity}|${p.title}`;
            if (seen.has(k))
                return false;
            seen.add(k);
            return true;
        }).sort((a, b) => (b.playing - a.playing) || (b.lastActive - a.lastActive));
    }

    get current() {
        const list = this.players;
        return list.find(p => p.id === this.selectedId) ?? list[0] ?? null;
    }

    select(id) {
        this.selectedId = id;
        this._changed();
    }

    // Poll position while someone is watching the progress line.
    setWatching(on) {
        if (on && !this._posTimer) {
            this._posTimer = timeout(1000, () => {
                this.current?.refreshPosition();
                return true;
            });
        } else if (!on) {
            this._posTimer = clearSource(this._posTimer);
        }
    }

    destroy() {
        this.setWatching(false);
        this._changeIdle = clearSource(this._changeIdle);
        Gio.DBus.session.signal_unsubscribe(this._ownerId);
        for (const p of this._players.values())
            p.destroy();
        this._players.clear();
        this.clearHandlers();
    }
}
