// Trending headlines from free, keyless public feeds, grouped by category.
// Fetches rarely, skips metered and offline networks, and caches results.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Emitter, timeout, clearSource, cacheDir, readTextFile} from './util.js';
import {httpGet} from './media.js';

const PER_SOURCE = 6;

function decodeEntities(s) {
    return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

export function parseFeed(xml) {
    const out = [];
    const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/g) ?? xml.match(/<entry[\s>][\s\S]*?<\/entry>/g) ?? [];
    for (const b of blocks) {
        const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/.exec(b)?.[1] ?? '');
        let link = /<link[^>]*href="([^"]+)"/.exec(b)?.[1] ?? decodeEntities(/<link>([\s\S]*?)<\/link>/.exec(b)?.[1] ?? '');
        link = link.replace(/&amp;/g, '&');
        const source = decodeEntities(/<source[^>]*>([\s\S]*?)<\/source>/.exec(b)?.[1] ?? '');
        if (title && link)
            out.push({title, url: link, publisher: source});
    }
    return out;
}

async function getJson(url) {
    return JSON.parse(new TextDecoder().decode((await httpGet(url)).get_data()));
}

async function getText(url) {
    return new TextDecoder().decode((await httpGet(url, {maxBytes: 4 * 1024 * 1024})).get_data());
}

async function hn(list) {
    const ids = (await getJson(`https://hacker-news.firebaseio.com/v0/${list}.json`)).slice(0, PER_SOURCE);
    const items = await Promise.all(ids.map(id => getJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).catch(() => null)));
    return items.filter(Boolean).map(i => ({
        title: i.title.replace(/^Show HN:\s*/, ''), url: i.url || `https://news.ycombinator.com/item?id=${i.id}`,
    }));
}

async function lobsters(path) {
    return (await getJson(`https://lobste.rs/${path}.json`)).slice(0, PER_SOURCE)
        .map(s => ({title: s.title, url: s.url || s.comments_url}));
}

async function devto(tag) {
    return (await getJson(`https://dev.to/api/articles?tag=${tag}&top=7&per_page=${PER_SOURCE}`))
        .map(a => ({title: a.title, url: a.url}));
}

