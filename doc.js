/* byteworkz/doc.js — byteDoc rich-text editor (self-registers into ByteWorkz.apps).
 *
 * Features:
 *  - contenteditable single editor with multi-doc tabs
 *  - format toolbar (B/I/U/Strike, headings, lists, align, link, blockquote, clear)
 *  - tables (insert, context menu for row/col operations)
 *  - images (file picker → DataURL, click-to-select + corner-resize)
 *  - find/replace with highlighting (Ctrl+F)
 *  - live word/char count in status bar
 *  - per-tab snapshot undo/redo stack (Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z) — replaces
 *    the deprecated browser-native execCommand undo. Cursor + range are stored
 *    alongside each snapshot via DOM-path coordinates, so undo restores the
 *    caret precisely, not just to the start of the editor.
 *  - keyboard: Ctrl+B/I/U, Ctrl+S (download JSON), Ctrl+O (open), Ctrl+F (find),
 *    Ctrl+Z (undo), Ctrl+Y / Ctrl+Shift+Z (redo)
 *  - autosave to localStorage (debounced) + Recent list update
 *
 * Persistence shape:
 *   { app:"bytedoc", version:1, id, title, html, createdAt, updatedAt }
 */

import { topbar } from './app.js';
import { docs, file, nowIso } from './storage.js';
import { toast, prompt, confirm, showModal, showContextMenu, closeContextMenu, escapeHtml, uid, debounce } from './ui.js';

// Registry-Bootstrap muss in jedem App-Modul stehen — bei ES-Modul-Eval-Order
// (depth-first post-order) läuft doc.js + sheet.js vor app.js' Body, also kann
// hier window.ByteWorkz noch nicht existieren. Idempotent: erstes Modul gewinnt.
window.ByteWorkz = window.ByteWorkz || { apps: [] };

const APP_ID = 'doc';
const APP_TITLE = 'byteDoc';
const APP_MIME = 'bytedoc';
const APP_VERSION = 1;

const SAFE_PASTE_TAGS = new Set(['P','DIV','BR','B','STRONG','I','EM','U','S','STRIKE','H1','H2','H3','H4','UL','OL','LI','A','BLOCKQUOTE','TABLE','THEAD','TBODY','TR','TD','TH','SPAN','IMG']);
const STRIP_ATTRS = ['style','class','id','onclick','onload','onerror'];

// Undo/redo: per-tab linear history. Each entry is {html, sel}; the cursor
// indexes the "current" state. Branching is destroyed on the next commit
// after an undo (standard linear-history semantics). Cap at 100 to bound
// memory — at typical doc sizes (~5KB html + small selection), ~500 KB.
const HISTORY_LIMIT = 100;
const SNAPSHOT_IDLE_MS = 700;

const state = {
    container: null,
    editor: null,
    titleInput: null,
    indicator: null,
    statusBar: null,
    findBar: null,
    findInput: null,
    replaceInput: null,
    findHits: [],
    findIdx: -1,
    openDocs: [],     // [{id,title,html,createdAt,updatedAt,dirty,history}]
    activeId: null,
    saveDebounced: null,
    snapshotDebounced: null,
    mounted: false,
    selectedImg: null,
    imgResizeBox: null
};

/* ---------------- Undo / Redo (snapshot stack) ---------------- */

// Find-bar highlights are transient UI, not content. Strip <mark.find-hit>
// wrappers from any html we persist or snapshot — otherwise saving with the
// find bar open leaves the marks in localStorage and they survive reload.
function cleanHtml(html) {
    if (!html || html.indexOf('find-hit') === -1) return html;
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    tmp.querySelectorAll('mark.find-hit').forEach(m => {
        const t = document.createTextNode(m.textContent || '');
        m.replaceWith(t);
    });
    tmp.normalize();
    return tmp.innerHTML;
}

function nodePath(node) {
    const path = [];
    while (node && node !== state.editor) {
        const p = node.parentNode;
        if (!p) return null;
        path.unshift(Array.prototype.indexOf.call(p.childNodes, node));
        node = p;
    }
    return node === state.editor ? path : null;
}
function resolvePath(path) {
    if (!path) return null;
    let n = state.editor;
    for (const idx of path) {
        if (!n || !n.childNodes[idx]) return null;
        n = n.childNodes[idx];
    }
    return n;
}
function captureSelection() {
    if (!state.editor) return null;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!state.editor.contains(r.startContainer) || !state.editor.contains(r.endContainer)) return null;
    const startPath = nodePath(r.startContainer);
    const endPath = nodePath(r.endContainer);
    if (!startPath || !endPath) return null;
    return { startPath, startOffset: r.startOffset, endPath, endOffset: r.endOffset };
}
function restoreSelection(s) {
    if (!s) return;
    const start = resolvePath(s.startPath);
    const end = resolvePath(s.endPath);
    if (!start || !end) return;
    try {
        const r = document.createRange();
        const maxStart = start.nodeType === Node.TEXT_NODE ? start.nodeValue.length : start.childNodes.length;
        const maxEnd = end.nodeType === Node.TEXT_NODE ? end.nodeValue.length : end.childNodes.length;
        r.setStart(start, Math.min(s.startOffset, maxStart));
        r.setEnd(end, Math.min(s.endOffset, maxEnd));
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
    } catch {} // boundaries can race with DOM changes; silently skip
}

