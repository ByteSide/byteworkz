/* byteworkz/app.js — boot, hash router, app registry, hub view.
 *
 * Routes:
 *   #/                 → hub
 *   #/doc              → new byteDoc
 *   #/doc/<id>         → byteDoc with doc <id>
 *   #/sheet            → new byteSheet
 *   #/sheet/<id>       → byteSheet with doc <id>
 *
 * App registry (Voidcore-ready):
 *   window.ByteWorkz.apps.push({ id, title, route, mount(container, params), unmount() })
 */

import { recent, docs, file, nowIso } from './storage.js';
import { toast, fmtRelative, uid, confirm, showModal, escapeHtml } from './ui.js';
import { parseCSV, csvToCellsObj } from './csv.js';

window.ByteWorkz = window.ByteWorkz || { apps: [] };

import './doc.js';     // self-registers
import './sheet.js';   // self-registers

// Apply persisted theme preference as early as possible — before any view
// renders — so the user doesn't briefly see the default-dark variant flash
// on a light-preferring system. Three states: 'auto' (or absent) follows
// prefers-color-scheme; 'dark'/'light' override. Stored as bare string.
(() => {
    try {
        const saved = localStorage.getItem('byteworkz.theme');
        if (saved === 'dark' || saved === 'light') {
            document.documentElement.setAttribute('data-theme', saved);
        }
        // 'auto' or null → no attribute → media-query decides.
    } catch { /* localStorage blocked */ }
})();

export function setTheme(mode) {
    if (mode === 'auto') {
        document.documentElement.removeAttribute('data-theme');
        try { localStorage.removeItem('byteworkz.theme'); } catch {}
    } else if (mode === 'dark' || mode === 'light') {
        document.documentElement.setAttribute('data-theme', mode);
        try { localStorage.setItem('byteworkz.theme', mode); } catch {}
    }
}
export function currentTheme() {
    return document.documentElement.getAttribute('data-theme') || 'auto';
}

const root = () => document.getElementById('app-root');
const views = {
    hub:   document.querySelector('[data-view="hub"]'),
    doc:   document.querySelector('[data-view="doc"]'),
    sheet: document.querySelector('[data-view="sheet"]')
};
const topbarCenter = document.getElementById('topbar-center');
const topbarVersion = document.getElementById('topbar-version');

let currentView = null;     // 'hub' | 'doc' | 'sheet'
let currentApp = null;      // app object currently mounted

function showView(name) {
    Object.entries(views).forEach(([k, el]) => { el.hidden = (k !== name); });
    currentView = name;
    if (name === 'hub') {
        topbarCenter.innerHTML = '';
    }
}

/* ---------------- Router ---------------- */

function parseHash() {
    const h = (location.hash || '#/').replace(/^#/, '');
    const parts = h.split('/').filter(Boolean);
    if (parts.length === 0) return { route: 'hub', params: {} };
    const [head, ...rest] = parts;
    if (head === 'doc')   return { route: 'doc',   params: { id: rest[0] || null } };
    if (head === 'sheet') return { route: 'sheet', params: { id: rest[0] || null } };
    return { route: 'hub', params: {} };
}

async function router() {
    const { route, params } = parseHash();

    if (route === 'hub') {
        if (currentApp && currentApp.unmount) { try { currentApp.unmount(); } catch (e) { console.warn(e); } }
        currentApp = null;
        showView('hub');
        renderHub();
        return;
    }

    const appId = route;  // 'doc' or 'sheet'
    const nextApp = window.ByteWorkz.apps.find(a => a.id === appId);
    if (!nextApp) {
        toast('Unknown app: ' + appId, { kind: 'error' });
        location.hash = '#/';
        return;
    }

    // If switching apps, unmount the previous.
    if (currentApp && currentApp.id !== appId && currentApp.unmount) {
        try { currentApp.unmount(); } catch (e) { console.warn(e); }
        currentApp = null;
    }

    showView(appId);

    // Mount (always — modules may reuse internal state if same app)
    try {
        nextApp.mount(views[appId], { id: params.id });
    } catch (e) {
        console.error(e);
        toast('Could not open ' + nextApp.title + ': ' + e.message, { kind: 'error' });
        location.hash = '#/';
        return;
    }
    currentApp = nextApp;
}

window.addEventListener('hashchange', router);
window.addEventListener('DOMContentLoaded', () => {
    if (!location.hash) location.hash = '#/';
    router();
    fetch('/version.json').then(r => r.json()).then(v => {
        if (topbarVersion) topbarVersion.textContent = 'v' + v.version;
    }).catch(() => {});
    const aboutBtn = document.getElementById('topbar-about');
    if (aboutBtn) aboutBtn.addEventListener('click', openAboutModal);
    registerServiceWorker();
    bindInstallPrompt();
    // Global Ctrl+K / Cmd+K → command palette. Bound at the document level
    // so it works regardless of which view is active or which element holds
    // focus (the byteSheet grid steals keys; this listener runs at capture
    // phase to win the race).
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            e.stopPropagation();
            openCmdPalette();
        }
    }, true);
});

