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
import { toast, prompt, confirm, showModal, showContextMenu, closeContextMenu, escapeHtml, uid, debounce, tagEditorDialog } from './ui.js';

// Registry-Bootstrap muss in jedem App-Modul stehen — bei ES-Modul-Eval-Order
// (depth-first post-order) läuft doc.js + sheet.js vor app.js' Body, also kann
// hier window.ByteWorkz noch nicht existieren. Idempotent: erstes Modul gewinnt.
window.ByteWorkz = window.ByteWorkz || { apps: [] };

const APP_ID = 'doc';
const APP_TITLE = 'byteDoc';
const APP_MIME = 'bytedoc';
const APP_VERSION = 1;

const SAFE_PASTE_TAGS = new Set(['P','DIV','BR','B','STRONG','I','EM','U','S','STRIKE','H1','H2','H3','H4','UL','OL','LI','A','BLOCKQUOTE','TABLE','THEAD','TBODY','TR','TD','TH','SPAN','IMG','PRE','CODE']);
// Whitelist of attributes per tag. Everything else is stripped. The previous
// blacklist (style/class/id/onclick/onload/onerror) missed onmouseover,
// onfocus, onpointerdown, formaction, srcdoc, etc. — a hand-crafted
// .bytedoc.json with `<p onmouseover=...>` would XSS on load. Whitelist
// makes the attack surface enumerable.
const ATTR_WHITELIST = {
    A:   ['href', 'target', 'rel'],
    IMG: ['src', 'alt', 'width', 'height']
    // Everything else: zero attrs allowed.
};
// href schemes considered safe to keep on <a>. javascript:, data:, vbscript:
// all get stripped.
const SAFE_URL_RE = /^(https?:|mailto:|tel:|ftp:|#|\/|\.)/i;
// src schemes for <img>. data:image/* permits inline images (our paste flow
// stores images this way). data:text/html or anything else gets stripped.
const SAFE_IMG_RE = /^(data:image\/(png|jpe?g|gif|webp|svg\+xml|bmp);|https?:)/i;

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
    imgResizeBox: null,
    outlineOpen: true,   // toggleable, persisted via localStorage
    outlineIO: null      // IntersectionObserver for active-heading tracking
};

// Restore outline-open preference at module load.
try {
    state.outlineOpen = localStorage.getItem('byteworkz.doc.outlineOpen') !== '0';
} catch { /* localStorage blocked — defaults to open */ }

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
        tags: [],
        dirty: false
    };
}

// Persist an in-memory doc to localStorage in the canonical on-disk shape.
// Needed by every new-doc code path: without an immediate save, refresh on
// the canonical URL (#/doc/<id>) yields "Document not found".
// Pass { silent: true } for the first save of an empty new doc — keeps the
// abandoned Untitled out of the Recent list until the first real edit.
/* Single source of truth for the on-disk shape of a byteDoc — every save
 * path (debounced auto-save, explicit Ctrl+S download, tag-edit immediate
 * write) must go through this so we don't end up with one path silently
 * dropping a field that another path adds. Historically, adding `tags`
 * to two of three paths but not the third caused tags to be wiped on the
 * next keystroke; consolidating prevents that class of bug entirely. */
function docPayload(d) {
    return {
        app: APP_MIME, version: APP_VERSION,
        id: d.id, title: d.title,
        createdAt: d.createdAt, updatedAt: d.updatedAt,
        html: d.html,
        tags: Array.isArray(d.tags) ? d.tags : []
    };
}