function ensureHistory(d) {
    if (!d.history) d.history = { stack: [], cursor: -1 };
    return d.history;
}
// Commit current editor state as a new history entry. No-op if identical to
// the existing cursor entry. Truncates any redo branch.
function commitSnapshot(d) {
    if (!d || !state.editor) return;
    const html = cleanHtml(state.editor.innerHTML);
    const h = ensureHistory(d);
    const cur = h.stack[h.cursor];
    if (cur && cur.html === html) return;
    h.stack = h.stack.slice(0, h.cursor + 1);
    h.stack.push({ html, sel: captureSelection() });
    h.cursor++;
    if (h.stack.length > HISTORY_LIMIT) {
        h.stack.shift();
        h.cursor--;
    }
}
function undo() {
    const d = active(); if (!d) return;
    if (state.snapshotDebounced) state.snapshotDebounced.cancel();
    // Commit any pending in-flight edits so the first Ctrl+Z undoes them as
    // their own discrete step rather than skipping past them.
    commitSnapshot(d);
    const h = ensureHistory(d);
    if (h.cursor <= 0) return;
    h.cursor--;
    const s = h.stack[h.cursor];
    clearImgSelection();
    state.editor.focus();
    state.editor.innerHTML = s.html;
    restoreSelection(s.sel);
    afterHistoryNav(d);
}
function redo() {
    const d = active(); if (!d) return;
    if (state.snapshotDebounced) state.snapshotDebounced.cancel();
    const h = ensureHistory(d);
    if (h.cursor >= h.stack.length - 1) return;
    h.cursor++;
    const s = h.stack[h.cursor];
    clearImgSelection();
    state.editor.focus();
    state.editor.innerHTML = s.html;
    restoreSelection(s.sel);
    afterHistoryNav(d);
}
function afterHistoryNav(d) {
    d.dirty = true;
    setIndicator('saving');
    renderTabs();
    updateWordCount();
    if (state.saveDebounced) state.saveDebounced();
}

function newDoc(title = 'Untitled') {
    return {
        id: uid('d'),
        title,
        html: '<p><br></p>',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        dirty: false
    };
}

// Persist an in-memory doc to localStorage in the canonical on-disk shape.
// Needed by every new-doc code path: without an immediate save, refresh on
// the canonical URL (#/doc/<id>) yields "Document not found".
// Pass { silent: true } for the first save of an empty new doc — keeps the
// abandoned Untitled out of the Recent list until the first real edit.
function persistDoc(d, opts) {
    return docs.save({
        app: APP_MIME, version: APP_VERSION,
        id: d.id, title: d.title,
        createdAt: d.createdAt, updatedAt: d.updatedAt,
        html: d.html
    }, opts);
}

function findOpen(id) { return state.openDocs.find(d => d.id === id) || null; }
function active() { return findOpen(state.activeId); }

/* ---------------- Mount / Unmount ---------------- */

function mount(container, params) {
    state.container = container;

    // First-time DOM build (or rebuild if cleared)
    if (!state.mounted) buildDOM();
    state.mounted = true;

    // Resolve which doc to show
    const id = params && params.id;
    if (id) {
        let d = findOpen(id);
        if (!d) {
            const stored = docs.load(id);
            if (stored && stored.app === APP_MIME) {
                d = { ...stored, dirty: false };
                state.openDocs.push(d);
            } else {
                toast('Document not found.', { kind: 'error' });
                location.hash = '#/';
                return;
            }
        }
        setActive(id);
    } else {
        // New empty doc — persist immediately so refresh works AND so the
        // canonical-URL-normalisation below doesn't kick off a second mount
        // that would race the in-memory state. {silent:true} keeps the
        // abandoned Untitled out of Recent until the first real edit.
        const d = newDoc();
        state.openDocs.push(d);
        persistDoc(d, { silent: true });
        setActive(d.id);
        history.replaceState(null, '', '#/doc/' + d.id);
    }

    renderTabs();
    renderTopbar();
    state.editor.focus();
}

function unmount() {
    // Capture the current editor html into the active doc, then flush the
    // pending debounced save so the user's last edits hit localStorage
    // before we tear down. Without this, rapid app-switches lose unsaved
    // changes (saveDebounced fires too late, against stale state).
    if (state.activeId && state.editor) {
        const cur = findOpen(state.activeId);
        if (cur) {
            cur.html = cleanHtml(state.editor.innerHTML);
            cur.updatedAt = nowIso();
            if (state.snapshotDebounced) state.snapshotDebounced.flush();
        }
    }
    if (state.saveDebounced) state.saveDebounced.flush();

    topbar.clearCenter();
    document.removeEventListener('keydown', onGlobalKey, true);
    state.mounted = false;
    clearImgSelection();
    if (state.container) state.container.innerHTML = '';
    closeContextMenu();
}