/* ---------------- PWA: service worker + install prompt ---------------- */

// Register the SW. On `updatefound` we attach to the installing worker and
// wait for its `statechange` to `installed`. If there's a controller already
// (i.e., this isn't the first install), surface a "new version" toast that
// the user can click to reload into the new shell. Without the controller
// check we'd toast on every first-ever visit, which is noise.
function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').then(reg => {
        reg.addEventListener('updatefound', () => {
            const nw = reg.installing;
            if (!nw) return;
            nw.addEventListener('statechange', () => {
                if (nw.state === 'installed' && navigator.serviceWorker.controller) {
                    showUpdateToast(nw);
                }
            });
        });
    }).catch((err) => {
        // SW unavailable / blocked / file-protocol — site still works
        // without offline support. Log for debugging but don't surface.
        console.warn('byteworkz SW registration failed:', err);
    });
}

function showUpdateToast(worker) {
    const host = document.getElementById('toast-host');
    if (!host) return;
    const el = document.createElement('div');
    el.className = 'toast toast-update';
    el.dataset.kind = 'info';
    el.style.pointerEvents = 'auto';
    el.innerHTML = `
        <span>New version available.</span>
        <button class="btn-primary toast-reload-btn" type="button">Reload</button>
    `;
    el.querySelector('.toast-reload-btn').addEventListener('click', () => {
        // Tell the waiting SW to take over, then reload once it's the new
        // controller. The controllerchange listener catches the transition
        // — without it, the reload could race the activation and the new
        // assets would only land on the next reload after that.
        worker.postMessage({ type: 'SKIP_WAITING' });
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            location.reload();
        }, { once: true });
    });
    host.appendChild(el);
}

// Capture the browser's `beforeinstallprompt` so we can offer install from
// our About modal instead of relying on the browser's default UI (which
// some browsers hide). Only fires on Chromium-based browsers; Safari /
// Firefox handle install differently or not at all — the about modal just
// won't show the button in that case.
let _installPrompt = null;
function bindInstallPrompt() {
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        _installPrompt = e;
    });
    window.addEventListener('appinstalled', () => {
        _installPrompt = null;
    });
}

export function installApp() {
    if (!_installPrompt) return false;
    _installPrompt.prompt();
    _installPrompt.userChoice.finally(() => { _installPrompt = null; });
    return true;
}
export function canInstall() { return !!_installPrompt; }

