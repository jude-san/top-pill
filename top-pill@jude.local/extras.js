// System stats, Bluetooth peeks, synced lyrics, focus timer and clipboard history.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {Emitter, timeout, clearSource, readTextFile, cacheDir, themedIcon} from './util.js';
import {httpGet} from './media.js';

/* ---------- System stats ---------- */
// CPU, memory and temperature, read from /proc and /sys. Polls only while
// someone is looking (the Live tab is open).
export class SystemStats extends Emitter {
    constructor() {
        super();
        this.cpu = 0;
        this.mem = 0;
        this.memUsed = 0;
        this.memTotal = 0;
        this.temp = null;
        this._prev = null;
        this._tempPath = this._findTemp();
    }

    _findTemp() {
        // Prefer the CPU package sensor (coretemp / k10temp), then any thermal zone.
        try {
            const base = '/sys/class/hwmon';
            const dir = Gio.File.new_for_path(base).enumerate_children('standard::name', 0, null);
            let info, fallback = null;
            while ((info = dir.next_file(null))) {
                const p = `${base}/${info.get_name()}`;
                const name = (readTextFile(`${p}/name`) ?? '').trim();
                if (['coretemp', 'k10temp', 'zenpower', 'cpu_thermal'].includes(name))
                    return `${p}/temp1_input`;
                if (!fallback && GLib.file_test(`${p}/temp1_input`, GLib.FileTest.EXISTS) && name !== 'nvme')
                    fallback = `${p}/temp1_input`;
            }
            dir.close(null);
            if (fallback)
                return fallback;
        } catch {}
        return GLib.file_test('/sys/class/thermal/thermal_zone0/temp', GLib.FileTest.EXISTS)
            ? '/sys/class/thermal/thermal_zone0/temp' : null;
    }

    _read() {
        const line = (readTextFile('/proc/stat') ?? '').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
        if (line.length >= 4) {
            const idle = line[3] + (line[4] ?? 0);
            const total = line.reduce((a, b) => a + b, 0);
            if (this._prev) {
                const dt = total - this._prev.total;
                this.cpu = dt > 0 ? Math.max(0, Math.min(1, 1 - (idle - this._prev.idle) / dt)) : this.cpu;
            }
            this._prev = {idle, total};
        }
        const mi = readTextFile('/proc/meminfo') ?? '';
        const kb = k => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(mi)?.[1] ?? 0);
        this.memTotal = kb('MemTotal') * 1024;
        this.memUsed = Math.max(0, this.memTotal - kb('MemAvailable') * 1024);
        this.mem = this.memTotal ? this.memUsed / this.memTotal : 0;
        const t = this._tempPath ? Number(readTextFile(this._tempPath)) : NaN;
        this.temp = Number.isFinite(t) && t > 0 ? t / 1000 : null;
        this.emit('changed');
    }

    setWatching(on) {
        if (on && !this._timer) {
            this._read();
            this._timer = timeout(2000, () => {
                this._read();
                return true;
            });
        } else if (!on) {
            this._timer = clearSource(this._timer);
        }
    }

    destroy() {
        this.setWatching(false);
        this.clearHandlers();
    }
}

/* ---------- Bluetooth ---------- */
// Peeks when a device connects or disconnects, with its battery when known.
export class BluetoothWatcher extends Emitter {
    constructor() {
        super();
        this._devices = [];
        this._init().catch(e => console.debug(`Top Pill: Bluetooth unavailable: ${e.message}`));
    }

    async _init() {
        const {default: GnomeBluetooth} = await import('gi://GnomeBluetooth?version=3.0');
        if (this._destroyed)
            return;
        this._client = new GnomeBluetooth.Client();
        this._store = this._client.get_devices();
        this._store.connectObject('items-changed', () => this._bind(), this);
        this._bind();
    }

    _bind() {
        this._devices.forEach(d => d.disconnectObject(this));
        this._devices = [];
        for (let i = 0; i < this._store.get_n_items(); i++) {
            const d = this._store.get_item(i);
            d.connectObject('notify::connected', () => this._changed(d), this);
            this._devices.push(d);
        }
    }

    _changed(d) {
        if (!d.paired && !d.trusted)
            return;
        const pct = d.connected && d.battery_percentage > 0 ? Math.round(d.battery_percentage) : null;
        this.emit('device', {
            name: d.alias || d.name || 'Bluetooth device', connected: d.connected, battery: pct,
            gicon: Gio.ThemedIcon.new_from_names([`${d.icon || 'bluetooth'}-symbolic`, 'bluetooth-active-symbolic']),
        });
    }

    destroy() {
        this._destroyed = true;
        this._devices.forEach(d => d.disconnectObject(this));
        this._store?.disconnectObject(this);
        this._devices = [];
        this._store = null;
        this._client = null;
        this.clearHandlers();
    }
}