function buildDOM() {
    state.container.innerHTML = `
        <div class="doc-shell">
            ${toolbarHTML()}
            <div class="tabs-bar doc-tabs" id="doc-tabs"></div>
            <div class="doc-find-bar" id="doc-find-bar" hidden>
                <input type="text" id="doc-find-input" placeholder="Find…">
                <input type="text" id="doc-replace-input" placeholder="Replace with…">
                <span class="find-count" id="doc-find-count">0/0</span>
                <button class="btn-icon" id="doc-find-prev" title="Previous (Shift+Enter)">↑</button>
                <button class="btn-icon" id="doc-find-next" title="Next (Enter)">↓</button>
                <button class="btn-secondary" id="doc-replace-one">Replace</button>
                <button class="btn-secondary" id="doc-replace-all">All</button>
                <div class="spacer"></div>
                <button class="btn-icon" id="doc-find-close" title="Close (Esc)">✕</button>
            </div>
            <div class="doc-editor-wrap" id="doc-editor-wrap">
                <div class="doc-editor" id="doc-editor" contenteditable="true" spellcheck="true"></div>
            </div>
            <div class="status-bar" id="doc-status"></div>
        </div>
    `;

    state.editor = state.container.querySelector('#doc-editor');
    state.statusBar = state.container.querySelector('#doc-status');
    state.findBar = state.container.querySelector('#doc-find-bar');
    state.findInput = state.container.querySelector('#doc-find-input');
    state.replaceInput = state.container.querySelector('#doc-replace-input');

    bindToolbar();
    bindEditor();
    bindFindReplace();

    document.addEventListener('keydown', onGlobalKey, true);

    state.saveDebounced = debounce(() => {
        const d = active(); if (!d) return;
        d.html = cleanHtml(state.editor.innerHTML);
        d.updatedAt = nowIso();
        d.dirty = false;
        const payload = { app: APP_MIME, version: APP_VERSION, id: d.id, title: d.title, createdAt: d.createdAt, updatedAt: d.updatedAt, html: d.html };
        const ok = docs.save(payload);
        setIndicator(ok ? 'saved' : 'error');
    }, 900);

    // Capture a snapshot 700ms after the user stops typing. Anything sooner
    // floods the stack; anything later loses granularity. Structural ops
    // commit synchronously via commitSnapshot() and don't depend on this.
    state.snapshotDebounced = debounce(() => {
        commitSnapshot(active());
    }, SNAPSHOT_IDLE_MS);
}

function toolbarHTML() {
    return `
    <div class="toolbar doc-toolbar">
        <button class="btn-icon" data-action="undo" title="Undo (Ctrl+Z)">↶</button>
        <button class="btn-icon" data-action="redo" title="Redo (Ctrl+Y)">↷</button>
        <div class="btn-divider"></div>
        <select class="heading-pick" title="Block style">
            <option value="p">Paragraph</option>
            <option value="h1">Heading 1</option>
            <option value="h2">Heading 2</option>
            <option value="h3">Heading 3</option>
            <option value="blockquote">Quote</option>
        </select>
        <div class="btn-divider"></div>
        <button class="btn-icon" data-cmd="bold"      title="Bold (Ctrl+B)"><b>B</b></button>
        <button class="btn-icon" data-cmd="italic"    title="Italic (Ctrl+I)"><i>I</i></button>
        <button class="btn-icon" data-cmd="underline" title="Underline (Ctrl+U)"><u>U</u></button>
        <button class="btn-icon" data-cmd="strikeThrough" title="Strikethrough"><s>S</s></button>
        <div class="btn-divider"></div>
        <button class="btn-icon" data-cmd="insertUnorderedList" title="Bulleted list">•≡</button>
        <button class="btn-icon" data-cmd="insertOrderedList"   title="Numbered list">1.≡</button>
        <div class="btn-divider"></div>
        <button class="btn-icon" data-cmd="justifyLeft"   title="Align left">⯇</button>
        <button class="btn-icon" data-cmd="justifyCenter" title="Align center">≡</button>
        <button class="btn-icon" data-cmd="justifyRight"  title="Align right">⯈</button>
        <button class="btn-icon" data-cmd="justifyFull"   title="Justify">☷</button>
        <div class="btn-divider"></div>
        <button class="btn-icon" data-action="link"  title="Insert link">⛓</button>
        <button class="btn-icon" data-action="table" title="Insert table">▦</button>
        <button class="btn-icon" data-action="image" title="Insert image">🖼</button>
        <button class="btn-icon" data-cmd="removeFormat" title="Clear format">Tx</button>
        <div class="btn-divider"></div>
        <button class="btn-icon" data-action="find" title="Find &amp; Replace (Ctrl+F)">⌕</button>
        <button class="btn-icon" data-action="save" title="Download JSON (Ctrl+S)">⤓</button>
        <button class="btn-icon" data-action="open" title="Open file (Ctrl+O)">⤒</button>
        <button class="btn-icon" data-action="export-html" title="Export HTML">↗</button>
    </div>`;
}