function openAboutModal() {
    const v = topbarVersion ? topbarVersion.textContent : '';
    const installable = canInstall();
    const theme = currentTheme();
    showModal({
        title: 'About byteworkz',
        bodyHTML: `
            <p style="margin-top:0;color:var(--fg-muted);font-size:13px;">
                A minimal office suite that lives entirely in your browser.
                <strong>byteDoc</strong> writes, <strong>byteSheet</strong>
                calculates. No accounts, no cloud, no tracking.
                <span style="font-family:var(--mono);font-size:11px;display:block;margin-top:6px;color:var(--fg-dim);">${escapeHtml(v)}</span>
            </p>

            <div class="about-section">
                <h3>Global</h3>
                <div class="about-grid">
                    <kbd>Ctrl+K</kbd><span>Command palette — jump between documents</span>
                </div>
            </div>

            <div class="about-section">
                <h3>byteDoc shortcuts</h3>
                <div class="about-grid">
                    <kbd>Ctrl+B</kbd><span>Bold</span>
                    <kbd>Ctrl+I</kbd><span>Italic</span>
                    <kbd>Ctrl+U</kbd><span>Underline</span>
                    <kbd>Ctrl+F</kbd><span>Find &amp; replace</span>
                    <kbd>Ctrl+S</kbd><span>Download JSON</span>
                    <kbd>Ctrl+O</kbd><span>Open file</span>
                    <kbd>Ctrl+P</kbd><span>Print</span>
                    <kbd>Ctrl+Z / Y</kbd><span>Undo / redo</span>
                </div>
            </div>
            <div class="about-section">
                <h3>byteDoc markdown shortcuts</h3>
                <div class="about-grid">
                    <kbd>**bold**</kbd><span>+ space → <strong>bold</strong></span>
                    <kbd>*italic*</kbd><span>+ space → <em>italic</em></span>
                    <kbd>\`code\`</kbd><span>+ space → inline code</span>
                    <kbd>~~strike~~</kbd><span>+ space → strikethrough</span>
                    <kbd># </kbd><span>at line start → Heading 1</span>
                    <kbd>## </kbd><span>at line start → Heading 2</span>
                    <kbd>### </kbd><span>at line start → Heading 3</span>
                    <kbd>&gt; </kbd><span>at line start → blockquote</span>
                    <kbd>- </kbd><span>at line start → bullet list</span>
                    <kbd>1. </kbd><span>at line start → numbered list</span>
                </div>
            </div>

            <div class="about-section">
                <h3>byteSheet shortcuts</h3>
                <div class="about-grid">
                    <kbd>Arrow keys</kbd><span>Move active cell</span>
                    <kbd>Shift+Arrows</kbd><span>Extend selection</span>
                    <kbd>Enter / Tab</kbd><span>Commit + move</span>
                    <kbd>F2</kbd><span>Edit current cell</span>
                    <kbd>Just type</kbd><span>Replace + start edit</span>
                    <kbd>Delete</kbd><span>Clear selection</span>
                    <kbd>Ctrl+C / X / V</kbd><span>Copy / cut / paste (TSV)</span>
                    <kbd>Ctrl+A</kbd><span>Select all</span>
                    <kbd>Ctrl+Z / Y</kbd><span>Undo / redo</span>
                    <kbd>Ctrl+S / O / P</kbd><span>Save / open / print</span>
                </div>
            </div>

            <div class="about-section">
                <h3>Appearance</h3>
                <div class="theme-picker">
                    <button class="theme-pick" data-theme-set="auto"  ${theme === 'auto'  ? 'data-active' : ''}>Auto</button>
                    <button class="theme-pick" data-theme-set="dark"  ${theme === 'dark'  ? 'data-active' : ''}>Dark</button>
                    <button class="theme-pick" data-theme-set="light" ${theme === 'light' ? 'data-active' : ''}>Light</button>
                </div>
                <p style="margin:6px 0 0;font-size:11px;color:var(--fg-dim);">"Auto" follows your operating system preference.</p>
            </div>

            <div class="about-section">
                <h3>Links</h3>
                <div class="about-links">
                    <a href="https://github.com/ByteSide/byteworkz" target="_blank" rel="noopener noreferrer">Source on GitHub</a>
                    <a href="/imprint.html">Imprint</a>
                    <a href="/privacy.html">Privacy</a>
                </div>
            </div>

            ${installable ? `
            <div class="about-section about-install">
                <h3>Install as app</h3>
                <p style="margin:0 0 10px;font-size:13px;color:var(--fg-muted);">
                    Run byteworkz as a standalone app — separate window, no browser chrome, works offline. Documents stay on this device just like in the browser.
                </p>
                <button class="btn-primary" id="about-install-btn" type="button">Install byteworkz</button>
            </div>` : ''}

            <div class="about-section">
                <h3>Privacy in one sentence</h3>
                <p style="margin:0;font-size:13px;color:var(--fg-muted);">
                    Everything — documents, spreadsheets, embedded images — stays in your browser's localStorage and never reaches a server. The only thing recorded server-side is an anonymised access log (IP truncated to /24, no cookies, no analytics).
                </p>
            </div>
        `,
        actions: [
            { label: 'Close', kind: 'primary' }
        ],
        onMount: (modal, close) => {
            const btn = modal.querySelector('#about-install-btn');
            if (btn) btn.addEventListener('click', () => {
                if (installApp()) close();
            });
            // Theme picker — click sets data-theme + persists, then updates
            // the active pill in-place (no need to re-open the modal).
            modal.querySelectorAll('.theme-pick').forEach(btn => {
                btn.addEventListener('click', () => {
                    setTheme(btn.dataset.themeSet);
                    modal.querySelectorAll('.theme-pick').forEach(b => b.removeAttribute('data-active'));
                    btn.setAttribute('data-active', '');
                });
            });
        }
    });
}