function persistDoc(d, opts) {
    return docs.save(docPayload(d), opts);
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
    // Disconnect the outline IntersectionObserver — without this it keeps
    // holding refs to the detached editor headings and to its own closure
    // (containing state + editor refs), preventing GC across mount/unmount
    // cycles. Cumulative growth over many app switches in one session.
    if (state.outlineIO) { state.outlineIO.disconnect(); state.outlineIO = null; }
    // Clear activeId so that the next mount of any doc (including this same
    // one) properly populates the freshly-rebuilt editor. Without this, the
    // setActive early-return added above would short-circuit on remount and
    // leave the editor empty.
    state.activeId = null;
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
            <div class="doc-main-area">
                <div class="doc-editor-wrap" id="doc-editor-wrap">
                    <div class="doc-editor" id="doc-editor" contenteditable="true" spellcheck="true"></div>
                </div>
                <aside class="doc-outline" id="doc-outline" hidden>
                    <h3 class="outline-title">Outline</h3>
                    <ul class="outline-list" id="outline-list"></ul>
                </aside>
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
        const ok = docs.save(docPayload(d));
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
        <button class="btn-icon" data-action="code"  title="Insert code block">&lt;/&gt;</button>
        <button class="btn-icon" data-cmd="removeFormat" title="Clear format">Tx</button>
        <div class="btn-divider"></div>
        <button class="btn-icon" data-action="outline" title="Toggle outline">≡</button>
        <button class="btn-icon" data-action="find" title="Find &amp; Replace (Ctrl+F)">⌕</button>
        <button class="btn-icon" data-action="save" title="Download JSON (Ctrl+S)">⤓</button>
        <button class="btn-icon" data-action="open" title="Open file (Ctrl+O)">⤒</button>
        <button class="btn-icon" data-action="export-html" title="Export HTML">↗</button>
        <button class="btn-icon" data-action="export-md" title="Export Markdown">MD</button>
        <button class="btn-icon" data-action="tags" title="Edit tags">🏷</button>
        <button class="btn-icon" data-action="print" title="Print (Ctrl+P)">⎙</button>
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
    if (action === 'code') return doInsertCodeBlock();
    if (action === 'outline') return toggleOutline();
    if (action === 'find') return toggleFind(true);
    if (action === 'save') return doDownload();
    if (action === 'open') return doOpen();
    if (action === 'export-html') return doExportHtml();
    if (action === 'export-md') return doExportMarkdown();
    if (action === 'tags') return editDocTags();
    if (action === 'print') return window.print();
}

function doInsertCodeBlock() {
    state.editor.focus();
    if (state.snapshotDebounced) state.snapshotDebounced.flush();
    // The trailing <p><br></p> exists so the user can keep typing prose
    // after the code block — without it, the caret has no exit from <pre>
    // on Enter (which inside pre stays as a line break).
    document.execCommand('insertHTML', false, '<pre><code>// code</code></pre><p><br></p>');
    markDirty();
    commitSnapshot(active());
}

// Promise wrapper around FileReader for dataURL — used by drag-drop and
// clipboard-paste image handlers. Resolves to null on read failure (rather
// than rejecting) so multi-file batches don't abort on one bad file.
function readImageAsDataURL(file) {
    return new Promise(resolve => {
        if (file.size > 8 * 1024 * 1024) {
            toast(`Image "${file.name || 'unnamed'}" too large (max 8 MB).`, { kind: 'error' });
            resolve(null); return;
        }
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => resolve(null);
        r.readAsDataURL(file);
    });
}

// Caret position from screen coords — used to drop images where the
// pointer is, not at the end of the doc. Two APIs exist; the older
// Firefox one needs adaptation.
function caretRangeFromPoint(x, y) {
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    if (document.caretPositionFromPoint) {
        const pos = document.caretPositionFromPoint(x, y);
        if (!pos) return null;
        const r = document.createRange();
        r.setStart(pos.offsetNode, pos.offset);
        r.collapse(true);
        return r;
    }
    return null;
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
    // Idempotent: clicking the already-active tab is a no-op. Critical to
    // early-return here — without it, re-running the body would reset
    // editor.innerHTML from d.html, which only catches up to the editor
    // every 900ms via the debounced save. Anything typed in the last
    // 900ms would be lost on a same-tab click.
    if (state.activeId === id) return;
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
    // Sanitize on load too — not just on paste. A hand-crafted .bytedoc.json
    // (or a localStorage entry tampered with via DevTools, or an older doc
    // saved before sanitization was tightened) could otherwise XSS via
    // onmouseover/onpointerdown/img-onerror on the next mount.
    if (state.editor) state.editor.innerHTML = sanitizeHTML(d.html || '<p><br></p>') || '<p><br></p>';
    if (state.titleInput) state.titleInput.value = d.title || '';
    setIndicator('idle');
    renderTabs();
    updateWordCount();
    clearImgSelection();
    closeFind();
    // Seed history on first activation. Subsequent activations inherit the
    // doc's existing stack (per-tab linear history).
    if (!d.history) commitSnapshot(d);
    renderOutline();
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
        renderOutline();
        if (state.snapshotDebounced) state.snapshotDebounced();
    });
    state.editor.addEventListener('paste', onPaste);
    state.editor.addEventListener('click', onEditorClick);
    state.editor.addEventListener('contextmenu', onEditorContext);
    bindImageDrop();
    bindCodeBlockTab();
    bindMarkdownShortcuts();
}

