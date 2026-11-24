// Mirrors GNOME's own notifications into the pill and, optionally, replaces
// the top banner with the pill's peek. Notifications stay owned by GNOME, so
// the calendar list, Do Not Disturb, per-app settings and sounds keep working.
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Emitter, themedIcon} from './util.js';

const CATEGORY_RULES = [
    ['Messages', /slack|telegram|discord|whatsapp|signal|teams|element|zoom|skype|thunderbird\.chat|fractal|polari|chatterino|messenger|wire|zulip|mattermost|rocket/],
    ['Mail', /thunderbird|geary|evolution|mailspring|betterbird|mail|gmail|outlook/],
    ['AI', /claude|chatgpt|openai|codex|gemini|copilot|ollama|lmstudio|lm-studio|alpaca|perplexity|anthropic|jan\b/],
];

function categorize(source) {
    const key = `${source.policy?.id ?? ''} ${source.title ?? ''}`.toLowerCase();
    for (const [cat, re] of CATEGORY_RULES) {
        if (re.test(key))
            return cat;
    }
    return 'System';
}

let _nextId = 1;

export class NotificationWatcher extends Emitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._items = new Map(); // Notification -> item
        this._sources = new Set();
        this._injections = new InjectionManager();

        const tray = Main.messageTray;
        tray.connectObject(
            'source-added', (_t, s) => this._watchSource(s),
            'source-removed', (_t, s) => this._unwatchSource(s), this);
        for (const s of tray.getSources())
            this._watchSource(s);

        const self = this;
        this._injections.overrideMethod(tray, '_showNotification', original => function () {
            // Keep GNOME's banner for critical alerts (low battery, etc.) and
            // whenever the user switched the replacement off.
            const next = this._notificationQueue[0];
            if (!self._settings.get_boolean('replace-banners') || !next ||
                next.urgency === MessageTray.Urgency.CRITICAL)
                return original.call(this);
            const n = this._notificationQueue.shift();
            this.emit('queue-changed');
            self._peek(n);
            return undefined;
        });
    }

    _watchSource(source) {
        if (this._sources.has(source))
            return;
        this._sources.add(source);
        source.connectObject(
            'notification-added', (_s, n) => this._add(n),
            'notify::count', () => this.emit('changed'), this);
        for (const n of source.notifications)
            this._add(n);
    }

    _unwatchSource(source) {
        this._sources.delete(source);
        source.disconnectObject(this);
    }

    _add(n) {
        if (this._items.has(n))
            return;
        const item = {id: `n${_nextId++}`, notification: n};
        this._items.set(n, item);
        n.connectObject(
            'destroy', () => {
                this._items.delete(n);
                n.disconnectObject(this);
                this.emit('changed');
            },
            'notify::title', () => this.emit('changed'),
            'notify::body', () => this.emit('changed'),
            'notify::acknowledged', () => this.emit('changed'), this);
        this.emit('changed');
    }

    _peek(n) {
        // GNOME would have played the sound when showing its banner.
        n.playSound();
        if (!n.sound && n.source.policy.enableSound && this._settings.get_boolean('peek-sound')) {
            try {
                global.display.get_sound_player().play_from_theme('message-new-instant', n.title ?? 'Notification', null);
            } catch {}
        }
        const item = this._items.get(n);
        if (item)
            this.emit('peek', this.describe(item));
    }

    describe(item) {
        const n = item.notification;
        const s = n.source;
        return {
            id: item.id,
            title: n.title || s.title || 'Notification',
            body: (n.body ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
            app: s.title || '',
            gicon: s.icon ?? n.gicon ?? themedIcon('dialog-information-symbolic'),
            image: n.gicon && s.icon && n.gicon !== s.icon ? n.gicon : null,
            datetime: n.datetime,
            category: categorize(s),
            unread: !n.acknowledged,
            urgent: n.urgency === MessageTray.Urgency.CRITICAL,
            actions: n.actions.map(a => ({label: a.label, run: () => a.activate()})),
        };
    }

    get items() {
        return [...this._items.values()]
            .map(i => this.describe(i))
            .sort((a, b) => (b.datetime?.to_unix() ?? 0) - (a.datetime?.to_unix() ?? 0));
    }

    get unreadCount() {
        let c = 0;
        for (const i of this._items.values()) {
            if (!i.notification.acknowledged)
                c++;
        }
        return c;
    }

    _find(id) {
        for (const i of this._items.values()) {
            if (i.id === id)
                return i.notification;
        }
        return null;
    }

    activate(id) {
        const n = this._find(id);
        if (!n)
            return;
        Main.overview.hide();
        n.activate();
    }

    dismiss(id) {
        this._find(id)?.destroy(MessageTray.NotificationDestroyedReason.DISMISSED);
    }

    clear(ids = null) {
        const targets = [...this._items.values()]
            .filter(i => !ids || ids.includes(i.id))
            .map(i => i.notification);
        for (const n of targets)
            n.destroy(MessageTray.NotificationDestroyedReason.DISMISSED);
    }

    // GNOME drops temporary notifications (like "Screenshot captured") once
    // they have been seen; do the same when the inbox closes.
    dropSeenTransient() {
        const seen = [...this._items.values()].map(i => i.notification)
            .filter(n => n.isTransient && n.acknowledged);
        for (const n of seen)
            n.destroy(MessageTray.NotificationDestroyedReason.EXPIRED);
    }

    acknowledgeAll() {
        for (const i of this._items.values())
            i.notification.acknowledged = true;
    }

    destroy() {
        this._injections.clear();
        Main.messageTray.disconnectObject(this);
        for (const s of this._sources)
            s.disconnectObject(this);
        for (const n of this._items.keys())
            n.disconnectObject(this);
        this._sources.clear();
        this._items.clear();
        this.clearHandlers();
    }
}
