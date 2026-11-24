// Live activities: software updates (aptdaemon, PackageKit, snapd), browser
// downloads, AI coding agents and local models, and the charger.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Emitter, timeout, clearSource, fmtBytes, readTextFile, themedIcon, report} from './util.js';
import {httpGet} from './media.js';

const HZ = 100; // USER_HZ on Linux

function sysCall(bus, name, path, iface, method, args, type, cancellable) {
    return new Promise((resolve, reject) => {
        bus.call(name, path, iface, method, args, type ? new GLib.VariantType(type) : null,
            Gio.DBusCallFlags.NO_AUTO_START, 5000, cancellable, (c, res) => {
                try {
                    resolve(c.call_finish(res).deepUnpack());
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function getAll(bus, name, path, iface, cancellable) {
    return sysCall(bus, name, path, 'org.freedesktop.DBus.Properties', 'GetAll',
        new GLib.Variant('(s)', [iface]), '(a{sv})', cancellable)
        .then(([props]) => Object.fromEntries(Object.entries(props).map(([k, v]) => [k, v.deepUnpack()])));
}

/* ---------- Charger (UPower) ---------- */
class Battery {
    constructor(hub) {
        this._hub = hub;
        this.present = false;
        this.charging = false;
        this.percent = 0;
        this._sub = Gio.DBus.system.signal_subscribe('org.freedesktop.UPower', 'org.freedesktop.DBus.Properties',
            'PropertiesChanged', '/org/freedesktop/UPower/devices/DisplayDevice', null, 0, () => this._read());
        this._read(true);
    }

    async _read(initial = false) {
        try {
            const p = await getAll(Gio.DBus.system, 'org.freedesktop.UPower', '/org/freedesktop/UPower/devices/DisplayDevice',
                'org.freedesktop.UPower.Device', null);
            const was = this.charging;
            this.present = !!p.IsPresent && p.Type === 2;
            // 1 charging, 4 fully charged, 5 pending charge
            this.charging = this.present && [1, 4, 5].includes(p.State);
            this.percent = Math.round(p.Percentage ?? 0);
            if (!initial && this.charging && !was)
                this._hub.emit('charger', {percent: this.percent});
        } catch {}
    }

    destroy() {
        Gio.DBus.system.signal_unsubscribe(this._sub);
    }
}

/* ---------- Software updates ---------- */
const PK_ROLES = {
    10: 'Installing', 11: 'Installing', 14: 'Removing', 22: 'Updating software', 25: 'Downloading updates',
    29: 'Upgrading system', 30: 'Repairing system',
};

class PackageKit {
    constructor(hub) {
        this._hub = hub;
        this._tx = new Map();
        this._cancel = new Gio.Cancellable();
        this._listSub = Gio.DBus.system.signal_subscribe('org.freedesktop.PackageKit', 'org.freedesktop.PackageKit',
            'TransactionListChanged', '/org/freedesktop/PackageKit', null, 0,
            (_c, _s, _p, _i, _n, params) => this._setList(params.deepUnpack()[0]));
        this._itemSub = Gio.DBus.system.signal_subscribe('org.freedesktop.PackageKit', 'org.freedesktop.PackageKit.Transaction',
            'ItemProgress', null, null, 0, (_c, _s, path, _i, _n, params) => {
                const t = this._tx.get(path);
                if (!t)
                    return;
                const [pkg] = params.deepUnpack();
                t.pkg = pkg.split(';')[0];
            });
        sysCall(Gio.DBus.system, 'org.freedesktop.PackageKit', '/org/freedesktop/PackageKit', 'org.freedesktop.PackageKit',
            'GetTransactionList', null, '(ao)', this._cancel).then(([l]) => this._setList(l)).catch(() => {});
    }

    _setList(paths) {
        for (const p of [...this._tx.keys()]) {
            if (!paths.includes(p))
                this._tx.delete(p);
        }
        for (const p of paths) {
            if (!this._tx.has(p))
                this._tx.set(p, {path: p, role: 0, percent: 101, pkg: ''});
        }
        this._hub.poll();
    }

    get busy() {
        return this._tx.size > 0;
    }

    async refresh() {
        await Promise.all([...this._tx.values()].map(async t => {
            try {
                const p = await getAll(Gio.DBus.system, 'org.freedesktop.PackageKit', t.path,
                    'org.freedesktop.PackageKit.Transaction', this._cancel);
                t.role = p.Role;
                t.percent = p.Percentage;
            } catch {
                this._tx.delete(t.path);
            }
        }));
    }

    items() {
        return [...this._tx.values()].filter(t => PK_ROLES[t.role]).map(t => {
            const verb = PK_ROLES[t.role];
            const title = t.pkg && [10, 11, 14].includes(t.role) ? `${verb} ${t.pkg}` : (verb === 'Installing' ? 'Installing software' : verb);
            return {
                id: `pk:${t.path}`, kind: 'system', icon: themedIcon('system-software-install-symbolic'),
                title, subtitle: t.percent <= 100 ? `${t.percent}%` : 'Working…', app: 'Software',
                progress: t.percent <= 100 ? t.percent / 100 : null,
                cancel: () => sysCall(Gio.DBus.system, 'org.freedesktop.PackageKit', t.path,
                    'org.freedesktop.PackageKit.Transaction', 'Cancel', null, null, null).catch(() => {}),
            };
        });
    }

    destroy() {
        this._cancel.cancel();
        Gio.DBus.system.signal_unsubscribe(this._listSub);
        Gio.DBus.system.signal_unsubscribe(this._itemSub);
    }
}

const APT_ROLES = {
    'role-upgrade-system': 'Upgrading system', 'role-commit-packages': 'Applying updates', 'role-install-packages': 'Installing',
    'role-remove-packages': 'Removing', 'role-upgrade-packages': 'Updating software', 'role-install-file': 'Installing package',
    'role-fix-broken-depends': 'Repairing packages', 'role-fix-incomplete-install': 'Repairing packages',
};

// Ubuntu's Software Updater uses aptdaemon.
class AptDaemon {
    constructor(hub) {
        this._hub = hub;
        this._tx = new Map();
        this._cancel = new Gio.Cancellable();
        this._sub = Gio.DBus.system.signal_subscribe('org.debian.apt', 'org.debian.apt', 'ActiveTransactionsChanged',
            '/org/debian/apt', null, 0, (_c, _s, _p, _i, _n, params) => {
                const [current, queue] = params.deepUnpack();
                this._setList([current, ...queue].filter(Boolean));
            });
        sysCall(Gio.DBus.system, 'org.debian.apt', '/org/debian/apt', 'org.debian.apt', 'GetActiveTransactions', null,
            '(sas)', this._cancel).then(([c, q]) => this._setList([c, ...q].filter(Boolean))).catch(() => {});
    }

    _setList(paths) {
        for (const p of [...this._tx.keys()]) {
            if (!paths.includes(p))
                this._tx.delete(p);
        }
        for (const p of paths) {
            if (!this._tx.has(p))
                this._tx.set(p, {path: p, role: '', progress: -1, details: '', cancellable: false, packages: []});
        }
        this._hub.poll();
    }

    get busy() {
        return this._tx.size > 0;
    }

    async refresh() {
        await Promise.all([...this._tx.values()].map(async t => {
            try {
                const p = await getAll(Gio.DBus.system, 'org.debian.apt', t.path, 'org.debian.apt.transaction', this._cancel);
                t.role = p.Role ?? '';
                t.progress = p.Progress ?? -1;
                t.details = p.StatusDetails ?? '';
                t.cancellable = !!p.Cancellable;
                t.packages = (p.Packages ?? []).flat().filter(Boolean);
            } catch {
                this._tx.delete(t.path);
            }
        }));
    }

    items() {
        return [...this._tx.values()].filter(t => APT_ROLES[t.role]).map(t => {
            let title = APT_ROLES[t.role];
            if ((title === 'Installing' || title === 'Removing') && t.packages.length === 1)
                title = `${title} ${t.packages[0]}`;
            else if (title === 'Installing' || title === 'Removing')
                title = `${title} software`;
            const pct = t.progress >= 0 && t.progress <= 100 ? t.progress : null;
            return {
                id: `apt:${t.path}`, kind: 'system', icon: themedIcon('software-update-available-symbolic'),
                title, subtitle: t.details || (pct !== null ? `${pct}%` : 'Working…'), app: 'Software Updater',
                progress: pct !== null ? pct / 100 : null,
                cancel: t.cancellable ? () => sysCall(Gio.DBus.system, 'org.debian.apt', t.path, 'org.debian.apt.transaction',
                    'Cancel', null, null, null).catch(() => {}) : null,
            };
        });
    }

    destroy() {
        this._cancel.cancel();
        Gio.DBus.system.signal_unsubscribe(this._sub);
    }
}

// App Center and automatic snap refreshes go through snapd.
class Snapd {
    constructor(hub) {
        this._hub = hub;
        this._changes = [];
        this._available = GLib.file_test('/run/snapd.socket', GLib.FileTest.EXISTS);
        this._session = null;
    }

    get busy() {
        return this._changes.length > 0;
    }

    async _client() {
        if (this._session)
            return this._session;
        const {default: Soup} = await import('gi://Soup?version=3.0');
        this._Soup = Soup;
        this._session = new Soup.Session({
            remote_connectable: Gio.UnixSocketAddress.new('/run/snapd.socket'), timeout: 5,
        });
        return this._session;
    }

    async refresh() {
        if (!this._available)
            return;
        try {
            const session = await this._client();
            const msg = this._Soup.Message.new('GET', 'http://localhost/v2/changes?select=in-progress');
            const bytes = await new Promise((resolve, reject) => {
                session.send_and_read_async(msg, GLib.PRIORITY_LOW, null, (s, r) => {
                    try {
                        resolve(s.send_and_read_finish(r));
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            const json = JSON.parse(new TextDecoder().decode(bytes.get_data()));
            this._changes = (json.result ?? []).filter(c => !c.ready);
        } catch {
            this._changes = [];
        }
    }

    items() {
        return this._changes.map(c => {
            const tasks = c.tasks ?? [];
            const doing = tasks.find(t => t.status === 'Doing' && t.progress?.total > 1);
            let progress = null;
            let subtitle = 'Working…';
            if (doing) {
                progress = doing.progress.done / doing.progress.total;
                subtitle = doing.progress.label === 'bytes' || doing.progress.total > 1e5
                    ? `${fmtBytes(doing.progress.done)} of ${fmtBytes(doing.progress.total)}`
                    : (doing.summary ?? subtitle);
            } else if (tasks.length) {
                const done = tasks.filter(t => t.status === 'Done').length;
                progress = done / tasks.length;
                subtitle = tasks.find(t => t.status === 'Doing')?.summary ?? subtitle;
            }
            const title = (c.summary ?? 'Snap change').replace(/"/g, '');
            return {
                id: `snap:${c.id}`, kind: 'system', icon: themedIcon('package-x-generic-symbolic'),
                title, subtitle, app: 'Snap', progress, cancel: null,
            };
        });
    }

    destroy() {
        this._session?.abort();
    }
}

/* ---------- Browser downloads ---------- */
const PARTIAL = /\.(part|crdownload|download|opdownload)$/;
// A partial file that has not grown for this long is a leftover, not a download.
const STALE_US = 90 * 1e6;

class Downloads {
    constructor(hub) {
        this._hub = hub;
        this._files = new Map(); // path -> {size, lastSize, speed, started}
        const dir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) ??
            GLib.build_filenamev([GLib.get_home_dir(), 'Downloads']);
        this._dir = Gio.File.new_for_path(dir);
        try {
            this._monitor = this._dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            this._monitor.connect('changed', (_m, file, other, ev) => this._onChanged(file, other, ev));
        } catch (e) {
            console.debug(`Top Pill: cannot watch downloads: ${e.message}`);
        }
        this._scan();
    }

    _scan() {
        try {
            const en = this._dir.enumerate_children('standard::name,standard::size,time::modified', 0, null);
            let info;
            while ((info = en.next_file(null))) {
                if (!PARTIAL.test(info.get_name()))
                    continue;
                const ageUs = (Date.now() / 1000 - info.get_attribute_uint64('time::modified')) * 1e6;
                this._track(this._dir.get_child(info.get_name()).get_path(), info.get_size(), Math.max(0, ageUs));
            }
            en.close(null);
        } catch {}
    }

    _track(path, size = 0, ageUs = 0) {
        if (!this._files.has(path)) {
            const now = GLib.get_monotonic_time();
            this._files.set(path, {size, lastSize: size, speed: 0, started: now, changed: now - ageUs});
            this._hub.poll();
        }
    }

    _active(d) {
        return GLib.get_monotonic_time() - d.changed < STALE_US;
    }

    _onChanged(file, other, ev) {
        const path = file.get_path();
        const T = Gio.FileMonitorEvent;
        if ((ev === T.CREATED || ev === T.MOVED_IN) && PARTIAL.test(path)) {
            this._track(path);
        } else if (ev === T.RENAMED && this._files.has(path)) {
            this._files.delete(path);
            const final = other?.get_path();
            if (final && !PARTIAL.test(final))
                this._finished(final);
            else if (final)
                this._track(final);
        } else if ((ev === T.DELETED || ev === T.MOVED_OUT) && this._files.has(path)) {
            this._files.delete(path);
            // Firefox removes "name.ext.part" and keeps "name.ext".
            const final = path.replace(PARTIAL, '');
            const f = Gio.File.new_for_path(final);
            if (path.endsWith('.part') && f.query_exists(null)) {
                const size = f.query_info('standard::size', 0, null).get_size();
                if (size > 0)
                    this._finished(final);
            }
            this._hub.poll();
        }
    }

    _finished(path) {
        this._hub.emit('download-finished', {path, name: GLib.path_get_basename(path)});
        this._hub.poll();
    }

    get busy() {
        return [...this._files.values()].some(d => this._active(d));
    }

    refresh(dt) {
        for (const [path, d] of this._files) {
            try {
                const size = Gio.File.new_for_path(path).query_info('standard::size', 0, null).get_size();
                const inst = Math.max(0, size - d.lastSize) / Math.max(dt, 0.25);
                d.speed = d.speed ? d.speed * 0.6 + inst * 0.4 : inst;
                if (size !== d.lastSize)
                    d.changed = GLib.get_monotonic_time();
                d.lastSize = size;
                d.size = size;
            } catch {
                this._files.delete(path);
            }
        }
    }

    items() {
        return [...this._files.entries()].filter(([, d]) => this._active(d)).map(([path, d]) => {
            let name = GLib.path_get_basename(path).replace(PARTIAL, '');
            // Browsers use random temporary names until the file is saved.
            if (/^Unconfirmed \d+$/.test(name) || /^\.?[0-9a-f]{12,}/i.test(name) || /^\.(com|org)\./.test(name))
                name = 'Download';
            return {
                id: `dl:${path}`, kind: 'download', icon: themedIcon('folder-download-symbolic'),
                title: name, app: 'Downloads',
                subtitle: `${fmtBytes(d.size)}${d.speed > 1000 ? ` · ${fmtBytes(d.speed)}/s` : ''}`,
                progress: null, cancel: null,
                open: () => Gio.AppInfo.launch_default_for_uri(this._dir.get_uri(), null),
            };
        });
    }

    destroy() {
        this._monitor?.cancel();
    }
}

/* ---------- AI agents and local models ---------- */
const AGENTS = [
    {key: 'claude', name: 'Claude Code', icon: 'claude', match: (comm, cmd) =>
        (comm === 'claude' && !/claude-desktop|--type=|electron/i.test(cmd)) || (comm === 'node' && /@anthropic-ai\/claude-code|\/claude(\s|$)/.test(cmd))},
    {key: 'codex', name: 'Codex CLI', icon: 'codex', match: (comm, cmd) =>
        comm === 'codex' || (comm === 'node' && /@openai\/codex|\/codex(\s|$)/.test(cmd))},
    {key: 'gemini', name: 'Gemini CLI', icon: 'gemini', match: (comm, cmd) =>
        comm === 'gemini' || (comm === 'node' && /@google\/gemini-cli|\/gemini(\s|$)/.test(cmd))},
    {key: 'copilot', name: 'Copilot CLI', icon: 'copilot', match: (comm, cmd) =>
        comm === 'copilot' || (comm === 'node' && /@github\/copilot|\/copilot(\s|$)/.test(cmd))},
];
const INTERESTING_COMM = new Set(['claude', 'codex', 'gemini', 'copilot', 'node', 'ollama', 'lms', 'lm-studio', 'LM Studio', 'llama-server']);

class AiWatcher {
    constructor(hub, iconDir) {
        this._hub = hub;
        this._iconDir = iconDir;
        this._comm = new Map(); // pid -> comm (cached, invalidated when the pid goes)
        this._procs = new Map(); // pid -> {agent, ticks, cpu, cwd, start, working, workedFor}
        this._btime = Number(/btime (\d+)/.exec(readTextFile('/proc/stat') ?? '')?.[1] ?? 0);
        this._ollama = {running: false, models: [], busy: false, pids: []};
        this._lmstudio = {running: false, models: []};
        this._lastScan = 0;
    }

    _icon(name) {
        const path = GLib.build_filenamev([this._iconDir, `${name}.svg`]);
        return GLib.file_test(path, GLib.FileTest.EXISTS)
            ? Gio.FileIcon.new(Gio.File.new_for_path(path)) : themedIcon('applications-science-symbolic');
    }

    _stat(pid) {
        const s = readTextFile(`/proc/${pid}/stat`);
        if (!s)
            return null;
        const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
        return {ticks: Number(f[11]) + Number(f[12]), start: Number(f[19])};
    }

    _hasChildren(pid) {
        try {
            const dir = Gio.File.new_for_path(`/proc/${pid}/task`);
            const en = dir.enumerate_children('standard::name', 0, null);
            let info, any = false;
            while (!any && (info = en.next_file(null))) {
                const kids = (readTextFile(`/proc/${pid}/task/${info.get_name()}/children`) ?? '').trim();
                any = kids.length > 0;
            }
            en.close(null);
            return any;
        } catch {
            return false;
        }
    }

    scan(dt) {
        const seen = new Set();
        const ollamaPids = [];
        let lmsRunning = false;
        try {
            const en = Gio.File.new_for_path('/proc').enumerate_children('standard::name', 0, null);
            let info;
            while ((info = en.next_file(null))) {
                const name = info.get_name();
                if (!/^\d+$/.test(name))
                    continue;
                const pid = Number(name);
                seen.add(pid);
                let comm = this._comm.get(pid);
                if (comm === undefined) {
                    comm = (readTextFile(`/proc/${pid}/comm`) ?? '').trim();
                    this._comm.set(pid, comm);
                }
                if (!INTERESTING_COMM.has(comm))
                    continue;
                if (comm === 'ollama' || comm === 'llama-server') {
                    ollamaPids.push(pid);
                    continue;
                }
                if (comm === 'lms' || comm === 'lm-studio' || comm === 'LM Studio') {
                    lmsRunning = true;
                    continue;
                }
                let p = this._procs.get(pid);
                if (!p) {
                    const cmd = (readTextFile(`/proc/${pid}/cmdline`) ?? '').replace(/\0/g, ' ');
                    const agent = AGENTS.find(a => a.match(comm, cmd));
                    if (!agent) {
                        this._procs.set(pid, {agent: null});
                        continue;
                    }
                    const st = this._stat(pid);
                    let cwd = '';
                    try {
                        cwd = GLib.file_read_link(`/proc/${pid}/cwd`);
                    } catch {}
                    p = {agent, ticks: st?.ticks ?? 0, cpu: 0, cwd, start: st?.start ?? 0, working: false, since: 0, workStart: 0};
                    this._procs.set(pid, p);
                    continue;
                }
                if (!p.agent)
                    continue;
                const st = this._stat(pid);
                if (!st)
                    continue;
                p.cpu = (st.ticks - p.ticks) / HZ / Math.max(dt, 0.5);
                p.ticks = st.ticks;
                const working = p.cpu > 0.03 || this._hasChildren(pid);
                const now = GLib.get_monotonic_time() / 1e6;
                if (working && !p.working)
                    p.workStart = now;
                if (!working && p.working && now - p.workStart > 20)
                    this._hub.emit('agent-done', {name: p.agent.name, project: GLib.path_get_basename(p.cwd || ''), icon: this._icon(p.agent.icon)});
                p.working = working;
            }
            en.close(null);
        } catch (e) {
            console.debug(`Top Pill: /proc scan: ${e.message}`);
        }
        for (const pid of [...this._comm.keys()]) {
            if (!seen.has(pid)) {
                this._comm.delete(pid);
                this._procs.delete(pid);
            }
        }
        this._ollama.running = ollamaPids.length > 0;
        this._ollama.pids = ollamaPids;
        this._lmstudio.running = lmsRunning;
    }

    async refreshModels(dt) {
        if (this._ollama.running) {
            try {
                const json = JSON.parse(new TextDecoder().decode((await httpGet('http://127.0.0.1:11434/api/ps')).get_data()));
                this._ollama.models = (json.models ?? []).map(m => m.name);
            } catch {
                this._ollama.models = [];
            }
            // A busy runner means a model is generating.
            let busy = false;
            for (const pid of this._ollama.pids) {
                const st = this._stat(pid);
                const prev = this._ollama[`t${pid}`];
                if (st && prev !== undefined && (st.ticks - prev) / HZ / Math.max(dt, 0.5) > 0.25)
                    busy = true;
                if (st)
                    this._ollama[`t${pid}`] = st.ticks;
            }
            this._ollama.busy = busy;
            for (const k of Object.keys(this._ollama)) {
                if (/^t\d+$/.test(k) && !this._ollama.pids.includes(Number(k.slice(1))))
                    delete this._ollama[k];
            }
        } else {
            this._ollama.models = [];
        }
        if (this._lmstudio.running) {
            try {
                const json = JSON.parse(new TextDecoder().decode((await httpGet('http://127.0.0.1:1234/api/v0/models')).get_data()));
                this._lmstudio.models = (json.data ?? []).filter(m => m.state === 'loaded').map(m => m.id);
            } catch {
                this._lmstudio.models = [];
            }
        } else {
            this._lmstudio.models = [];
        }
    }

    get busy() {
        return [...this._procs.values()].some(p => p.agent) || this._ollama.models.length > 0 || this._lmstudio.models.length > 0;
    }

    items() {
        const out = [];
        const groups = new Map();
        for (const [pid, p] of this._procs) {
            if (!p.agent)
                continue;
            const key = `${p.agent.key}|${p.cwd}`;
            const g = groups.get(key);
            if (!g || p.start < g.p.start)
                groups.set(key, {pid, p, working: (g?.working ?? false) || p.working});
            else
                g.working ||= p.working;
        }
        const uptime = Number((readTextFile('/proc/uptime') ?? '0').split(' ')[0]);
        for (const {pid, p, working} of groups.values()) {
            const project = p.cwd ? GLib.path_get_basename(p.cwd) : '';
            const age = uptime - p.start / HZ;
            out.push({
                id: `ai:${p.agent.key}:${pid}`, kind: 'ai', icon: this._icon(p.agent.icon), app: p.agent.name,
                title: project ? `${p.agent.name} · ${project}` : p.agent.name,
                // a fixed start time, so the pill is not redrawn every few seconds
                subtitle: working ? `Working · since ${GLib.DateTime.new_now_local().add_seconds(-age).format('%H:%M')}` : 'Waiting for you',
                working, progress: working ? null : undefined, cancel: null,
            });
        }
        for (const m of this._ollama.models) {
            out.push({
                id: `ai:ollama:${m}`, kind: 'ai', icon: this._icon('ollama'), app: 'Ollama',
                title: `Ollama · ${m}`, subtitle: this._ollama.busy ? 'Generating' : 'Model loaded',
                working: this._ollama.busy, progress: this._ollama.busy ? null : undefined, cancel: null,
            });
        }
        for (const m of this._lmstudio.models) {
            out.push({
                id: `ai:lms:${m}`, kind: 'ai', icon: this._icon('lmstudio'), app: 'LM Studio',
                title: `LM Studio · ${m}`, subtitle: 'Model loaded', working: false, progress: undefined, cancel: null,
            });
        }
        return out;
    }
}

/* ---------- Hub ---------- */
export class LiveHub extends Emitter {
    constructor(settings, iconDir) {
        super();
        this._settings = settings;
        this.battery = new Battery(this);
        this._pk = new PackageKit(this);
        this._apt = new AptDaemon(this);
        this._snap = new Snapd(this);
        this._dl = new Downloads(this);
        this._ai = new AiWatcher(this, iconDir);
        this._items = [];
        this._last = GLib.get_monotonic_time();
        this._tick = 0;
        this._running = false;
        this._ready = true;
        this.poll();
    }

    // Fast while something is happening, slow otherwise.
    _schedule() {
        this._timer = clearSource(this._timer);
        const active = this._pk.busy || this._apt.busy || this._snap.busy || this._dl.busy;
        this._timer = timeout(active ? 1000 : 4000, () => {
            this._timer = 0;
            this.poll();
            return false;
        });
    }

    async poll() {
        if (!this._ready || this._destroyed)
            return;
        if (this._running) {
            this._again = true;
            return;
        }
        this._running = true;
        try {
            const now = GLib.get_monotonic_time();
            const dt = (now - this._last) / 1e6;
            this._last = now;
            this._tick++;
            const aiOn = this._settings.get_boolean('watch-ai');
            const jobs = [this._pk.refresh(), this._apt.refresh()];
            // snapd every ~8 s when idle
            if (this._snap.busy || this._tick % 2 === 0)
                jobs.push(this._snap.refresh());
            if (aiOn) {
                this._ai.scan(dt);
                jobs.push(this._ai.refreshModels(dt));
            }
            this._dl.refresh(dt);
            // Never let one stuck source stall the whole Live list.
            let guard;
            await Promise.race([
                Promise.allSettled(jobs),
                new Promise(resolve => {
                    guard = timeout(20000, () => {
                        guard = 0;
                        console.warn('Top Pill: a live source took over 20 s; skipping it this round');
                        resolve();
                    });
                }),
            ]);
            clearSource(guard);
            const items = [...this._pk.items(), ...this._apt.items(), ...this._snap.items(), ...this._dl.items(),
                ...(aiOn ? this._ai.items() : [])];
            const sig = JSON.stringify(items.map(i => [i.id, i.title, i.subtitle, i.progress === null ? 'n' : Math.round((i.progress ?? -1) * 100)]));
            this._items = items;
            if (sig !== this._sig) {
                this._sig = sig;
                this.emit('changed');
            }
        } catch (e) {
            report(e, 'live poll');
        } finally {
            this._running = false;
            if (this._destroyed)
                return;
            if (this._again) {
                this._again = false;
                this.poll();
            } else {
                this._schedule();
            }
        }
    }

    get items() {
        return this._items;
    }

    destroy() {
        this._destroyed = true;
        this._timer = clearSource(this._timer);
        for (const s of [this.battery, this._pk, this._apt, this._snap, this._dl])
            s.destroy();
        this.clearHandlers();
    }
}
