/* byteworkz/storage.js — localStorage persistence + JSON file I/O.
 *
 * Storage layout in localStorage:
 *   byteworkz.recent       → JSON array of { id, app, title, updatedAt }   (≤ MAX_RECENT)
 *   byteworkz.docs.<id>    → full document JSON (per app)
 *
 * On quota overflow, oldest recent docs are evicted FIFO and the user is toasted.
 */

import { toast } from './ui.js';

const KEY_RECENT = 'byteworkz.recent';
const KEY_DOC_PREFIX = 'byteworkz.docs.';
const MAX_RECENT = 20;

function lsGetJSON(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        return JSON.parse(raw);
    } catch { return fallback; }
}
function lsSetJSON(key, value) {
    const raw = JSON.stringify(value);
    try {
        localStorage.setItem(key, raw);
        return true;
    } catch (e) {
        // Quota exceeded — evict oldest recent docs and retry once.
        if (evictOldestUntilFits(raw.length + key.length)) {
            try { localStorage.setItem(key, raw); return true; }
            catch { /* fallthrough */ }
        }
        toast('Storage full — could not save. Try downloading the file.', { kind: 'error', timeout: 5000 });
        return false;
    }
}

function evictOldestUntilFits(needBytes) {
    let recent = lsGetJSON(KEY_RECENT, []);
    if (!recent.length) return false;
    recent.sort((a, b) => (a.updatedAt || '').localeCompare(b.updatedAt || ''));
    let freed = 0;
    while (recent.length > 1 && freed < needBytes) {
        const drop = recent.shift();
        if (drop) {
            const k = KEY_DOC_PREFIX + drop.id;
            const v = localStorage.getItem(k);
            freed += (v ? v.length : 0) + k.length;
            localStorage.removeItem(k);
        }
    }
    // setItem can still throw QuotaExceededError even after shrinking, on
    // browsers that count quota against an in-progress write. Swallowing
    // here is fine: the blobs are already evicted, and lsGetJSON on next
    // load returns the stale-but-larger array — self-heals on next save.
    try { localStorage.setItem(KEY_RECENT, JSON.stringify(recent)); } catch {}
    return freed >= needBytes;
}

/* ---------------- recent ---------------- */

export const recent = {
    list() {
        const r = lsGetJSON(KEY_RECENT, []);
        return r.slice().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    },
    touch(meta) {
        // meta: { id, app, title, updatedAt, tags? }
        // tags is optional — the Hub renders tag-filter pills from this array
        // so we don't have to load every doc just to enumerate tags.
        const r = lsGetJSON(KEY_RECENT, []);
        const idx = r.findIndex(x => x.id === meta.id);
        if (idx >= 0) r.splice(idx, 1);
        r.unshift({
            id: meta.id,
            app: meta.app,
            title: meta.title,
            updatedAt: meta.updatedAt,
            tags: Array.isArray(meta.tags) ? meta.tags : []
        });
        // Cap to MAX_RECENT — also delete the dropped docs' blobs so they
        // don't sit in localStorage orphaned (accessible by no UI).
        while (r.length > MAX_RECENT) {
            const dropped = r.pop();
            if (dropped) localStorage.removeItem(KEY_DOC_PREFIX + dropped.id);
        }
        lsSetJSON(KEY_RECENT, r);
    },
    remove(id) {
        const r = lsGetJSON(KEY_RECENT, []).filter(x => x.id !== id);
        lsSetJSON(KEY_RECENT, r);
        localStorage.removeItem(KEY_DOC_PREFIX + id);
    },
    get(id) {
        return lsGetJSON(KEY_RECENT, []).find(x => x.id === id) || null;
    },
    /* All unique tag strings used across the recent list, sorted alphabetically.
     * Empty array if no doc has any tags. */
    allTags() {
        const r = lsGetJSON(KEY_RECENT, []);
        const set = new Set();
        for (const e of r) {
            if (Array.isArray(e.tags)) e.tags.forEach(t => set.add(t));
        }
        return Array.from(set).sort();
    }
};

/* ---------------- docs ---------------- */

export const docs = {
    // save(doc) — normal save, also adds to Recent.
    // save(doc, { silent: true }) — persists without adding/touching Recent.
    // Used for the initial save of a freshly-created empty doc so that
    // abandoned "New byteDoc/Sheet" clicks don't clutter the Recent list.
    // Once the user actually edits the doc, the debounced save runs without
    // {silent} and the doc shows up in Recent.
    save(doc, { silent = false } = {}) {
        if (!doc || !doc.id) return false;
        const ok = lsSetJSON(KEY_DOC_PREFIX + doc.id, doc);
        if (ok && !silent) recent.touch({
            id: doc.id,
            app: doc.app,
            title: doc.title || 'Untitled',
            updatedAt: doc.updatedAt || new Date().toISOString(),
            tags: doc.tags || []
        });
        return ok;
    },
    load(id) {
        return lsGetJSON(KEY_DOC_PREFIX + id, null);
    },
    delete(id) {
        localStorage.removeItem(KEY_DOC_PREFIX + id);
        recent.remove(id);
    }
};

/* ---------------- file I/O ---------------- */

export const file = {
    download(filename, content, mime = 'application/json') {
        const blob = (content instanceof Blob)
            ? content
            : new Blob([typeof content === 'string' ? content : JSON.stringify(content, null, 2)], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
    },
    /* openPicker(accept='.json,application/json') → Promise<{name, content<string>, json?}>|null */
    openPicker(accept = '.json,application/json') {
        return new Promise(resolve => {
            const inp = document.createElement('input');
            inp.type = 'file';
            inp.accept = accept;
            inp.style.display = 'none';
            inp.addEventListener('change', async () => {
                const f = inp.files && inp.files[0];
                if (!f) { resolve(null); return; }
                try {
                    const text = await f.text();
                    let json = null;
                    if (/^\s*[{[]/.test(text)) {
                        try { json = JSON.parse(text); } catch { /* not JSON */ }
                    }
                    resolve({ name: f.name, content: text, json });
                } catch (err) {
                    toast('Could not read file: ' + err.message, { kind: 'error' });
                    resolve(null);
                } finally {
                    inp.remove();
                }
            });
            document.body.appendChild(inp);
            inp.click();
        });
    }
};

export function nowIso() { return new Date().toISOString(); }
