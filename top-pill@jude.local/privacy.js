// Microphone, camera and screen-sharing indicators, using the same signals
// GNOME's own top-bar privacy indicators use.
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

import {Emitter} from './util.js';

const SKIPPED_APPS = ['org.gnome.VolumeControl', 'org.PulseAudio.pavucontrol'];

export class PrivacyWatcher extends Emitter {
    constructor() {
        super();
        this.mic = false;
        this.micApps = [];
        this.camera = false;
        this.screen = false;
        this._handles = new Set();

        this._control = Volume.getMixerControl();
        this._control.connectObject(
            'stream-added', () => this._syncMic(),
            'stream-removed', () => this._syncMic(),
            'default-source-changed', () => this._syncMic(), this);
        this._syncMic();

        try {
            this._camera = new Shell.CameraMonitor();
            this._camera.connectObject('notify::cameras-in-use', () => this._syncCamera(), this);
            this._syncCamera();
        } catch (e) {
            console.debug(`Top Pill: camera monitor unavailable: ${e.message}`);
        }

        const controller = global.backend.get_remote_access_controller?.();
        controller?.connectObject('new-handle', (_c, handle) => this._track(handle), this);
        this._controller = controller;
        // Pick up a share that started before the extension was enabled.
        try {
            for (const h of Main.panel.statusArea.quickSettings?._remoteAccess?._handles ?? [])
                this._track(h);
        } catch {}
        this._syncScreen();
    }

    _track(handle) {
        if (!handle.is_recording || this._handles.has(handle))
            return;
        this._handles.add(handle);
        handle.connectObject('stopped', () => {
            this._handles.delete(handle);
            handle.disconnectObject(this);
            this._syncScreen();
        }, this);
        this._syncScreen();
    }

    _syncMic() {
        const outputs = this._control.get_source_outputs()
            .filter(o => !SKIPPED_APPS.includes(o.get_application_id()));
        const mic = !!this._control.get_default_source() && outputs.length > 0;
        this.micApps = [...new Set(outputs.map(o => o.get_name()).filter(Boolean))];
        this._set('mic', mic);
    }

    _syncCamera() {
        this._set('camera', !!this._camera?.cameras_in_use);
    }

    _syncScreen() {
        this._set('screen', this._handles.size > 0);
    }

    _set(key, value) {
        if (this[key] === value && key !== 'mic')
            return;
        this[key] = value;
        this.emit('changed');
    }

    get any() {
        return this.mic || this.camera || this.screen;
    }

    destroy() {
        this._control.disconnectObject(this);
        this._camera?.disconnectObject(this);
        this._controller?.disconnectObject(this);
        for (const h of this._handles)
            h.disconnectObject(this);
        this._handles.clear();
        this._camera = null;
        this.clearHandlers();
    }
}