function bindToolbar() {
    const tb = state.container.querySelector('.doc-toolbar');
    tb.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-cmd], button[data-action]');
        if (!btn) return;
        if (btn.dataset.cmd) {
            execCmd(btn.dataset.cmd);
        } else if (btn.dataset.action) {
            handleAction(btn.dataset.action);
        }
    });
    tb.querySelector('select.heading-pick').addEventListener('change', (e) => {
        const v = e.target.value;
        execCmd('formatBlock', v.toUpperCase());
        e.target.value = 'p';
    });
}

function execCmd(cmd, value = null) {
    state.editor.focus();
    // Commit any pending text-input snapshot so this formatting change is its
    // own discrete undo step, not merged with the preceding typing.
    if (state.snapshotDebounced) state.snapshotDebounced.flush();
    document.execCommand(cmd, false, value);
    markDirty();
    // Snapshot the post-format state right away — formatting ops fire input
    // events on most browsers, but we don't want to rely on that across all
    // execCommand variants.
    commitSnapshot(active());
}

function handleAction(action) {
    if (action === 'undo') return undo();
    if (action === 'redo') return redo();
    if (action === 'link') return doInsertLink();
    if (action === 'table') return doInsertTable();
    if (action === 'image') return doInsertImage();
    if (action === 'find') return toggleFind(true);
    if (action === 'save') return doDownload();
    if (action === 'open') return doOpen();
    if (action === 'export-html') return doExportHtml();
}

/* ---------------- Topbar (title + save indicator + word count) ---------------- */

function renderTopbar() {
    const wrap = document.createElement('div');
    wrap.style.display = 'flex'; wrap.style.gap = '8px'; wrap.style.alignItems = 'center';
    wrap.style.flex = '1'; wrap.style.minWidth = '0';
    wrap.innerHTML = `
        <input type="text" id="doc-title" class="doc-title-input" value="" placeholder="Untitled">
        <span id="doc-indicator" class="save-indicator" data-state="idle">●</span>
        <span style="flex:1"></span>
        <span id="doc-wc" class="topbar-version">0 words</span>
    `;
    topbar.setCenter(wrap);
    state.titleInput = document.getElementById('doc-title');
    state.indicator = document.getElementById('doc-indicator');

    state.titleInput.addEventListener('input', () => {
        const d = active(); if (!d) return;
        d.title = state.titleInput.value.trim() || 'Untitled';
        markDirty();
        renderTabs();
    });
    state.titleInput.addEventListener('blur', () => updateWordCount());
}

function setIndicator(stateName) {
    if (!state.indicator) return;
    state.indicator.dataset.state = stateName;
    state.indicator.title = stateName === 'saving' ? 'Saving…' : stateName === 'saved' ? 'Saved' : stateName === 'error' ? 'Save failed' : '';
}

/* ---------------- Tabs ---------------- */

function renderTabs() {
    const tabsEl = state.container.querySelector('#doc-tabs');
    tabsEl.innerHTML = '';
    state.openDocs.forEach(d => {
        const t = document.createElement('div');
        t.className = 'tab' + (d.id === state.activeId ? ' active' : '');
        t.innerHTML = `<span class="tab-title">${escapeHtml(d.title || 'Untitled')}${d.dirty ? ' •' : ''}</span><button class="tab-close" title="Close">✕</button>`;
        t.addEventListener('click', (e) => {
            if (e.target.closest('.tab-close')) return;
            setActive(d.id);
        });
        t.querySelector('.tab-close').addEventListener('click', async (e) => {
            e.stopPropagation();
            await closeTab(d.id);
        });
        tabsEl.appendChild(t);
    });
    const add = document.createElement('button');
    add.className = 'tab-add';
    add.textContent = '+';
    add.title = 'New document';
    add.addEventListener('click', () => {
        const d = newDoc();
        state.openDocs.push(d);
        persistDoc(d, { silent: true });
        setActive(d.id);
        renderTabs();
        history.replaceState(null, '', '#/doc/' + d.id);
    });
    tabsEl.appendChild(add);
}

function setActive(id) {
    // Save current first — capture editor html AND flush pending debounced save
    // so the outgoing tab's edits hit localStorage before we switch context.
    // Without the flush, the debounced save would fire later and operate on
    // the NEW active doc, losing the outgoing edits.
    if (state.activeId && state.activeId !== id) {
        const cur = findOpen(state.activeId);
        if (cur && state.editor) {
            cur.html = cleanHtml(state.editor.innerHTML);
            cur.updatedAt = nowIso();
            // Snapshot the outgoing tab's last state too — without this, edits
            // made right before tab-switch are lost from the undo stack of
            // the doc the user actually made them in.
            if (state.snapshotDebounced) state.snapshotDebounced.cancel();
            commitSnapshot(cur);
        }
        if (state.saveDebounced) state.saveDebounced.flush();
    }
    state.activeId = id;
    const d = active();
    if (!d) return;
    if (state.editor) state.editor.innerHTML = d.html || '<p><br></p>';
    if (state.titleInput) state.titleInput.value = d.title || '';
    setIndicator('idle');
    renderTabs();
    updateWordCount();
    clearImgSelection();
    closeFind();
    // Seed history on first activation. Subsequent activations inherit the
    // doc's existing stack (per-tab linear history).
    if (!d.history) commitSnapshot(d);
    // Update hash without retrigger
    if (location.hash !== '#/doc/' + id) history.replaceState(null, '', '#/doc/' + id);
}