/* ---------- Lyrics ---------- */
// Synced lyrics from LRCLIB (free, no account). Cached per track.
function parseLrc(text) {
    const lines = [];
    for (const raw of (text ?? '').split('\n')) {
        const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
        const words = raw.replace(/\[[^\]]*\]/g, '').trim();
        for (const m of stamps)
            lines.push({t: (Number(m[1]) * 60 + Number(m[2])) * 1e6, text: words});
    }
    return lines.sort((a, b) => a.t - b.t);
}

export class Lyrics extends Emitter {
    constructor() {
        super();
        this._key = null;
        this.lines = [];
        this.state = 'none'; // none | loading | synced | plain | missing
    }

    // Look up lyrics for a track (no-op if already loaded).
    async load(p) {
        if (!p || p.isVideo || !p.title || !p.artists.length) {
            this._set(null, [], 'none');
            return;
        }
        const key = `${p.artists[0]}|${p.title}|${p.album}`.toLowerCase();
        if (key === this._key)
            return;
        this._key = key;
        this._set(key, [], 'loading');
        const file = GLib.build_filenamev([cacheDir('lyrics'), `${GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, key, -1)}.json`]);
        let data = null;
        try {
            data = JSON.parse(readTextFile(file) ?? 'null');
        } catch {}
        if (!data) {
            const q = new URLSearchParams({artist_name: p.artists[0], track_name: p.title});
            if (p.album)
                q.set('album_name', p.album);
            if (p.length)
                q.set('duration', String(Math.round(p.length / 1e6)));
            try {
                const bytes = await httpGet(`https://lrclib.net/api/get?${q.toString()}`, {maxBytes: 512 * 1024});
                const j = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                data = {synced: j.syncedLyrics ?? null, plain: j.plainLyrics ?? null};
            } catch (e) {
                // 404 means LRCLIB has no lyrics; remember that too.
                data = /404/.test(e.message) ? {synced: null, plain: null} : null;
            }
            if (data) {
                try {
                    GLib.file_set_contents(file, JSON.stringify(data));
                } catch {}
            }
        }
        if (key !== this._key)
            return;
        if (data?.synced)
            this._set(key, parseLrc(data.synced), 'synced');
        else
            this._set(key, [], data?.plain ? 'plain' : 'missing');
    }

    _set(key, lines, state) {
        this.lines = lines;
        this.state = state;
        this.emit('changed');
    }

    // [current, next] lines at a position (µs).
    at(pos) {
        const L = this.lines;
        if (!L.length)
            return [null, null];
        let i = -1;
        for (let k = 0; k < L.length && L[k].t <= pos + 150000; k++)
            i = k;
        const cur = i >= 0 ? L[i].text : null;
        let next = null;
        for (let k = i + 1; k < L.length; k++) {
            if (L[k].text) {
                next = L[k].text;
                break;
            }
        }
        return [cur, next];
    }

    destroy() {
        this.clearHandlers();
    }
}

/* ---------- Focus timer ---------- */
// Uses wall-clock time (so a laptop that sleeps mid-session still ends on
// time) and is saved to disk, so locking the screen or an update doesn't
// lose it.
const now = () => GLib.get_real_time();
const today = () => GLib.DateTime.new_now_local().format('%F');