/* ---------------- Command palette (Ctrl+K) ─────────────────────────────
 * Lightweight quick-switcher for opening any document or running a built-in
 * action without leaving the keyboard. Bypasses showModal so we own the
 * keyboard handling (Up/Down/Enter/Esc) and the filter loop.
 *
 * Items come from two sources:
 *   1. recent.list() — all docs that have been opened recently
 *   2. a fixed set of built-in actions (Hub, New doc, New sheet, Open file)
 *
 * Filter is plain substring matching against `${title} ${app}` lowercased.
 * No fuzzy ranking — keeps the implementation tiny and predictable. */

let _palOpen = false;

function openCmdPalette() {
    if (_palOpen) return;
    _palOpen = true;

    const items = buildPaletteItems();
    const host = document.createElement('div');
    host.className = 'cmd-pal-host';
    host.innerHTML = `
        <div class="cmd-pal-backdrop"></div>
        <div class="cmd-pal" role="dialog" aria-label="Command palette">
            <input class="cmd-pal-input" type="text" placeholder="Search documents and actions…" autocomplete="off" spellcheck="false">
            <ul class="cmd-pal-list" role="listbox"></ul>
            <div class="cmd-pal-hint">
                <kbd>↑</kbd><kbd>↓</kbd> navigate · <kbd>Enter</kbd> open · <kbd>Esc</kbd> close
            </div>
        </div>
    `;
    document.body.appendChild(host);

    const input = host.querySelector('.cmd-pal-input');
    const list = host.querySelector('.cmd-pal-list');
    let active = 0;
    let filtered = items;

    const renderList = () => {
        if (!filtered.length) {
            list.innerHTML = '<li class="cmd-pal-empty">No matches</li>';
            return;
        }
        list.innerHTML = filtered.map((it, idx) => `
            <li class="cmd-pal-item${idx === active ? ' is-active' : ''}" data-idx="${idx}" role="option" aria-selected="${idx === active}">
                <span class="cmd-pal-icon" data-kind="${it.kind}">${it.icon || ''}</span>
                <span class="cmd-pal-title">${escapeHtml(it.title)}</span>
                <span class="cmd-pal-meta">${escapeHtml(it.meta || '')}</span>
            </li>
        `).join('');
        const el = list.querySelector(`[data-idx="${active}"]`);
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    };

    const close = () => {
        if (!_palOpen) return;
        _palOpen = false;
        host.remove();
    };

    const runActive = () => {
        const it = filtered[active];
        if (!it) return;
        close();
        try { it.run(); } catch (e) { console.error(e); toast('Failed: ' + e.message, { kind: 'error' }); }
    };

    input.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();
        if (q.startsWith('#') && q.length > 1) {
            // Tag-filter mode: match documents whose `tags` array contains the
            // (sub)string after `#`. Actions still surface — they're rarely
            // tagged and shouldn't disappear when a tag filter is active.
            const tagQ = q.slice(1);
            filtered = items.filter(it =>
                it.kind === 'action' ||
                (Array.isArray(it.tags) && it.tags.some(t => t.includes(tagQ)))
            );
        } else {
            filtered = q
                ? items.filter(it => (it.title + ' ' + (it.meta || '') + ' ' + ((it.tags || []).map(t => '#' + t).join(' '))).toLowerCase().includes(q))
                : items;
        }
        active = 0;
        renderList();
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(filtered.length - 1, active + 1); renderList(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); renderList(); }
        else if (e.key === 'Enter') { e.preventDefault(); runActive(); }
        // Stop the Escape from also dismissing an underlying showModal —
        // its document-level keydown handler would receive the same event
        // and close the parent modal under the palette.
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    });
    list.addEventListener('click', (e) => {
        const li = e.target.closest('.cmd-pal-item');
        if (!li) return;
        active = parseInt(li.dataset.idx, 10);
        runActive();
    });
    host.querySelector('.cmd-pal-backdrop').addEventListener('click', close);

    renderList();
    input.focus();
}

