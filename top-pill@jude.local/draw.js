// Cairo-drawn pieces: wavy progress line, progress ring, AI orb and the
// blob buddy (the toy that lives in an empty inbox).
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Cairo from 'cairo';

import {clamp} from './util.js';

function rgba(cr, c, a = 1) {
    c ??= [1, 1, 1];
    cr.setSourceRGBA(c[0], c[1], c[2], (c[3] ?? 1) * a);
}

/* ---------- Soft shadow ---------- */
// St's own box-shadow turns hard-edged on large rounded widgets, so the pill
// draws its shadow here, only outside its rounded shape.
function roundRect(cr, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

export const Shadow = GObject.registerClass(
class TopPillShadow extends St.DrawingArea {
    _init(params) {
        super._init({reactive: false, ...params});
        this.pad = 24;
        this.radius = 18;
        this.offsetY = 5;
        this.strength = 0.32;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const p = this.pad;
        const bw = w - 2 * p, bh = h - 2 * p;
        if (bw > 0 && bh > 0) {
            // keep the area under the pill itself clear
            cr.setFillRule(Cairo.FillRule.EVEN_ODD);
            cr.rectangle(0, 0, w, h);
            roundRect(cr, p, p, bw, bh, this.radius);
            cr.clip();
            cr.setFillRule(Cairo.FillRule.WINDING);
            const steps = 12;
            for (let i = steps; i >= 1; i--) {
                const g = (i / steps) * (p - 2);
                const a = this.strength * Math.pow(1 - i / (steps + 1), 2.2) / 3.2;
                cr.setSourceRGBA(0, 0, 0, a);
                roundRect(cr, p - g, p - g + this.offsetY * (1 - i / (steps * 1.6)), bw + 2 * g, bh + 2 * g, this.radius + g);
                cr.fill();
            }
        }
        cr.$dispose();
    }
});

/* ---------- Wavy progress ---------- */
export const WaveProgress = GObject.registerClass(
class TopPillWave extends St.DrawingArea {
    _init(params) {
        super._init({reactive: true, track_hover: true, ...params});
        this.fraction = 0;
        this.playing = false;
        this.phase = 0;
        this.color = [1, 1, 1];
        this.trackColor = [1, 1, 1, 0.2];
        this.onSeek = null;
        this.connect('button-release-event', (_a, ev) => {
            const [x] = ev.get_coords();
            const [ok, lx] = this.transform_stage_point(x, 0);
            if (ok && this.onSeek)
                this.onSeek(clamp(lx / this.width, 0, 1));
            return Clutter.EVENT_STOP;
        });
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const s = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const mid = h / 2;
        const x = clamp(this.fraction, 0, 1) * w;
        const amp = this.playing ? 3 * s : 0;
        const len = 14 * s;
        cr.setLineCap(1); // ROUND
        cr.setLineWidth(3 * s);
        // played part: wave
        rgba(cr, this.color);
        cr.moveTo(0, mid);
        for (let px = 0; px <= x; px += 1)
            cr.lineTo(px, mid + Math.sin(((px + this.phase * len) / len) * Math.PI * 2) * amp * Math.min(1, px / (8 * s)));
        cr.stroke();
        // remaining part: flat
        rgba(cr, this.trackColor);
        cr.moveTo(Math.min(x + 4 * s, w), mid);
        cr.lineTo(w, mid);
        cr.stroke();
        // knob
        rgba(cr, this.color);
        cr.arc(x, mid, (this.hover ? 6 : 4.5) * s, 0, Math.PI * 2);
        cr.fill();
        cr.$dispose();
    }
});

/* ---------- Progress ring ---------- */
export const Ring = GObject.registerClass(
class TopPillRing extends St.DrawingArea {
    _init(params) {
        super._init(params);
        this.fraction = null; // null = spinning
        this.spin = 0;
        this.color = [1, 1, 1];
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const r = Math.min(w, h) / 2 - 2.5;
        cr.setLineWidth(Math.max(2, w / 9));
        cr.setLineCap(1);
        rgba(cr, this.color, 0.22);
        cr.arc(w / 2, h / 2, r, 0, Math.PI * 2);
        cr.stroke();
        rgba(cr, this.color);
        if (this.fraction === null) {
            const a = this.spin * Math.PI * 2;
            cr.arc(w / 2, h / 2, r, a, a + Math.PI * 0.6);
        } else {
            cr.arc(w / 2, h / 2, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(this.fraction, 0.001, 1));
        }
        cr.stroke();
        cr.$dispose();
    }
});

/* ---------- AI orb ---------- */
export const Orb = GObject.registerClass(
class TopPillOrb extends St.DrawingArea {
    _init(params) {
        super._init(params);
        this.t = 0;
        this.color = [0.6, 0.5, 1];
        this.active = true;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const pulse = this.active ? (Math.sin(this.t * 3) + 1) / 2 : 0.3;
        const r = Math.min(w, h) / 2;
        const g = new Cairo.RadialGradient(w / 2 - r * 0.3, h / 2 - r * 0.3, r * 0.1, w / 2, h / 2, r);
        g.addColorStopRGBA(0, 1, 1, 1, 0.95);
        g.addColorStopRGBA(0.45, this.color[0], this.color[1], this.color[2], 0.95);
        g.addColorStopRGBA(1, this.color[0] * 0.6, this.color[1] * 0.6, this.color[2] * 0.8, 0.9);
        cr.setSource(g);
        cr.arc(w / 2, h / 2, r * (0.72 + pulse * 0.12), 0, Math.PI * 2);
        cr.fill();
        rgba(cr, this.color, 0.25 * pulse);
        cr.arc(w / 2, h / 2, r * (0.9 + pulse * 0.1), 0, Math.PI * 2);
        cr.fill();
        cr.$dispose();
    }
});

/* ---------- Blob buddy ---------- */
function blobPath(cr, cx, cy, w, h) {
    // A soft rounded blob: flatter bottom, domed top.
    const k = 0.5523;
    const rx = w / 2, ryTop = h * 0.58, ryBot = h * 0.42;
    cr.moveTo(cx - rx, cy);
    cr.curveTo(cx - rx, cy - ryTop * k, cx - rx * k, cy - ryTop, cx, cy - ryTop);
    cr.curveTo(cx + rx * k, cy - ryTop, cx + rx, cy - ryTop * k, cx + rx, cy);
    cr.curveTo(cx + rx, cy + ryBot * k, cx + rx * k, cy + ryBot, cx, cy + ryBot);
    cr.curveTo(cx - rx * k, cy + ryBot, cx - rx, cy + ryBot * k, cx - rx, cy);
    cr.closePath();
}

function heart(cr, x, y, s) {
    cr.moveTo(x, y + s * 0.3);
    cr.curveTo(x, y, x - s * 0.5, y, x - s * 0.5, y + s * 0.3);
    cr.curveTo(x - s * 0.5, y + s * 0.6, x, y + s * 0.8, x, y + s);
    cr.curveTo(x, y + s * 0.8, x + s * 0.5, y + s * 0.6, x + s * 0.5, y + s * 0.3);
    cr.curveTo(x + s * 0.5, y, x, y, x, y + s * 0.3);
    cr.closePath();
}

export function drawFace(cr, cx, cy, size, {look = [0, 0], blink = 0, mood = 'calm', sleeping = false, color = [0.6, 0.5, 1], squash = 0, spin = 0, ink = [0.1, 0.1, 0.14]}) {
    const w = size * (1 + squash * 0.25);
    const h = size * 0.86 * (1 - squash * 0.25);
    cr.save();
    cr.translate(cx, cy);
    if (spin)
        cr.rotate(spin);
    cr.translate(-cx, -cy);
    blobPath(cr, cx, cy, w, h);
    rgba(cr, color);
    cr.fillPreserve();
    cr.setLineWidth(Math.max(1, size / 40));
    rgba(cr, [1, 1, 1], 0.18);
    cr.stroke();
    // shine
    rgba(cr, [1, 1, 1], 0.28);
    cr.save();
    cr.translate(cx - w * 0.2, cy - h * 0.3);
    cr.scale(w * 0.16, h * 0.09);
    cr.arc(0, 0, 1, 0, Math.PI * 2);
    cr.restore();
    cr.fill();
    const ex = w * 0.19, ey = cy - h * 0.06, er = size * 0.1;
    const lx = clamp(look[0], -1, 1) * er * 0.45, ly = clamp(look[1], -1, 1) * er * 0.35;
    for (const side of [-1, 1]) {
        const x = cx + side * ex;
        if (sleeping || blink > 0.85) {
            rgba(cr, ink);
            cr.setLineWidth(Math.max(1.2, size / 28));
            cr.arc(x, ey, er * 0.75, 0.15 * Math.PI, 0.85 * Math.PI);
            cr.stroke();
            continue;
        }
        cr.save();
        cr.translate(x, ey);
        cr.scale(1, 1 - blink);
        rgba(cr, [1, 1, 1]);
        cr.arc(0, 0, er, 0, Math.PI * 2);
        cr.fill();
        rgba(cr, ink);
        cr.arc(lx, ly, er * 0.55, 0, Math.PI * 2);
        cr.fill();
        rgba(cr, [1, 1, 1]);
        cr.arc(lx + er * 0.2, ly - er * 0.22, er * 0.17, 0, Math.PI * 2);
        cr.fill();
        cr.restore();
    }
    if (mood === 'happy' || mood === 'tickle') {
        rgba(cr, [1, 0.45, 0.6], 0.55);
        for (const side of [-1, 1]) {
            cr.arc(cx + side * w * 0.3, ey + er * 1.25, er * 0.55, 0, Math.PI * 2);
            cr.fill();
        }
    }
    rgba(cr, ink);
    cr.setLineWidth(Math.max(1.2, size / 28));
    const my = ey + er * 1.55;
    if (mood === 'tickle') {
        cr.arc(cx, my - er * 0.1, er * 0.55, 0, Math.PI);
        cr.fill();
    } else if (mood === 'happy') {
        cr.arc(cx, my - er * 0.2, er * 0.5, 0.1 * Math.PI, 0.9 * Math.PI);
        cr.stroke();
    } else if (sleeping) {
        cr.arc(cx, my, er * 0.18, 0, Math.PI * 2);
        cr.stroke();
    } else {
        cr.arc(cx, my - er * 0.35, er * 0.35, 0.2 * Math.PI, 0.8 * Math.PI);
        cr.stroke();
    }
    cr.restore();
}

export const MiniFace = GObject.registerClass(
class TopPillMiniFace extends St.DrawingArea {
    _init(params) {
        super._init(params);
        this.color = [0.6, 0.5, 1];
        this.blink = 0;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        drawFace(cr, w / 2, h / 2 + h * 0.06, Math.min(w, h) * 0.95, {color: this.color, blink: this.blink, mood: 'calm'});
        cr.$dispose();
    }
});

const GRAVITY = 1800; // px/s² (scaled)

export const Buddy = GObject.registerClass(
class TopPillBuddy extends St.DrawingArea {
    _init(params, eventRoot = null) {
        super._init({reactive: true, track_hover: true, ...params});
        // While dragging, motion and release are read from this ancestor's
        // captured events instead of taking an input grab (a grab that is
        // not released would freeze all input).
        this._eventRoot = eventRoot;
        this.color = [0.6, 0.5, 1];
        this.ink = [0.1, 0.1, 0.14];
        this.textColor = [1, 1, 1];
        this._s = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._size = 58 * this._s;
        this._pos = null;
        this._vel = [0, 0];
        this._look = [0, 0];
        this._lookTarget = [0, 0];
        this._squash = 0;
        this._spin = 0;
        this._spinVel = 0;
        this._blink = 0;
        this._nextBlink = 2;
        this._mood = 'calm';
        this._moodUntil = 0;
        this._hearts = [];
        this._lastInteract = 0;
        this._t = 0;
        this._clicks = [];
        this._drag = null;
        this.connect('motion-event', (_a, ev) => this._onMotion(ev));
        this.connect('button-press-event', (_a, ev) => this._onPress(ev));
        this.connect('button-release-event', (_a, ev) => this._onRelease(ev));
        this.connect('leave-event', () => {
            this._lookTarget = [0, 0];
        });
    }

    _local(ev) {
        const [x, y] = ev.get_coords();
        const [, lx, ly] = this.transform_stage_point(x, y);
        return [lx, ly];
    }

    get _floor() {
        return this.height - this._size * 0.42 - 10 * this._s;
    }

    _ensurePos() {
        if (!this._pos && this.width > 0)
            this._pos = [this.width / 2, this._floor];
    }

    _onMotion(ev) {
        this._ensurePos();
        const [x, y] = this._local(ev);
        this._wake();
        if (this._drag) {
            const nx = clamp(x - this._drag.dx, this._size / 2, this.width - this._size / 2);
            const ny = clamp(y - this._drag.dy, this._size * 0.5, this._floor);
            const now = GLib.get_monotonic_time() / 1e6;
            const dt = Math.max(now - this._drag.t, 0.008);
            this._vel = [(nx - this._pos[0]) / dt, (ny - this._pos[1]) / dt];
            this._drag.moved += Math.abs(nx - this._pos[0]) + Math.abs(ny - this._pos[1]);
            this._drag.t = now;
            this._pos = [nx, ny];
        }
        this._lookTarget = [(x - this._pos[0]) / (this._size * 1.2), (y - this._pos[1]) / (this._size * 1.2)];
        return Clutter.EVENT_PROPAGATE;
    }

    _onPress(ev) {
        this._ensurePos();
        const [x, y] = this._local(ev);
        this._wake();
        const d = Math.hypot(x - this._pos[0], y - this._pos[1]);
        if (d < this._size * 0.7) {
            if (this._drag)
                return Clutter.EVENT_STOP;
            this._drag = {dx: x - this._pos[0], dy: y - this._pos[1], moved: 0, t: GLib.get_monotonic_time() / 1e6};
            this._vel = [0, 0];
            this._watchDrag();
            this._mood = 'happy';
            this._moodUntil = this._t + 10;
        } else {
            // A nudge from the side: hop towards the pointer.
            this._vel = [clamp((x - this._pos[0]) * 3, -500, 500) * this._s, -380 * this._s];
            this._heart(2);
        }
        return Clutter.EVENT_STOP;
    }

    _watchDrag() {
        this._unwatchDrag();
        const root = this._eventRoot;
        if (!root)
            return;
        this._dragId = root.connect('captured-event', (_a, ev) => {
            const type = ev.type();
            if (type === Clutter.EventType.MOTION) {
                this._onMotion(ev);
            } else if (type === Clutter.EventType.BUTTON_RELEASE || type === Clutter.EventType.TOUCH_END ||
                       type === Clutter.EventType.TOUCH_CANCEL) {
                this._onRelease();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _unwatchDrag() {
        if (this._dragId) {
            this._eventRoot?.disconnect(this._dragId);
            this._dragId = 0;
        }
    }

    _onRelease() {
        this._unwatchDrag();
        if (!this._drag)
            return Clutter.EVENT_STOP;
        const moved = this._drag.moved;
        this._drag = null;
        if (moved < 6 * this._s) {
            const now = this._t;
            this._clicks = this._clicks.filter(t => now - t < 1.2);
            this._clicks.push(now);
            if (this._clicks.length >= 3) {
                this._clicks = [];
                this._mood = 'tickle';
                this._moodUntil = now + 1.6;
                this._spinVel = 14;
                this._vel = [0, -300 * this._s];
                this._heart(5);
            } else {
                this._mood = 'happy';
                this._moodUntil = now + 1.4;
                this._vel = [0, -520 * this._s];
                this._heart(2);
            }
        } else {
            this._mood = 'calm';
            // keep the throw velocity, but tame it
            this._vel = [clamp(this._vel[0], -900, 900), clamp(this._vel[1], -900, 900)];
        }
        return Clutter.EVENT_STOP;
    }

    _heart(n) {
        for (let i = 0; i < n; i++) {
            this._hearts.push({
                x: this._pos[0] + (Math.random() - 0.5) * this._size * 0.8,
                y: this._pos[1] - this._size * 0.4,
                vy: -(40 + Math.random() * 40) * this._s, life: 0, max: 1 + Math.random() * 0.6,
                size: (8 + Math.random() * 6) * this._s,
            });
        }
    }

    _wake() {
        this._lastInteract = this._t;
    }

    get sleeping() {
        return !this._drag && this._t - this._lastInteract > 9;
    }

    reset() {
        this._pos = null;
        this._vel = [0, 0];
        this._lastInteract = this._t;
        this._hearts = [];
    }

    step(dt) {
        this._t += dt;
        this._ensurePos();
        if (!this._pos)
            return;
        const floor = this._floor;
        if (!this._drag) {
            this._vel[1] += GRAVITY * this._s * dt;
            this._pos[0] += this._vel[0] * dt;
            this._pos[1] += this._vel[1] * dt;
            const minX = this._size / 2, maxX = this.width - this._size / 2;
            if (this._pos[0] < minX || this._pos[0] > maxX) {
                this._pos[0] = clamp(this._pos[0], minX, maxX);
                this._vel[0] *= -0.5;
            }
            if (this._pos[1] >= floor) {
                if (this._vel[1] > 250 * this._s)
                    this._squash = clamp(this._vel[1] / (1400 * this._s), 0.15, 0.6);
                this._pos[1] = floor;
                this._vel[1] = this._vel[1] > 250 * this._s ? -this._vel[1] * 0.35 : 0;
                this._vel[0] *= 0.82;
            }
        }
        this._squash *= Math.pow(0.0008, dt);
        this._spin += this._spinVel * dt;
        this._spinVel *= Math.pow(0.05, dt);
        if (Math.abs(this._spinVel) < 0.3) {
            this._spin *= Math.pow(0.001, dt);
            this._spinVel = 0;
        }
        const idleBob = this._pos[1] >= floor - 0.5 && !this._drag ? Math.sin(this._t * 2.4) * 0.04 : 0;
        this._bob = idleBob;
        this._look[0] += (this._lookTarget[0] - this._look[0]) * Math.min(1, dt * 10);
        this._look[1] += (this._lookTarget[1] - this._look[1]) * Math.min(1, dt * 10);
        this._nextBlink -= dt;
        if (this._nextBlink <= 0) {
            this._blink = 1;
            this._nextBlink = 2.5 + Math.random() * 3;
        }
        this._blink = Math.max(0, this._blink - dt * 7);
        if (this._t > this._moodUntil && this._mood !== 'calm' && !this._drag)
            this._mood = 'calm';
        for (const h of this._hearts) {
            h.life += dt;
            h.y += h.vy * dt;
            h.x += Math.sin(h.life * 6) * 0.4;
        }
        this._hearts = this._hearts.filter(h => h.life < h.max);
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w] = this.get_surface_size();
        this._ensurePos();
        if (!this._pos || !w) {
            cr.$dispose();
            return;
        }
        const [x, y] = this._pos;
        const floor = this._floor;
        // shadow
        const lift = clamp((floor - y) / (this._size * 2), 0, 1);
        rgba(cr, [0, 0, 0], 0.22 * (1 - lift * 0.7));
        cr.save();
        cr.translate(x, floor + this._size * 0.42);
        cr.scale(this._size * 0.42 * (1 - lift * 0.4), this._size * 0.08);
        cr.arc(0, 0, 1, 0, Math.PI * 2);
        cr.restore();
        cr.fill();
        const sleeping = this.sleeping;
        drawFace(cr, x, y - (this._bob ?? 0) * this._size, this._size, {
            look: this._look, blink: this._blink, mood: this._mood, sleeping, color: this.color,
            squash: this._squash - (this._vel[1] < -200 ? 0.12 : 0), spin: this._spin, ink: this.ink,
        });
        if (sleeping) {
            cr.selectFontFace('Sans', 0, 1);
            const t = this._t;
            for (let i = 0; i < 3; i++) {
                const p = ((t * 0.5) + i / 3) % 1;
                cr.setFontSize((9 + i * 3) * this._s);
                rgba(cr, this.textColor, 0.8 * (1 - p));
                cr.moveTo(x + this._size * (0.35 + p * 0.3), y - this._size * (0.45 + p * 0.5));
                cr.showText('z');
            }
        }
        for (const h of this._hearts) {
            rgba(cr, [1, 0.35, 0.55], 1 - h.life / h.max);
            heart(cr, h.x, h.y, h.size);
            cr.fill();
        }
        cr.$dispose();
    }

    vfunc_unmap() {
        this._unwatchDrag();
        this._drag = null;
        super.vfunc_unmap();
    }
});
