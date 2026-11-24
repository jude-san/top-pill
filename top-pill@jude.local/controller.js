// Wires the data sources to the pill and to GNOME (chrome, shortcut, settings).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Pill} from './pill.js';
import {MediaManager, abortHttp} from './media.js';
import {NotificationWatcher} from './notifications.js';
import {PrivacyWatcher} from './privacy.js';
import {LiveHub} from './live.js';
import {Trending} from './trending.js';
import {AudioLevels} from './levels.js';
import {SystemStats, BluetoothWatcher, Lyrics, FocusTimer, ClipboardHistory} from './extras.js';
import {Meetings} from './meetings.js';
import {AiUsage} from './usage.js';
import {Approvals} from './approvals.js';
import {Ops} from './ops.js';
import {timeout, clearSource, cacheDir, themedIcon, openUri, report, readTextFile} from './util.js';

// Stand-ins used when a core part can't start, so the rest keeps working.
const STUB_VALUES = {
    media: {players: [], current: null},
    notifs: {items: [], unreadCount: 0},
    privacy: {mic: false, camera: false, screen: false, any: false, items: []},
    live: {items: []},
    trending: {enabled: false, items: [], message: 'Unavailable', state: 'error'},
    levels: {available: false},
};

function stub(name) {
    return new Proxy({...STUB_VALUES[name]}, {
        get(target, key) {
            if (key in target)
                return target[key];
            if (key === 'then' || typeof key === 'symbol')
                return undefined;
            if (key === 'on')
                return () => () => {};
            return () => {};
        },
    });
}

export class Controller {
    constructor(ext) {
        try {
            this._init(ext);
        } catch (e) {
            // Leave nothing half-built behind; the loader may try another build.
            try {
                this.destroy();
            } catch {}
            throw e;
        }
    }