/* ---------------- Markdown shortcuts ----------------
 *
 * Notion / GitHub-style typing affordances:
 *   `**bold**` + space          → <strong>bold</strong>
 *   `*italic*` + space          → <em>italic</em>
 *   `` `code` `` + space        → <code>code</code>
 *   `~~strike~~` + space        → <s>strike</s>
 *
 * Block triggers, only when typed at the start of an empty paragraph
 * (current block contains nothing but the trigger chars):
 *   `# `   → <h1>
 *   `## `  → <h2>
 *   `### ` → <h3>
 *   `> `   → <blockquote>
 *   `- `   → <ul><li>
 *   `1. `  → <ol><li>
 *
 * Triggered on keydown of the space key — by then the marker characters
 * are fully in the DOM. Inline transforms let the space insert naturally
 * (cursor lands after the wrapped element + space). Block transforms
 * preventDefault on the space and create a fresh empty block with the
 * caret inside, ready to type into.
 *
 * Inside <pre> / <code> the shortcuts are skipped — pre is a literal
 * region, transforming markers there would surprise users writing code.
 */

// Inline patterns: each entry tries to match against the text immediately
// before the cursor at the moment of space-keydown. \S guards at the
// inner edges enforce CommonMark-ish "no whitespace adjacent to marker"
// — `** X **` doesn't trigger, while `**X**` does.
const INLINE_MD_PATTERNS = [
    { re: /\*\*(\S(?:[^*]*\S)?)\*\*$/, tag: 'strong' },
    { re: /__(\S(?:[^_]*\S)?)__$/,     tag: 'strong' },
    { re: /(?<!\*)\*(\S(?:[^*]*\S)?)\*$/, tag: 'em' },
    { re: /(?<!_)_(\S(?:[^_]*\S)?)_$/,    tag: 'em' },
    { re: /`(\S(?:[^`]*\S)?)`$/,       tag: 'code' },
    { re: /~~(\S(?:[^~]*\S)?)~~$/,     tag: 's' }
];

function bindMarkdownShortcuts() {
    state.editor.addEventListener('keydown', (e) => {
        if (e.key !== ' ' || e.ctrlKey || e.metaKey || e.altKey) return;
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return;
        const range = sel.getRangeAt(0);
        if (!range.collapsed) return;
        const node = range.startContainer;
        if (isInsidePreOrCode(node)) return;
        if (tryBlockMarkdown()) {
            e.preventDefault();
            markDirty();
            updateWordCount();
            commitSnapshot(active());
            return;
        }
        if (tryInlineMarkdown()) {
            // Let the space insert naturally after the transform — cursor
            // is now positioned right after the wrapped element. Snapshot
            // committed after the natural space insert via the input event
            // → debounce; for finer-grained undo we also fire one here.
            markDirty();
            commitSnapshot(active());
        }
    });
}

function isInsidePreOrCode(node) {
    while (node && node !== state.editor) {
        if (node.nodeType === 1 && (node.tagName === 'PRE' || node.tagName === 'CODE')) return true;
        node = node.parentNode;
    }
    return false;
}

function tryInlineMarkdown() {
    const sel = window.getSelection();
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return false;
    const offset = range.startOffset;
    const before = node.textContent.slice(0, offset);
    for (const { re, tag } of INLINE_MD_PATTERNS) {
        const m = re.exec(before);
        if (!m) continue;
        const full = m[0];
        const inner = m[1];
        const r = document.createRange();
        r.setStart(node, offset - full.length);
        r.setEnd(node, offset);
        sel.removeAllRanges();
        sel.addRange(r);
        document.execCommand('insertHTML', false, `<${tag}>${escapeHtml(inner)}</${tag}>`);
        return true;
    }
    return false;
}

function tryBlockMarkdown() {
    const sel = window.getSelection();
    const range = sel.getRangeAt(0);
    // Find enclosing P/DIV (heading shortcuts only fire at the top of
    // plain blocks — not inside existing headings, lists, tables).
    let block = range.startContainer;
    if (block.nodeType === Node.TEXT_NODE) block = block.parentNode;
    while (block && block !== state.editor) {
        if (block.tagName === 'P' || block.tagName === 'DIV') break;
        block = block.parentNode;
    }
    if (!block || block === state.editor) return false;
    const trimmed = block.textContent.trim();
    let newTag = null;
    let listKind = null;
    if      (trimmed === '#')   newTag = 'h1';
    else if (trimmed === '##')  newTag = 'h2';
    else if (trimmed === '###') newTag = 'h3';
    else if (trimmed === '>')   newTag = 'blockquote';
    else if (trimmed === '-' || trimmed === '*') listKind = 'ul';
    else if (trimmed === '1.')  listKind = 'ol';
    if (!newTag && !listKind) return false;

    if (listKind) {
        const list = document.createElement(listKind);
        const li = document.createElement('li');
        li.innerHTML = '<br>';
        list.appendChild(li);
        block.parentNode.replaceChild(list, block);
        placeCaretAtStart(li);
        return true;
    }
    const next = document.createElement(newTag);
    next.innerHTML = '<br>';
    block.parentNode.replaceChild(next, block);
    placeCaretAtStart(next);
    return true;
}

function placeCaretAtStart(el) {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
}

/* ---------------- Outline (TOC sidebar) ----------------
 *
 * Right-rail sidebar listing every H1/H2/H3 in the doc. Click an entry to
 * smooth-scroll there (with a brief accent flash on the heading). An
 * IntersectionObserver watches headings as they enter / leave the
 * scrollable editor and marks the topmost-visible one as `.active`, so
 * the user sees where in the doc they are while scrolling.
 *
 * The outline auto-hides if the doc has fewer than 2 headings — short
 * docs don't need navigation. User toggle (toolbar button) overrides
 * and is persisted to localStorage.
 *
 * Heading IDs are runtime-assigned via `data-outline-id` so we can
 * cross-reference items in the list with the heading elements. IDs are
 * fresh per re-render; old ones are overwritten so stale entries can't
 * accumulate after edits.
 */

function renderOutline() {
    const aside = document.getElementById('doc-outline');
    const list = document.getElementById('outline-list');
    if (!aside || !list) return;
    const headings = state.editor.querySelectorAll('h1, h2, h3');
    // Auto-hide for tiny docs unless the user has explicitly opened the
    // outline — even then we still want to render the list so toggling on
    // shows it populated.
    if (headings.length < 2) {
        aside.hidden = true;
        return;
    }
    list.innerHTML = '';
    headings.forEach((h, idx) => {
        const oid = 'oh-' + idx;
        h.dataset.outlineId = oid;
        const li = document.createElement('li');
        li.className = 'outline-item ' + h.tagName.toLowerCase();
        li.dataset.target = oid;
        li.textContent = (h.textContent || '').trim() || '(empty)';
        li.title = li.textContent;
        li.addEventListener('click', () => {
            h.scrollIntoView({ behavior: 'smooth', block: 'start' });
            // Brief accent flash so the user's eye lands on what they jumped to.
            h.classList.add('outline-scrolled-to');
            setTimeout(() => h.classList.remove('outline-scrolled-to'), 800);
        });
        list.appendChild(li);
    });
    aside.hidden = !state.outlineOpen;
    bindOutlineActiveTracking();
}

function bindOutlineActiveTracking() {
    if (state.outlineIO) state.outlineIO.disconnect();
    const wrap = document.getElementById('doc-editor-wrap');
    if (!wrap) return;
    state.outlineIO = new IntersectionObserver((entries) => {
        // Pick the heading whose intersection ratio is highest among
        // currently-intersecting ones — that's the one the user is reading.
        // Updating with the latest entry alone misses cases where multiple
        // headings are visible at once.
        let bestEntry = null;
        for (const e of entries) {
            if (!e.isIntersecting) continue;
            if (!bestEntry || e.intersectionRatio > bestEntry.intersectionRatio) bestEntry = e;
        }
        if (!bestEntry) return;
        const oid = bestEntry.target.dataset.outlineId;
        document.querySelectorAll('.outline-item.active').forEach(li => li.classList.remove('active'));
        const li = document.querySelector(`.outline-item[data-target="${oid}"]`);
        if (li) li.classList.add('active');
    }, {
        root: wrap,
        threshold: [0, 0.5, 1.0],
        // Bias toward the top — a heading is "active" only when it's in
        // the top portion of the viewport (else we'd keep showing the
        // bottom-most-visible one which is rarely what the user is on).
        rootMargin: '0px 0px -60% 0px'
    });
    state.editor.querySelectorAll('h1, h2, h3').forEach(h => state.outlineIO.observe(h));
}

function toggleOutline() {
    state.outlineOpen = !state.outlineOpen;
    try { localStorage.setItem('byteworkz.doc.outlineOpen', state.outlineOpen ? '1' : '0'); } catch {}
    const aside = document.getElementById('doc-outline');
    if (aside) {
        const headings = state.editor.querySelectorAll('h1, h2, h3');
        aside.hidden = !state.outlineOpen || headings.length < 2;
    }
}

// Tab inside a <pre> should insert a tab character, not move focus or
// indent the whole document. Only intercepts when the caret is actually
// inside a pre — outside, default browser behaviour (focus next field).
function bindCodeBlockTab() {
    state.editor.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return;
        const sel = window.getSelection();
        if (!sel.rangeCount) return;
        let node = sel.getRangeAt(0).startContainer;
        while (node && node !== state.editor) {
            if (node.nodeType === 1 && node.tagName === 'PRE') {
                e.preventDefault();
                document.execCommand('insertText', false, e.shiftKey ? '' : '\t');
                return;
            }
            node = node.parentNode;
        }
    });
}

// Image drag-drop. Files-only — dragging text or html falls through to
// the browser's default contenteditable handler. Visual feedback (the
// .drag-over class) is gated through a counter because dragenter/leave
// fire on every child element traversal, which would otherwise flicker
// the highlight on/off as the pointer moves over child nodes.
function bindImageDrop() {
    let depth = 0;
    const hasFiles = (dt) => dt && Array.from(dt.types || []).includes('Files');
    state.editor.addEventListener('dragenter', (e) => {
        if (!hasFiles(e.dataTransfer)) return;
        e.preventDefault();
        depth++;
        state.editor.classList.add('drag-over');
    });
    state.editor.addEventListener('dragover', (e) => {
        if (hasFiles(e.dataTransfer)) e.preventDefault();  // allow drop
    });
    state.editor.addEventListener('dragleave', () => {
        depth = Math.max(0, depth - 1);
        if (depth === 0) state.editor.classList.remove('drag-over');
    });
    state.editor.addEventListener('drop', async (e) => {
        depth = 0;
        state.editor.classList.remove('drag-over');
        const files = e.dataTransfer && e.dataTransfer.files;
        if (!files || !files.length) return;
        const imgs = Array.from(files).filter(f => f.type.startsWith('image/'));
        if (!imgs.length) return;
        e.preventDefault();
        // Place caret at the drop point so the image lands where the
        // pointer was, not at the end of the doc.
        const range = caretRangeFromPoint(e.clientX, e.clientY);
        if (range && state.editor.contains(range.startContainer)) {
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        } else {
            state.editor.focus();
        }
        if (state.snapshotDebounced) state.snapshotDebounced.flush();
        const dataURLs = await Promise.all(imgs.map(readImageAsDataURL));
        const html = dataURLs.filter(Boolean).map(u => `<img src="${u}" alt="">`).join('');
        if (!html) return;
        document.execCommand('insertHTML', false, html);
        markDirty();
        commitSnapshot(active());
    });
}

function onPaste(e) {
    e.preventDefault();
    const cd = e.clipboardData;
    if (!cd) return;
    // Commit any pending text-input snapshot so the paste becomes a discrete
    // undo step rather than merging with the surrounding typing.
    if (state.snapshotDebounced) state.snapshotDebounced.flush();

    // Image-in-clipboard path — screenshots, copied images from browsers.
    // The browser exposes them through clipboardData.files. Process these
    // FIRST: when a user copies an image from a website, the clipboard
    // often contains both the image file AND an <img>-tag HTML fragment;
    // the HTML alternative would re-fetch the image at runtime (broken
    // offline, network round-trip even online), while files give us the
    // bytes we can inline as a DataURL right now.
    const imgFiles = cd.files && Array.from(cd.files).filter(f => f.type.startsWith('image/'));
    if (imgFiles && imgFiles.length) {
        Promise.all(imgFiles.map(readImageAsDataURL)).then(urls => {
            const html = urls.filter(Boolean).map(u => `<img src="${u}" alt="">`).join('');
            if (!html) return;
            document.execCommand('insertHTML', false, html);
            markDirty();
            commitSnapshot(active());
        });
        return;
    }

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
    if (!html) return '';
    const tmp = document.createElement('div');
    tmp.innerHTML = String(html);
    scrub(tmp);
    return tmp.innerHTML;
}
function scrubAttrs(el) {
    const allowed = ATTR_WHITELIST[el.tagName] || [];
    // Walk attrs in reverse — removeAttribute mutates the live NamedNodeMap.
    for (let i = el.attributes.length - 1; i >= 0; i--) {
        const a = el.attributes[i];
        if (!allowed.includes(a.name.toLowerCase())) {
            el.removeAttribute(a.name);
        }
    }
    if (el.tagName === 'A') {
        const href = el.getAttribute('href') || '';
        if (!SAFE_URL_RE.test(href)) {
            el.removeAttribute('href');
        } else {
            el.setAttribute('target', '_blank');
            el.setAttribute('rel', 'noopener noreferrer');
        }
    } else if (el.tagName === 'IMG') {
        const src = el.getAttribute('src') || '';
        if (!SAFE_IMG_RE.test(src)) el.removeAttribute('src');
    }
}
function scrub(node) {
    Array.from(node.children).forEach(child => {
        if (!SAFE_PASTE_TAGS.has(child.tagName)) {
            child.replaceWith(document.createTextNode(child.textContent || ''));
        } else {
            scrubAttrs(child);
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
    wc.textContent = `${words} words`;
    // status bar
    if (state.statusBar) {
        const paras = state.editor.querySelectorAll('p,h1,h2,h3,h4,li,td,th,blockquote').length;
        state.statusBar.innerHTML = `
            <span class="status-chip"><span class="status-label">W</span><strong>${words}</strong></span>
            <span class="status-chip"><span class="status-label">C</span><strong>${chars}</strong></span>
            <span class="status-chip"><span class="status-label">¶</span><strong>${paras}</strong></span>
            <span class="spacer"></span>
            <span class="status-brand">byteDoc</span>
        `;
    }
}

function doDownload() {
    const d = active(); if (!d) return;
    // Force flush latest html (strip transient find-hit marks)
    d.html = cleanHtml(state.editor.innerHTML);
    d.updatedAt = nowIso();
    const payload = docPayload(d);
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

/* ── Markdown export ─────────────────────────────────────────────────────
 * Convert the editor's contenteditable HTML to GitHub-flavored Markdown.
 * Recursive walk over the DOM tree — element handlers either delegate to
 * their children (most cases) or wrap them in MD syntax. Block-level
 * elements emit trailing blank lines; inline elements emit no whitespace
 * around themselves and let surrounding whitespace from text nodes survive.
 *
 * Deliberately conservative: any element we don't recognise gets its
 * children flattened, dropping the wrapper. That means an exported doc is
 * always valid Markdown even if the live document picks up wrapper tags
 * we don't list here.
 *
 * Not supported:
 *   - Nested ordered lists (numbering would need depth tracking)
 *   - Inline colours / sizes (no MD equivalent; lost on export)
 *   - <u> underline (no canonical MD; rendered as raw text)
 */
function htmlToMarkdown(html) {
    const sandbox = document.createElement('div');
    sandbox.innerHTML = cleanHtml(html);
    const out = walkMd(sandbox, { listDepth: 0, ordered: false, ordIdx: 0 }).trim();
    return out + '\n';
}

function walkMd(node, ctx) {
    if (node.nodeType === Node.TEXT_NODE) {
        // Inside a code block, raw text passes through verbatim; elsewhere
        // collapse runs of whitespace to a single space so the document
        // doesn't carry contenteditable's frequent stray whitespace.
        const t = node.textContent;
        return ctx.inCode ? t : t.replace(/\s+/g, ' ');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toLowerCase();
    const kids = (subCtx) => Array.from(node.childNodes).map(c => walkMd(c, subCtx || ctx)).join('');

    switch (tag) {
        case 'h1': return '\n# '   + kids().trim() + '\n\n';
        case 'h2': return '\n## '  + kids().trim() + '\n\n';
        case 'h3': return '\n### ' + kids().trim() + '\n\n';
        case 'h4': return '\n#### ' + kids().trim() + '\n\n';
        case 'p': case 'div': {
            const text = kids().trim();
            return text ? text + '\n\n' : '';
        }
        case 'br': return '  \n';
        case 'hr': return '\n---\n\n';
        case 'strong': case 'b': return '**' + kids() + '**';
        case 'em':     case 'i': return '*'  + kids() + '*';
        case 's': case 'strike': case 'del': return '~~' + kids() + '~~';
        case 'u': return kids();  // no MD equivalent; drop the wrapper
        case 'code': {
            // Inline code (not inside a <pre>) — wrap in single backticks. If
            // the content contains backticks, escalate to double-backticks.
            if (node.parentElement && node.parentElement.tagName.toLowerCase() === 'pre') {
                return kids({ ...ctx, inCode: true });
            }
            const inner = kids({ ...ctx, inCode: true });
            const fence = inner.includes('`') ? '``' : '`';
            return fence + inner + fence;
        }
        case 'pre': {
            // Detect language from class="language-xxx" (common across syntax
            // highlighters and matches the project's own code-block markup).
            let lang = '';
            const codeChild = node.querySelector('code');
            const cls = (codeChild && codeChild.className) || node.className || '';
            const m = cls.match(/language-([\w-]+)/);
            if (m) lang = m[1];
            const body = kids({ ...ctx, inCode: true }).replace(/\n+$/, '');
            return '\n```' + lang + '\n' + body + '\n```\n\n';
        }
        case 'blockquote': {
            const text = kids().trim();
            return text.split('\n').map(l => '> ' + l).join('\n') + '\n\n';
        }
        case 'a': {
            const href = node.getAttribute('href') || '';
            const txt = kids().trim() || href;
            return href ? `[${txt}](${href})` : txt;
        }
        case 'img': {
            const src = node.getAttribute('src') || '';
            const alt = (node.getAttribute('alt') || '').replace(/[\[\]]/g, '');
            return src ? `![${alt}](${src})` : '';
        }
        case 'ul': case 'ol': {
            const ordered = tag === 'ol';
            const items = Array.from(node.children).filter(c => c.tagName.toLowerCase() === 'li');
            const lines = items.map((li, idx) => {
                const marker = ordered ? `${idx + 1}.` : '-';
                const text = walkMd(li, { ...ctx, listDepth: ctx.listDepth + 1, ordered, ordIdx: idx }).trim();
                // Indent continuation lines so MD parsers keep the list item
                // attached. Two spaces is the gentle, widely-supported amount.
                const indented = text.replace(/\n/g, '\n  ');
                return `${marker} ${indented}`;
            });
            return '\n' + lines.join('\n') + '\n\n';
        }
        case 'li': return kids();
        case 'table': {
            const rows = Array.from(node.querySelectorAll('tr'));
            if (!rows.length) return '';
            const cells = rows.map(tr => Array.from(tr.children).map(c => walkMd(c, ctx).trim().replace(/\|/g, '\\|')));
            const cols = Math.max(...cells.map(r => r.length));
            const header = cells[0] || [];
            // Pad short rows to the max column count so GitHub MD doesn't
            // mis-align downstream cells.
            const pad = (row) => { while (row.length < cols) row.push(''); return row; };
            const headerLine = '| ' + pad([...header]).join(' | ') + ' |';
            const sepLine    = '| ' + Array(cols).fill('---').join(' | ') + ' |';
            const bodyLines  = cells.slice(1).map(r => '| ' + pad([...r]).join(' | ') + ' |');
            return '\n' + [headerLine, sepLine, ...bodyLines].join('\n') + '\n\n';
        }
        case 'td': case 'th': return kids();
        case 'tr': case 'tbody': case 'thead': case 'tfoot': return kids();
        case 'mark': case 'span': return kids();    // strip wrappers we don't model
        default: return kids();
    }
}

function doExportMarkdown() {
    const d = active(); if (!d) return;
    const md = htmlToMarkdown(state.editor.innerHTML);
    file.download(safeFilename(d.title) + '.md', md, 'text/markdown');
    toast('Markdown exported.', { kind: 'ok' });
}

/* Tag editor — delegates to the shared ui.js dialog. Marks the doc dirty
 * after every chip mutation so changes hit disk without waiting for the
 * usual debounced editor save. */
async function editDocTags() {
    const d = active(); if (!d) return;
    if (!Array.isArray(d.tags)) d.tags = [];
    await tagEditorDialog(d, () => {
        d.dirty = true;
        d.updatedAt = nowIso();
        persistDoc(d);
    });
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