async function closeTab(id) {
    const d = findOpen(id);
    if (!d) return;
    if (d.dirty) {
        const ok = await confirm({ title: 'Close document', message: `"${d.title}" has unsaved changes. Close anyway?`, danger: true, okLabel: 'Close' });
        if (!ok) return;
    }
    const idx = state.openDocs.findIndex(x => x.id === id);
    state.openDocs.splice(idx, 1);
    if (state.activeId === id) {
        if (state.openDocs.length === 0) {
            // No more docs — return to hub
            location.hash = '#/';
            return;
        }
        const next = state.openDocs[Math.min(idx, state.openDocs.length - 1)];
        setActive(next.id);
    } else {
        renderTabs();
    }
}

/* ---------------- Editor events ---------------- */

function bindEditor() {
    state.editor.addEventListener('input', () => {
        markDirty();
        updateWordCount();
        if (state.snapshotDebounced) state.snapshotDebounced();
    });
    state.editor.addEventListener('paste', onPaste);
    state.editor.addEventListener('click', onEditorClick);
    state.editor.addEventListener('contextmenu', onEditorContext);
}

function onPaste(e) {
    e.preventDefault();
    const cd = e.clipboardData;
    if (!cd) return;
    // Commit any pending text-input snapshot so the paste becomes a discrete
    // undo step rather than merging with the surrounding typing.
    if (state.snapshotDebounced) state.snapshotDebounced.flush();
    // Prefer text/html, sanitize.
    let html = cd.getData('text/html');
    if (html) {
        html = sanitizeHTML(html);
        document.execCommand('insertHTML', false, html);
    } else {
        const txt = cd.getData('text/plain');
        if (txt) document.execCommand('insertText', false, txt);
    }
    markDirty();
    commitSnapshot(active());
}

function sanitizeHTML(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    scrub(tmp);
    return tmp.innerHTML;
}
function scrub(node) {
    // Walk children; strip unknown tags by replacing with their text
    Array.from(node.children).forEach(child => {
        if (!SAFE_PASTE_TAGS.has(child.tagName)) {
            // Replace with text content
            const t = document.createTextNode(child.textContent || '');
            child.replaceWith(t);
        } else {
            // Strip dangerous/style attrs
            STRIP_ATTRS.forEach(a => child.removeAttribute(a));
            // Keep href for A only
            if (child.tagName !== 'A') child.removeAttribute('href');
            else {
                const href = child.getAttribute('href') || '';
                if (/^(javascript|data):/i.test(href)) child.removeAttribute('href');
            }
            scrub(child);
        }
    });
}

function onEditorClick(e) {
    closeContextMenu();
    if (e.target.tagName === 'IMG') {
        selectImg(e.target);
    } else {
        clearImgSelection();
    }
}

function onEditorContext(e) {
    // Show table context menu if inside a table
    const cell = e.target.closest('td,th');
    if (!cell) return;
    e.preventDefault();
    const table = cell.closest('table');
    const tr = cell.parentElement;
    showContextMenu(e.clientX, e.clientY, [
        { label: 'Insert row above',  onClick: () => insertRow(tr, 'above') },
        { label: 'Insert row below',  onClick: () => insertRow(tr, 'below') },
        { label: 'Insert column left',  onClick: () => insertCol(table, cellIndex(cell), 'left') },
        { label: 'Insert column right', onClick: () => insertCol(table, cellIndex(cell), 'right') },
        { sep: true },
        { label: 'Delete row',     onClick: () => { tr.remove(); if (!table.querySelector('tr')) table.remove(); markDirty(); commitSnapshot(active()); } },
        { label: 'Delete column',  onClick: () => deleteCol(table, cellIndex(cell)) },
        { label: 'Delete table',   onClick: () => { table.remove(); markDirty(); commitSnapshot(active()); } }
    ]);
}

function cellIndex(cell) {
    return Array.from(cell.parentElement.children).indexOf(cell);
}
// Table-structure edits don't fire `input` events on contenteditable, so we
// have to call commitSnapshot() ourselves — without it, undo would not see
// them at all.
function insertRow(tr, where) {
    const cols = tr.children.length;
    const newRow = document.createElement('tr');
    for (let i = 0; i < cols; i++) {
        const td = document.createElement('td');
        td.innerHTML = '<br>';
        newRow.appendChild(td);
    }
    if (where === 'above') tr.parentElement.insertBefore(newRow, tr);
    else tr.parentElement.insertBefore(newRow, tr.nextSibling);
    markDirty();
    commitSnapshot(active());
}
function insertCol(table, colIdx, where) {
    const rows = table.querySelectorAll('tr');
    rows.forEach(r => {
        const cell = r.children[colIdx];
        if (!cell) return;
        const tag = cell.tagName === 'TH' ? 'th' : 'td';
        const newCell = document.createElement(tag);
        newCell.innerHTML = '<br>';
        if (where === 'left') r.insertBefore(newCell, cell);
        else r.insertBefore(newCell, cell.nextSibling);
    });
    markDirty();
    commitSnapshot(active());
}
function deleteCol(table, colIdx) {
    const rows = table.querySelectorAll('tr');
    rows.forEach(r => { if (r.children[colIdx]) r.removeChild(r.children[colIdx]); });
    if (!table.querySelector('td,th')) table.remove();
    markDirty();
    commitSnapshot(active());
}