    _init(ext) {
        this._ext = this.ext = ext;
        this.build = ext.buildId ?? (readTextFile(GLib.build_filenamev([ext.path, 'builds', 'current'])) ?? '').trim() ?? 'bundled';
        this.health = {};
        this._off = [];
        const settings = this._settings = ext.getSettings();
        this._notifSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._cleanArtCache();

        // Every part is optional: one failing to start never stops the pill.
        const tryNew = (name, make, core = false) => {
            try {
                const obj = make();
                this.health[name] = 'ok';
                return obj;
            } catch (e) {
                report(e, `${name} unavailable`);
                this.health[name] = `failed: ${e.message}`;
                return core ? stub(core) : null;
            }
        };
        this.media = tryNew('media', () => new MediaManager(), 'media');
        this.notifs = tryNew('notifications', () => new NotificationWatcher(settings), 'notifs');
        this.privacy = tryNew('privacy', () => new PrivacyWatcher(), 'privacy');
        this.live = tryNew('live', () => new LiveHub(settings, GLib.build_filenamev([ext.path, 'icons'])), 'live');
        this.trending = tryNew('trending', () => new Trending(settings), 'trending');
        this.levels = tryNew('audio-levels', () => new AudioLevels(), 'levels');
        this.stats = tryNew('stats', () => new SystemStats());
        this.bluetooth = tryNew('bluetooth', () => new BluetoothWatcher());
        this.lyrics = tryNew('lyrics', () => new Lyrics());
        this.focus = tryNew('focus', () => new FocusTimer(settings));
        this.clip = tryNew('clipboard', () => new ClipboardHistory(settings));
        this.meetings = tryNew('meetings', () => new Meetings());
        this.usage = tryNew('usage', () => new AiUsage(settings));
        this.approvals = tryNew('approvals', () => new Approvals());
        this._iconDir = GLib.build_filenamev([ext.path, 'icons']);
        this._remindedMeetings = new Set();
        this._pending = [];

        this.pill = new Pill({
            settings, media: this.media, notifs: this.notifs, privacy: this.privacy, live: this.live,
            trending: this.trending, levels: this.levels,
            stats: this.stats, lyrics: this.lyrics, focus: this.focus, clip: this.clip,
            meetings: this.meetings, usage: this.usage, approvals: this.approvals, iconDir: this._iconDir,
            setLevelsWanted: on => this._setLevelsWanted(on),
        });
        Main.layoutManager.addTopChrome(this.pill, {trackFullscreen: true});
        this.pill.attached();

        this._off.push(
            this.media.on('changed', () => this.pill.updateMedia()),
            this.notifs.on('changed', () => this.pill.update()),
            this.notifs.on('peek', d => this._queuePeek(d)),
            this.live.on('changed', () => this.pill.updateLive()),
            this.privacy.on('changed', () => this.pill.updateLive()),
            this.trending.on('changed', () => this.pill.update()),
            this.levels.on('levels', v => {
                this.pill.onLevels(v);
                if (this.levels.available === false && !this._levelsFallback) {
                    this._levelsFallback = true;
                    this.pill.updateMedia();
                }
            }),
            this.live.on('charger', ({percent}) => {
                if (settings.get_boolean('show-charging'))
                    this.pill.showCharge(percent);
            }),
            this.live.on('download-finished', ({path, name}) => {
                if (!settings.get_boolean('download-peek') || !this._bannersAllowed())
                    return;
                this._play('complete');
                this._queuePeek({
                    title: 'Download complete', body: name, app: 'Downloads', gicon: themedIcon('folder-download-symbolic'),
                    onClick: () => this._showInFiles(path),
                });
            }),
            this.live.on('agent-done', ({name, project, icon}) => {
                if (!settings.get_boolean('ai-done-peek') || !this._bannersAllowed())
                    return;
                // the agent's own hooks report this more accurately when set up
                if (this._lastHookEvent && Date.now() - this._lastHookEvent < 6 * 3600e3)
                    return;
                this._play('message-new-instant');
                this._queuePeek({
                    title: `${name} is waiting for you`, body: project ? `Finished working in ${project}` : 'Finished working',
                    app: '', gicon: icon, onClick: () => this.pill.expand('live'),
                });
            }),
        );
        const on = (src, sig, fn) => (src ? src.on(sig, fn) : () => {});
        this._off.push(
            on(this.stats, 'changed', () => this.pill.onStats()),
            on(this.lyrics, 'changed', () => this.pill.updateMedia()),
            on(this.focus, 'changed', () => this.pill.update()),
            on(this.focus, 'tick', () => this.pill.updateFocus()),
            on(this.focus, 'done', phase => {
                this._play('complete');
                this._queuePeek({
                    title: phase === 'focus' ? 'Focus session done' : 'Break is over',
                    body: phase === 'focus' ? 'Time for a break' : 'Ready for the next focus round? Open Today to start.',
                    app: '', gicon: themedIcon('alarm-symbolic'), onClick: () => this.pill.expand('today'),
                });
            }),
            on(this.clip, 'changed', () => {
                if (this.pill.mode === 'expanded')
                    this.pill.update();
            }),
            on(this.meetings, 'changed', () => {
                this.pill.update();
                this._meetingReminder();
            }),
            on(this.meetings, 'tick', () => {
                this._meetingReminder();
                // keep "in N min" current only when a meeting is close
                if (this.meetings.next(15))
                    this.pill.update();
            }),
            on(this.usage, 'changed', () => this.pill.update()),
            on(this.approvals, 'changed', () => this.pill.updateAsk()),
            on(this.approvals, 'event', ev => this._agentEvent(ev)),
            on(this.bluetooth, 'device', d => {
                if (!settings.get_boolean('bluetooth-peek') || !this._bannersAllowed())
                    return;
                this._queuePeek({
                    title: d.name, app: '', gicon: d.gicon,
                    body: d.connected ? `Connected${d.battery !== null ? ` · battery ${d.battery}%` : ''}` : 'Disconnected',
                });
            }),
        );
        this.pill.connect('request-prefs', () => ext.openPreferences());
        this.ops = tryNew('status', () => new Ops(this));

        Main.wm.addKeybinding('toggle-shortcut', settings, Meta.KeyBindingFlags.NONE,
            // POPUP too, so the shortcut can always close the open pill
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP, () => this.pill.toggle());

        if (Main.layoutManager._startingUp) {
            Main.layoutManager.connectObject('startup-complete', () => this._appear(), this);
        } else {
            this._appearId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._appearId = 0;
                this._appear();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _appear() {
        this.pill.update();
        this.pill.appear();
        this._logAnimationState();
    }

    // Record why animations are on or off (GNOME decides this system-wide).
    _logAnimationState() {
        try {
            const st = St.Settings.get();
            const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
            const info = {
                animations: st.enable_animations,
                setting: iface.get_boolean('enable-animations'),
                hardwareAccelerated: global.backend.is_rendering_hardware_accelerated?.() ?? null,
                forced: global.force_animations ?? null,
            };
            console.log(`Top Pill: animation state ${JSON.stringify(info)}`);
            GLib.file_set_contents(GLib.build_filenamev([cacheDir(''), 'status.json']), JSON.stringify(info));
        } catch (e) {
            console.log(`Top Pill: could not read animation state: ${e.message}`);
        }
    }

    _agentEvent(ev) {
        this._lastHookEvent = Date.now();
        if (!this._settings.get_boolean('ai-done-peek') || !this._bannersAllowed())
            return;
        const name = ev.ai === 'codex' ? 'Codex' : 'Claude Code';
        const project = ev.cwd ? GLib.path_get_basename(ev.cwd) : '';
        const gicon = Gio.FileIcon.new(Gio.File.new_for_path(GLib.build_filenamev([this._iconDir, `${ev.ai}.svg`])));
        this._play('message-new-instant');
        this._queuePeek({
            title: ev.kind === 'notification' ? `${name} needs you` : `${name} finished`,
            body: ev.message || (project ? `In ${project}` : ''), app: '', gicon,
            onClick: () => this.pill.expand('live'),
        });
    }

    // Peek a few minutes before a calendar event starts.
    _meetingReminder() {
        const mins = this._settings.get_int('meeting-reminder');
        if (!mins || !this._settings.get_boolean('meetings') || !this.meetings)
            return;
        for (const m of this.meetings.events) {
            const until = (m.start - Date.now()) / 60000;
            if (until > 0 && until <= mins && !this._remindedMeetings.has(m.id)) {
                this._remindedMeetings.add(m.id);
                this._play('message-new-instant');
                this._queuePeek({
                    title: m.title, app: '', gicon: themedIcon('x-office-calendar-symbolic'),
                    body: `Starts in ${Math.max(1, Math.round(until))} min${m.link ? ' · click to join' : ''}`,
                    onClick: () => (m.link ? openUri(m.link) : this.pill.expand('today')),
                });
            }
        }
    }

    _bannersAllowed() {
        return this._notifSettings.get_boolean('show-banners');
    }

    _play(id) {
        if (!this._settings.get_boolean('peek-sound'))
            return;
        try {
            global.display.get_sound_player().play_from_theme(id, 'Top Pill', null);
        } catch {}
    }

    // New events wait a moment, then arrive together as one peek.
    _queuePeek(desc) {
        if (this.pill.mode === 'expanded')
            return;
        this._pending.push(desc);
        if (this._peekDelay)
            return;
        this._peekDelay = timeout(Math.max(0, this._settings.get_int('peek-delay')), () => {
            this._peekDelay = 0;
            const batch = this._pending;
            this._pending = [];
            if (!batch.length)
                return;
            const burst = batch.length + (this.pill.mode === 'peek' ? (this._lastBurst ?? 1) : 0);
            this._lastBurst = burst;
            this.pill.peek(batch[batch.length - 1], burst);
        });
    }

    _setLevelsWanted(on) {
        if (on) {
            this._levelsOff = clearSource(this._levelsOff);
            this.levels.start();
        } else if (!this._levelsOff && this.levels._pipeline) {
            // brief pauses (track changes) should not restart the stream
            this._levelsOff = timeout(2500, () => {
                this._levelsOff = 0;
                this.levels.stop();
            });
        }
    }

    _showInFiles(path) {
        Gio.DBus.session.call('org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
            'org.freedesktop.FileManager1', 'ShowItems',
            new GLib.Variant('(ass)', [[Gio.File.new_for_path(path).get_uri()], '']),
            null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    _cleanArtCache() {
        try {
            const dir = Gio.File.new_for_path(cacheDir('art'));
            const en = dir.enumerate_children('standard::name,time::modified', 0, null);
            const cutoff = Date.now() / 1000 - 14 * 86400;
            let info;
            while ((info = en.next_file(null))) {
                if (info.get_attribute_uint64('time::modified') < cutoff)
                    dir.get_child(info.get_name()).delete(null);
            }
            en.close(null);
        } catch {}
    }

    destroy() {
        this._peekDelay = clearSource(this._peekDelay);
        this._levelsOff = clearSource(this._levelsOff);
        this._appearId = clearSource(this._appearId);
        Main.layoutManager.disconnectObject(this);
        try {
            Main.wm.removeKeybinding('toggle-shortcut');
        } catch {}
        this._off?.forEach(off => off());
        this._off = [];
        this.ops?.destroy();
        try {
            this.pill?.destroy();
        } catch (e) {
            report(e, 'pill shutdown');
        }
        this.pill = null;
        for (const s of [this.approvals, this.usage, this.meetings, this.clip, this.focus, this.lyrics, this.bluetooth, this.stats,
            this.levels, this.trending, this.live, this.privacy, this.notifs, this.media]) {
            try {
                s?.destroy();
            } catch (e) {
                report(e, 'shutdown');
            }
        }
        abortHttp();
        this._settings = null;
    }
}
