// Health and control over D-Bus, used by the `top-pill` command:
//   Status() -> JSON describing every part of Top Pill
//   Reload()  -> restart Top Pill in place
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

import {recentErrors, report} from './util.js';

const PATH = '/org/gnome/Shell/Extensions/TopPill';
const IFACE = `<node><interface name="org.gnome.Shell.Extensions.TopPill.Ops">
  <method name="Status"><arg type="s" name="json" direction="out"/></method>
  <method name="Reload"/>
</interface></node>`;

export class Ops {
    constructor(controller) {
        this._c = controller;
        this._started = Date.now();
        this._impl = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        try {
            this._impl.export(Gio.DBus.session, PATH);
        } catch (e) {
            report(e, 'could not export status');
        }
    }

    Status() {
        const c = this._c;
        const pill = c.pill;
        const s = {
            version: c.ext.metadata['version-name'] ?? String(c.ext.metadata.version ?? ''),
            build: c.build,
            gnomeShell: Config.PACKAGE_VERSION,
            uptimeSeconds: Math.round((Date.now() - this._started) / 1000),
            pill: {
                mode: pill?.mode, tucked: pill?.tucked, visible: pill?.visible, opacity: pill?.opacity,
                holdingInput: !!pill?._grabHelper?.grabbed, animating: pill?._animators?.size ?? 0,
            },
            shell: {modalCount: Main.modalCount, actionMode: Main.actionMode, locked: Main.sessionMode.isLocked},
            parts: c.health,
            data: {
                notifications: c.notifs.items?.length ?? 0,
                players: c.media.players?.length ?? 0,
                liveItems: c.live.items?.length ?? 0,
                trendingItems: c.trending.items?.length ?? 0,
                trendingState: c.trending.message || c.trending.state || '',
                meetings: c.meetings?.events?.length ?? null,
                clipboardItems: c.clip?.items?.length ?? null,
                pendingApprovals: c.approvals?.queue?.length ?? null,
                focus: c.focus ? `${c.focus.phase}${c.focus.paused ? ' (paused)' : ''}` : null,
                usageProviders: c.usage?.providers?.map(p => p.name) ?? null,
                lyrics: c.lyrics?.state ?? null,
            },
            recentErrors,
        };
        return JSON.stringify(s, null, 1);
    }

    Reload() {
        const uuid = this._c.ext.uuid;
        const em = Main.extensionManager;
        // GNOME applies enable/disable from a settings change. Asking to enable
        // before it has finished the disable pass gets silently dropped, so
        // wait until that pass is done (or 1 s if it can't be observed).
        let waited = 0;
        const pass = () => !Array.isArray(em._enabledExtensions) ? waited >= 1000 : !em._enabledExtensions.includes(uuid);
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            em.disableExtension(uuid);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                waited += 100;
                const state = em.lookup(uuid)?.state;
                if ((state === ExtensionState.INACTIVE && pass()) || waited >= 10000) {
                    em.enableExtension(uuid);
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        try {
            this._impl.unexport();
        } catch {}
        this._impl = null;
        this._c = null;
    }
}
