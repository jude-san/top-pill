// AI plan usage: Claude (from Claude Code's own sign-in, asked of Anthropic
// every 10 minutes) and ChatGPT (from Codex's local session logs, no network).
// The sign-in token is only read, never refreshed or sent anywhere but Anthropic.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Emitter, readTextFile, report} from './util.js';
import {httpGet} from './media.js';

const HOME = GLib.get_home_dir();
const CLAUDE_DIR = GLib.getenv('CLAUDE_CONFIG_DIR') || GLib.build_filenamev([HOME, '.claude']);
const CODEX_DIR = GLib.getenv('CODEX_HOME') || GLib.build_filenamev([HOME, '.codex']);

function windowLabel(minutes) {
    if (!minutes)
        return 'Limit';
    if (minutes <= 300)
        return `${Math.round(minutes / 60)} hours`;
    if (minutes <= 7 * 1440)
        return 'Week';
    return `${Math.round(minutes / 1440)} days`;
}

function newestJsonl(dir, max = 6) {
    const out = [];
    const walk = path => {
        let en;
        try {
            en = Gio.File.new_for_path(path).enumerate_children('standard::name,standard::type', 0, null);
        } catch {
            return;
        }
        const names = [];
        let info;
        while ((info = en.next_file(null)))
            names.push([info.get_name(), info.get_file_type()]);
        en.close(null);
        names.sort((a, b) => (a[0] < b[0] ? 1 : -1));
        for (const [name, type] of names) {
            if (out.length >= max)
                return;
            const p = GLib.build_filenamev([path, name]);
            if (type === Gio.FileType.DIRECTORY)
                walk(p);
            else if (name.endsWith('.jsonl'))
                out.push(p);
        }
    };
    walk(dir);
    return out;
}

function tail(path, bytes = 256 * 1024) {
    try {
        const f = Gio.File.new_for_path(path);
        const size = f.query_info('standard::size', 0, null).get_size();
        const stream = f.read(null);
        if (size > bytes)
            stream.seek(size - bytes, GLib.SeekType.SET, null);
        const data = stream.read_bytes(Math.min(size, bytes), null);
        stream.close(null);
        return new TextDecoder().decode(data.get_data());
    } catch {
        return '';
    }
}

