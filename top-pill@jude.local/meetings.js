// Upcoming calendar events from GNOME's own calendar service, with their
// meeting link (Google Meet, Zoom, Teams, Webex) read from Evolution Data
// Server, where GNOME's calendar keeps them.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Calendar from 'resource:///org/gnome/shell/ui/calendar.js';

import {Emitter, timeout, clearSource} from './util.js';

const FACTORIES = ['org.gnome.evolution.dataserver.Calendar8', 'org.gnome.evolution.dataserver.Calendar7'];
const FACTORY_PATH = '/org/gnome/evolution/dataserver/CalendarFactory';
const FACTORY_IFACE = 'org.gnome.evolution.dataserver.CalendarFactory';
const CAL_IFACE = 'org.gnome.evolution.dataserver.Calendar';
const LINK_PROPS = ['X-GOOGLE-CONFERENCE', 'URL', 'LOCATION', 'DESCRIPTION'];

function call(name, path, iface, method, args, type) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(name, path, iface, method, args, type ? new GLib.VariantType(type) : null,
            Gio.DBusCallFlags.NONE, 5000, null, (c, res) => {
                try {
                    resolve(c.call_finish(res).deepUnpack());
                } catch (e) {
                    reject(e);
                }
            });
    });
}

// Only real meeting hosts count, so a random link in a description is never offered as "Join".
export function isMeetingLink(link) {
    let u;
    try {
        u = GLib.Uri.parse(link, GLib.UriFlags.NONE);
    } catch {
        return false;
    }
    if (u.get_scheme() !== 'https' || u.get_userinfo())
        return false;
    const host = (u.get_host() ?? '').toLowerCase();
    const path = u.get_path() ?? '';
    const on = d => host === d || host.endsWith(`.${d}`);
    if (host === 'meet.google.com')
        return path.length > 1;
    if (host === 'teams.microsoft.com')
        return path.startsWith('/l/meetup-join/') || path.startsWith('/meet/');
    if (host === 'teams.live.com')
        return path.length > 1;
    if (on('zoom.us'))
        return ['/j/', '/my/', '/w/'].some(p => path.startsWith(p));
    if (on('webex.com'))
        return host !== 'webex.com' && path.length > 1;
    return false;
}

export function findMeetingLink(ical) {
    // unfold continuation lines
    const lines = [];
    for (const raw of ical.split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (/^[ \t]/.test(line) && lines.length)
            lines[lines.length - 1] += line.slice(1);
        else
            lines.push(line);
    }
    for (const prop of LINK_PROPS) {
        for (const line of lines) {
            const m = /^([A-Za-z-]+)(?:;[^:]*)?:(.*)$/.exec(line);
            if (!m || m[1].toUpperCase() !== prop)
                continue;
            const value = m[2].replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');
            for (const link of value.match(/https:\/\/[^\s"<>]+/g) ?? []) {
                const clean = link.replace(/[).,;]+$/, '');
                if (isMeetingLink(clean))
                    return clean;
            }
        }
    }
    return null;
}

export class Meetings extends Emitter {
    constructor() {
        super();
        this.events = [];
        this._links = new Map();
        this._source = new Calendar.DBusEventSource();
        this._source.connectObject('changed', () => this._refresh(), this);
        this._request();
        // re-request each 15 min so "upcoming" moves along, and recheck hourly ranges
        this._timer = timeout(15 * 60 * 1000, () => {
            this._request();
            return true;
        });
        this._key = '';
        this._tick = timeout(60 * 1000, () => {
            this._refresh();
            this.emit('tick');
            return true;
        });
    }

    _request() {
        const now = new Date();
        const end = new Date(now.getTime() + 36 * 3600 * 1000);
        try {
            this._source.requestRange(new Date(now.getTime() - 3600 * 1000), end);
        } catch (e) {
            console.debug(`Top Pill: calendar: ${e.message}`);
        }
        this._refresh();
    }

    _refresh() {
        const now = new Date();
        const end = new Date(now.getTime() + 36 * 3600 * 1000);
        let list = [];
        try {
            list = this._source.getEvents(new Date(now.getTime() - 3600 * 1000), end);
        } catch {}
        this.events = list
            .filter(e => e.end > now && !(e.date.getHours() === 0 && e.end - e.date >= 86400000)) // skip all-day
            .sort((a, b) => a.date - b.date)
            .slice(0, 5)
            .map(e => ({id: e.id, title: e.summary || 'Event', start: e.date, end: e.end, link: this._links.get(e.id) ?? null}));
        const key = JSON.stringify(this.events.map(e => [e.id, e.title, +e.start, +e.end, e.link]));
        if (key !== this._key) {
            this._key = key;
            this.emit('changed');
        }
        for (const e of this.events) {
            if (!this._links.has(e.id))
                this._lookup(e.id);
        }
    }

    async _lookup(id) {
        this._links.set(id, null);
        const [source, uid, rid = ''] = id.split('\n');
        if (!source || !uid)
            return;
        for (const factory of FACTORIES) {
            try {
                const [path, name] = await call(factory, FACTORY_PATH, FACTORY_IFACE, 'OpenCalendar',
                    new GLib.Variant('(s)', [source]), '(ss)');
                try {
                    await call(name, path, CAL_IFACE, 'Open', null, null);
                    const [ical] = await call(name, path, CAL_IFACE, 'GetObject', new GLib.Variant('(ss)', [uid, rid]), '(s)');
                    const link = findMeetingLink(ical);
                    this._links.set(id, link);
                    if (link)
                        this._refresh();
                } finally {
                    call(name, path, CAL_IFACE, 'Close', null, null).catch(() => {});
                }
                return;
            } catch {
                // try the older factory name
            }
        }
    }

    // The next event that starts within `minutes`, or is happening now.
    next(minutes = 12 * 60) {
        const now = Date.now();
        return this.events.find(e => e.start - now < minutes * 60000 && e.end > now) ?? null;
    }

    destroy() {
        this._timer = clearSource(this._timer);
        this._tick = clearSource(this._tick);
        this._source.disconnectObject(this);
        this._source.destroy?.();
        this._source = null;
        this.clearHandlers();
    }
}
