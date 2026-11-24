// Top Pill — a top-of-screen activity pill for GNOME Shell.
//
// GNOME Shell keeps an extension's modules in memory until you log out. To let
// updates load without logging out, install.sh puts each version of the code
// in builds/<id>/ and this small loader imports the newest one every time the
// extension is enabled. Reload = `gnome-extensions disable` + `enable`.
//
// If the newest build fails to load or start, the loader falls back to the
// previous builds (newest first), so a bad update never leaves you without
// the pill. builds/.fallback records when that happened.
import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const ID_RE = /^[\w.-]+$/;

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes).trim() : '';
    } catch {
        return '';
    }
}

export default class TopPillExtension extends Extension {
    // GNOME waits for this, so the extension only shows as on once the pill
    // really started (and shows an error in Extensions if no build could).
    async enable() {
        const builds = GLib.build_filenamev([this.path, 'builds']);
        // Tells install.sh that this shell runs the reloadable loader.
        try {
            GLib.mkdir_with_parents(builds, 0o755);
            GLib.file_set_contents(GLib.build_filenamev([builds, '.loader-running']), `${Date.now()}`);
        } catch {}
        const token = this._token = {};
        await this._start(token, builds);
    }

    _candidates(builds) {
        const current = readText(GLib.build_filenamev([builds, 'current']));
        const ids = [];
        try {
            const dir = GLib.Dir.open(builds, 0);
            let name;
            while ((name = dir.read_name()) !== null) {
                if (ID_RE.test(name) && !name.startsWith('.') &&
                    GLib.file_test(GLib.build_filenamev([builds, name, 'controller.js']), GLib.FileTest.EXISTS))
                    ids.push(name);
            }
            dir.close();
        } catch {}
        ids.sort().reverse();
        const ordered = ID_RE.test(current) && ids.includes(current) ? [current, ...ids.filter(i => i !== current)] : ids;
        return [...ordered.map(id => [id, `file://${GLib.build_filenamev([builds, id, 'controller.js'])}`]), ['bundled', './controller.js']];
    }

    async _start(token, builds) {
        const list = this._candidates(builds);
        for (const [id, url] of list) {
            try {
                const {Controller} = await import(url);
                if (this._token !== token)
                    return; // disabled while loading
                this.buildId = id;
                this._controller = new Controller(this);
                console.log(`Top Pill: running build ${id}`);
                if (id !== list[0][0]) {
                    const note = `${new Date().toISOString()} build ${list[0][0]} failed; running ${id}`;
                    console.warn(`Top Pill: ${note}`);
                    try {
                        GLib.file_set_contents(GLib.build_filenamev([builds, '.fallback']), note);
                    } catch {}
                } else {
                    GLib.unlink(GLib.build_filenamev([builds, '.fallback']));
                }
                return;
            } catch (e) {
                logError(e, `Top Pill: build ${id} could not start`);
                if (this._token !== token)
                    return;
            }
        }
        throw new Error('Top Pill: no installed build could start; run install.sh again');
    }

    disable() {
        this._token = null;
        try {
            this._controller?.destroy();
        } catch (e) {
            logError(e, 'Top Pill: stop');
        }
        this._controller = null;
    }
}