export class FocusTimer extends Emitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._file = GLib.build_filenamev([cacheDir(''), 'focus.json']);
        this.phase = 'off'; // off | focus | break
        this.paused = false;
        this._endsAt = 0;
        this._left = 0;
        this.rounds = 0;
        this._day = today();
        this._restore();
    }

    _restore() {
        let s = null;
        try {
            s = JSON.parse(readTextFile(this._file) ?? 'null');
        } catch {}
        if (!s || typeof s !== 'object')
            return;
        if (s.day === today())
            this.rounds = Number(s.rounds) || 0;
        if (!['focus', 'break'].includes(s.phase))
            return;
        this.phase = s.phase;
        this.paused = !!s.paused;
        this._endsAt = Number(s.endsAt) || 0;
        this._left = Number(s.left) || 0;
        if (this.paused) {
            this._left = Math.min(this._left, this.total);
        } else if (this._endsAt <= now()) {
            // It ended while we were away: count it, then wait for the user.
            if (this.phase === 'focus' && s.day === today())
                this.rounds++;
            this.phase = 'off';
            this._save();
            return;
        }
        if (!this.paused)
            this._tick();
    }

    _save() {
        const s = {phase: this.phase, paused: this.paused, endsAt: this._endsAt, left: this._left, rounds: this.rounds, day: this._day};
        try {
            GLib.file_set_contents(this._file, JSON.stringify(s));
        } catch (e) {
            console.debug(`Top Pill: focus save: ${e.message}`);
        }
    }

    _newDay() {
        const d = today();
        if (d !== this._day) {
            this._day = d;
            this.rounds = 0;
        }
    }

    get total() {
        const m = this.phase === 'break' ? this._settings.get_int('focus-break-minutes') : this._settings.get_int('focus-minutes');
        return Math.max(1, m) * 60e6;
    }

    get remaining() {
        if (this.phase === 'off')
            return 0;
        return this.paused ? this._left : Math.max(0, this._endsAt - now());
    }

    get fraction() {
        return this.phase === 'off' ? 0 : Math.min(1, Math.max(0, 1 - this.remaining / this.total));
    }

    start(phase = 'focus') {
        this._newDay();
        this.phase = phase;
        this.paused = false;
        this._endsAt = now() + this.total;
        this._tick();
        this._save();
        this.emit('changed');
    }

    togglePause() {
        if (this.phase === 'off')
            return;
        if (this.paused) {
            this._endsAt = now() + this._left;
            this.paused = false;
            this._tick();
        } else {
            this._left = this.remaining;
            this.paused = true;
            this._timer = clearSource(this._timer);
        }
        this._save();
        this.emit('changed');
    }

    stop() {
        this.phase = 'off';
        this.paused = false;
        this._timer = clearSource(this._timer);
        this._save();
        this.emit('changed');
    }

    _tick() {
        this._timer = clearSource(this._timer);
        this._timer = timeout(1000, () => {
            if (this.remaining > 0) {
                this.emit('tick');
                return true;
            }
            this._timer = 0;
            const was = this.phase;
            this._newDay();
            if (was === 'focus')
                this.rounds++;
            this.emit('done', was);
            // move on to the next phase automatically
            this.start(was === 'focus' ? 'break' : 'focus');
            if (was === 'break')
                this.togglePause(); // wait for the user before the next focus round
            return false;
        });
    }

    destroy() {
        this._timer = clearSource(this._timer);
        this.clearHandlers();
    }
}

/* ---------- Clipboard history ---------- */
// Text only, kept in memory only (gone at log-out). Copies that password
// managers mark as secret are never kept. The list lives at module level so
// it survives the extension being switched off and on (screen lock, updates).
let _store = [];
const SECRET_HINT = 'x-kde-passwordManagerHint';
const MAX_ITEMS = 30;
const MAX_CHARS = 20000;

export class ClipboardHistory extends Emitter {
    constructor(settings) {
        super();
        this._settings = settings;
        if (!settings.get_boolean('clipboard-history'))
            _store = [];
        this._clip = St.Clipboard.get_default();
        this._selection = global.display.get_selection();
        this._ownerId = this._selection.connect('owner-changed', (_s, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                this._copied();
        });
        this._settingsId = settings.connect('changed::clipboard-history', () => {
            if (!settings.get_boolean('clipboard-history'))
                this.clear();
        });
    }

    get items() {
        return _store;
    }

    set items(v) {
        _store = v;
    }

    _copied() {
        if (!this._settings.get_boolean('clipboard-history'))
            return;
        const types = this._clip.get_mimetypes(St.ClipboardType.CLIPBOARD);
        if (types.includes(SECRET_HINT))
            return;
        if (!types.some(t => t.startsWith('text/') || t === 'UTF8_STRING' || t === 'STRING'))
            return;
        this._clip.get_text(St.ClipboardType.CLIPBOARD, (_c, text) => {
            if (this._destroyed || !text || !text.trim())
                return;
            if (text === this._ownText) {
                this._ownText = null; // our own "copy again"
                return;
            }
            if (text.length > MAX_CHARS)
                text = text.slice(0, MAX_CHARS);
            this.items = [{text, at: GLib.DateTime.new_now_local()}, ...this.items.filter(i => i.text !== text)].slice(0, MAX_ITEMS);
            this.emit('changed');
        });
    }

    // Put an item back on the clipboard (moves it to the top).
    use(text) {
        this._ownText = text;
        this._clip.set_text(St.ClipboardType.CLIPBOARD, text);
        const item = this.items.find(i => i.text === text);
        this.items = [item ?? {text, at: GLib.DateTime.new_now_local()}, ...this.items.filter(i => i.text !== text)];
        this.emit('changed');
    }

    remove(text) {
        this.items = this.items.filter(i => i.text !== text);
        this.emit('changed');
    }

    clear() {
        this.items = [];
        this.emit('changed');
    }

    destroy() {
        this._selection.disconnect(this._ownerId);
        this._settings.disconnect(this._settingsId);
        this._destroyed = true;
        this.clearHandlers();
    }
}

export const focusIcon = () => themedIcon('alarm-symbolic');