export const SOURCES = [
    {id: 'hn', cat: 'Tech', name: 'Hacker News', fetch: () => hn('topstories')},
    {id: 'google-tech', cat: 'Tech', name: 'Google News · Technology', fetch: async () =>
        parseFeed(await getText('https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=en-US&gl=US&ceid=US:en'))
            .slice(0, PER_SOURCE).map(i => ({title: i.publisher ? i.title.replace(new RegExp(`\\s+-\\s+${i.publisher.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '') : i.title, url: i.url, by: i.publisher}))},
    {id: 'lobsters', cat: 'Tech', name: 'Lobsters', fetch: () => lobsters('hottest')},
    {id: 'devto-devops', cat: 'DevOps', name: 'DEV · #devops', fetch: () => devto('devops')},
    {id: 'devto-kubernetes', cat: 'DevOps', name: 'DEV · #kubernetes', fetch: () => devto('kubernetes')},
    {id: 'lobsters-devops', cat: 'DevOps', name: 'Lobsters · devops', fetch: () => lobsters('t/devops')},
    {id: 'newstack', cat: 'DevOps', name: 'The New Stack', fetch: async () =>
        parseFeed(await getText('https://thenewstack.io/blog/feed/')).slice(0, PER_SOURCE)},
    {id: 'hf-models', cat: 'AI', name: 'Hugging Face · Models', fetch: async () =>
        (await getJson(`https://huggingface.co/api/models?sort=trendingScore&direction=-1&limit=${PER_SOURCE}`))
            .map(m => ({title: m.id, url: `https://huggingface.co/${m.id}`}))},
    {id: 'hf-papers', cat: 'AI', name: 'Hugging Face · Papers', fetch: async () =>
        (await getJson(`https://huggingface.co/api/daily_papers?limit=${PER_SOURCE}`))
            .map(p => ({title: p.title ?? p.paper?.title, url: `https://huggingface.co/papers/${p.paper?.id}`}))
            .filter(p => p.title && !p.url.endsWith('undefined'))},
    {id: 'devto-ai', cat: 'AI', name: 'DEV · #ai', fetch: () => devto('ai')},
    {id: 'github', cat: 'New tools', name: 'GitHub Trending', fetch: async () => {
        // GitHub has no trending API; read the public page.
        const html = await getText('https://github.com/trending');
        const out = [];
        for (const m of html.matchAll(/<article[^>]*class="[^"]*Box-row[^"]*"[^>]*>([\s\S]*?)<\/article>/g)) {
            const repo = /<h2[^>]*>[\s\S]*?<a[^>]*href="\/([^"/]+\/[^"/]+)"/.exec(m[1])?.[1];
            if (!repo)
                continue;
            // the description paragraph (not an SVG <path>, not button labels)
            const desc = decodeEntities((/<p\s[^>]*color-fg-muted[^>]*>([\s\S]*?)<\/p>/.exec(m[1]) ??
                /<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/.exec(m[1]))?.[1] ?? '');
            const stars = /([\d,]+)\s+stars? today/.exec(m[1])?.[1];
            out.push({title: desc ? `${repo} — ${desc}` : repo, url: `https://github.com/${repo}`, by: stars ? `★ ${stars} today` : ''});
            if (out.length >= PER_SOURCE)
                break;
        }
        if (!out.length)
            throw new Error('page layout not recognised');
        return out;
    }},
    {id: 'showhn', cat: 'New tools', name: 'Show HN', fetch: () => hn('showstories')},
];

export const CATEGORIES = ['Tech', 'DevOps', 'AI', 'New tools'];

export class Trending extends Emitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this.items = [];
        this.status = {};
        this.state = 'waiting'; // waiting | fetching | metered | offline | failed | ok
        this.lastError = '';
        this._cacheFile = GLib.build_filenamev([cacheDir(''), 'trending.json']);
        this._statusFile = GLib.build_filenamev([cacheDir(''), 'trending-status.json']);
        try {
            const cached = JSON.parse(readTextFile(this._cacheFile) ?? 'null');
            if (cached?.items) {
                this.items = cached.items;
                this.state = 'ok';
                this._fetchedAt = cached.at ?? 0;
            }
        } catch {}
        this._net = Gio.NetworkMonitor.get_default();
        this._netId = this._net.connect('network-changed', () => this._maybeFetch());
        this._settingsIds = ['trending-enabled', 'trending-sources', 'trending-interval']
            .map(k => settings.connect(`changed::${k}`, () => this._maybeFetch(true)));
        this._startTimer = timeout(8000, () => {
            this._startTimer = 0;
            this._maybeFetch();
        });
    }

    get enabled() {
        return this._settings.get_boolean('trending-enabled');
    }

    _enabledSources() {
        const on = this._settings.get_strv('trending-sources');
        return SOURCES.filter(s => on.includes(s.id));
    }

    _reschedule() {
        this._timer = clearSource(this._timer);
        const mins = Math.max(10, this._settings.get_int('trending-interval'));
        this._timer = timeout(mins * 60 * 1000, () => {
            this._timer = 0;
            this._maybeFetch(true);
        });
    }

    async _maybeFetch(force = false, manual = false) {
        if (!this.enabled) {
            this.items = [];
            this.emit('changed');
            return;
        }
        const mins = Math.max(10, this._settings.get_int('trending-interval'));
        const fresh = this._fetchedAt && Date.now() - this._fetchedAt < mins * 60 * 1000;
        if ((fresh && !force) || this._fetching)
            return;
        // Respect metered connections for automatic refreshes, but a click on
        // Refresh always fetches.
        if (!manual && this._net.network_metered) {
            this.state = 'metered';
            this.emit('changed');
            this._reschedule();
            return;
        }
        if (!manual && !this._net.network_available) {
            this.state = 'offline';
            this.emit('changed');
            this._reschedule();
            return;
        }
        this._fetching = true;
        this.state = 'fetching';
        this.emit('changed');
        const results = await Promise.all(this._enabledSources().map(async s => {
            try {
                const list = (await s.fetch()).filter(i => i.title && i.url).slice(0, PER_SOURCE);
                this.status[s.id] = {ok: true, count: list.length, at: Date.now()};
                return list.map((i, rank) => ({...i, cat: s.cat, source: s.name, sourceId: s.id, rank}));
            } catch (e) {
                this.status[s.id] = {ok: false, error: e.message, at: Date.now()};
                return [];
            }
        }));
        this._fetching = false;
        if (this._destroyed)
            return;
        const flat = results.flat();
        const failures = Object.values(this.status).filter(s => !s.ok);
        this.state = flat.length ? 'ok' : 'failed';
        this.lastError = flat.length ? '' : (failures[0]?.error ?? 'no sources enabled');
        if (!flat.length)
            console.log(`Top Pill: trending fetch failed: ${JSON.stringify(this.status)}`);
        // Interleave sources so "All" mixes categories.
        const merged = [];
        for (let r = 0; r < PER_SOURCE; r++) {
            for (const list of results) {
                if (list[r])
                    merged.push(list[r]);
            }
        }
        if (flat.length) {
            this.items = merged;
            this._fetchedAt = Date.now();
            try {
                GLib.file_set_contents(this._cacheFile, JSON.stringify({at: this._fetchedAt, items: merged}));
            } catch {}
        }
        try {
            GLib.file_set_contents(this._statusFile, JSON.stringify(this.status));
        } catch {}
        this._reschedule();
        this.emit('changed');
    }

    refresh() {
        this._maybeFetch(true, true);
    }

    get message() {
        return {
            waiting: 'Loading headlines shortly…',
            fetching: 'Fetching headlines…',
            metered: 'Paused on a metered connection · press ⟳ to load anyway',
            offline: 'Offline · press ⟳ to try again',
            failed: `Couldn't load headlines: ${this.lastError}`,
            ok: 'Nothing in this category yet',
        }[this.state] ?? 'Fetching headlines…';
    }

    destroy() {
        this._destroyed = true;
        this._timer = clearSource(this._timer);
        this._startTimer = clearSource(this._startTimer);
        this._net.disconnect(this._netId);
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        this.clearHandlers();
    }
}