export class AiUsage extends Emitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this.providers = []; // [{id, name, plan, windows:[{label, percent, resetsAt}], note}]
        this._claude = null;
        this._codex = null;
        this._claudeNext = 0;
        this._failures = 0;
        this._codexStamp = '';
        this._key = '';
        this._lastRefresh = 0;
        // Nothing runs in the background: usage is read when the Today tab
        // opens (and again while it stays open, at most once a minute).
        this._settingsId = settings.connect('changed::ai-usage', () => this.refresh(true));
    }

    // Call when the numbers are about to be shown.
    wanted() {
        if (Date.now() - this._lastRefresh > 60e3)
            this.refresh();
    }

    get enabled() {
        return this._settings.get_boolean('ai-usage');
    }

    async refresh(force = false) {
        if (this._busy)
            return;
        this._lastRefresh = Date.now();
        this._busy = true;
        try {
            if (!this.enabled) {
                this.providers = [];
            } else {
                this._codex = this._readCodex();
                if (force || Date.now() >= this._claudeNext)
                    await this._readClaude();
                this.providers = [this._claude, this._codex].filter(p => p && p.windows.length);
            }
        } catch (e) {
            report(e, 'usage');
        } finally {
            this._busy = false;
        }
        const key = JSON.stringify(this.providers);
        if (key !== this._key) {
            this._key = key;
            this.emit('changed');
        }
    }

    async _readClaude() {
        const credPath = GLib.build_filenamev([CLAUDE_DIR, '.credentials.json']);
        let cred;
        try {
            cred = JSON.parse(readTextFile(credPath) ?? 'null')?.claudeAiOauth;
        } catch {}
        if (!cred?.accessToken) {
            this._claude = null;
            this._claudeNext = Date.now() + 30 * 60e3;
            return;
        }
        if (cred.expiresAt && cred.expiresAt <= Date.now()) {
            // Claude Code refreshes its own sign-in; try again later.
            this._claudeNext = Date.now() + 5 * 60e3;
            return;
        }
        try {
            const bytes = await httpGet('https://api.anthropic.com/api/oauth/usage', {
                maxBytes: 256 * 1024,
                headers: {
                    'Authorization': `Bearer ${cred.accessToken}`,
                    'anthropic-beta': 'oauth-2025-04-20',
                },
            });
            const j = JSON.parse(new TextDecoder().decode(bytes.get_data()));
            const windows = [];
            if (Array.isArray(j.limits)) {
                for (const l of j.limits) {
                    const group = l.group ?? l.kind ?? '';
                    let label = group === 'session' ? '5 hours' : /^weekly/.test(group) ? 'Week' : group;
                    const model = l.scope?.model?.display_name;
                    if (model)
                        label += ` · ${model}`;
                    if (typeof l.percent === 'number')
                        windows.push({label, percent: l.percent, resetsAt: l.resets_at ? Date.parse(l.resets_at) : 0});
                }
            } else {
                for (const [key, label] of [['five_hour', '5 hours'], ['seven_day', 'Week'], ['seven_day_opus', 'Week · Opus']]) {
                    const w = j[key];
                    if (w && typeof w.utilization === 'number')
                        windows.push({label, percent: w.utilization, resetsAt: w.resets_at ? Date.parse(w.resets_at) : 0});
                }
            }
            this._claude = {id: 'claude', name: 'Claude', windows, note: ''};
            this._failures = 0;
            this._claudeNext = Date.now() + 10 * 60e3;
        } catch (e) {
            this._failures++;
            console.debug(`Top Pill: Claude usage: ${e.message}`);
            this._claudeNext = Date.now() + Math.min(60, 10 * 2 ** this._failures) * 60e3;
        }
    }

    _readCodex() {
        if (!GLib.file_test(GLib.build_filenamev([CODEX_DIR, 'auth.json']), GLib.FileTest.EXISTS))
            return null;
        const files = newestJsonl(GLib.build_filenamev([CODEX_DIR, 'sessions']));
        // Skip re-reading when the newest log hasn't changed.
        let stamp = '';
        try {
            const info = Gio.File.new_for_path(files[0]).query_info('standard::size,time::modified', 0, null);
            stamp = `${files[0]}|${info.get_size()}|${info.get_modification_date_time()?.to_unix()}`;
        } catch {}
        if (stamp && stamp === this._codexStamp)
            return this._codex;
        this._codexStamp = stamp;
        for (const file of files) {
            const lines = tail(file).split('\n').reverse();
            for (const line of lines) {
                if (!line.includes('rate_limits'))
                    continue;
                let ev;
                try {
                    ev = JSON.parse(line);
                } catch {
                    continue;
                }
                const find = o => {
                    if (!o || typeof o !== 'object')
                        return null;
                    if (o.rate_limits)
                        return o.rate_limits;
                    for (const v of Object.values(o)) {
                        const r = find(v);
                        if (r)
                            return r;
                    }
                    return null;
                };
                const rl = find(ev);
                if (!rl)
                    continue;
                const windows = ['primary', 'secondary'].map(k => rl[k]).filter(w => w && typeof w.used_percent === 'number')
                    .map(w => ({label: windowLabel(w.window_minutes), percent: w.used_percent,
                        resetsAt: w.resets_at ? w.resets_at * 1000 : (w.resets_in_seconds ? Date.now() + w.resets_in_seconds * 1000 : 0)}));
                return {id: 'codex', name: 'ChatGPT', windows, note: 'As of Codex’s last use'};
            }
        }
        return null;
    }

    destroy() {
        this._settings.disconnect(this._settingsId);
        this.clearHandlers();
    }
}
