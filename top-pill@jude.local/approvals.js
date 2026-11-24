// Agent approvals: Claude Code and Codex call a small hook (top-pill-hook)
// when they need permission. The hook asks the pill over D-Bus and waits.
// If nobody answers (pill off, or you answer in the terminal), the agent just
// asks in its terminal as usual.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Emitter, clearSource, timeout, report} from './util.js';

export const DBUS_PATH = '/org/gnome/Shell/Extensions/TopPill';
const IFACE = `<node><interface name="org.gnome.Shell.Extensions.TopPill">
  <method name="Ask"><arg type="s" name="request" direction="in"/><arg type="s" name="answer" direction="out"/></method>
  <method name="Event"><arg type="s" name="event" direction="in"/></method>
</interface></node>`;

const MAX_WAIT_MS = 9 * 60 * 1000 + 30 * 1000;
let _nextId = 1;

export class Approvals extends Emitter {
    constructor() {
        super();
        this.queue = [];
        this._impl = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        try {
            this._impl.export(Gio.DBus.session, DBUS_PATH);
        } catch (e) {
            report(e, 'could not export approvals');
        }
    }

    // D-Bus: Ask(s) -> s, answered later
    AskAsync([json], invocation) {
        let req;
        try {
            req = JSON.parse(json);
        } catch {
            invocation.return_value(new GLib.Variant('(s)', ['']));
            return;
        }
        const item = {
            id: `a${_nextId++}`, invocation,
            ai: req.ai === 'codex' ? 'codex' : 'claude',
            tool: String(req.tool ?? 'a tool').slice(0, 80),
            input: String(req.input ?? '').slice(0, 400),
            cwd: String(req.cwd ?? ''),
            always: !!req.always,
        };
        // If the hook goes away (answered in the terminal), drop the request.
        const sender = invocation.get_sender();
        if (sender) {
            item.watch = Gio.bus_watch_name_on_connection(Gio.DBus.session, sender, Gio.BusNameWatcherFlags.NONE,
                null, () => this._finish(item.id, null));
        }
        item.timer = timeout(MAX_WAIT_MS, () => {
            item.timer = 0;
            this._finish(item.id, '');
        });
        this.queue.push(item);
        this.emit('changed');
    }

    // D-Bus: Event(s) — agent finished or needs input
    Event(json) {
        try {
            const ev = JSON.parse(json);
            this.emit('event', {
                ai: ev.ai === 'codex' ? 'codex' : 'claude',
                kind: ev.kind === 'notification' ? 'notification' : 'stop',
                cwd: String(ev.cwd ?? ''),
                message: String(ev.message ?? '').slice(0, 200),
            });
        } catch {}
    }

    answer(id, answer) {
        this._finish(id, answer);
    }

    _finish(id, answer) {
        const i = this.queue.findIndex(q => q.id === id);
        if (i < 0)
            return;
        const [item] = this.queue.splice(i, 1);
        item.timer = clearSource(item.timer);
        if (item.watch)
            Gio.bus_unwatch_name(item.watch);
        if (answer !== null) {
            try {
                item.invocation.return_value(new GLib.Variant('(s)', [answer]));
            } catch {}
        }
        this.emit('changed');
    }

    get current() {
        return this.queue[0] ?? null;
    }

    destroy() {
        // Unanswered requests fall back to the agent's own terminal prompt.
        for (const item of [...this.queue])
            this._finish(item.id, '');
        try {
            this._impl.unexport();
        } catch {}
        this.clearHandlers();
    }
}