/* ---------------- Image select + resize ---------------- */

function selectImg(img) {
    clearImgSelection();
    state.selectedImg = img;
    img.classList.add('selected');
    showImgResizeBox(img);
}
function clearImgSelection() {
    if (state.selectedImg) state.selectedImg.classList.remove('selected');
    state.selectedImg = null;
    if (state.imgResizeBox) {
        // Run cleanup BEFORE removing the box so the registered listeners
        // are detached. Without this, every image click leaks 5 listeners
        // (2 on document for drag + 3 for scroll/resize reflow).
        if (typeof state.imgResizeBox._cleanup === 'function') state.imgResizeBox._cleanup();
        state.imgResizeBox.remove();
        state.imgResizeBox = null;
    }
}
function showImgResizeBox(img) {
    const box = document.createElement('div');
    box.className = 'img-resize-overlay';
    document.body.appendChild(box);
    state.imgResizeBox = box;
    positionResizeBox();

    let startX, startW, dragging = false;
    box.addEventListener('mousedown', (e) => {
        // The ::after handle is in the bottom-right corner — check coords
        const r = box.getBoundingClientRect();
        if (e.clientX > r.right - 12 && e.clientY > r.bottom - 12) {
            dragging = true;
            startX = e.clientX;
            startW = img.getBoundingClientRect().width;
            e.preventDefault();
        }
    });
    const onMove = (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const newW = Math.max(40, startW + dx);
        img.style.width = newW + 'px';
        img.style.height = 'auto';
        positionResizeBox();
    };
    const onUp = () => { if (dragging) { dragging = false; markDirty(); commitSnapshot(active()); } };
    const reflow = () => positionResizeBox();
    const editorWrap = document.querySelector('#doc-editor-wrap');

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    state.editor.addEventListener('scroll', reflow);
    if (editorWrap) editorWrap.addEventListener('scroll', reflow);
    window.addEventListener('resize', reflow);

    // ALL listeners get removed by clearImgSelection. Previous version only
    // listed mousemove/mouseup in _cleanup and never called it anyway.
    box._cleanup = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (state.editor) state.editor.removeEventListener('scroll', reflow);
        if (editorWrap) editorWrap.removeEventListener('scroll', reflow);
        window.removeEventListener('resize', reflow);
    };
}
function positionResizeBox() {
    if (!state.selectedImg || !state.imgResizeBox) return;
    const r = state.selectedImg.getBoundingClientRect();
    Object.assign(state.imgResizeBox.style, {
        left: r.left + 'px',
        top: r.top + 'px',
        width: r.width + 'px',
        height: r.height + 'px'
    });
}

/* ---------------- Insert link / table / image ---------------- */

