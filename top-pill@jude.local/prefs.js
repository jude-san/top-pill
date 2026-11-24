import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Kept in sync with trending.js (prefs cannot import shell modules).
const SOURCES = [
    ['hn', 'Tech', 'Hacker News'], ['google-tech', 'Tech', 'Google News · Technology'], ['lobsters', 'Tech', 'Lobsters'],
    ['devto-devops', 'DevOps', 'DEV · #devops'], ['devto-kubernetes', 'DevOps', 'DEV · #kubernetes'],
    ['lobsters-devops', 'DevOps', 'Lobsters · devops'], ['newstack', 'DevOps', 'The New Stack'],
    ['hf-models', 'AI', 'Hugging Face · trending models'], ['hf-papers', 'AI', 'Hugging Face · daily papers'], ['devto-ai', 'AI', 'DEV · #ai'],
    ['github', 'New tools', 'GitHub Trending'], ['showhn', 'New tools', 'Show HN'],
];

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, subtitle, lower, upper, step) {
    const row = new Adw.SpinRow({
        title, subtitle,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 10}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export default class TopPillPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(640, 760);

        /* General */
        const general = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});
        const look = new Adw.PreferencesGroup({title: 'Look', description: 'The pill follows your accent colour, text size, high contrast and the Animations setting in Accessibility.'});
        const themes = ['auto', 'dark', 'light', 'glass'];
        const themeRow = new Adw.ComboRow({
            title: 'Style', subtitle: 'Auto follows the system light or dark style',
            model: Gtk.StringList.new(['Auto', 'Dark', 'Light', 'Glass']),
        });
        themeRow.selected = Math.max(0, themes.indexOf(settings.get_string('theme')));
        themeRow.connect('notify::selected', () => settings.set_string('theme', themes[themeRow.selected]));
        look.add(themeRow);
        look.add(switchRow(settings, 'adaptive-tint', 'Tint media with artwork colour'));
        look.add(switchRow(settings, 'audio-bars', 'Bars react to what is playing', 'Reads the sound output level, not the microphone'));
        look.add(switchRow(settings, 'show-next-bubble', 'Next-activity bubble'));
        general.add(look);

        const place = new Adw.PreferencesGroup({title: 'Placement'});
        place.add(switchRow(settings, 'tuck-away', 'Tuck into the top bar', 'When a window is under the pill or in the overview. Move the pointer near to bring it back.'));
        const sc = new Adw.ActionRow({title: 'Keyboard shortcut', subtitle: 'Open or close the pill'});
        const entry = new Gtk.Entry({valign: Gtk.Align.CENTER, text: settings.get_strv('toggle-shortcut')[0] ?? '', width_chars: 16});
        entry.connect('changed', () => {
            const t = entry.get_text().trim();
            const [ok] = Gtk.accelerator_parse(t);
            if (ok || !t)
                settings.set_strv('toggle-shortcut', t ? [t] : []);
        });
        sc.add_suffix(entry);
        place.add(sc);
        general.add(place);

        const notif = new Adw.PreferencesGroup({title: 'Notifications', description: 'Notifications stay in GNOME, so Do Not Disturb and per-app settings in Settings › Notifications still apply.'});
        notif.add(switchRow(settings, 'replace-banners', 'Peek instead of GNOME banners', 'Urgent alerts still use the system banner'));
        notif.add(spinRow(settings, 'peek-delay', 'Peek delay', 'Milliseconds to wait so bursts arrive together', 0, 3000, 50));
        notif.add(spinRow(settings, 'peek-duration', 'Peek duration', 'Milliseconds a peek stays', 2000, 15000, 200));
        notif.add(switchRow(settings, 'peek-sound', 'Sound', 'Apps with sounds turned off stay silent'));
        general.add(notif);
        window.add(general);

        /* Activities */
        const act = new Adw.PreferencesPage({title: 'Activities', icon_name: 'emblem-synchronizing-symbolic'});
        const live = new Adw.PreferencesGroup({title: 'Live activities'});
        live.add(switchRow(settings, 'watch-ai', 'AI agents and local models', 'Claude Code, Codex CLI, Gemini CLI, Copilot CLI, Ollama and LM Studio'));
        live.add(switchRow(settings, 'ai-done-peek', 'Peek when an agent finishes'));
        live.add(switchRow(settings, 'download-peek', 'Peek when a download finishes'));
        live.add(switchRow(settings, 'show-charging', 'Charging peek'));
        live.add(switchRow(settings, 'show-privacy', 'Microphone, camera and screen sharing'));
        live.add(switchRow(settings, 'show-stats', 'CPU, memory and temperature', 'In the Live tab, read only while it is open'));
        live.add(switchRow(settings, 'bluetooth-peek', 'Bluetooth devices', 'Peek when headphones and other devices connect, with battery level'));
        live.add(switchRow(settings, 'lyrics', 'Synced lyrics', 'From LRCLIB, a free lyrics service; looked up once per song and cached'));
        act.add(live);
        const agents = new Adw.PreferencesGroup({
            title: 'Agent approvals',
            description: 'Claude Code and Codex can ask for permission in the pill (Allow, Always allow, Deny). ' +
                'To set it up, run in a terminal:\n  top-pill hooks enable\n' +
                'If the pill does not answer, the agent asks in its terminal as usual.',
        });
        agents.add(switchRow(settings, 'approvals', 'Show permission requests in the pill'));
        act.add(agents);
        window.add(act);

        /* Today */
        const today = new Adw.PreferencesPage({title: 'Today', icon_name: 'x-office-calendar-symbolic'});
        const cal = new Adw.PreferencesGroup({title: 'Calendar', description: 'Uses the calendars in GNOME Online Accounts and GNOME Calendar.'});
        cal.add(switchRow(settings, 'meetings', 'Upcoming events with Join', 'Join appears for Google Meet, Zoom, Teams and Webex links'));
        cal.add(spinRow(settings, 'meeting-reminder', 'Remind me', 'Minutes before an event (0 = no reminder)', 0, 60, 1));
        today.add(cal);
        const focus = new Adw.PreferencesGroup({title: 'Focus timer'});
        focus.add(spinRow(settings, 'focus-minutes', 'Focus length', 'Minutes', 5, 120, 5));
        focus.add(spinRow(settings, 'focus-break-minutes', 'Break length', 'Minutes', 1, 60, 1));
        today.add(focus);
        const ai = new Adw.PreferencesGroup({
            title: 'AI plan usage',
            description: 'Claude: read with Claude Code’s own sign-in and asked of Anthropic every 10 minutes. ' +
                'ChatGPT: read from Codex’s local logs, no network.',
        });
        ai.add(switchRow(settings, 'ai-usage', 'Show Claude and ChatGPT usage'));
        today.add(ai);
        const clip = new Adw.PreferencesGroup({title: 'Clipboard'});
        clip.add(switchRow(settings, 'clipboard-history', 'Clipboard history', 'Text only, kept in memory until you log out; password-manager copies are skipped'));
        today.add(clip);
        window.add(today);

        /* Trending */
        const tr = new Adw.PreferencesPage({title: 'Trending', icon_name: 'starred-symbolic'});
        const tg = new Adw.PreferencesGroup({title: 'Trending', description: 'Free public feeds, no account needed. Fetched rarely, and never on metered connections.'});
        tg.add(switchRow(settings, 'trending-enabled', 'Show trending headlines'));
        tg.add(spinRow(settings, 'trending-interval', 'Refresh every', 'Minutes', 10, 720, 5));
        tr.add(tg);
        const statusPath = GLib.build_filenamev([GLib.get_user_cache_dir(), 'top-pill', 'trending-status.json']);
        let status = {};
        try {
            const [, bytes] = GLib.file_get_contents(statusPath);
            status = JSON.parse(new TextDecoder().decode(bytes));
        } catch {}
        for (const cat of ['Tech', 'DevOps', 'AI', 'New tools']) {
            const g = new Adw.PreferencesGroup({title: cat});
            for (const [id, , name] of SOURCES.filter(s => s[1] === cat)) {
                const st = status[id];
                const subtitle = !st ? 'Not fetched yet' : st.ok ? `Working · ${st.count} items` : `Last fetch failed: ${st.error}`;
                const row = new Adw.SwitchRow({title: name, subtitle});
                row.active = settings.get_strv('trending-sources').includes(id);
                row.connect('notify::active', () => {
                    const set = new Set(settings.get_strv('trending-sources'));
                    if (row.active)
                        set.add(id);
                    else
                        set.delete(id);
                    settings.set_strv('trending-sources', [...set]);
                });
                g.add(row);
            }
            tr.add(g);
        }
        window.add(tr);
    }
}
