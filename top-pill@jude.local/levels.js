// Audio-reactive bars: reads the level of what is playing (the output
// "monitor", not the microphone) with GStreamer. The stream is tagged the way
// GNOME's own level meters are, so it does not light up the microphone
// indicator. Runs only while media is playing and the bars are on screen.
import {Emitter} from './util.js';

let Gst = null;
async function loadGst() {
    if (Gst !== null)
        return Gst;
    try {
        Gst = (await import('gi://Gst?version=1.0')).default;
        if (!Gst.is_initialized())
            Gst.init(null);
        if (!Gst.ElementFactory.find('pulsesrc') || !Gst.ElementFactory.find('level'))
            Gst = false;
    } catch {
        Gst = false;
    }
    return Gst;
}

export class AudioLevels extends Emitter {
    constructor() {
        super();
        this.values = [0, 0, 0, 0];
        this.available = null;
        this._pipeline = null;
    }

    async start() {
        this._want = true;
        if (this._pipeline || this._starting)
            return;
        if (this._failedAt && Date.now() - this._failedAt < 60000)
            return;
        this._starting = true;
        const G = await loadGst();
        this._starting = false;
        this.available = !!G;
        if (!G || !this._want || this._pipeline)
            return;
        try {
            // Built element by element so the stream tags are set exactly.
            const pipe = new G.Pipeline({name: 'top-pill-levels'});
            const src = G.ElementFactory.make('pulsesrc', null);
            src.set_property('device', '@DEFAULT_MONITOR@');
            src.set_property('client-name', 'Top Pill level meter');
            const props = G.Structure.from_string('props, application.id=(string)org.gnome.VolumeControl, ' +
                'media.name=(string)"Peak detect", media.role=(string)music');
            src.set_property('stream-properties', Array.isArray(props) ? props[0] : props);
            const caps = G.ElementFactory.make('capsfilter', null);
            caps.set_property('caps', G.Caps.from_string('audio/x-raw,rate=22050,channels=2'));
            const conv = G.ElementFactory.make('audioconvert', null);
            const level = G.ElementFactory.make('level', null);
            level.set_property('interval', 60000000);
            level.set_property('post-messages', true);
            const sink = G.ElementFactory.make('fakesink', null);
            sink.set_property('sync', false);
            for (const e of [src, conv, caps, level, sink])
                pipe.add(e);
            if (!src.link(conv) || !conv.link(caps) || !caps.link(level) || !level.link(sink))
                throw new Error('could not link level pipeline');
            this._pipeline = pipe;
            const bus = this._pipeline.get_bus();
            bus.add_signal_watch();
            this._busId = bus.connect('message::element', (_b, msg) => this._onMessage(msg));
            this._errId = bus.connect('message::error', (_b, msg) => {
                console.debug(`Top Pill: level meter stopped: ${msg.parse_error?.()[0]?.message ?? 'error'}`);
                // fall back to the gentle animation and retry later
                this._failedAt = Date.now();
                this.available = false;
                const want = this._want;
                this.stop();
                this._want = want;
                this.emit('levels', this.values);
            });
            this._pipeline.set_state(G.State.PLAYING);
        } catch (e) {
            console.debug(`Top Pill: level meter: ${e.message}`);
            this._pipeline = null;
            this.available = false;
        }
    }

    _onMessage(msg) {
        const s = msg.get_structure();
        if (!s || s.get_name() !== 'level')
            return;
        const read = key => {
            try {
                const v = s.get_value(key);
                const out = [];
                for (let i = 0; i < (v?.n_values ?? 0); i++)
                    out.push(Number(v.get_nth(i)));
                return out;
            } catch {
                return [];
            }
        };
        const rms = read('rms');
        const peak = read('peak');
        // dB (-60..0) to 0..1
        const n = db => Math.min(1, Math.max(0, (db + 50) / 50));
        const raw = [n(rms[0] ?? -60), n(peak[0] ?? -60), n(peak[1] ?? peak[0] ?? -60), n(rms[1] ?? rms[0] ?? -60)];
        this.values = this.values.map((v, i) => (raw[i] > v ? raw[i] : v * 0.72 + raw[i] * 0.28));
        this.emit('levels', this.values);
    }

    stop() {
        this._want = false;
        if (!this._pipeline)
            return;
        try {
            const bus = this._pipeline.get_bus();
            if (this._busId)
                bus.disconnect(this._busId);
            if (this._errId)
                bus.disconnect(this._errId);
            bus.remove_signal_watch();
            this._pipeline.set_state(Gst.State.NULL);
        } catch {}
        this._pipeline = null;
        this.values = [0, 0, 0, 0];
        this.emit('levels', this.values);
    }

    destroy() {
        this.stop();
        this.clearHandlers();
    }
}