async function doInsertLink() {
    const sel = window.getSelection();
    if (!sel || !state.editor.contains(sel.anchorNode)) {
        toast('Place cursor in the document first.', { kind: 'error' });
        return;
    }
    // Save range
    const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const url = await prompt({ title: 'Insert link', label: 'URL', placeholder: 'https://example.com' });
    if (!url) return;
    state.editor.focus();
    if (range) {
        const newSel = window.getSelection();
        newSel.removeAllRanges();
        newSel.addRange(range);
    }
    execCmd('createLink', url);
    // Add target=_blank
    const links = state.editor.querySelectorAll('a[href]');
    links.forEach(a => { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener'); });
    commitSnapshot(active());
}

async function doInsertTable() {
    let rows = 3, cols = 3;
    await showModal({
        title: 'Insert table',
        bodyHTML: `
            <div class="modal-row">
              <div><label>Rows</label><input type="number" id="tbl-rows" min="1" max="50" value="3"></div>
              <div><label>Columns</label><input type="number" id="tbl-cols" min="1" max="20" value="3"></div>
            </div>
            <label style="display:flex;gap:8px;align-items:center;">
              <input type="checkbox" id="tbl-header"> First row as header
            </label>
        `,
        actions: [
            { label: 'Cancel', kind: 'secondary' },
            { label: 'Insert', kind: 'primary', onClick: (close) => {
                rows = parseInt(document.getElementById('tbl-rows').value, 10) || 3;
                cols = parseInt(document.getElementById('tbl-cols').value, 10) || 3;
                const withHead = document.getElementById('tbl-header').checked;
                insertTableHTML(rows, cols, withHead);
                close();
            }}
        ]
    });
}

function insertTableHTML(rows, cols, withHead) {
    let html = '<table>';
    if (withHead && rows > 0) {
        html += '<thead><tr>';
        for (let c = 0; c < cols; c++) html += '<th>Header</th>';
        html += '</tr></thead>';
        rows -= 1;
    }
    html += '<tbody>';
    for (let r = 0; r < rows; r++) {
        html += '<tr>';
        for (let c = 0; c < cols; c++) html += '<td><br></td>';
        html += '</tr>';
    }
    html += '</tbody></table><p><br></p>';
    state.editor.focus();
    if (state.snapshotDebounced) state.snapshotDebounced.flush();
    document.execCommand('insertHTML', false, html);
    markDirty();
    commitSnapshot(active());
}

async function doInsertImage() {
    // pickImageAsDataURL spawns its own <input type=file> + FileReader and
    // returns a DataURL. The previous version also called file.openPicker
    // first, forcing the user to pick the same image twice. Removed.
    const dataURL = await pickImageAsDataURL();
    if (!dataURL) return;
    state.editor.focus();
    if (state.snapshotDebounced) state.snapshotDebounced.flush();
    document.execCommand('insertHTML', false, `<img src="${dataURL}" alt="">`);
    markDirty();
    commitSnapshot(active());
}
function pickImageAsDataURL() {
    return new Promise(resolve => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = 'image/*'; inp.style.display = 'none';
        inp.addEventListener('change', () => {
            const f = inp.files && inp.files[0];
            if (!f) { resolve(null); inp.remove(); return; }
            if (f.size > 8 * 1024 * 1024) {
                toast('Image too large (max 8 MB).', { kind: 'error' });
                resolve(null); inp.remove(); return;
            }
            const reader = new FileReader();
            reader.onload = () => { resolve(reader.result); inp.remove(); };
            reader.onerror = () => { toast('Could not read image.', { kind: 'error' }); resolve(null); inp.remove(); };
            reader.readAsDataURL(f);
        });
        document.body.appendChild(inp);
        inp.click();
    });
}

/* ---------------- Find / Replace ---------------- */

function toggleFind(show) {
    if (show) {
        state.findBar.hidden = false;
        state.findInput.focus();
        state.findInput.select();
        if (state.findInput.value) runFind();
    } else {
        closeFind();
    }
}
function closeFind() {
    if (!state.findBar) return;
    state.findBar.hidden = true;
    clearHighlights();
    state.findHits = [];
    state.findIdx = -1;
}

function bindFindReplace() {
    state.findInput.addEventListener('input', runFind);
    state.findInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) gotoFind(-1); else gotoFind(1);
        } else if (e.key === 'Escape') {
            closeFind();
        }
    });
    state.replaceInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeFind();
    });
    state.container.querySelector('#doc-find-prev').addEventListener('click', () => gotoFind(-1));
    state.container.querySelector('#doc-find-next').addEventListener('click', () => gotoFind(1));
    state.container.querySelector('#doc-find-close').addEventListener('click', closeFind);
    state.container.querySelector('#doc-replace-one').addEventListener('click', replaceOne);
    state.container.querySelector('#doc-replace-all').addEventListener('click', replaceAll);
}

function clearHighlights() {
    if (!state.editor) return;
    state.editor.querySelectorAll('mark.find-hit').forEach(m => {
        const t = document.createTextNode(m.textContent);
        m.replaceWith(t);
    });
    state.editor.normalize();
}

function runFind() {
    clearHighlights();
    const q = state.findInput.value;
    state.findHits = [];
    state.findIdx = -1;
    if (!q) { updateFindCount(); return; }

    const tw = document.createTreeWalker(state.editor, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
            return (n.parentElement && n.parentElement.closest('script,style')) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        }
    });
    const matches = []; // {node, start, end}
    const lcq = q.toLowerCase();
    let node;
    while ((node = tw.nextNode())) {
        const t = node.nodeValue;
        const lc = t.toLowerCase();
        let i = 0;
        while ((i = lc.indexOf(lcq, i)) !== -1) {
            matches.push({ node, start: i, end: i + q.length });
            i += q.length;
        }
    }
    // Wrap in reverse per-node to avoid index drift.
    const byNode = new Map();
    matches.forEach(m => {
        if (!byNode.has(m.node)) byNode.set(m.node, []);
        byNode.get(m.node).push(m);
    });
    byNode.forEach((arr, n) => {
        arr.sort((a, b) => b.start - a.start);
        arr.forEach(m => {
            const range = document.createRange();
            range.setStart(m.node, m.start);
            range.setEnd(m.node, m.end);
            const mark = document.createElement('mark');
            mark.className = 'find-hit';
            mark.textContent = range.toString();
            range.deleteContents();
            range.insertNode(mark);
            state.findHits.push(mark);
        });
    });
    // Sort hits in document order
    state.findHits = state.editor.querySelectorAll('mark.find-hit');
    state.findHits = Array.from(state.findHits);
    if (state.findHits.length) {
        state.findIdx = 0;
        markActive();
    }
    updateFindCount();
}