function buildPaletteItems() {
    const items = [];
    // Built-in actions first — they're always available and provide an
    // anchor for the keyboard-first user who never wants the mouse.
    items.push(
        { kind: 'action', icon: '◧', title: 'Go to Hub',           meta: 'home',     run: () => { location.hash = '#/'; } },
        { kind: 'action', icon: '＋', title: 'New byteDoc',         meta: 'document', run: () => { location.hash = '#/doc'; } },
        { kind: 'action', icon: '＋', title: 'New byteSheet',       meta: 'spreadsheet', run: () => { location.hash = '#/sheet'; } },
        { kind: 'action', icon: '⤒', title: 'Open from file…',     meta: 'JSON',     run: openAnyFile }
    );
    // Recent docs — title first so the user matches by name. Meta shows the
    // app type so a "report" could be either bytedoc or bytesheet and the
    // user can pick the right one.
    try {
        const recents = recent.list();
        for (const r of recents) {
            const isDoc = r.app === 'bytedoc';
            items.push({
                kind: 'doc',
                icon: isDoc ? '📄' : '▦',
                title: r.title || 'Untitled',
                meta:  isDoc ? 'byteDoc' : 'byteSheet',
                tags:  Array.isArray(r.tags) ? r.tags : [],
                run: () => { location.hash = (isDoc ? '#/doc/' : '#/sheet/') + r.id; }
            });
        }
    } catch (e) { console.warn('recent.list failed', e); }
    return items;
}

/* ---------------- Hub view ---------------- */

function renderHub() {
    // Hub-static tiles + actions are in index.html; bind handlers (idempotent).
    bindOnce(document.querySelectorAll('.hub-tile, [data-route]'), 'click', (e) => {
        const r = e.currentTarget.dataset.route;
        if (r) { location.hash = r; e.preventDefault(); }
    });

    bindOnce(document.getElementById('hub-new-doc'),   'click', () => { location.hash = '#/doc'; });
    bindOnce(document.getElementById('hub-new-sheet'), 'click', () => { location.hash = '#/sheet'; });
    bindOnce(document.getElementById('hub-open-file'), 'click', openAnyFile);

    renderTemplates();
    renderRecent();
}

/* ---------------- Templates ---------------- */

// Module-level cache so we don't refetch on every hub-render. SW also caches
// /templates/index.json so subsequent fetches are instant, but this avoids
// even that one round-trip + JSON parse.
let _templatesCache = null;

async function renderTemplates() {
    const section = document.getElementById('hub-templates-section');
    const list = document.getElementById('hub-templates');
    if (!section || !list) return;
    try {
        if (!_templatesCache) {
            const r = await fetch('/templates/index.json');
            if (!r.ok) return;  // section stays hidden — fail silent
            _templatesCache = await r.json();
        }
        const items = (_templatesCache && _templatesCache.templates) || [];
        if (!items.length) return;
        list.innerHTML = '';
        items.forEach(meta => {
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'template-card';
            card.dataset.tplId = meta.id;
            const icon = meta.app === 'bytedoc' ? docIconSvg() : sheetIconSvg();
            const badge = meta.app === 'bytedoc' ? 'doc' : 'sheet';
            card.innerHTML = `
                <div class="template-card-head">
                    <span class="template-card-icon">${icon}</span>
                    <span class="template-card-badge">${badge}</span>
                </div>
                <div class="template-card-title">${escapeHtml(meta.title)}</div>
                <div class="template-card-desc">${escapeHtml(meta.description || '')}</div>
            `;
            card.addEventListener('click', () => instantiateTemplate(meta));
            list.appendChild(card);
        });
        section.hidden = false;
    } catch (e) {
        console.warn('Templates load failed:', e);
    }
}

async function instantiateTemplate(meta) {
    try {
        const r = await fetch('/templates/' + encodeURIComponent(meta.file));
        if (!r.ok) {
            toast('Could not load template.', { kind: 'error' });
            return;
        }
        const tpl = await r.json();
        if (tpl.app !== meta.app) {
            toast('Template type mismatch.', { kind: 'error' });
            return;
        }
        // Stamp a fresh id + timestamps so the instantiated doc is its own
        // entity, not a shared alias of the template. Title stays as the
        // template's title (e.g. "Monthly Budget") — user can rename via
        // the topbar input.
        tpl.id = uid(meta.app === 'bytedoc' ? 'd' : 's');
        const now = nowIso();
        tpl.createdAt = now;
        tpl.updatedAt = now;
        const ok = docs.save(tpl);
        if (!ok) return;  // toast already shown by storage layer
        location.hash = (meta.app === 'bytedoc' ? '#/doc/' : '#/sheet/') + tpl.id;
    } catch (e) {
        toast('Could not load template: ' + e.message, { kind: 'error' });
    }
}

