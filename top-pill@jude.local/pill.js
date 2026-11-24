// The pill itself: idle, peek, charge and expanded states, the teardrop
// entrance, tuck-away into the top bar, and every view inside it.
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as GrabHelper from 'resource:///org/gnome/shell/ui/grabHelper.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

import {unit, animationsEnabled, clamp, timeout, clearSource, fmtTime, fmtAgo, openUri, themedIcon, Signals, report} from './util.js';
import {WaveProgress, Ring, Orb, MiniFace, Buddy, Shadow} from './draw.js';
import {CATEGORIES as TREND_CATS} from './trending.js';

const M = Clutter.AnimationMode;
const PRIV_COLORS = {mic: '#FF9F0A', camera: '#30D158', screen: '#BF5AF2'};
const TREND_COLORS = {
    dark: {Tech: '#62A0EA', DevOps: '#8FF0A4', AI: '#DC8ADD', 'New tools': '#FFA348'},
    light: {Tech: '#1C71D8', DevOps: '#26A269', AI: '#9141AC', 'New tools': '#C64600'},
};
const INBOX_CATS = ['Messages', 'Mail', 'AI', 'System'];

function label(text, cls, params = {}) {
    const l = new St.Label({text: text ?? '', style_class: cls, y_align: Clutter.ActorAlign.CENTER, ...params});
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return l;
}

function icon(gicon, size, cls = '') {
    const g = typeof gicon === 'string' ? themedIcon(gicon) : gicon;
    return new St.Icon({gicon: g ?? themedIcon('application-x-executable-symbolic'), icon_size: size, style_class: cls});
}

function button(child, cls, onClick, params = {}) {
    const b = new St.Button({child, style_class: cls, can_focus: true, reactive: true, ...params});
    b.connect('clicked', () => onClick?.());
    return b;
}

function hbox(cls = '', params = {}) {
    return new St.BoxLayout({style_class: cls, ...params});
}

function vbox(cls = '', params = {}) {
    return new St.BoxLayout({style_class: cls, orientation: Clutter.Orientation.VERTICAL, ...params});
}

// Lays out a progress fill as a fraction of the track, inside allocation
// (setting widths from notify::width would re-queue layout mid-allocation).
const FractionLayout = GObject.registerClass(
class TopPillFractionLayout extends Clutter.LayoutManager {
    _init() {
        super._init();
        this.fraction = 0;
        this.offset = 0;
    }

    set(fraction, offset = 0) {
        fraction = clamp(fraction, 0, 1);
        if (fraction === this.fraction && offset === this.offset)
            return;
        this.fraction = fraction;
        this.offset = offset;
        this.layout_changed();
    }

    vfunc_get_preferred_width() {
        return [0, 0];
    }

    vfunc_get_preferred_height(container) {
        const c = container.get_first_child();
        return c ? c.get_preferred_height(-1) : [0, 0];
    }

    vfunc_allocate(container, box) {
        const c = container.get_first_child();
        if (!c)
            return;
        const w = box.get_width();
        const b = new Clutter.ActorBox();
        b.x1 = Math.round(this.offset * w);
        b.x2 = b.x1 + Math.round(this.fraction * w);
        b.y1 = 0;
        b.y2 = box.get_height();
        c.allocate(b);
    }
});

function progressBar(fillClass = '', props = {}) {
    const layout = new FractionLayout();
    const track = new St.Widget({style_class: 'tp-progress', layout_manager: layout, clip_to_allocation: true, x_expand: true, ...props});
    const fill = new St.Widget({style_class: `tp-progress-fill ${fillClass}`.trim(), y_expand: true});
    track.add_child(fill);
    track._layout = layout;
    track._fill = fill;
    return track;
}