function markActive() {
    state.findHits.forEach((m, i) => m.classList.toggle('active', i === state.findIdx));
    const m = state.findHits[state.findIdx];
    if (m) m.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
function gotoFind(dir) {
    if (!state.findHits.length) return;
    state.findIdx = (state.findIdx + dir + state.findHits.length) % state.findHits.length;
    markActive();
    updateFindCount();
}
function updateFindCount() {
    state.container.querySelector('#doc-find-count').textContent = state.findHits.length ? `${state.findIdx + 1}/${state.findHits.length}` : '0/0';
}

function replaceOne() {
    if (state.findIdx < 0 || !state.findHits[state.findIdx]) return;
    const m = state.findHits[state.findIdx];
    const repl = state.replaceInput.value;
    const t = document.createTextNode(repl);
    m.replaceWith(t);
    state.editor.normalize();
    markDirty();
    commitSnapshot(active());
    runFind();
}
function replaceAll() {
    const q = state.findInput.value;
    if (!q) return;
    let n = 0;
    state.findHits.forEach(m => {
        m.replaceWith(document.createTextNode(state.replaceInput.value));
        n++;
    });
    state.editor.normalize();
    markDirty();
    commitSnapshot(active());
    runFind();
    toast(`Replaced ${n}.`, { kind: 'ok' });
}

/* ---------------- Save / open / export ---------------- */

function markDirty() {
    const d = active();
    if (!d) return;
    d.dirty = true;
    setIndicator('saving');
    renderTabs();
    state.saveDebounced && state.saveDebounced();
}
function updateWordCount() {
    const wc = document.getElementById('doc-wc');
    if (!wc || !state.editor) return;
    const text = state.editor.innerText || '';
    const words = (text.match(/\S+/g) || []).length;
    const chars = text.length;
    wc.textContent = `${words} words • ${chars} chars`;
    // status bar
    if (state.statusBar) {
        const paras = state.editor.querySelectorAll('p,h1,h2,h3,h4,li,td,th,blockquote').length;
        state.statusBar.innerHTML = `<span>${words} words</span><span>${chars} chars</span><span>${paras} blocks</span><span class="spacer"></span><span>byteDoc</span>`;
    }
}

function doDownload() {
    const d = active(); if (!d) return;
    // Force flush latest html (strip transient find-hit marks)
    d.html = cleanHtml(state.editor.innerHTML);
    d.updatedAt = nowIso();
    const payload = { app: APP_MIME, version: APP_VERSION, id: d.id, title: d.title, createdAt: d.createdAt, updatedAt: d.updatedAt, html: d.html };
    docs.save(payload);
    file.download(safeFilename(d.title) + '.bytedoc.json', payload);
    toast('Downloaded.', { kind: 'ok' });
}

async function doOpen() {
    const picked = await file.openPicker('.json,application/json');
    if (!picked || !picked.json) return;
    const j = picked.json;
    if (j.app !== APP_MIME) {
        toast('Not a byteDoc file.', { kind: 'error' });
        return;
    }
    const id = j.id || uid('d');
    j.id = id;
    j.updatedAt = nowIso();
    docs.save(j);
    // Open in new tab — docs.save above already persisted; just normalise URL
    const d = { ...j, dirty: false };
    state.openDocs.push(d);
    setActive(d.id);
    history.replaceState(null, '', '#/doc/' + d.id);
}

function doExportHtml() {
    const d = active(); if (!d) return;
    // Strip transient find-hit <mark> wrappers from the body — exported HTML
    // shouldn't carry our highlight class. cleanHtml() does this without
    // mutating the live editor.
    const body = cleanHtml(state.editor.innerHTML);
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(d.title)}</title>
<style>
body { font-family: -apple-system, system-ui, sans-serif; max-width: 760px; margin: 40px auto; padding: 0 16px; color:#111; line-height:1.65; }
h1,h2,h3 { line-height:1.2; }
table { border-collapse: collapse; }
table td, table th { border: 1px solid #ccc; padding: 6px 10px; }
table th { background:#f5f5f5; }
blockquote { border-left:3px solid #FD7D00; padding: 4px 14px; color:#555; }
img { max-width: 100%; }
a { color:#FD7D00; }
</style></head><body>
${body}
</body></html>`;
    file.download(safeFilename(d.title) + '.html', html, 'text/html');
    toast('HTML exported.', { kind: 'ok' });
}

function safeFilename(s) {
    return (s || 'untitled').replace(/[^\w\-]+/g, '_').slice(0, 60);
}

/* ---------------- Global keybindings ---------------- */

function onGlobalKey(e) {
    if (!state.mounted) return;
    // Only when this app's view is visible
    if (state.container.hidden) return;
    const meta = e.ctrlKey || e.metaKey;
    if (meta && e.key.toLowerCase() === 's') { e.preventDefault(); doDownload(); return; }
    if (meta && e.key.toLowerCase() === 'o') { e.preventDefault(); doOpen(); return; }
    if (meta && e.key.toLowerCase() === 'f') { e.preventDefault(); toggleFind(true); return; }
    // Intercept Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z BEFORE the browser's native
    // undo stack handles them — otherwise we get a doubled / confused state
    // where the browser undoes one execCommand step and our snapshot stack
    // undoes another.
    if (meta && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if (meta && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redo(); return; }
    if (e.key === 'Escape' && state.findBar && !state.findBar.hidden) { closeFind(); return; }
}

/* ---------------- Register ---------------- */

window.ByteWorkz.apps.push({
    id: APP_ID,
    title: APP_TITLE,
    mount, unmount
});