async function openAnyFile() {
    const picked = await file.openPicker('.json,.csv,.txt,application/json,text/csv,text/plain');
    if (!picked) return;
    if (picked.json && picked.json.app) {
        const j = picked.json;
        // Prefix the generated id by app type so storage scans / debugging
        // stay readable. The previous code always used 'd' regardless.
        const prefix = j.app === 'bytesheet' ? 's' : 'd';
        const id = j.id || uid(prefix);
        j.id = id;
        j.updatedAt = nowIso();
        docs.save(j);
        if (j.app === 'bytedoc')        location.hash = '#/doc/' + id;
        else if (j.app === 'bytesheet') location.hash = '#/sheet/' + id;
        else toast('Unknown app type: ' + j.app, { kind: 'error' });
        return;
    }
    // Not a byteworkz JSON — try CSV. We materialise a fresh bytesheet doc
    // from the CSV data and navigate to it. Same result as opening byteSheet
    // first and using its CSV import, just one click instead of two.
    if (picked.content && /\.csv$|\.txt$/i.test(picked.name || '')) {
        importCSVAsNewDoc(picked.content, picked.name);
        return;
    }
    toast('Not a byteworkz document.', { kind: 'error' });
}

function importCSVAsNewDoc(text, filename) {
    const rows = parseCSV(text);
    if (!rows.length) {
        toast('CSV is empty.', { kind: 'error' });
        return;
    }
    const base = (filename || 'Imported').replace(/\.[^.]+$/, '').slice(0, 60) || 'Imported';
    const { cells, rowsLoaded, colsLoaded } = csvToCellsObj(rows, { maxRows: 1000, maxCols: 80 });
    const now = nowIso();
    const doc = {
        app: 'bytesheet',
        version: 1,
        id: uid('s'),
        title: base,
        createdAt: now,
        updatedAt: now,
        activeSheet: 0,
        sheets: [{
            name: 'Sheet1',
            cols: 26,
            rows: 100,
            cells,
            charts: []
        }]
    };
    docs.save(doc);
    const truncated = rows.length > rowsLoaded
        ? ` (truncated from ${rows.length} rows)`
        : '';
    toast(`Imported ${rowsLoaded} × ${colsLoaded}${truncated}.`, { kind: 'ok' });
    location.hash = '#/sheet/' + doc.id;
}

// Module-level state for the Hub tag filter: which tag is currently
// selected (null = no filter, show everything). Reset on every renderHub.
let _hubTagFilter = null;

function renderRecent() {
    const list = document.getElementById('recent-list');
    list.innerHTML = '';
    const allItems = recent.list();
    renderTagFilterBar(allItems);
    const items = _hubTagFilter
        ? allItems.filter(m => Array.isArray(m.tags) && m.tags.includes(_hubTagFilter))
        : allItems;
    if (items.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'recent-empty';
        empty.textContent = _hubTagFilter
            ? `No documents tagged #${_hubTagFilter}.`
            : 'No documents yet. Open byteDoc or byteSheet to start.';
        list.appendChild(empty);
        return;
    }
    items.forEach(m => {
        const li = document.createElement('li');
        li.className = 'recent-row';
        li.dataset.id = m.id;
        const isDoc = m.app === 'bytedoc';
        const route = isDoc ? '#/doc/' + m.id : '#/sheet/' + m.id;
        const tagChips = Array.isArray(m.tags) && m.tags.length
            ? '<span class="recent-row-tags">' + m.tags.map(t => `<span class="recent-row-tag">#${escapeHtml(t)}</span>`).join('') + '</span>'
            : '';
        li.innerHTML = `
            <div class="recent-row-icon">${isDoc ? docIconSvg() : sheetIconSvg()}</div>
            <div class="recent-row-name">${escapeHtml(m.title || 'Untitled')}</div>
            ${tagChips}
            <span class="recent-row-badge">${isDoc ? 'doc' : 'sheet'}</span>
            <span class="recent-row-meta">${fmtRelative(m.updatedAt)}</span>
            <button class="recent-row-del" title="Delete">✕</button>
        `;
        li.addEventListener('click', (e) => {
            if (e.target.closest('.recent-row-del')) return;
            location.hash = route;
        });
        li.querySelector('.recent-row-del').addEventListener('click', async (e) => {
            e.stopPropagation();
            const ok = await confirm({
                title: 'Delete document',
                message: `Delete "${m.title || 'Untitled'}"? This cannot be undone.`,
                danger: true, okLabel: 'Delete'
            });
            if (ok) {
                docs.delete(m.id);
                renderRecent();
                toast('Deleted.', { kind: 'ok' });
            }
        });
        list.appendChild(li);
    });
}