function fmtClock(us) {
    const s = Math.max(0, Math.ceil(us / 1e6));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function hhmm(d) {
    return GLib.DateTime.new_from_unix_local(Math.floor(d.getTime() / 1000)).format('%H:%M');
}

function meetingWhen(m) {
    const mins = Math.round((m.start - Date.now()) / 60000);
    const span = `${hhmm(m.start)}–${hhmm(m.end)}`;
    if (mins <= 0)
        return `Now · ${span}`;
    if (mins < 60)
        return `In ${mins} min · ${span}`;
    const today = new Date().toDateString() === m.start.toDateString();
    return today ? span : `Tomorrow · ${span}`;
}

function fmtReset(ms) {
    const d = GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
    const now = GLib.DateTime.new_now_local();
    const sameDay = d.get_day_of_year() === now.get_day_of_year() && d.get_year() === now.get_year();
    return sameDay ? `at ${d.format('%H:%M')}` : d.format('%a %H:%M');
}

function parseHex(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export const Pill = GObject.registerClass({
    Signals: {'request-prefs': {}},
}, class TopPill extends St.Widget {
    _init(ctx) {
        super._init({name: 'topPill', layout_manager: new Clutter.FixedLayout(), reactive: false, opacity: 0});
        this._ctx = ctx;
        this._settings = ctx.settings;
        this._signals = new Signals();
        this._mode = 'idle';
        this._tab = 'inbox';
        this._actIndex = 0;
        this._tucked = false;
        this._inboxCat = 'All';
        this._trendCat = 'All';
        this._selectedNotif = null;
        this._animators = new Set();
        this._U = unit();
        this._accent = [0.4, 0.6, 1];

        this._shadow = new Shadow();
        this.add_child(this._shadow);
        this._body = new St.Widget({
            style_class: 'tp-body', reactive: true, track_hover: true,
            layout_manager: new Clutter.BinLayout(),
        });
        this.add_child(this._body);
        for (const prop of ['x', 'width', 'height', 'translation-x', 'translation-y', 'scale-x', 'opacity'])
            this._body.connect(`notify::${prop}`, () => this._syncShadow());
        // Content is clipped by an inner box so the shadow can stay outside.
        this._clip = new St.Widget({
            clip_to_allocation: true, x_expand: true, y_expand: true,
            layout_manager: new Clutter.BinLayout(),
        });
        this._body.add_child(this._clip);
        this._bubble = button(hbox('tp-bubble-box'), 'tp-bubble', () => this.cycle(1), {accessible_name: 'Next activity'});
        this._bubbleIcon = icon(null, 12, 'tp-bubble-icon');
        this._bubbleLabel = label('', 'tp-bubble-label');
        this._bubble.child.add_child(this._bubbleIcon);
        this._bubble.child.add_child(this._bubbleLabel);
        this._bubble.visible = false;
        this.add_child(this._bubble);

        // Accent probe: reads -st-accent-color for Cairo drawing.
        this._probe = new St.Widget({style_class: 'tp-accent-probe', width: 1, height: 1, opacity: 0});
        this.add_child(this._probe);
        this._probe.connect('style-changed', () => this._readAccent());

        this._idle = this._buildIdle();
        this._peek = this._buildPeek();
        this._charge = this._buildCharge();
        this._exp = this._buildExpanded();
        this._ask = this._buildAsk();
        for (const l of [this._idle, this._peek, this._charge, this._exp, this._ask]) {
            l.x_align = Clutter.ActorAlign.CENTER;
            l.y_align = Clutter.ActorAlign.START;
            l.visible = false;
            this._clip.add_child(l);
        }
        this._idle.visible = true;

        this._body.connect('notify::height', () => this._syncRadius());
        this._body.connect('notify::hover', () => this._onHover());
        this._body.connect('scroll-event', (_a, ev) => this._onScroll(ev));
        this._body.connect('button-release-event', (_a, ev) => this._onBodyClick(ev));

        this._grabHelper = new GrabHelper.GrabHelper(this, {actionMode: Shell.ActionMode.POPUP});

        const st = St.Settings.get();
        this._signals.connect(st, 'notify::color-scheme', () => this._applyTheme());
        this._signals.connect(st, 'notify::high-contrast', () => this._applyTheme());
        this._signals.connect(st, 'notify::accent-color', () => this._readAccent());
        this._signals.connect(st, 'notify::text-scaling-factor', () => this._rescale());
        this._signals.connect(St.ThemeContext.get_for_stage(global.stage), 'notify::scale-factor', () => this._rescale());
        this._signals.connect(this._settings, 'changed::theme', () => this._applyTheme());
        this._signals.connect(this._settings, 'changed::tuck-away', () => this._queueTuck());
        this._signals.connect(Main.layoutManager, 'monitors-changed', () => this._relayout(false));
        this._signals.connect(Main.overview, 'showing', () => this._queueTuck());
        this._signals.connect(Main.overview, 'hidden', () => this._queueTuck());
        this._signals.connect(Main.panel, 'notify::height', () => this._relayout(false));
        this._watchWindows();
        this._watchPanelMenus();
        // The shell tears the UI down without disabling extensions at logout.
        this._signals.connect(global.display, 'closing', () => {
            this._closing = true;
            this._syncClock();
        });
        // Pause every decoration while the pill can't be seen.
        this.connect('notify::mapped', () => this._onShownChanged());
        this.connect('notify::opacity', () => this._onShownChanged());
    }

    // Called once the pill is on stage.
    attached() {
        this._applyTheme();
    }

    // Step aside while a top-bar menu (calendar, quick settings…) is open.
    _watchPanelMenus() {
        this._menuOpen = new Set();
        for (const ind of Object.values(Main.panel.statusArea)) {
            const menu = ind?.menu;
            if (!menu?.connectObject)
                continue;
            menu.connectObject('open-state-changed', (m, open) => {
                if (open)
                    this._menuOpen.add(m);
                else
                    this._menuOpen.delete(m);
                // never stay hidden because a menu vanished without closing
                for (const x of [...this._menuOpen]) {
                    if (!x.isOpen)
                        this._menuOpen.delete(x);
                }
                const away = this._menuOpen.size > 0;
                this._body.reactive = !away;
                this.ease({opacity: away ? 0 : 255, duration: 150, mode: M.EASE_OUT_QUAD});
                if (away && this._mode === 'expanded')
                    this.collapse();
            }, this);
            this._menus = [...(this._menus ?? []), menu];
        }
    }

    /* ---------------- theme ---------------- */
    get _themeName() {
        const t = this._settings.get_string('theme');
        if (t !== 'auto')
            return t;
        return St.Settings.get().color_scheme === St.SystemColorScheme.PREFER_DARK ? 'dark' : 'light';
    }

    get _light() {
        return this._themeName === 'light';
    }

    _applyTheme() {
        for (const t of ['dark', 'light', 'glass'])
            this.remove_style_class_name(`tp-theme-${t}`);
        this.add_style_class_name(`tp-theme-${this._themeName}`);
        if (St.Settings.get().high_contrast)
            this.add_style_class_name('tp-hc');
        else
            this.remove_style_class_name('tp-hc');
        this._readAccent();
        this.update();
    }

    _readAccent() {
        if (!this.get_stage())
            return;
        try {
            const c = this._probe.get_theme_node().get_foreground_color();
            this._accent = [c.red / 255, c.green / 255, c.blue / 255];
        } catch {}
        this._fg = this._light ? [0.11, 0.11, 0.12] : [1, 1, 1];
        for (const a of [this._wave, this._ring, this._orb, this._mini, this._buddy]) {
            if (!a)
                continue;
            a.color = a === this._wave ? this._fg : this._accent;
            if (a === this._wave)
                a.trackColor = [...this._fg, 0.22];
            if (a === this._buddy) {
                a.ink = [0.1, 0.1, 0.14];
                a.textColor = this._fg;
            }
            a.queue_repaint();
        }
    }

    _rescale() {
        this._U = unit();
        this._relayout(false);
    }

    /* ---------------- animation clock ---------------- */
    _animate(fn, on) {
        if (on)
            this._animators.add(fn);
        else
            this._animators.delete(fn);
        this._syncClock();
    }

    _syncClock() {
        const run = this._animators.size > 0 && this._shown && !this._closing;
        if (run && !this._clock) {
            let last = GLib.get_monotonic_time();
            this._clock = timeout(33, () => {
                const now = GLib.get_monotonic_time();
                const dt = Math.min((now - last) / 1e6, 0.1);
                last = now;
                for (const f of this._animators)
                    f(dt);
                if (!this._animators.size || !this._shown || this._closing) {
                    this._clock = 0;
                    return false;
                }
                return true;
            });
        } else if (!run && this._clock) {
            this._clock = clearSource(this._clock);
        }
    }

    /* ---------------- idle ---------------- */
    _buildIdle() {
        const box = hbox('tp-idle', {y_align: Clutter.ActorAlign.CENTER});
        this._lead = new St.Bin({style_class: 'tp-lead', y_align: Clutter.ActorAlign.CENTER});
        this._idleLabel = label('', 'tp-idle-label tp-fg', {x_expand: true});
        this._badge = label('', 'tp-badge');
        this._bars = hbox('tp-bars', {y_align: Clutter.ActorAlign.CENTER});
        this._barActors = [0, 1, 2, 3].map(() => {
            const b = new St.Widget({style_class: 'tp-bar', y_align: Clutter.ActorAlign.CENTER, pivot_point: new Graphene.Point({x: 0.5, y: 0.5})});
            this._bars.add_child(b);
            return b;
        });
        this._privBox = hbox('tp-priv-dots', {y_align: Clutter.ActorAlign.CENTER});
        this._privDots = {};
        for (const k of ['mic', 'camera', 'screen']) {
            const d = new St.Widget({style_class: 'tp-priv-dot', style: `background-color: ${PRIV_COLORS[k]};`});
            this._privDots[k] = d;
            this._privBox.add_child(d);
        }
        this._dotsBox = hbox('tp-dots');
        this._dots = button(this._dotsBox, 'tp-dots-button', () => this.cycle(1), {accessible_name: 'Switch activity', y_align: Clutter.ActorAlign.CENTER});
        for (const a of [this._lead, this._idleLabel, this._badge, this._bars, this._privBox, this._dots])
            box.add_child(a);
        return box;
    }

    _setLead(kind, data) {
        const key = `${kind}|${data?.key ?? ''}`;
        if (this._leadKey === key) {
            this._updateLead(kind, data);
            return;
        }
        this._leadKey = key;
        this._blinkTimer = clearSource(this._blinkTimer);
        this._orbRest = clearSource(this._orbRest);
        this._ring = this._orb = this._mini = null;
        const s = 24 * this._U;
        let child;
        if (kind === 'art') {
            child = new St.Widget({style_class: 'tp-art-mini', width: s, height: s});
        } else if (kind === 'ring') {
            child = this._ring = new Ring({width: s, height: s, pivot_point: new Graphene.Point({x: 0.5, y: 0.5})});
            this._ring.color = this._accent;
        } else if (kind === 'orb') {
            child = this._orb = new Orb({width: s, height: s, pivot_point: new Graphene.Point({x: 0.5, y: 0.5})});
            this._orb.color = this._accent;
            this._orb.t = 0.5; // drawn once; the pulse is a scale transition
        } else if (kind === 'face') {
            child = this._mini = new MiniFace({width: s, height: s});
            this._mini.color = this._accent;
        } else if (kind === 'trend') {
            child = new St.Widget({style_class: 'tp-trend-lead', width: s, height: s, layout_manager: new Clutter.BinLayout()});
            child.add_child(icon('starred-symbolic', 12, 'tp-trend-lead-icon'));
        } else {
            child = icon(data?.gicon, 20, 'tp-lead-icon');
        }
        this._lead.set_child(child);
        this._updateLead(kind, data);
    }

    _updateLead(kind, data) {
        const child = this._lead.get_child();
        if (kind === 'art' && child) {
            if (data.artPath)
                child.style = `background-image: url("file://${data.artPath}"); background-size: cover;`;
            else
                child.style = null;
        } else if (kind === 'ring' && this._ring) {
            this._ring.fraction = data.progress ?? null;
            this._ring.queue_repaint();
        } else if (kind === 'icon' && child instanceof St.Icon && data?.gicon) {
            child.gicon = data.gicon;
        }
        this._leadKind = kind;
        this._leadData = data;
        const on = this._shown && this._mode === 'idle' && animationsEnabled();
        // spinner: rotate the actor (no redraws)
        const spin = on && kind === 'ring' && this._ring && data.progress == null;
        if (this._ring) {
            if (spin && !this._ring.get_transition('rotation-angle-z')) {
                this._ring.rotation_angle_z = 0;
                this._ring.ease({rotation_angle_z: 360, duration: 1100, mode: M.LINEAR, repeatCount: -1});
            } else if (!spin) {
                this._ring.remove_transition('rotation-angle-z');
                this._ring.rotation_angle_z = 0;
            }
        }
        // orb: a couple of breaths, then a rest (a constant pulse would keep
        // the compositor drawing every frame for as long as an agent works)
        if (this._orb) {
            if (on && !this._orb.get_transition('scale-x') && !this._orbRest)
                this._breathe(this._orb);
            else if (!on) {
                this._orbRest = clearSource(this._orbRest);
                this._orb.remove_all_transitions();
                this._orb.set_scale(1, 1);
            }
        }
        // face: a blink every few seconds, three repaints each
        if (this._mini && on && !this._blinkTimer)
            this._scheduleBlink();
        else if (!on)
            this._blinkTimer = clearSource(this._blinkTimer);
    }

    _breathe(orb) {
        orb.set_scale(1, 1);
        orb.ease({
            scale_x: 0.84, scale_y: 0.84, duration: 900, mode: M.EASE_IN_OUT_SINE, repeatCount: 3, autoReverse: true,
            onStopped: finished => {
                if (!finished || this._orb !== orb)
                    return;
                this._orbRest = timeout(12000, () => {
                    this._orbRest = 0;
                    if (this._orb === orb && this._shown && this._mode === 'idle' && animationsEnabled())
                        this._breathe(orb);
                    return false;
                });
            },
        });
    }

    _scheduleBlink() {
        this._blinkTimer = timeout(3000 + Math.random() * 3000, () => {
            this._blinkTimer = 0;
            const m = this._mini;
            if (!m || !this._shown)
                return false;
            const steps = [1, 0.5, 0];
            const step = () => {
                if (this._mini !== m)
                    return false;
                m.blink = steps.shift();
                m.queue_repaint();
                return steps.length > 0;
            };
            step();
            this._blinkTimer = timeout(60, () => {
                const more = step();
                if (!more) {
                    this._blinkTimer = 0;
                    this._scheduleBlink();
                }
                return more;
            });
            return false;
        });
    }

    // Whether the pill can be seen right now (mapped and not faded out).
    get _shown() {
        return this.mapped && this.opacity > 0;
    }

    _onShownChanged() {
        const shown = this._shown;
        if (shown === this._wasShown)
            return;
        this._wasShown = shown;
        this._syncClock();
        if (this._leadKind)
            this._updateLead(this._leadKind, this._leadData);
        if (this._mode === 'idle')
            this.update();
    }

    get activities() {
        const out = [];
        const p = this._ctx.media.current;
        // A player paused long ago (a forgotten browser tab) is not an activity.
        const recent = p && GLib.get_monotonic_time() - p.lastActive < 15 * 60 * 1e6;
        if (p && (p.playing || (p.status === 'Paused' && recent))) {
            out.push({
                key: 'media', tab: 'media', gicon: p.gicon ?? themedIcon('audio-x-generic-symbolic'),
                label: p.artists.length ? `${p.title} · ${p.artists.join(', ')}` : p.title,
                short: p.title, lead: p.artPath ? 'art' : 'icon', artPath: p.artPath,
            });
        }
        for (const it of this._ctx.live.items) {
            if (it.kind === 'ai' && !it.working)
                continue;
            out.push({
                key: it.id, tab: 'live', gicon: it.icon, label: `${it.title} · ${it.subtitle}`, short: it.app || it.title,
                lead: it.kind === 'ai' ? 'orb' : 'ring', progress: it.progress,
            });
        }
        const f = this._ctx.focus;
        if (f && f.phase !== 'off') {
            out.push({
                key: 'focus', tab: 'today', gicon: themedIcon('alarm-symbolic'),
                label: `${f.phase === 'break' ? 'Break' : 'Focus'} · ${fmtClock(f.remaining)}${f.paused ? ' · paused' : ' left'}`,
                short: f.phase === 'break' ? 'Break' : 'Focus', lead: 'ring', progress: Math.max(0.001, 1 - f.fraction),
            });
        }
        const m = this._settings.get_boolean('meetings') ? this._ctx.meetings?.next(15) : null;
        if (m) {
            const mins = Math.round((m.start - Date.now()) / 60000);
            out.push({
                key: `meeting:${m.id}`, tab: 'today', gicon: themedIcon('x-office-calendar-symbolic'),
                label: mins > 0 ? `${m.title} · in ${mins} min` : `${m.title} · now`, short: 'Meeting', lead: 'icon',
            });
        }
        const unread = this._ctx.notifs.unreadCount;
        if (unread > 0) {
            const latest = this._ctx.notifs.items.find(n => n.unread);
            out.push({
                key: 'inbox', tab: 'inbox', gicon: latest?.gicon ?? themedIcon('preferences-system-notifications-symbolic'),
                label: latest ? `${latest.title}${latest.body ? ` · ${latest.body}` : ''}` : `${unread} new`,
                short: `${unread} new`, lead: 'icon',
            });
        }
        return out;
    }

    _updateIdle() {
        const acts = this.activities;
        if (this._actIndex >= acts.length)
            this._actIndex = 0;
        const cur = acts[this._actIndex];
        const unread = this._ctx.notifs.unreadCount;
        if (cur) {
            this._setLead(cur.lead, cur);
            this._idleLabel.text = cur.label;
        } else {
            const trends = this._ctx.trending.enabled ? this._ctx.trending.items : [];
            if (trends.length) {
                const t = trends[Math.floor(GLib.get_real_time() / 9e6) % trends.length];
                this._setLead('trend', {key: 'trend'});
                this._idleLabel.text = t.title;
                this._ensureTicker(true);
            } else {
                this._setLead('face', {key: 'face'});
                this._idleLabel.text = 'All caught up';
            }
        }
        if (cur || !this._ctx.trending.items.length)
            this._ensureTicker(false);
        this._badge.visible = unread > 0 && cur?.key !== 'inbox';
        this._badge.text = unread > 9 ? '9+' : String(unread);
        // bars
        const p = this._ctx.media.current;
        const playing = !!p?.playing;
        this._bars.visible = playing;
        this._ctx.setLevelsWanted(playing && this._mode === 'idle' && this._shown && this._settings.get_boolean('audio-bars') && animationsEnabled());
        if (!playing)
            this._setBars([0, 0, 0, 0]);
        else if (!animationsEnabled())
            this._setBars([0.45, 0.8, 0.6, 0.35]);
        this._fakeBarsOn(playing && (!this._ctx.levels.available || !this._settings.get_boolean('audio-bars')) &&
            animationsEnabled() && this._mode === 'idle' && this._shown);
        // privacy
        const pv = this._ctx.privacy;
        const showPriv = this._settings.get_boolean('show-privacy');
        this._privDots.mic.visible = showPriv && pv.mic;
        this._privDots.camera.visible = showPriv && pv.camera;
        this._privDots.screen.visible = showPriv && pv.screen;
        this._privBox.visible = showPriv && pv.any;
        // dots
        this._dots.visible = acts.length > 1;
        const dotsKey = `${this._actIndex}|${acts.slice(0, 6).map(a => a.key).join(',')}`;
        if (dotsKey !== this._dotsKey) {
            this._dotsKey = dotsKey;
            this._dotsBox.destroy_all_children();
            this._buildDots(acts);
        }
        // next bubble
        const next = acts.length > 1 ? acts[(this._actIndex + 1) % acts.length] : null;
        this._bubbleNext = next;
        if (next) {
            this._bubbleIcon.gicon = next.gicon;
            this._bubbleLabel.text = next.short;
        }
    }

    _buildDots(acts) {
        acts.slice(0, 6).forEach((a, i) => {
            const on = i === this._actIndex;
            const d = new St.Widget({style_class: on ? 'tp-dot tp-dot-on' : 'tp-dot', layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER});
            if (on)
                d.add_child(icon(a.gicon, 10, 'tp-dot-icon'));
            this._dotsBox.add_child(d);
        });
    }

    // Bars keep a fixed size and are scaled, so level updates only repaint.
    _setBars(vals) {
        const h = Math.round(16 * this._U);
        this._barActors.forEach((b, i) => {
            if (b.height !== h)
                b.height = h;
            b.remove_transition('scale-y');
            b.scale_y = (3 + clamp(vals[i] ?? 0, 0, 1) * 13) / 16;
        });
    }

    // Decorative bars when the real level meter isn't available.
    _fakeBarsOn(on) {
        if (on === !!this._fakeBarsRunning)
            return;
        this._fakeBarsRunning = on;
        this._barActors.forEach((b, i) => {
            b.remove_transition('scale-y');
            if (!on)
                return;
            b.height = Math.round(16 * this._U);
            b.scale_y = 0.3;
            b.ease({scale_y: 0.75 + 0.2 * (i % 2), duration: 380 + i * 110, mode: M.EASE_IN_OUT_SINE, repeatCount: -1, autoReverse: true});
        });
    }

    onLevels(vals) {
        if (this._bars.visible)
            this._setBars(vals);
    }

    _ensureTicker(on) {
        if (on && !this._ticker) {
            this._ticker = timeout(9000, () => {
                if (this._mode === 'idle')
                    this._updateIdle();
                return true;
            });
        } else if (!on) {
            this._ticker = clearSource(this._ticker);
        }
    }

    cycle(dir) {
        const n = this.activities.length;
        if (n < 2)
            return;
        this._actIndex = (this._actIndex + dir + n) % n;
        this._idleLabel.opacity = 0;
        this._updateIdle();
        this._idleLabel.ease({opacity: 255, duration: 220, mode: M.EASE_OUT_QUAD});
        this._relayout(true);
    }

    /* ---------------- peek ---------------- */
    _buildPeek() {
        const box = hbox('tp-peek', {y_align: Clutter.ActorAlign.CENTER});
        const iconWrap = new St.Widget({layout_manager: new Clutter.BinLayout(), style_class: 'tp-peek-iconwrap', y_align: Clutter.ActorAlign.CENTER});
        this._ping = new St.Widget({style_class: 'tp-ping', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._peekIcon = new St.Bin({x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        iconWrap.add_child(this._ping);
        iconWrap.add_child(this._peekIcon);
        const text = vbox('tp-peek-text', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const top = hbox('tp-peek-top');
        this._peekTitle = label('', 'tp-peek-title tp-fg');
        this._peekApp = label('', 'tp-peek-app tp-muted');
        top.add_child(this._peekTitle);
        top.add_child(this._peekApp);
        this._peekBody = label('', 'tp-peek-body tp-muted');
        text.add_child(top);
        text.add_child(this._peekBody);
        this._peekCount = label('', 'tp-badge');
        box.add_child(iconWrap);
        box.add_child(text);
        box.add_child(this._peekCount);
        return box;
    }

    peek(desc, burst = 1) {
        if (this._mode === 'expanded' || this._mode === 'ask')
            return;
        this._peekDesc = desc;
        const ic = icon(desc.gicon, 30, 'tp-peek-icon');
        this._peekIcon.set_child(ic);
        this._peekTitle.text = desc.title;
        this._peekApp.text = desc.app && desc.app !== desc.title ? desc.app : '';
        this._peekBody.text = desc.body || '';
        this._peekBody.visible = !!desc.body;
        this._peekCount.text = `+${burst - 1}`;
        this._peekCount.visible = burst > 1;
        const wasTucked = this._tucked;
        this._setMode('peek');
        if (wasTucked)
            this._drop();
        if (animationsEnabled()) {
            // wiggle + ping
            ic.set_pivot_point(0.5, 0.5);
            const seq = [-12, 10, -6, 3, 0];
            let i = 0;
            const step = () => {
                if (i >= seq.length || !ic.get_stage())
                    return;
                ic.ease({rotation_angle_z: seq[i++], duration: 90, mode: M.EASE_IN_OUT_SINE, onComplete: step});
            };
            this._wiggle = clearSource(this._wiggle);
            this._wiggle = timeout(260, () => {
                this._wiggle = 0;
                step();
                return false;
            });
            this._ping.set_pivot_point(0.5, 0.5);
            this._ping.remove_all_transitions();
            this._ping.opacity = 200;
            this._ping.scale_x = this._ping.scale_y = 1;
            this._ping.ease({scale_x: 1.9, scale_y: 1.9, opacity: 0, duration: 900, delay: 200, mode: M.EASE_OUT_QUAD});
        }
        this._peekTimer = clearSource(this._peekTimer);
        this._peekTimer = timeout(this._settings.get_int('peek-duration') || 4800, () => {
            this._peekTimer = 0;
            if (this._mode === 'peek' && !this._body.hover)
                this._setMode('idle');
            else if (this._mode === 'peek')
                this._peekLinger = true;
        });
    }

    /* ---------------- charge ---------------- */
    _buildCharge() {
        const box = hbox('tp-charge', {y_align: Clutter.ActorAlign.CENTER});
        this._chargeIcon = icon('battery-level-80-charging-symbolic', 18, 'tp-charge-icon');
        this._chargeLabel = label('', 'tp-charge-label tp-fg', {x_expand: true});
        const track = new St.Widget({style_class: 'tp-charge-track', y_align: Clutter.ActorAlign.CENTER, layout_manager: new Clutter.BinLayout()});
        this._chargeFill = new St.Widget({style_class: 'tp-charge-fill', x_align: Clutter.ActorAlign.START, y_expand: true});
        track.add_child(this._chargeFill);
        box.add_child(this._chargeIcon);
        box.add_child(this._chargeLabel);
        box.add_child(track);
        this._chargeTrack = track;
        return box;
    }

    showCharge(pct) {
        if (this._mode !== 'idle')
            return;
        const lvl = Math.min(100, Math.round(pct / 10) * 10);
        this._chargeIcon.gicon = themedIcon(lvl >= 100 ? 'battery-full-charged-symbolic' : `battery-level-${lvl}-charging-symbolic`);
        this._chargeLabel.text = `Charging · ${pct}%`;
        this._chargePct = pct;
        this._setMode('charge');
        this._chargeTimer = clearSource(this._chargeTimer);
        this._chargeTimer = timeout(2600, () => {
            this._chargeTimer = 0;
            if (this._mode === 'charge')
                this._setMode('idle');
        });
    }

    /* ---------------- expanded ---------------- */
    _buildExpanded() {
        const box = vbox('tp-exp');
        this._tabsBox = hbox('tp-tabs');
        this._tabButtons = {};
        const tabs = [['inbox', 'Inbox', 'mail-unread-symbolic'], ['media', 'Media', 'audio-x-generic-symbolic'],
            ['live', 'Live', 'emblem-synchronizing-symbolic'], ['today', 'Today', 'x-office-calendar-symbolic'],
            ['clip', 'Clipboard', 'edit-paste-symbolic'], ['trend', 'Trending', 'starred-symbolic']];
        const strip = hbox('tp-tabstrip', {x_expand: true});
        for (const [key, name, ic] of tabs) {
            const inner = hbox('tp-tab-inner');
            inner.add_child(icon(ic, 14, 'tp-tab-icon'));
            const nameLabel = label(name, 'tp-tab-label');
            inner.add_child(nameLabel);
            const count = label('', 'tp-tab-count');
            inner.add_child(count);
            const b = button(inner, 'tp-tab', () => this.showTab(key), {accessible_name: name, toggle_mode: false});
            b._count = count;
            b._label = nameLabel;
            this._tabButtons[key] = b;
            strip.add_child(b);
        }
        this._tabsBox.add_child(strip);
        this._tabsBox.add_child(button(icon('go-up-symbolic', 14), 'tp-icon-button', () => this.collapse(), {accessible_name: 'Collapse'}));
        box.add_child(this._tabsBox);
        this._views = new St.Widget({layout_manager: new Clutter.BinLayout(), style_class: 'tp-views', x_expand: true});
        box.add_child(this._views);
        return box;
    }

    get _availableTabs() {
        const t = ['inbox'];
        if (this._ctx.media.players.length)
            t.push('media');
        t.push('live', 'today');
        if (this._settings.get_boolean('clipboard-history'))
            t.push('clip');
        if (this._ctx.trending.enabled)
            t.push('trend');
        return t;
    }

    expand(tab = null) {
        if (!tab) {
            const cur = this.activities[this._actIndex];
            tab = this._mode === 'peek' ? 'inbox' : (cur?.tab ?? 'inbox');
        }
        if (this._mode !== 'expanded') {
            this._setMode('expanded');
            if (!this._grabHelper.grabbed) {
                // While open, all input is routed to this container. It must
                // accept input, or clicks outside and Esc would go nowhere and
                // the pointer would seem frozen. (It ignores input otherwise
                // so it never blocks the windows around the pill.)
                this.reactive = true;
                this._lastInput = GLib.get_monotonic_time();
                this._inputId ??= this.connect('captured-event', (_a, ev) => {
                    this._lastInput = GLib.get_monotonic_time();
                    // Close on the *press* outside the pill. Waiting for a full
                    // click is unreliable: if the release goes astray the pill
                    // stays open, holding all input.
                    const type = ev.type();
                    if (this._mode === 'expanded' &&
                        (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN)) {
                        const target = global.stage.get_event_actor(ev);
                        if (!target || !this._body.contains(target)) {
                            this.collapse();
                            return Clutter.EVENT_STOP;
                        }
                    }
                    return Clutter.EVENT_PROPAGATE;
                });
                // Safety net: if the open pill hears nothing for 20 s, input is
                // probably not reaching it, so close it and give input back.
                this._watchdog = clearSource(this._watchdog);
                this._watchdog = timeout(2000, () => {
                    if (this._mode !== 'expanded') {
                        this._watchdog = 0;
                        return false;
                    }
                    if (GLib.get_monotonic_time() - this._lastInput > 20e6) {
                        console.log('Top Pill: no input reached the open pill for 20 s; closing it');
                        this._watchdog = 0;
                        this.collapse();
                        return false;
                    }
                    return true;
                });
                console.log(`Top Pill: opened, taking input (modal count before: ${Main.modalCount})`);
                // GNOME releases the input grab only after this callback
                // returns, so it must never throw.
                this._grabHelper.grab({
                    actor: this._body, focus: this._body,
                    onUngrab: () => {
                        try {
                            this.collapse(true);
                        } catch (e) {
                            report(e, 'collapse');
                        }
                    },
                });
            }
        }
        this.showTab(tab);
    }

    collapse(fromGrab = false) {
        // Releasing input comes first and nothing after it may throw: an error
        // here once left the pointer captured until log-out.
        if (!fromGrab && this._grabHelper.grabbed) {
            try {
                this._grabHelper.ungrab({actor: this._body});
            } catch (e) {
                report(e, 'ungrab');
            }
        }
        if (this._mode !== 'expanded')
            return;
        try {
            this._ctx.media.setWatching(false);
            this._ctx.stats?.setWatching(false);
            this._animate(this._waveTick, false);
            this._animate(this._buddyTick, false);
            this._animate(this._indetTick, false);
            this._setMode('idle');
            this._setTint(null);
            this._ctx.notifs.dropSeenTransient?.();
        } catch (e) {
            report(e, 'collapse');
            this._mode = 'idle';
            this.reactive = false;
        }
    }

    toggle() {
        if (this._mode === 'expanded')
            this.collapse();
        else
            this.expand();
    }

    showTab(tab) {
        if (!this._availableTabs.includes(tab))
            tab = 'inbox';
        const changed = tab !== this._tab || !this._views.get_n_children();
        this._tab = tab;
        if (tab === 'inbox')
            this._ctx.notifs.acknowledgeAll();
        for (const [k, b] of Object.entries(this._tabButtons)) {
            b.visible = this._availableTabs.includes(k);
            if (k === tab)
                b.add_style_pseudo_class('checked');
            else
                b.remove_style_pseudo_class('checked');
        }
        this._renderView(changed);
        this._relayout(true);
    }

    _updateTabCounts() {
        const counts = {
            inbox: this._ctx.notifs.items.length,
            media: this._ctx.media.players.length > 1 ? this._ctx.media.players.length : 0,
            live: this._ctx.live.items.length,
            today: 0,
            clip: 0,
            trend: 0,
        };
        for (const [k, b] of Object.entries(this._tabButtons)) {
            b._count.text = counts[k] ? String(counts[k]) : '';
            b._count.visible = !!counts[k];
            b.visible = this._availableTabs.includes(k);
            // compact strip: only the open tab shows its name
            b._label.visible = k === this._tab;
        }
    }

    _renderView(fresh) {
        this._updateTabCounts();
        this._animate(this._waveTick, false);
        this._animate(this._buddyTick, false);
        this._animate(this._indetTick, false);
        this._ctx.media.setWatching(this._tab === 'media');
        if (this._tab !== 'media')
            this._setTint(null);
        if (this._tab !== 'live')
            this._liveRows = null;
        if (this._tab !== 'media')
            this._mediaView = null;
        if (this._tab !== 'today')
            this._todayView = null;
        this._ctx.stats?.setWatching(this._tab === 'live' && this._settings.get_boolean('show-stats'));
        if (this._tab === 'today')
            this._ctx.usage?.wanted();
        const keepScroll = this._scroll && !fresh ? this._scroll.vadjustment.value : 0;
        if (fresh || this._tab === 'inbox' || this._tab === 'trend' || this._tab === 'clip' ||
            (this._tab === 'media' && !this._mediaView) || (this._tab === 'live' && !this._liveRows) ||
            (this._tab === 'today' && !this._todayView)) {
            this._views.destroy_all_children();
            this._scroll = null;
            this._buddy = null;
            this._wave = null;
            const view = {
                inbox: () => this._inboxView(), media: () => this._buildMediaView(), live: () => this._buildLiveView(),
                today: () => this._buildTodayView(), clip: () => this._clipView(), trend: () => this._trendView(),
            }[this._tab]();
            view.x_expand = true;
            view.x_align = Clutter.ActorAlign.FILL;
            this._views.add_child(view);
            if (fresh && animationsEnabled()) {
                view.opacity = 0;
                view.translation_y = 6 * this._U;
                view.ease({opacity: 255, translation_y: 0, duration: 220, mode: M.EASE_OUT_QUAD});
            }
        }
        if (this._tab === 'media')
            this._updateMediaView();
        if (this._tab === 'live')
            this._updateLiveView();
        if (this._tab === 'today')
            this._updateTodayView();
        if (this._scroll && keepScroll)
            this._scroll.vadjustment.value = keepScroll;
    }

    _chips(cats, current, colors, onPick, extra = null) {
        const row = hbox('tp-chips');
        for (const c of ['All', ...cats]) {
            const inner = hbox('tp-chip-inner');
            if (colors?.[c])
                inner.add_child(new St.Widget({style_class: 'tp-chip-dot', style: `background-color: ${colors[c]};`, y_align: Clutter.ActorAlign.CENTER}));
            inner.add_child(label(c, 'tp-chip-label'));
            const b = button(inner, c === current ? 'tp-chip tp-chip-on' : 'tp-chip', () => onPick(c), {accessible_name: `Show ${c}`});
            row.add_child(b);
        }
        row.add_child(new St.Widget({x_expand: true}));
        if (extra)
            row.add_child(extra);
        return row;
    }

    _scrollList(rows, rowH, maxRows) {
        const list = vbox('tp-list');
        rows.forEach(r => list.add_child(r));
        const overflow = rows.length > maxRows;
        const sv = new St.ScrollView({
            style_class: overflow ? 'tp-scroll vfade' : 'tp-scroll',
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: overflow ? St.PolicyType.AUTOMATIC : St.PolicyType.NEVER,
            overlay_scrollbars: true, child: list,
        });
        if (overflow) {
            // Show exactly maxRows rows, measured, plus a peek of the next one.
            const fit = () => {
                let h = 0;
                rows.slice(0, maxRows).forEach(r => {
                    h += r.get_preferred_height(list.width || 400 * this._U)[1];
                });
                h += Math.round(rowH * 0.45 * this._U);
                if (Math.abs(sv.height - h) > 1) {
                    sv.height = h;
                    this._relayout(true);
                }
            };
            sv.height = Math.round((maxRows + 0.45) * rowH * this._U);
            sv.connect('notify::mapped', () => sv.mapped && fit());
        }
        this._scroll = sv;
        return sv;
    }

    /* inbox */
    _inboxView() {
        const all = this._ctx.notifs.items;
        const view = vbox('tp-view');
        if (!all.length) {
            view.add_child(this._buddyView());
            this._viewH = 196;
            return view;
        }
        const present = INBOX_CATS.filter(c => all.some(n => n.category === c));
        if (this._inboxCat !== 'All' && !present.includes(this._inboxCat))
            this._inboxCat = 'All';
        const shown = this._inboxCat === 'All' ? all : all.filter(n => n.category === this._inboxCat);
        const clearLabel = this._inboxCat === 'All' ? 'Clear all' : `Clear ${this._inboxCat}`;
        const clear = button(label(clearLabel, 'tp-clear-label'), 'tp-clear', () => {
            this._ctx.notifs.clear(this._inboxCat === 'All' ? null : shown.map(n => n.id));
        }, {accessible_name: clearLabel});
        view.add_child(this._chips(present.length > 1 ? present : [], this._inboxCat, null, c => {
            this._inboxCat = c;
            this._renderView(false);
            this._relayout(true);
        }, clear));
        const rows = shown.map(n => this._notifRow(n));
        const expanded = shown.some(n => n.id === this._selectedNotif);
        view.add_child(this._scrollList(rows, 58, expanded ? 3 : 4));
        const extraRows = expanded ? 1.6 : 0;
        this._viewH = 38 + Math.min(shown.length, expanded ? 3 : 4) * 58 + (expanded && shown.length < 3 ? extraRows * 58 * 0 : 0);
        return view;
    }

    _notifRow(n) {
        const sel = this._selectedNotif === n.id;
        const row = vbox(sel ? 'tp-row tp-row-open' : 'tp-row');
        const top = hbox('tp-row-top', {x_expand: true, x_align: Clutter.ActorAlign.FILL});
        top.add_child(icon(n.gicon, 28, 'tp-row-icon'));
        const text = vbox('tp-row-text', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const line1 = hbox('tp-row-line');
        line1.add_child(label(n.title, `tp-row-title tp-fg${n.unread ? ' tp-unread' : ''}`, {x_expand: true}));
        line1.add_child(label(fmtAgo(n.datetime), 'tp-row-time tp-muted'));
        text.add_child(line1);
        const body = label(n.body || n.app, 'tp-row-body tp-muted');
        if (sel) {
            body.clutter_text.line_wrap = true;
            body.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        }
        text.add_child(body);
        top.add_child(text);
        top.add_child(button(icon('object-select-symbolic', 14), 'tp-icon-button tp-row-dismiss',
            () => this._ctx.notifs.dismiss(n.id), {accessible_name: 'Dismiss', y_align: Clutter.ActorAlign.CENTER}));
        const click = button(top, 'tp-row-button', () => {
            this._selectedNotif = sel ? null : n.id;
            this._renderView(false);
            this._relayout(true);
        }, {x_expand: true});
        row.add_child(click);
        if (sel) {
            const acts = hbox('tp-row-actions');
            for (const a of n.actions.slice(0, 2)) {
                acts.add_child(button(label(a.label, 'tp-action-label'), 'tp-action', () => {
                    a.run();
                    this.collapse();
                }));
            }
            acts.add_child(button(label(n.app ? `Open ${n.app}` : 'Open', 'tp-action-label'), 'tp-action tp-action-primary', () => {
                this.collapse();
                this._ctx.notifs.activate(n.id);
            }));
            row.add_child(acts);
        }
        return row;
    }

    _buddyView() {
        const wrap = vbox('tp-buddy-wrap');
        const head = hbox('tp-buddy-head');
        const t = vbox('', {x_expand: true});
        t.add_child(label('All caught up', 'tp-buddy-title tp-fg'));
        t.add_child(label('Nudge, drag or tickle your buddy', 'tp-buddy-hint tp-muted'));
        head.add_child(t);
        wrap.add_child(head);
        this._buddy = new Buddy({x_expand: true, height: Math.round(132 * this._U)}, this);
        this._buddy.color = this._accent;
        this._buddy.textColor = this._fg ?? [1, 1, 1];
        this._buddyTick = dt => this._buddy?.step(dt);
        wrap.add_child(this._buddy);
        this._buddy.connect('notify::mapped', () => {
            if (this._buddy)
                this._animate(this._buddyTick, this._buddy.mapped);
        });
        return wrap;
    }

    /* media */
    _buildMediaView() {
        const v = this._mediaView = {};
        const root = vbox('tp-view tp-media');
        v.chips = hbox('tp-players');
        root.add_child(v.chips);
        const main = hbox('tp-media-main');
        v.art = new St.Button({style_class: 'tp-art', can_focus: true, accessible_name: 'Open player'});
        v.art.connect('clicked', () => {
            this._ctx.media.current?.raise();
            this.collapse();
        });
        main.add_child(v.art);
        const info = vbox('tp-media-info', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        v.title = label('', 'tp-media-title tp-fg');
        v.artist = label('', 'tp-media-artist tp-muted');
        const src = hbox('tp-media-src');
        v.srcIcon = icon(null, 14, 'tp-media-src-icon');
        v.srcLabel = label('', 'tp-media-src-label tp-muted');
        src.add_child(v.srcIcon);
        src.add_child(v.srcLabel);
        info.add_child(v.title);
        info.add_child(v.artist);
        info.add_child(src);
        main.add_child(info);
        root.add_child(main);
        v.lyrics = vbox('tp-lyrics');
        v.lyric1 = label('', 'tp-lyric tp-fg');
        v.lyric2 = label('', 'tp-lyric-next tp-muted');
        v.lyrics.add_child(v.lyric1);
        v.lyrics.add_child(v.lyric2);
        v.lyrics.visible = false;
        root.add_child(v.lyrics);
        this._wave = v.wave = new WaveProgress({x_expand: true, height: Math.round(18 * this._U), style_class: 'tp-wave'});
        v.wave.color = this._fg ?? [1, 1, 1];
        v.wave.trackColor = [...(this._fg ?? [1, 1, 1]), 0.22];
        v.wave.onSeek = f => this._ctx.media.current?.seekFraction(f);
        root.add_child(v.wave);
        const times = hbox('tp-times');
        v.elapsed = label('', 'tp-time tp-muted', {x_expand: true});
        v.total = label('', 'tp-time tp-muted');
        times.add_child(v.elapsed);
        times.add_child(v.total);
        root.add_child(times);
        const ctl = hbox('tp-controls');
        v.prev = button(icon('media-skip-backward-symbolic', 18), 'tp-ctl', () => this._ctx.media.current?.previous(), {accessible_name: 'Previous'});
        v.play = button(icon('media-playback-start-symbolic', 22), 'tp-ctl tp-ctl-main', () => this._ctx.media.current?.playPause(), {accessible_name: 'Play or pause'});
        v.next = button(icon('media-skip-forward-symbolic', 18), 'tp-ctl', () => this._ctx.media.current?.next(), {accessible_name: 'Next'});
        const outInner = hbox('tp-out-inner');
        outInner.add_child(icon('audio-volume-high-symbolic', 14));
        v.outLabel = label('', 'tp-out-label');
        v.outLabel.visible = false;
        outInner.add_child(v.outLabel);
        v.out = button(outInner, 'tp-out', () => {
            this.collapse();
            Main.panel.statusArea.quickSettings?.menu?.open(true);
        }, {accessible_name: 'Sound output', track_hover: true});
        v.out.connect('notify::hover', () => {
            const sink = Volume.getMixerControl().get_default_sink();
            v.outLabel.text = sink?.get_description() ?? 'Sound output';
            v.outLabel.visible = v.out.hover;
        });
        ctl.add_child(new St.Widget({x_expand: true}));
        for (const b of [v.prev, v.play, v.next])
            ctl.add_child(b);
        const right = new St.Widget({x_expand: true, layout_manager: new Clutter.BinLayout()});
        v.out.x_align = Clutter.ActorAlign.END;
        right.add_child(v.out);
        ctl.add_child(right);
        root.add_child(ctl);
        this._waveTick = dt => {
            const p = this._ctx.media.current;
            if (!p || !this._wave)
                return;
            this._wave.phase = (this._wave.phase + dt * 1.2) % 1;
            this._wave.fraction = p.length ? p.currentPosition / p.length : 0;
            this._wave.queue_repaint();
            const sec = Math.floor(p.currentPosition / 1e6);
            if (sec !== this._lastSec) {
                this._lastSec = sec;
                v.elapsed.text = fmtTime(p.currentPosition);
            }
            this._syncLyrics(p);
        };
        this._viewH = 206;
        return root;
    }

    _updateMediaView() {
        const v = this._mediaView;
        const p = this._ctx.media.current;
        if (!v || !p)
            return;
        const players = this._ctx.media.players;
        v.chips.visible = players.length > 1;
        const chipsKey = `${p.id}|${players.map(pl => `${pl.id}:${pl.identity}`).join(',')}`;
        if (chipsKey !== v.chipsKey) {
            v.chipsKey = chipsKey;
            v.chips.destroy_all_children();
        }
        for (const pl of v.chips.get_n_children() ? [] : players) {
            const inner = hbox('tp-chip-inner');
            inner.add_child(icon(pl.gicon ?? 'audio-x-generic-symbolic', 14));
            inner.add_child(label(pl.identity, 'tp-chip-label'));
            v.chips.add_child(button(inner, pl === p ? 'tp-chip tp-chip-on' : 'tp-chip', () => this._ctx.media.select(pl.id), {accessible_name: pl.identity}));
        }
        const U = this._U;
        const [aw, ah] = p.isVideo ? [128, 72] : [84, 84];
        const artKey = `${p.id}|${p.artPath}|${p.isVideo}`;
        if (artKey !== v.artKey) {
            v.artKey = artKey;
            v.art.set_size(Math.round(aw * U), Math.round(ah * U));
            v.art.style = p.artPath ? `background-image: url("file://${p.artPath}"); background-size: cover;` : null;
            v.art.set_child(p.artPath ? null : icon(p.gicon ?? 'audio-x-generic-symbolic', 32, 'tp-art-fallback'));
        }
        v.title.text = p.title;
        v.artist.text = p.artists.join(', ') || p.album || '';
        v.artist.visible = !!v.artist.text;
        v.srcIcon.gicon = p.gicon ?? themedIcon('audio-x-generic-symbolic');
        v.srcLabel.text = p.identity;
        v.total.text = p.length ? fmtTime(p.length) : '';
        v.elapsed.text = fmtTime(p.currentPosition);
        v.wave.visible = p.length > 0;
        v.wave.playing = p.playing;
        v.wave.fraction = p.length ? p.currentPosition / p.length : 0;
        v.wave.reactive = p.canSeek;
        v.wave.queue_repaint();
        v.play.child.icon_name = p.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        v.prev.reactive = p.canPrev;
        v.prev.opacity = p.canPrev ? 255 : 90;
        v.next.reactive = p.canNext;
        v.next.opacity = p.canNext ? 255 : 90;
        // adaptive tint from the artwork
        this._setTint(p.tint && this._settings.get_boolean('adaptive-tint') ? p.tint : null);
        this._animate(this._waveTick, p.playing && animationsEnabled());
        this._ctx.lyrics?.load(p);
        this._syncLyrics(p);
        this._viewH = (players.length > 1 ? 40 : 0) + 64 + Math.max(84, p.isVideo ? 72 : 84) + 56;
    }

    /* live */
    _buildLiveView() {
        const root = vbox('tp-view tp-live');
        root.add_child(this._buildStats());
        this._liveList = vbox('tp-list');
        this._liveRows = new Map();
        const sv = new St.ScrollView({
            style_class: 'tp-scroll', hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true, child: this._liveList,
        });
        this._scroll = sv;
        this._liveScroll = sv;
        root.add_child(sv);
        this._liveEmpty = label('No tasks running right now', 'tp-empty tp-muted');
        root.add_child(this._liveEmpty);
        this._privPanel = vbox('tp-priv-panel');
        root.add_child(this._privPanel);
        this._indetTick = dt => {
            for (const r of this._liveRows?.values() ?? []) {
                if (r.indet) {
                    r.phase = (r.phase + dt * 0.7) % 1;
                    r.track._layout.set(0.32, r.phase * 1.32 - 0.32);
                }
            }
        };
        return root;
    }

    _updateLiveView() {
        if (!this._liveRows)
            return;
        const items = this._ctx.live.items;
        const ids = new Set(items.map(i => i.id));
        for (const [id, r] of this._liveRows) {
            if (!ids.has(id)) {
                r.row.destroy();
                this._liveRows.delete(id);
            }
        }
        for (const it of items) {
            let r = this._liveRows.get(it.id);
            if (!r) {
                r = {phase: Math.random()};
                r.row = hbox('tp-row tp-live-row');
                const ic = it.kind === 'ai' ? new St.Bin({child: icon(it.icon, 26, 'tp-row-icon'), style_class: 'tp-ai-icon'}) : icon(it.icon, 22, 'tp-row-icon tp-sys-icon');
                r.row.add_child(ic);
                const text = vbox('tp-row-text', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
                r.title = label('', 'tp-row-title tp-fg');
                r.sub = label('', 'tp-row-body tp-muted');
                r.track = progressBar('', {x_expand: false});
                r.fill = r.track._fill;
                text.add_child(r.title);
                text.add_child(r.sub);
                text.add_child(r.track);
                r.row.add_child(text);
                r.btn = button(icon('window-close-symbolic', 14), 'tp-icon-button', () => r.cancel?.(), {accessible_name: 'Cancel', y_align: Clutter.ActorAlign.CENTER});
                r.open = button(icon('folder-open-symbolic', 14), 'tp-icon-button', () => {
                    r.openFn?.();
                    this.collapse();
                }, {accessible_name: 'Open folder', y_align: Clutter.ActorAlign.CENTER});
                r.row.add_child(r.open);
                r.row.add_child(r.btn);
                this._liveRows.set(it.id, r);
                this._liveList.add_child(r.row);
            }
            r.title.text = it.title;
            r.sub.text = it.subtitle;
            r.cancel = it.cancel;
            r.openFn = it.open;
            r.btn.visible = !!it.cancel;
            r.open.visible = !!it.open;
            r.track.visible = it.progress !== undefined;
            r.indet = it.progress === null;
            r.fraction = it.progress ?? 0;
            this._sizeFill(r);
        }
        const n = items.length;
        this._liveScroll.visible = n > 0;
        this._liveScroll.height = n > 4 ? Math.round(4.45 * 60 * this._U) : -1;
        this._liveScroll.vscrollbar_policy = n > 4 ? St.PolicyType.AUTOMATIC : St.PolicyType.NEVER;
        this._liveScroll.style_class = n > 4 ? 'tp-scroll vfade' : 'tp-scroll';
        this._liveEmpty.visible = n === 0;
        // privacy panel
        this._privPanel.destroy_all_children();
        const pv = this._ctx.privacy;
        const rows = [];
        if (pv.mic)
            rows.push(['mic', 'audio-input-microphone-symbolic', pv.micApps.length ? `Microphone · ${pv.micApps.join(', ')}` : 'Microphone in use']);
        if (pv.camera)
            rows.push(['camera', 'camera-web-symbolic', 'Camera in use']);
        if (pv.screen)
            rows.push(['screen', 'screen-shared-symbolic', 'Screen is being shared']);
        this._privPanel.visible = rows.length > 0 && this._settings.get_boolean('show-privacy');
        for (const [k, ic, text] of rows) {
            const r = hbox('tp-priv-row');
            r.add_child(new St.Widget({style_class: 'tp-priv-dot tp-priv-dot-big', style: `background-color: ${PRIV_COLORS[k]};`, y_align: Clutter.ActorAlign.CENTER}));
            r.add_child(icon(ic, 14, 'tp-priv-icon'));
            r.add_child(label(text, 'tp-priv-label tp-fg', {x_expand: true}));
            this._privPanel.add_child(r);
        }
        this._animate(this._indetTick, items.some(i => i.progress === null) && animationsEnabled());
        this._viewH = (n ? Math.min(n, 4) * 60 : 52) + (this._privPanel.visible ? rows.length * 30 + 14 : 0) + 6;
    }

    _sizeFill(r) {
        if (!r.indet)
            r.track._layout.set(r.fraction, 0);
        else if (!animationsEnabled())
            r.track._layout.set(0.3, 0.35); // static "busy" segment when animations are off
    }

    /* trending */
    _trendView() {
        const view = vbox('tp-view');
        const all = this._ctx.trending.items;
        const colors = TREND_COLORS[this._light ? 'light' : 'dark'];
        const refresh = button(icon('view-refresh-symbolic', 14), 'tp-icon-button', () => this._ctx.trending.refresh(), {accessible_name: 'Refresh'});
        view.add_child(this._chips(TREND_CATS, this._trendCat, colors, c => {
            this._trendCat = c;
            this._renderView(false);
            this._relayout(true);
        }, refresh));
        const shown = this._trendCat === 'All' ? all : all.filter(t => t.cat === this._trendCat);
        if (!shown.length) {
            const msg = label(all.length ? 'Nothing in this category yet' : this._ctx.trending.message, 'tp-empty tp-muted');
            msg.clutter_text.line_wrap = true;
            msg.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            view.add_child(msg);
            this._viewH = 38 + 52;
            return view;
        }
        const rows = shown.map((t, i) => {
            const row = hbox('tp-trend-row', {x_expand: true, x_align: Clutter.ActorAlign.FILL});
            row.add_child(label(String(i + 1), 'tp-trend-rank'));
            const text = vbox('', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            text.add_child(label(t.title, 'tp-row-title tp-fg'));
            const meta = hbox('tp-trend-meta');
            meta.add_child(new St.Widget({style_class: 'tp-chip-dot', style: `background-color: ${colors[t.cat]};`, y_align: Clutter.ActorAlign.CENTER}));
            meta.add_child(label(`${t.cat} · ${t.source}${t.by ? ` · ${t.by}` : ''}`, 'tp-row-body tp-muted'));
            text.add_child(meta);
            row.add_child(text);
            row.add_child(icon('go-next-symbolic', 14, 'tp-faint'));
            return button(row, 'tp-row-button', () => {
                this.collapse();
                openUri(t.url);
            }, {x_expand: true, accessible_name: t.title});
        });
        view.add_child(this._scrollList(rows, 52, 4));
        this._viewH = 38 + Math.min(shown.length, 4) * 52;
        return view;
    }


    /* lyrics */
    _syncLyrics(p) {
        const v = this._mediaView;
        const L = this._ctx.lyrics;
        if (!v || !L)
            return;
        const show = this._settings.get_boolean('lyrics') && L.state === 'synced' && !p.isVideo;
        if (v.lyrics.visible !== show) {
            v.lyrics.visible = show;
            this._relayout(true);
        }
        if (!show)
            return;
        const [cur, next] = L.at(p.currentPosition);
        const a = cur || '♪', b = next ?? '';
        if (v.lyric1.text !== a) {
            v.lyric1.text = a;
            v.lyric2.text = b;
            if (animationsEnabled()) {
                v.lyric1.opacity = 0;
                v.lyric1.translation_y = 6 * this._U;
                v.lyric1.ease({opacity: 255, translation_y: 0, duration: 260, mode: M.EASE_OUT_QUAD});
            }
        }
    }

    /* today: next meetings, focus timer, AI plan usage */
    _buildTodayView() {
        const T = this._todayView = {};
        const sv = new St.ScrollView({
            style_class: 'tp-scroll', hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        const root = vbox('tp-view tp-today');
        sv.set_child(root);
        this._scroll = sv;
        T.scroll = sv;
        T.meetings = vbox('tp-card');
        T.focus = vbox('tp-card');
        T.usage = vbox('tp-card');
        root.add_child(T.meetings);
        root.add_child(T.focus);
        root.add_child(T.usage);
        // focus card (built once, updated in place)
        const fRow = hbox('tp-focus-row');
        T.ring = new Ring({width: Math.round(40 * this._U), height: Math.round(40 * this._U), y_align: Clutter.ActorAlign.CENTER});
        T.ring.color = this._accent;
        fRow.add_child(T.ring);
        const fText = vbox('', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        T.fTitle = label('Focus', 'tp-card-title tp-fg');
        T.fSub = label('', 'tp-row-body tp-muted');
        fText.add_child(T.fTitle);
        fText.add_child(T.fSub);
        fRow.add_child(fText);
        T.fStart = button(label('Start', 'tp-action-label'), 'tp-action tp-action-primary', () => this._ctx.focus.start('focus'), {y_align: Clutter.ActorAlign.CENTER});
        T.fPause = button(icon('media-playback-pause-symbolic', 14), 'tp-icon-button', () => this._ctx.focus.togglePause(), {accessible_name: 'Pause or resume', y_align: Clutter.ActorAlign.CENTER});
        T.fStop = button(icon('media-playback-stop-symbolic', 14), 'tp-icon-button', () => this._ctx.focus.stop(), {accessible_name: 'Stop', y_align: Clutter.ActorAlign.CENTER});
        for (const b of [T.fStart, T.fPause, T.fStop])
            fRow.add_child(b);
        T.focus.add_child(fRow);
        return sv;
    }

    _updateTodayView() {
        const T = this._todayView;
        if (!T)
            return;
        const U = this._U;
        // meetings
        const ms = this._settings.get_boolean('meetings') ? (this._ctx.meetings?.events ?? []) : [];
        const mKey = JSON.stringify(ms.slice(0, 3).map(m => [m.id, m.title, +m.start, m.link]));
        if (mKey !== T.mKey) {
            T.mKey = mKey;
            T.meetings.destroy_all_children();
            T.meetings.add_child(label('Next up', 'tp-card-heading tp-muted'));
            if (!ms.length)
                T.meetings.add_child(label(this._settings.get_boolean('meetings') ? 'Nothing on your calendar in the next day' : 'Calendar is off in settings', 'tp-row-body tp-muted'));
            for (const m of ms.slice(0, 3)) {
                const row = hbox('tp-meet-row');
                const txt = vbox('', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
                txt.add_child(label(m.title, 'tp-row-title tp-fg'));
                txt.add_child(label(meetingWhen(m), 'tp-row-body tp-muted'));
                row.add_child(txt);
                if (m.link) {
                    row.add_child(button(label('Join', 'tp-action-label'), 'tp-action tp-action-primary', () => {
                        this.collapse();
                        openUri(m.link);
                    }, {y_align: Clutter.ActorAlign.CENTER, accessible_name: `Join ${m.title}`}));
                }
                T.meetings.add_child(row);
            }
        }
        // focus
        const f = this._ctx.focus;
        const on = f.phase !== 'off';
        T.fTitle.text = !on ? 'Focus timer' : f.phase === 'break' ? 'Break' : 'Focusing';
        T.fSub.text = !on ? `${this._settings.get_int('focus-minutes')} min focus, ${this._settings.get_int('focus-break-minutes')} min break`
            : `${fmtClock(f.remaining)} ${f.paused ? 'paused' : 'left'}${f.rounds ? ` · ${f.rounds} done today` : ''}`;
        T.ring.fraction = on ? Math.max(0.001, 1 - f.fraction) : 1;
        T.ring.queue_repaint();
        T.fStart.visible = !on;
        T.fPause.visible = on;
        T.fStop.visible = on;
        T.fPause.child.icon_name = f.paused ? 'media-playback-start-symbolic' : 'media-playback-pause-symbolic';
        // AI usage
        const ps = this._settings.get_boolean('ai-usage') ? (this._ctx.usage?.providers ?? []) : [];
        const uKey = JSON.stringify(ps.map(p => [p.id, p.windows.map(w => [w.label, Math.round(w.percent), w.resetsAt])]));
        if (uKey !== T.uKey) {
            T.uKey = uKey;
            T.usage.destroy_all_children();
            T.usage.visible = ps.length > 0;
            T.usage.add_child(label('AI plan usage', 'tp-card-heading tp-muted'));
            for (const p of ps) {
                for (const w of p.windows) {
                    const row = vbox('tp-usage-row');
                    const top = hbox('');
                    top.add_child(label(`${p.name} · ${w.label}`, 'tp-row-title tp-fg', {x_expand: true}));
                    top.add_child(label(`${Math.round(w.percent)}%`, `tp-usage-pct${w.percent >= 90 ? ' tp-hot' : w.percent >= 75 ? ' tp-warm' : ''}`));
                    row.add_child(top);
                    const track = progressBar(w.percent >= 90 ? 'tp-hot-bg' : w.percent >= 75 ? 'tp-warm-bg' : '');
                    track._layout.set(w.percent / 100);
                    row.add_child(track);
                    if (w.resetsAt)
                        row.add_child(label(`Resets ${fmtReset(w.resetsAt)}${p.note ? ` · ${p.note}` : ''}`, 'tp-row-body tp-muted'));
                    T.usage.add_child(row);
                }
            }
        }
        const [, nat] = T.scroll.get_child().get_preferred_height(Math.round(416 * U));
        const sh = Math.round(Math.min(nat, 330 * U));
        T.scroll.vscrollbar_policy = nat > 330 * U ? St.PolicyType.AUTOMATIC : St.PolicyType.NEVER;
        if (sh !== T.scroll.height) {
            T.scroll.height = sh;
            // content arrived after opening (calendar, usage): grow to fit
            if (this._mode === 'expanded')
                this._relayout(true);
        }
    }

    /* clipboard history */
    _clipView() {
        const view = vbox('tp-view');
        const items = this._ctx.clip?.items ?? [];
        const clear = button(label('Clear', 'tp-clear-label'), 'tp-clear', () => this._ctx.clip.clear(), {accessible_name: 'Clear clipboard history'});
        const head = hbox('tp-chips');
        head.add_child(label(items.length ? 'Click to copy again' : '', 'tp-row-body tp-muted', {x_expand: true}));
        if (items.length)
            head.add_child(clear);
        view.add_child(head);
        if (!items.length) {
            view.add_child(label('Nothing copied yet. Text you copy shows up here (kept until you log out; password managers are skipped).', 'tp-empty tp-muted'));
            view.get_last_child().clutter_text.line_wrap = true;
            view.get_last_child().clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            return view;
        }
        const rows = items.map(it => {
            const row = hbox('tp-clip-row', {x_expand: true, x_align: Clutter.ActorAlign.FILL});
            const txt = vbox('', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            const preview = it.text.replace(/\s+/g, ' ').trim();
            txt.add_child(label(preview, 'tp-row-title tp-fg tp-mono'));
            txt.add_child(label(`${fmtAgo(it.at)}${it.text.length > 80 ? ` · ${it.text.length} characters` : ''}`, 'tp-row-body tp-muted'));
            row.add_child(txt);
            row.add_child(button(icon('user-trash-symbolic', 14), 'tp-icon-button', () => this._ctx.clip.remove(it.text), {accessible_name: 'Remove', y_align: Clutter.ActorAlign.CENTER}));
            return button(row, 'tp-row-button', () => {
                this._ctx.clip.use(it.text);
                this.collapse();
                this.flash('Copied', 'edit-copy-symbolic');
            }, {x_expand: true, accessible_name: `Copy ${preview.slice(0, 40)}`});
        });
        view.add_child(this._scrollList(rows, 56, 4));
        return view;
    }

    // A short confirmation in the pill (reuses the charge layer).
    flash(text, iconName) {
        if (this._mode !== 'idle')
            return;
        this._chargeIcon.gicon = themedIcon(iconName);
        this._chargeLabel.text = text;
        this._chargeTrack.visible = false;
        this._setMode('charge');
        this._chargeTimer = clearSource(this._chargeTimer);
        this._chargeTimer = timeout(1400, () => {
            this._chargeTimer = 0;
            this._chargeTrack.visible = true;
            if (this._mode === 'charge')
                this._setMode('idle');
        });
    }

    /* system stats strip (top of Live) */
    _buildStats() {
        const strip = hbox('tp-stats');
        const S = this._statsUi = {};
        for (const [key, name] of [['cpu', 'CPU'], ['mem', 'Memory'], ['temp', 'Temp']]) {
            const col = vbox('tp-stat', {x_expand: true});
            const top = hbox('');
            top.add_child(label(name, 'tp-stat-name tp-muted', {x_expand: true}));
            const val = label('–', 'tp-stat-val tp-fg');
            top.add_child(val);
            col.add_child(top);
            const track = progressBar();
            col.add_child(track);
            strip.add_child(col);
            S[key] = {val, track, fill: track._fill};
        }
        strip.visible = this._settings.get_boolean('show-stats');
        return strip;
    }

    onStats() {
        const S = this._statsUi;
        const st = this._ctx.stats;
        if (!S || !st || !this._liveRows)
            return;
        const set = (k, frac, text, hot) => {
            S[k].val.text = text;
            S[k].track._layout.set(frac);
            S[k].fill.style_class = `tp-progress-fill${hot >= 2 ? ' tp-hot-bg' : hot ? ' tp-warm-bg' : ''}`;
        };
        set('cpu', st.cpu, `${Math.round(st.cpu * 100)}%`, st.cpu > 0.9 ? 2 : st.cpu > 0.7 ? 1 : 0);
        set('mem', st.mem, `${(st.memUsed / 1e9).toFixed(1)} / ${(st.memTotal / 1e9).toFixed(0)} GB`, st.mem > 0.9 ? 2 : st.mem > 0.8 ? 1 : 0);
        if (st.temp === null)
            set('temp', 0, 'n/a', 0);
        else
            set('temp', st.temp / 100, `${Math.round(st.temp)}°C`, st.temp > 90 ? 2 : st.temp > 80 ? 1 : 0);
    }

    /* agent approval card */
    _buildAsk() {
        const box = vbox('tp-ask');
        const head = hbox('tp-ask-head');
        this._askIcon = new St.Bin({style_class: 'tp-ai-icon', y_align: Clutter.ActorAlign.CENTER});
        head.add_child(this._askIcon);
        const ht = vbox('', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._askTitle = label('', 'tp-peek-title tp-fg');
        this._askSub = label('', 'tp-row-body tp-muted');
        ht.add_child(this._askTitle);
        ht.add_child(this._askSub);
        head.add_child(ht);
        this._askMore = label('', 'tp-badge');
        head.add_child(this._askMore);
        box.add_child(head);
        this._askCode = new St.Label({style_class: 'tp-ask-code', x_expand: true});
        this._askCode.clutter_text.line_wrap = true;
        this._askCode.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._askCode.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        box.add_child(this._askCode);
        const btns = hbox('tp-ask-buttons');
        btns.add_child(new St.Widget({x_expand: true}));
        this._askDeny = button(label('Deny', 'tp-action-label'), 'tp-action', () => this._answerAsk('deny'), {accessible_name: 'Deny'});
        this._askAlways = button(label('Always allow', 'tp-action-label'), 'tp-action', () => this._answerAsk('always'), {accessible_name: 'Always allow'});
        this._askAllow = button(label('Allow', 'tp-action-label'), 'tp-action tp-action-primary', () => this._answerAsk('allow'), {accessible_name: 'Allow once'});
        for (const b of [this._askDeny, this._askAlways, this._askAllow])
            btns.add_child(b);
        box.add_child(btns);
        return box;
    }

    // Show the first waiting permission request (or hide the card).
    updateAsk() {
        const q = this._ctx.approvals?.queue ?? [];
        const req = this._settings.get_boolean('approvals') ? q[0] : null;
        if (!req) {
            if (this._mode === 'ask')
                this._setMode('idle');
            return;
        }
        const name = req.ai === 'codex' ? 'Codex' : 'Claude Code';
        const iconFile = GLib.build_filenamev([this._ctx.iconDir, `${req.ai}.svg`]);
        this._askIcon.set_child(icon(Gio.FileIcon.new(Gio.File.new_for_path(iconFile)), 28));
        this._askTitle.text = `${name} wants to use ${req.tool}`;
        this._askSub.text = req.cwd ? GLib.path_get_basename(req.cwd) : 'Needs your permission';
        this._askCode.text = req.input || '(no details)';
        this._askAlways.visible = req.always;
        this._askMore.text = `+${q.length - 1}`;
        this._askMore.visible = q.length > 1;
        this._askId = req.id;
        if (this._mode !== 'ask') {
            const wasTucked = this._tucked;
            this._setMode('ask');
            if (wasTucked)
                this._drop();
        } else {
            this._relayout(true);
        }
    }

    _answerAsk(answer) {
        if (this._askId)
            this._ctx.approvals.answer(this._askId, answer);
    }

    updateFocus() {
        if (this._mode === 'idle' && this.activities[this._actIndex]?.key === 'focus') {
            const cur = this.activities[this._actIndex];
            this._idleLabel.text = cur.label;
            if (this._ring) {
                this._ring.fraction = cur.progress;
                this._ring.queue_repaint();
            }
        }
        if (this._mode === 'expanded' && this._tab === 'today')
            this._updateTodayView();
    }

    /* ---------------- data updates ---------------- */
    update() {
        if (!this._idle || !this.get_stage())
            return;
        if (this._mode === 'expanded') {
            if (!this._availableTabs.includes(this._tab))
                this._tab = 'inbox';
            this._renderView(false);
        }
        this._updateIdle();
        this._relayout(true);
    }

    updateMedia() {
        if (!this.get_stage())
            return;
        if (this._mode === 'expanded' && this._tab === 'media')
            this._updateMediaView();
        else if (this._mode === 'expanded')
            this._updateTabCounts();
        this._updateIdle();
        this._relayout(true);
    }

    updateLive() {
        if (!this.get_stage())
            return;
        if (this._mode === 'expanded' && this._tab === 'live')
            this._updateLiveView();
        else if (this._mode === 'expanded')
            this._updateTabCounts();
        this._updateIdle();
        this._relayout(true);
    }

    /* ---------------- modes & layout ---------------- */
    _setMode(mode) {
        if (mode === this._mode && mode !== 'peek')
            return;
        // Never leave the input grab behind when the pill stops being open.
        if (mode !== 'expanded' && this._grabHelper?.grabbed) {
            try {
                this._grabHelper.ungrab({actor: this._body});
            } catch (e) {
                report(e, 'ungrab');
            }
        }
        if (mode !== 'expanded') {
            if (this.reactive)
                console.log(`Top Pill: closed, input released (modal count now: ${Main.modalCount})`);
            this.reactive = false;
            this._watchdog = clearSource(this._watchdog);
        }
        const prev = this._mode;
        this._mode = mode;
        this._peekLinger = false;
        // Only the idle pill lives in the top bar; anything else floats at once.
        if (mode !== 'idle')
            this._tucked = false;
        if (mode !== 'peek')
            this._peekTimer = clearSource(this._peekTimer);
        const layers = {idle: this._idle, peek: this._peek, charge: this._charge, expanded: this._exp, ask: this._ask};
        const show = layers[mode];
        for (const [k, l] of Object.entries(layers)) {
            if (l === show)
                continue;
            if (l.visible && k === prev) {
                l.remove_all_transitions();
                l.ease({opacity: 0, duration: 120, mode: M.EASE_OUT_QUAD, onComplete: () => {
                    if (this._mode !== k)
                        l.visible = false;
                }});
            } else if (this._mode !== k) {
                l.visible = false;
            }
        }
        show.remove_all_transitions();
        show.visible = true;
        show.opacity = 0;
        show.ease({opacity: 255, duration: 220, delay: mode === 'expanded' ? 150 : 90, mode: M.EASE_OUT_QUAD});
        if (mode === 'idle')
            this._updateIdle();
        else if (this._leadKind)
            this._updateLead(this._leadKind, this._leadData); // stop idle decorations
        if (mode !== 'idle')
            this._fakeBarsOn(false);
        this._ctx.setLevelsWanted(mode === 'idle' && this._shown && !!this._ctx.media.current?.playing && this._settings.get_boolean('audio-bars'));
        this._queueTuck();
        this._relayout(true);
    }

    get mode() {
        return this._mode;
    }

    _targetSize() {
        const U = this._U;
        switch (this._mode) {
        case 'peek':
            return [384 * U, 54 * U, 27 * U];
        case 'ask': {
            this._ask.width = Math.round(440 * U);
            const [, nh] = this._ask.get_preferred_height(Math.round(440 * U));
            return [440 * U, Math.max(nh, 120 * U), 26 * U];
        }
        case 'charge':
            return [264 * U, 36 * U, 18 * U];
        case 'expanded': {
            let h = (46 + (this._viewH ?? 120) + 12) * U;
            try {
                this._exp.width = Math.round(440 * U);
                const [, nh] = this._exp.get_preferred_height(Math.round(440 * U));
                if (nh > 0)
                    h = nh;
            } catch {}
            return [440 * U, Math.min(h, 560 * U), 26 * U];
        }
        default: {
            this._idleLabel.width = -1;
            const tucked = this._tucked;
            const lw = Math.min(this._idleLabel.get_preferred_width(-1)[1], (tucked ? 180 : 220) * U);
            this._idleLabel.width = Math.max(lw, 60 * U);
            this._idle.width = -1;
            const [, nat] = this._idle.get_preferred_width(-1);
            // round up so small text changes (download sizes) do not make it twitch
            const step = 12 * U;
            const h = tucked ? this._tuckedHeight : 36 * U;
            return [clamp(Math.ceil(nat / step) * step, (tucked ? 120 : 180) * U, 440 * U), h, h / 2];
        }
        }
    }

    _monitor() {
        return Main.layoutManager.primaryMonitor;
    }

    _floatPos(w) {
        const mon = this._monitor();
        if (!mon)
            return [0, 0];
        const panelH = Main.panel.visible ? Main.panel.height : 0;
        return [Math.round(mon.x + (mon.width - w) / 2), Math.round(mon.y + panelH + 6 * this._U)];
    }

    // In the top bar the pill is as tall as the bar's content, with full-size
    // text, instead of being a shrunken copy of the floating pill.
    get _tuckedHeight() {
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        return Math.round(clamp(Main.panel.height - 6 * sf, 22 * sf, 30 * this._U));
    }

    get _stageW() {
        return Math.round(460 * this._U);
    }

    _relayout(animate) {
        if (this._closing || !this._monitor())
            return;
        if (this._tucked && this._mode === 'idle')
            this.add_style_class_name('tp-tucked');
        else
            this.remove_style_class_name('tp-tucked');
        const [w, h, r] = this._targetSize();
        this._radius = r;
        const U = this._U;
        const dur = animate && animationsEnabled() ? 380 : 0;
        // Only the incoming layer takes the new width; the outgoing one keeps
        // its size while it fades, so nothing reflows mid-morph.
        const active = {idle: this._idle, peek: this._peek, charge: this._charge, expanded: this._exp, ask: this._ask}[this._mode];
        active.width = Math.round(w);
        this._idle.height = Math.round(this._mode === 'idle' ? h : 36 * U);
        this._peek.height = Math.round(54 * U);
        this._charge.height = Math.round(36 * U);
        this._chargeTrack.set_size(Math.round(54 * U), Math.round(6 * U));
        this._chargeFill.width = Math.round(54 * U * clamp((this._chargePct ?? 0) / 100, 0, 1));
        // The body sits centred in a fixed-width stage; x, width and height
        // share one spring so it swells evenly from its centre.
        const stageW = this._stageW;
        const bx = Math.round((stageW - w) / 2);
        const bodyKey = `${bx},${Math.round(w)}x${Math.round(h)}`;
        if (bodyKey !== this._bodyKey || !animate) {
            this._bodyKey = bodyKey;
            for (const p of ['x', 'width', 'height'])
                this._body.remove_transition(p);
            this._body.ease({x: bx, width: Math.round(w), height: Math.round(h), duration: dur, mode: M.EASE_OUT_BACK});
        }
        // bubble
        const showBubble = this._mode === 'idle' && !this._tucked && !!this._bubbleNext && this._settings.get_boolean('show-next-bubble');
        const bw = Math.round(112 * U);
        if (showBubble) {
            this._bubble.set_size(bw, Math.round(28 * U));
            const bubX = Math.round(bx + w + 8 * U);
            if (!this._bubble.visible) {
                // appear in place: fade and pop, rather than sliding in
                this._bubble.remove_all_transitions();
                this._bubble.set_position(bubX, Math.round(4 * U));
                this._bubble.visible = true;
                this._bubble.opacity = 0;
                this._bubble.set_pivot_point(0, 0.5);
                this._bubble.scale_x = this._bubble.scale_y = 0.6;
                this._bubble.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: dur ? 320 : 0, delay: dur ? 120 : 0, mode: M.EASE_OUT_BACK});
            } else {
                this._bubble.ease({x: bubX, y: Math.round(4 * U), duration: dur, mode: M.EASE_OUT_BACK});
            }
        } else {
            this._bubble.visible = false;
        }
        const groupW = w + (showBubble ? 8 * U + bw : 0);
        this._groupW = groupW;
        const [, fy] = this._floatPos(w);
        const mon = this._monitor();
        let tx = Math.round(mon.x + (mon.width - stageW) / 2), ty = fy, scale = 1;
        if (this._tucked) {
            const t = this._tuckPos(groupW);
            if (t) {
                // place the root so the body lands on the tucked spot
                tx = Math.round(t[0] - bx * t[2]);
                ty = t[1];
                scale = t[2];
            }
        }
        this.set_size(Math.round(stageW + 8 * U + bw), Math.round(this._tucked ? h : Math.max(h, 36 * U)));
        this.set_pivot_point(0, 0);
        const posKey = `${Math.round(tx)},${Math.round(ty)},${scale}`;
        if (posKey !== this._posKey || !animate) {
            this._posKey = posKey;
            this.ease({x: tx, y: ty, scale_x: scale, scale_y: scale, duration: dur ? 420 : 0, mode: M.EASE_OUT_QUINT});
        }
        this._syncRadius();
    }

    _syncRadius() {
        const h = this._body.height;
        const r = Math.min(this._radius ?? 18, h / 2);
        // St px are scaled by the HiDPI factor, our sizes already are.
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._body.style = `border-radius: ${Math.round(r / sf)}px;${this._tintStyle ?? ''}`;
        this._syncShadow();
    }

    _syncShadow() {
        const b = this._body;
        const s = this._shadow;
        const pad = Math.round(22 * this._U);
        s.pad = pad;
        s.radius = Math.min(this._radius ?? 18, b.height / 2);
        s.offsetY = Math.round(5 * this._U);
        s.strength = this._light ? 0.22 : 0.4;
        s.set_position(b.x + b.translation_x - pad, b.y + b.translation_y - pad);
        const w = Math.max(1, Math.round(b.width + 2 * pad)), h = Math.max(1, Math.round(b.height + 2 * pad));
        if (s.width !== w || s.height !== h)
            s.set_size(w, h);
        else
            s.queue_repaint();
        s.set_pivot_point(0.5, 0.5);
        s.scale_x = s.scale_y = b.scale_x;
        s.opacity = b.opacity;
    }

    // Media tint: blend the artwork colour into the top of the pill.
    _setTint(tint) {
        let style = '';
        if (tint && this._mode === 'expanded' && this._tab === 'media') {
            const base = {dark: [28, 28, 32, 1], glass: [30, 30, 36, 0.975], light: [250, 250, 251, 0.98]}[this._themeName];
            const k = this._light ? 0.28 : 0.42;
            const mix = base.slice(0, 3).map((c, i) => Math.round(c * (1 - k) + tint[i] * 255 * k));
            style = ` background-gradient-direction: vertical; background-gradient-start: rgba(${mix.join(',')},${base[3]}); background-gradient-end: rgba(${base.join(',')});`;
        }
        if (style !== (this._tintStyle ?? '')) {
            this._tintStyle = style;
            this._syncRadius();
        }
    }

    /* ---------------- entrance ---------------- */
    appear() {
        this._relayout(false);
        const [w, h] = this._targetSize();
        if (!animationsEnabled()) {
            this.opacity = 255;
            return;
        }
        // Teardrop: a narrow drop falls in, squashes on landing, settles into the pill.
        const U = this._U;
        this.opacity = 255;
        this._idle.opacity = 0;
        this._body.remove_all_transitions();
        const sw = this._stageW;
        this._body.set_size(Math.round(18 * U), Math.round(26 * U));
        this._body.x = Math.round((sw - 18 * U) / 2);
        this._body.translation_y = Math.round(-30 * U);
        this._body.opacity = 0;
        this._body.ease({
            translation_y: 0, opacity: 255, duration: 340, mode: M.EASE_IN_QUAD,
            onComplete: () => {
                this._body.ease({width: Math.round(w * 0.5), height: Math.round(h * 0.78), x: Math.round((sw - w * 0.5) / 2),
                    duration: 160, mode: M.EASE_OUT_QUAD,
                    onComplete: () => {
                        this._body.ease({width: Math.round(w), height: Math.round(h), x: Math.round((sw - w) / 2), duration: 520, mode: M.EASE_OUT_BACK});
                        this._idle.ease({opacity: 255, duration: 260, delay: 220, mode: M.EASE_OUT_QUAD});
                    }});
            },
        });
    }

    _drop() {
        if (!animationsEnabled())
            return;
        this._body.translation_y = Math.round(-24 * this._U);
        this._body.ease({translation_y: 0, duration: 520, mode: M.EASE_OUT_BOUNCE});
    }

    /* ---------------- input ---------------- */
    _onBodyClick(ev) {
        for (let a = global.stage.get_event_actor(ev); a && a !== this._body; a = a.get_parent()) {
            if (a instanceof St.Button)
                return Clutter.EVENT_PROPAGATE;
        }
        return this.handleClick(ev.get_button()) ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    }

    // Click on the pill body (not on one of its buttons).
    handleClick(btn) {
        if (this._mode === 'ask')
            return false;
        if (btn === 3) {
            this.emit('request-prefs');
            return true;
        }
        if (btn !== 1)
            return false;
        if (this._mode === 'idle' || this._mode === 'charge') {
            this.expand();
            return true;
        }
        if (this._mode === 'peek') {
            if (this._peekDesc?.onClick) {
                this._peekDesc.onClick();
                if (this._mode === 'peek')
                    this._setMode('idle');
            } else {
                this._selectedNotif = this._peekDesc?.id ?? null;
                this.expand('inbox');
            }
            return true;
        }
        return false;
    }

    _onScroll(ev) {
        if (this._mode !== 'idle')
            return Clutter.EVENT_PROPAGATE;
        const dir = ev.get_scroll_direction();
        if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.LEFT)
            this.cycle(-1);
        else if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.RIGHT)
            this.cycle(1);
        return Clutter.EVENT_STOP;
    }

    _onHover() {
        if (this._mode === 'idle' && animationsEnabled()) {
            this._body.set_pivot_point(0.5, 0.5);
            this._body.ease({scale_x: this._body.hover ? 1.03 : 1, scale_y: this._body.hover ? 1.03 : 1, duration: 160, mode: M.EASE_OUT_QUAD});
        } else if (!this._body.hover) {
            this._body.ease({scale_x: 1, scale_y: 1, duration: 160});
        }
        if (!this._body.hover && this._mode === 'peek' && this._peekLinger)
            this._setMode('idle');
    }

    /* ---------------- tuck away ---------------- */
    _watchWindows() {
        this._winSignals = new Map();
        const watch = w => {
            if (this._winSignals.has(w))
                return;
            const ids = [
                w.connect('position-changed', () => this._queueTuck()),
                w.connect('size-changed', () => this._queueTuck()),
                w.connect('unmanaged', () => {
                    this._winSignals.delete(w);
                    this._queueTuck();
                }),
            ];
            this._winSignals.set(w, ids);
        };
        for (const a of global.get_window_actors())
            watch(a.meta_window);
        this._signals.connect(global.display, 'window-created', (_d, w) => {
            watch(w);
            this._queueTuck();
        });
        this._signals.connect(global.display, 'restacked', () => this._queueTuck());
        this._signals.connect(global.workspace_manager, 'active-workspace-changed', () => this._queueTuck());
        for (const s of ['minimize', 'unminimize', 'map', 'destroy', 'size-changed'])
            this._signals.connect(global.window_manager, s, () => this._queueTuck());
    }

    _queueTuck() {
        if (this._tuckIdle || this._closing)
            return;
        this._tuckIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._tuckIdle = 0;
            if (!this._closing)
                this._updateTuck();
            return GLib.SOURCE_REMOVE;
        });
    }

    _windowUnder() {
        const mon = this._monitor();
        if (!mon)
            return false;
        const U = this._U;
        const w = this._groupW ?? 260 * U;
        const [x, y] = this._floatPos(this._body.width || w);
        const rect = new Mtk.Rectangle({x: Math.round(x - 16 * U), y: Math.round(y), width: Math.round(w + 32 * U), height: Math.round(40 * U)});
        const ws = global.workspace_manager.get_active_workspace();
        return global.get_window_actors().some(a => {
            const mw = a.meta_window;
            if (!mw || mw.minimized || !mw.showing_on_its_workspace() || mw.skip_taskbar)
                return false;
            if (mw.get_monitor() !== Main.layoutManager.primaryIndex)
                return false;
            if (!mw.is_on_all_workspaces() && mw.get_workspace() !== ws)
                return false;
            if (![Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG].includes(mw.get_window_type()))
                return false;
            return mw.get_frame_rect().overlap(rect);
        });
    }

    _updateTuck() {
        // Stays in the top bar while a window is underneath, wherever the
        // pointer is: dropping down on hover covered browser tabs.
        const want = this._settings.get_boolean('tuck-away') && this._mode === 'idle' &&
            (Main.overview.visible || this._windowUnder());
        if (want !== this._tucked) {
            this._tucked = want;
            this._relayout(true);
        }
    }

    _tuckPos(groupW) {
        const mon = this._monitor();
        const panelH = Main.panel.height;
        const h = this._tuckedHeight;
        const y = Math.round(mon.y + (panelH - h) / 2);
        const gap = 10 * this._U;
        const dm = Main.panel.statusArea.dateMenu;
        let leftLimit = mon.x, rightLimit = mon.x + mon.width;
        const rightChildren = Main.panel._rightBox?.get_children().filter(c => c.visible && c.width > 0) ?? [];
        if (rightChildren.length)
            rightLimit = Math.min(...rightChildren.map(c => c.get_transformed_position()[0]));
        const leftChildren = Main.panel._leftBox?.get_children().filter(c => c.visible && c.width > 0) ?? [];
        if (leftChildren.length)
            leftLimit = Math.max(...leftChildren.map(c => c.get_transformed_position()[0] + c.get_transformed_size()[0]));
        if (dm?.container?.visible) {
            const [dx] = dm.container.get_transformed_position();
            const [dw] = dm.container.get_transformed_size();
            const after = dx + dw + gap;
            const roomRight = rightLimit - gap - after;
            const roomLeft = dx - gap - (leftLimit + gap);
            // full size if it fits, otherwise shrink a little (never below 85%)
            for (const [room, side] of [[roomRight, 'right'], [roomLeft, 'left']]) {
                const scale = Math.min(1, room / groupW);
                if (scale >= 0.85) {
                    const gw = groupW * scale;
                    const x = side === 'right' ? after : dx - gap - gw;
                    return [Math.round(x), Math.round(mon.y + (panelH - h * scale) / 2), scale];
                }
            }
        } else {
            return [Math.round(mon.x + (mon.width - groupW) / 2), y, 1];
        }
        return null; // no room in the bar: stay floating
    }

    get tucked() {
        return this._tucked;
    }

    destroy() {
        this._signals.disconnectAll();
        for (const m of this._menus ?? [])
            m.disconnectObject(this);
        for (const [w, ids] of this._winSignals ?? []) {
            for (const id of ids) {
                try {
                    w.disconnect(id);
                } catch {}
            }
        }
        this._winSignals?.clear();
        this._pointerWatch?.remove();
        this._pointerWatch = null;
        for (const id of ['_clock', '_peekTimer', '_chargeTimer', '_ticker', '_nearOff', '_tuckIdle', '_watchdog', '_blinkTimer', '_wiggle', '_orbRest'])
            this[id] = clearSource(this[id]);
        this._animators.clear();
        this._closing = true;
        try {
            if (this._grabHelper.grabbed)
                this._grabHelper.ungrab({actor: this._body});
        } catch (e) {
            report(e, 'ungrab on destroy');
        }
        super.destroy();
    }
});
