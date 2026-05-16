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

window.ByteWorkz = window.ByteWorkz || { apps: [] };

import './doc.js';     // self-registers
import './sheet.js';   // self-registers

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
                <h3>byteDoc shortcuts</h3>
                <div class="about-grid">
                    <kbd>Ctrl+B</kbd><span>Bold</span>
                    <kbd>Ctrl+I</kbd><span>Italic</span>
                    <kbd>Ctrl+U</kbd><span>Underline</span>
                    <kbd>Ctrl+F</kbd><span>Find &amp; replace</span>
                    <kbd>Ctrl+S</kbd><span>Download JSON</span>
                    <kbd>Ctrl+O</kbd><span>Open file</span>
                    <kbd>Ctrl+Z / Y</kbd><span>Undo / redo</span>
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
                    <kbd>Ctrl+S / O</kbd><span>Save / open</span>
                </div>
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
        }
    });
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
    const picked = await file.openPicker('.json,application/json');
    if (!picked) return;
    if (!picked.json || !picked.json.app) {
        toast('Not a byteworkz document.', { kind: 'error' });
        return;
    }
    const j = picked.json;
    // Prefix the generated id by app type so storage scans / debugging stay
    // readable. The previous code always used 'd' regardless of app.
    const prefix = j.app === 'bytesheet' ? 's' : 'd';
    const id = j.id || uid(prefix);
    j.id = id;
    j.updatedAt = nowIso();
    docs.save(j);
    if (j.app === 'bytedoc')   { location.hash = '#/doc/' + id; }
    else if (j.app === 'bytesheet') { location.hash = '#/sheet/' + id; }
    else { toast('Unknown app type: ' + j.app, { kind: 'error' }); }
}

function renderRecent() {
    const list = document.getElementById('recent-list');
    list.innerHTML = '';
    const items = recent.list();
    if (items.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'recent-empty';
        empty.textContent = 'No documents yet. Open byteDoc or byteSheet to start.';
        list.appendChild(empty);
        return;
    }
    items.forEach(m => {
        const li = document.createElement('li');
        li.className = 'recent-row';
        li.dataset.id = m.id;
        const isDoc = m.app === 'bytedoc';
        const route = isDoc ? '#/doc/' + m.id : '#/sheet/' + m.id;
        li.innerHTML = `
            <div class="recent-row-icon">${isDoc ? docIconSvg() : sheetIconSvg()}</div>
            <div class="recent-row-name">${escapeHtml(m.title || 'Untitled')}</div>
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