/* Tag filter row rendered above the recent list. Hidden when no docs
 * carry tags (no clutter for users who don't use tagging). Click on a pill
 * sets the filter and re-renders; click "All" or the active pill clears. */
function renderTagFilterBar(items) {
    let bar = document.getElementById('hub-tag-filter');
    const tags = new Set();
    items.forEach(m => { if (Array.isArray(m.tags)) m.tags.forEach(t => tags.add(t)); });
    const tagList = Array.from(tags).sort();

    if (!tagList.length) {
        if (bar) bar.remove();
        _hubTagFilter = null;
        return;
    }
    // Self-heal stale filter state: if the active filter's tag has been
    // removed from every document, the pill no longer renders. Clearing
    // _hubTagFilter avoids a "ghost filter" state where the user sees a
    // confusing "No documents tagged #X" empty message but no way to
    // see what tag is active besides clicking "All".
    if (_hubTagFilter && !tagList.includes(_hubTagFilter)) {
        _hubTagFilter = null;
    }

    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'hub-tag-filter';
        bar.className = 'hub-tag-filter';
        // Insert just above the recent-list. The Hub's structure is
        // .hub-recent > h2 + ul#recent-list, so we drop the bar inside
        // .hub-recent right before #recent-list.
        const list = document.getElementById('recent-list');
        list.parentNode.insertBefore(bar, list);
    }
    bar.innerHTML =
        `<button class="tag-pill${_hubTagFilter === null ? ' is-active' : ''}" data-tag="">All</button>` +
        tagList.map(t => `<button class="tag-pill${_hubTagFilter === t ? ' is-active' : ''}" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</button>`).join('');
    bar.onclick = (e) => {
        const btn = e.target.closest('.tag-pill');
        if (!btn) return;
        const t = btn.dataset.tag;
        _hubTagFilter = t || null;
        renderRecent();
    };
}

function docIconSvg() {
    return `<svg viewBox="0 0 16 16" width="14" height="14"><rect x="3" y="2" width="10" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><line x1="5" y1="5" x2="11" y2="5" stroke="currentColor" stroke-width="1.2"/><line x1="5" y1="8" x2="11" y2="8" stroke="currentColor" stroke-width="1.2"/><line x1="5" y1="11" x2="9" y2="11" stroke="currentColor" stroke-width="1.2"/></svg>`;
}
function sheetIconSvg() {
    return `<svg viewBox="0 0 16 16" width="14" height="14"><rect x="2" y="3" width="12" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><line x1="2" y1="7" x2="14" y2="7" stroke="currentColor" stroke-width="1.2"/><line x1="6" y1="3" x2="6" y2="13" stroke="currentColor" stroke-width="1.2"/><line x1="10" y1="3" x2="10" y2="13" stroke="currentColor" stroke-width="1.2"/></svg>`;
}

/* ---------------- Topbar API for apps ---------------- */

export const topbar = {
    setCenter(html) {
        topbarCenter.innerHTML = '';
        if (typeof html === 'string') topbarCenter.innerHTML = html;
        else if (html instanceof Node) topbarCenter.appendChild(html);
    },
    clearCenter() { topbarCenter.innerHTML = ''; }
};

/* ---------------- helpers ---------------- */

function bindOnce(elOrList, ev, fn) {
    const els = (elOrList instanceof NodeList) ? Array.from(elOrList) : [elOrList].filter(Boolean);
    els.forEach(el => {
        if (el.dataset._bound && el.dataset._bound.includes(ev)) return;
        el.addEventListener(ev, fn);
        el.dataset._bound = (el.dataset._bound || '') + ',' + ev;
    });
}

export { renderRecent };
