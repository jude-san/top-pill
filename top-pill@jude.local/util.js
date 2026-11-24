// Shared helpers for Top Pill.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

// Logical-pixel scale: HiDPI scale factor times a gentle share of text scaling,
// so the pill grows with "Large Text" instead of clipping it.
export function unit() {
    const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const ts = St.Settings.get().text_scaling_factor ?? 1;
    return sf * Math.min(Math.max(ts, 1), 1.5);
}

export function animationsEnabled() {
    return St.Settings.get().enable_animations;
}

export function ease(actor, props) {
    actor.ease({mode: Clutter.AnimationMode.EASE_OUT_QUAD, duration: 250, ...props});
}

export function clamp(v, a, b) {
    return Math.min(Math.max(v, a), b);
}

// Recent errors, kept for `top-pill doctor` (newest last, at most 30).
export const recentErrors = [];

export function report(e, where) {
    logError(e, `Top Pill: ${where}`);
    recentErrors.push({at: new Date().toISOString(), where, message: String(e?.message ?? e).slice(0, 300)});
    if (recentErrors.length > 30)
        recentErrors.shift();
}

export function timeout(ms, fn) {
    return GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        try {
            return fn() === true ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        } catch (e) {
            report(e, 'timer');
            return GLib.SOURCE_REMOVE;
        }
    });
}

export function clearSource(id) {
    if (id)
        GLib.source_remove(id);
    return 0;
}

export function fmtTime(us) {
    if (!(us > 0))
        return '0:00';
    const s = Math.floor(us / 1e6);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function fmtBytes(n) {
    if (!(n > 0))
        return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1000 && i < u.length - 1) {
        n /= 1000;
        i++;
    }
    return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

export function fmtAgo(dt) {
    if (!dt)
        return '';
    const now = GLib.DateTime.new_now_local();
    const s = Math.max(0, Math.floor(now.difference(dt) / 1e6));
    if (s < 60)
        return 'now';
    if (s < 3600)
        return `${Math.floor(s / 60)}m`;
    if (s < 86400)
        return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
}

export function fmtDuration(sec) {
    sec = Math.max(0, Math.floor(sec));
    if (sec < 60)
        return `${sec}s`;
    if (sec < 3600)
        return `${Math.floor(sec / 60)}m ${sec % 60}s`;
    return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

export function cacheDir(sub) {
    const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'top-pill', sub]);
    GLib.mkdir_with_parents(dir, 0o700);
    return dir;
}

export function openUri(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
    } catch (e) {
        logError(e, `Top Pill: could not open ${uri}`);
    }
}

export function readTextFile(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes) : null;
    } catch {
        return null;
    }
}

export function themedIcon(name) {
    return Gio.ThemedIcon.new_with_default_fallbacks(name);
}

// Small signal bookkeeping helper for objects that are not GObjects.
export class Signals {
    constructor() {
        this._list = [];
    }

    connect(obj, name, fn) {
        const id = obj.connect(name, fn);
        this._list.push([obj, id]);
        return id;
    }

    disconnectAll() {
        for (const [obj, id] of this._list) {
            try {
                obj.disconnect(id);
            } catch {}
        }
        this._list = [];
    }
}

// Tiny event emitter for plain JS classes.
export class Emitter {
    constructor() {
        this._handlers = new Map();
    }

    on(name, fn) {
        if (!this._handlers.has(name))
            this._handlers.set(name, new Set());
        this._handlers.get(name).add(fn);
        return () => this._handlers.get(name)?.delete(fn);
    }

    emit(name, ...args) {
        for (const fn of this._handlers.get(name) ?? []) {
            try {
                fn(...args);
            } catch (e) {
                report(e, `handler for ${name}`);
            }
        }
    }

    clearHandlers() {
        this._handlers.clear();
    }
}
