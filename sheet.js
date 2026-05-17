/* byteworkz/sheet.js — byteSheet spreadsheet (self-registers into ByteWorkz.apps).
 *
 * Document shape:
 *   { app:"bytesheet", version:1, id, title, createdAt, updatedAt,
 *     activeSheet: 0,
 *     sheets: [{
 *       name, cols, rows,
 *       cells: { "A1": { v?, f?, s?:{b,i,a,c,bg,nf} } },
 *       charts: [{ id, kind, range:{sheet,start,end}, anchor:{x,y,w,h}, title }]
 *     }]
 *   }
 *
 *  - v   = raw user-entered value (string)
 *  - f   = formula (string, no leading '='); when set, v is the cached display value
 *  - s   = style: b/i bool, a:'l'|'c'|'r', c/bg: color hex, nf:''|'0.00'|'%'|'€'
 *
 * Engine: cells store the raw input. On commit, we tokenize formulas, evaluate,
 * track deps in a reverse-dep Map, and recompute affected cells topologically.
 */

import { topbar } from './app.js';
import { docs, file, nowIso } from './storage.js';
import {
    toast, prompt, confirm, showModal,
    showContextMenu, closeContextMenu,
    escapeHtml, uid, debounce,
    tagEditorDialog
} from './ui.js';
import { evaluate, colToNum, numToCol, splitRef, rewriteFormula, refToString, rangeToString, shiftRef, shiftRange } from './sheet-formula.js';
import { parseCSV, csvToCellsObj } from './csv.js';
import { evaluateCondRule, refInCondRange, shiftRangeStr, describeRule } from './cond-format.js';

// Siehe Kommentar in doc.js — Registry-Bootstrap idempotent in jedem App-Modul.
window.ByteWorkz = window.ByteWorkz || { apps: [] };

const APP_ID = 'sheet';
const APP_TITLE = 'byteSheet';
const APP_MIME = 'bytesheet';
const APP_VERSION = 1;

const DEFAULT_COLS = 26;
const DEFAULT_ROWS = 100;
const COL_WIDTH = 92;
const ROW_HEIGHT = 22;
const ROW_HEAD_WIDTH = 36;

// Undo/redo cap. Each snapshot deep-clones the whole sheets tree
// (~5-100KB for typical docs). Bounded memory: 100 × ~50KB = ~5MB.
const HISTORY_LIMIT = 100;

// Wrapper around structuredClone with a JSON-fallback for older browsers.
// state.doc only contains JSON-safe types (no DOM refs, no functions), so
// JSON.parse(JSON.stringify) is semantically equivalent — just slower.
function deepClone(x) {
    if (typeof structuredClone === 'function') return structuredClone(x);
    return JSON.parse(JSON.stringify(x));
}

const state = {
    container: null,
    doc: null,
    activeRef: 'A1',
    selStart: 'A1',
    selEnd: 'A1',
    editing: false,
    editorEl: null,
    computed: new Map(),     // key sheetIdx!REF → { value, error? }
    revDeps: new Map(),      // key sheetIdx!REF → Set<dependent key>
    formulaDeps: new Map(),  // key sheetIdx!REF → Set<source key>  (forward, for cleanup)
    titleInput: null,
    indicator: null,
    formulaInput: null,
    cellRefLabel: null,
    saveDebounced: null,
    mounted: false,
    gridWrap: null,
    gridTable: null,
    statusBar: null,
    chartLayer: null,
    sheetTabsEl: null,
    fillHandle: null,    // DOM overlay div positioned at selection's bottom-right
    fillDrag: null,      // in-progress drag state: {srcBounds, fillRange, direction}
    history: { stack: [], cursor: -1 }  // undo/redo linear-history stack
};

/* ---------------- Doc init ---------------- */

function newDoc() {
    return {
        app: APP_MIME, version: APP_VERSION,
        id: uid('s'),
        title: 'Untitled Sheet',
        createdAt: nowIso(), updatedAt: nowIso(),
        activeSheet: 0,
        sheets: [newSheet('Sheet1')]
    };
}
function newSheet(name) {
    return { name, cols: DEFAULT_COLS, rows: DEFAULT_ROWS, cells: {}, charts: [], merges: [] };
}
function activeSheet() { return state.doc.sheets[state.doc.activeSheet]; }

// Pick the lowest 'SheetN' name that isn't already taken. Naive `Sheet${len+1}`
// collides after the user has deleted a middle sheet — e.g. starting with
// [Sheet1, Sheet2, Sheet3], delete Sheet2 → length 2, next would be "Sheet3"
// which already exists. Formula cross-sheet refs match by name and findIndex
// returns the first match — so a name collision silently corrupts every
// formula targeting the duplicated name.
function nextSheetName() {
    let n = state.doc.sheets.length + 1;
    while (state.doc.sheets.some(s => s.name === `Sheet${n}`)) n++;
    return `Sheet${n}`;
}
// Pick a "(copy)" name that doesn't collide. Same correctness reasoning as
// nextSheetName — duplicating "Sheet1" twice would otherwise produce two
// sheets both named "Sheet1 (copy)".
function uniqueCopyName(baseName) {
    let candidate = `${baseName} (copy)`;
    let n = 2;
    while (state.doc.sheets.some(s => s.name === candidate)) {
        candidate = `${baseName} (copy ${n++})`;
    }
    return candidate;
}

/* ---------------- Mount / Unmount ---------------- */

function mount(container, params) {
    state.container = container;

    // Build DOM (once)
    if (!state.mounted) buildDOM();
    state.mounted = true;

    // Flush any pending save from a PREVIOUS doc that's about to be replaced —
    // otherwise the debounced save would later fire against the new state.doc
    // and the previous doc's edits would be lost. saveDebounced is created in
    // buildDOM, so it always exists at this point.
    if (state.doc && state.saveDebounced) state.saveDebounced.flush();

    // Load doc
    const id = params && params.id;
    if (id) {
        const stored = docs.load(id);
        if (!stored || stored.app !== APP_MIME) {
            toast('Sheet not found.', { kind: 'error' });
            location.hash = '#/';
            return;
        }
        state.doc = ensureShape(stored);
    } else {
        state.doc = newDoc();
        // Persist immediately so refresh on the canonical URL works AND the
        // synchronous-feeling history.replaceState (silent, no hashchange)
        // doesn't kick off a second mount that would race the in-memory state.
        // {silent:true} keeps the abandoned Untitled out of Recent until the
        // first real edit triggers an ordinary save via markDirty.
        docs.save(state.doc, { silent: true });
        history.replaceState(null, '', '#/sheet/' + state.doc.id);
    }

    state.activeRef = 'A1';
    state.selStart = 'A1';
    state.selEnd = 'A1';

    fullRecompute();
    renderTopbar();
    renderGrid();
    renderSheetTabs();
    syncFormulaBar();
    renderCharts();

    document.addEventListener('keydown', onGlobalKey, true);
    state.gridWrap.focus();

    // Fresh history per mount — opening a different doc shouldn't carry
    // over undo state from the previous doc. Initial snapshot seeds the
    // stack so the first user edit has a baseline to undo back to.
    state.history = { stack: [], cursor: -1 };
    commitSnapshot();
}

function unmount() {
    // Flush any pending save so the user's last edits hit localStorage
    // before we tear down. Without this, rapid app-switches lose recent
    // changes (the debounce timer never fires).
    if (state.saveDebounced) state.saveDebounced.flush();

    topbar.clearCenter();
    document.removeEventListener('keydown', onGlobalKey, true);
    state.mounted = false;
    // Fill-handle was a child of the about-to-be-cleared container; null
    // the ref so the next mount creates a fresh overlay attached to the
    // freshly-built gridWrap.
    state.fillHandle = null;
    state.fillDrag = null;
    if (state.container) state.container.innerHTML = '';
    closeContextMenu();
}

function ensureShape(doc) {
    doc.sheets = doc.sheets || [newSheet('Sheet1')];
    doc.sheets.forEach(s => {
        s.cells = s.cells || {};
        s.cols = s.cols || DEFAULT_COLS;
        s.rows = s.rows || DEFAULT_ROWS;
        s.charts = s.charts || [];
        s.condFormat = s.condFormat || [];
        s.freeze = s.freeze || { rows: 0, cols: 0 };
        s.merges = s.merges || [];
    });
    doc.activeSheet = Math.min(Math.max(0, doc.activeSheet || 0), doc.sheets.length - 1);
    doc.names = doc.names || {}; // workbook-wide named ranges → target text
    doc.tags = Array.isArray(doc.tags) ? doc.tags : [];
    return doc;
}

function buildDOM() {
    state.container.innerHTML = `
        <div class="sheet-shell">
            ${toolbarHTML()}
            <div class="sheet-formula-bar">
                <div class="cell-ref-label" id="sheet-cell-ref">A1</div>
                <input type="text" id="sheet-formula-input" placeholder='Type a value or =formula (e.g. =SUM(A1:A5))' spellcheck="false">
            </div>
            <div class="sheet-grid-wrap" id="sheet-grid-wrap" tabindex="0">
                <table class="sheet-grid" id="sheet-grid"></table>
                <div class="chart-layer" id="sheet-chart-layer"></div>
            </div>
            <div class="sheet-tabs" id="sheet-tabs"></div>
            <div class="status-bar" id="sheet-status"></div>
        </div>
    `;
    state.formulaInput = state.container.querySelector('#sheet-formula-input');
    state.cellRefLabel = state.container.querySelector('#sheet-cell-ref');
    state.gridWrap = state.container.querySelector('#sheet-grid-wrap');
    state.gridTable = state.container.querySelector('#sheet-grid');
    state.statusBar = state.container.querySelector('#sheet-status');
    state.sheetTabsEl = state.container.querySelector('#sheet-tabs');
    state.chartLayer = state.container.querySelector('#sheet-chart-layer');

    bindToolbar();
    bindFormulaBar();
    bindGridEvents();

    state.saveDebounced = debounce(saveNow, 700);
}

function toolbarHTML() {
    return `
    <div class="toolbar sheet-toolbar">
        <button class="btn-icon" data-action="undo" title="Undo (Ctrl+Z)">↶</button>
        <button class="btn-icon" data-action="redo" title="Redo (Ctrl+Y)">↷</button>
        <div class="btn-divider"></div>
        <button class="btn-icon" data-fmt="b"   title="Bold"><b>B</b></button>
        <button class="btn-icon" data-fmt="i"   title="Italic"><i>I</i></button>
        <div class="btn-divider"></div>
        <button class="btn-icon" data-align="l" title="Align left">⯇</button>
        <button class="btn-icon" data-align="c" title="Align center">≡</button>
        <button class="btn-icon" data-align="r" title="Align right">⯈</button>
        <div class="btn-divider"></div>
        <label title="Text color" style="display:flex;align-items:center;gap:4px;font-size:12px;">A<input type="color" data-color-target="c" value="#e8eef1"></label>
        <label title="Background"  style="display:flex;align-items:center;gap:4px;font-size:12px;">▣<input type="color" data-color-target="bg" value="#0f1f26"></label>
        <button class="btn-icon" data-clear-format title="Clear format">Tx</button>
        <div class="btn-divider"></div>
        <select id="number-format" title="Number format">
            <option value="">Default</option>
            <option value="0.00">0.00</option>
            <option value="0">Integer</option>
            <option value="%">Percent</option>
            <option value="€">Currency €</option>
            <option value="$">Currency $</option>
            <option value="date">Date</option>
        </select>
        <div class="btn-divider"></div>
        <button class="btn-icon" data-action="sort-asc"  title="Sort column ascending">↑a</button>
        <button class="btn-icon" data-action="sort-desc" title="Sort column descending">↓a</button>
        <button class="btn-icon" data-action="filter"    title="Filter column">⌄</button>
        <button class="btn-icon" data-action="cond-format" title="Conditional formatting">CF</button>
        <button class="btn-icon" data-action="freeze-row" title="Freeze top row">⇊R</button>
        <button class="btn-icon" data-action="freeze-col" title="Freeze first column">⇉C</button>
        <button class="btn-icon" data-action="merge"      title="Merge cells">⊟</button>
        <button class="btn-icon" data-action="unmerge"    title="Unmerge">⊞</button>
        <button class="btn-icon" data-action="names"      title="Named ranges">Nm</button>
        <button class="btn-icon" data-action="note"       title="Add / edit note">💬</button>
        <button class="btn-icon" data-action="tags"       title="Edit tags">🏷</button>
        <div class="btn-divider"></div>
        <button class="btn-icon" data-action="insert-chart" title="Insert chart">📊</button>
        <button class="btn-icon" data-action="insert-row"   title="Insert row above">+R</button>
        <button class="btn-icon" data-action="insert-col"   title="Insert column left">+C</button>
        <button class="btn-icon" data-action="delete-row"   title="Delete row">−R</button>
        <button class="btn-icon" data-action="delete-col"   title="Delete column">−C</button>
        <div class="btn-divider"></div>
        <button class="btn-icon" data-action="save"       title="Download JSON (Ctrl+S)">⤓</button>
        <button class="btn-icon" data-action="open"       title="Open file (Ctrl+O)">⤒</button>
        <button class="btn-icon" data-action="export-csv" title="Export CSV">CSV</button>
        <button class="btn-icon" data-action="print"      title="Print (Ctrl+P)">⎙</button>
    </div>`;
}

function bindToolbar() {
    const tb = state.container.querySelector('.sheet-toolbar');
    tb.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        if (btn.dataset.fmt)          return toggleFormat(btn.dataset.fmt);
        if (btn.dataset.align)        return setAlign(btn.dataset.align);
        if (btn.dataset.clearFormat !== undefined) return clearFormat();
        if (btn.dataset.action)       return handleAction(btn.dataset.action);
    });
    tb.querySelectorAll('input[type="color"]').forEach(inp => {
        inp.addEventListener('change', () => setStyleField(inp.dataset.colorTarget, inp.value));
    });
    tb.querySelector('#number-format').addEventListener('change', (e) => {
        setStyleField('nf', e.target.value);
    });
}

function handleAction(action) {
    switch (action) {
        case 'undo':         return undo();
        case 'redo':         return redo();
        case 'save':         return doDownload();
        case 'open':         return doOpen();
        case 'export-csv':   return doExportCSV();
        case 'print':        return window.print();
        case 'sort-asc':     return sortByActiveCol(true);
        case 'sort-desc':    return sortByActiveCol(false);
        case 'filter':       return showFilterPopover();
        case 'cond-format':  return showCondFormatDialog();
        case 'freeze-row':   return toggleFreezeRow();
        case 'freeze-col':   return toggleFreezeCol();
        case 'merge':        return mergeSelection();
        case 'unmerge':      return unmergeAtActive();
        case 'names':        return showNamesDialog();
        case 'note':         return editActiveNote();
        case 'tags':         return editDocTags();
        case 'insert-chart': return insertChartDialog();
        case 'insert-row':   return insertRowAtActive();
        case 'insert-col':   return insertColAtActive();
        case 'delete-row':   return deleteActiveRow();
        case 'delete-col':   return deleteActiveCol();
    }
}

/* ---------------- Topbar ---------------- */

function renderTopbar() {
    const wrap = document.createElement('div');
    wrap.style.display = 'flex'; wrap.style.gap = '8px'; wrap.style.alignItems = 'center';
    wrap.style.flex = '1'; wrap.style.minWidth = '0';
    wrap.innerHTML = `
        <input type="text" id="sheet-title" class="doc-title-input" value="" placeholder="Untitled Sheet">
        <span id="sheet-indicator" class="save-indicator" data-state="idle">●</span>
    `;
    topbar.setCenter(wrap);
    state.titleInput = document.getElementById('sheet-title');
    state.indicator = document.getElementById('sheet-indicator');
    state.titleInput.value = state.doc.title;
    state.titleInput.addEventListener('input', () => {
        state.doc.title = state.titleInput.value.trim() || 'Untitled Sheet';
        markDirty();
    });
}
function setIndicator(s) {
    if (!state.indicator) return;
    state.indicator.dataset.state = s;
}

/* ---------------- Grid render ---------------- */

function renderGrid() {
    const sh = activeSheet();
    const cols = sh.cols, rows = sh.rows;
    const fr = (sh.freeze && sh.freeze.rows) || 0;
    const fc = (sh.freeze && sh.freeze.cols) || 0;
    // Pre-compute merge anchors + skipped cells so the inner loop stays cheap.
    // anchorSpan: anchor-ref → {cs, rs}; skip: refs to omit entirely (they're
    // covered by the anchor's colspan/rowspan).
    const anchorSpan = new Map();
    const skip = new Set();
    if (sh.merges && sh.merges.length) {
        for (const m of sh.merges) {
            const b = mergeBox(m);
            anchorSpan.set(numToCol(b.c1) + b.r1, { cs: b.c2 - b.c1 + 1, rs: b.r2 - b.r1 + 1 });
            for (let r = b.r1; r <= b.r2; r++) {
                for (let c = b.c1; c <= b.c2; c++) {
                    if (r === b.r1 && c === b.c1) continue;
                    skip.add(numToCol(c) + r);
                }
            }
        }
    }
    let html = '';
    // header row
    html += '<thead><tr><th class="sheet-corner"></th>';
    for (let c = 1; c <= cols; c++) {
        const cls = c <= fc ? ' class="is-frozen-col-head"' : '';
        html += `<th${cls} data-col="${c}" style="min-width:${COL_WIDTH}px;width:${COL_WIDTH}px">${numToCol(c)}</th>`;
    }
    html += '</tr></thead><tbody>';
    for (let r = 1; r <= rows; r++) {
        const rowCls = r <= fr ? ' class="is-frozen-row"' : '';
        html += `<tr${rowCls}><th class="row-head${r <= fr ? ' is-frozen-row-head' : ''}" data-row="${r}">${r}</th>`;
        for (let c = 1; c <= cols; c++) {
            const ref = numToCol(c) + r;
            if (skip.has(ref)) continue;
            const sp = anchorSpan.get(ref);
            const attrs = sp
                ? ` colspan="${sp.cs}" rowspan="${sp.rs}" class="is-merged"`
                : '';
            html += `<td${attrs} data-ref="${ref}"></td>`;
        }
        html += '</tr>';
    }
    html += '</tbody>';
    state.gridTable.innerHTML = html;
    // Set actual width hint
    state.gridTable.style.width = (ROW_HEAD_WIDTH + cols * COL_WIDTH) + 'px';
    paintAllCells();
    updateSelectionVisual();
    updateStatusBar();
    applyFilter();
    updateFreezeButtonState();
}

function updateFreezeButtonState() {
    if (!state.container) return;
    const sh = activeSheet();
    const fr = (sh.freeze && sh.freeze.rows) || 0;
    const fc = (sh.freeze && sh.freeze.cols) || 0;
    const btnR = state.container.querySelector('button[data-action="freeze-row"]');
    const btnC = state.container.querySelector('button[data-action="freeze-col"]');
    if (btnR) btnR.classList.toggle('active', fr > 0);
    if (btnC) btnC.classList.toggle('active', fc > 0);
}

function toggleFreezeRow() {
    commitEdit();
    const sh = activeSheet();
    sh.freeze = sh.freeze || { rows: 0, cols: 0 };
    sh.freeze.rows = sh.freeze.rows ? 0 : 1;
    renderGrid();
    markDirty();
    commitSnapshot();
    toast(sh.freeze.rows ? 'Top row frozen' : 'Top row unfrozen');
}

function toggleFreezeCol() {
    commitEdit();
    const sh = activeSheet();
    sh.freeze = sh.freeze || { rows: 0, cols: 0 };
    sh.freeze.cols = sh.freeze.cols ? 0 : 1;
    renderGrid();
    markDirty();
    commitSnapshot();
    toast(sh.freeze.cols ? 'First column frozen' : 'First column unfrozen');
}

/* ── Merge / unmerge ─────────────────────────────────────────────────────
 * Merge takes the current selection bounds, validates it (must span >1 cell
 * and not overlap any existing merge), then collapses all but the top-left
 * cell into the anchor — non-anchor cell data is wiped so we don't carry
 * hidden ghost values past an unmerge later. Unmerge simply drops the
 * merge entry whose rectangle contains the active ref. */
function mergeSelection() {
    commitEdit();
    const sh = activeSheet();
    sh.merges = sh.merges || [];
    const b = selectionBounds();
    if (b.c1 === b.c2 && b.r1 === b.r2) {
        toast('Select 2+ cells to merge.', { kind: 'error' });
        return;
    }
    // Reject overlap with an existing merge (avoid nested / crossing merges).
    for (const m of sh.merges) {
        if (rectsOverlap(b, mergeBox(m))) {
            toast('Selection overlaps an existing merge.', { kind: 'error' });
            return;
        }
    }
    // Wipe data in non-anchor cells. The anchor keeps its value/formula.
    const anchorRef = numToCol(b.c1) + b.r1;
    for (let r = b.r1; r <= b.r2; r++) {
        for (let c = b.c1; c <= b.c2; c++) {
            const ref = numToCol(c) + r;
            if (ref === anchorRef) continue;
            delete sh.cells[ref];
        }
    }
    sh.merges.push({ a: anchorRef, b: numToCol(b.c2) + b.r2 });
    state.activeRef = anchorRef;
    state.selStart = anchorRef;
    state.selEnd = numToCol(b.c2) + b.r2;
    fullRecompute();
    renderGrid();
    markDirty();
    commitSnapshot();
    toast('Cells merged.');
}

/* ── Cell notes (comments) ───────────────────────────────────────────────
 * One free-text annotation per cell, stored as cell.n. Displays as a small
 * orange triangle in the top-right corner (CSS `::after`) and the browser's
 * native `title` tooltip on hover — no custom popup, keeps things accessible
 * and zero-listener. Empty / cleared note removes the field entirely.
 *
 * Notes survive both clear-contents (v/f removed) and clear-format (s
 * removed). To remove the note itself, open the dialog and submit empty. */
/* Tag editor — same shape used in doc.js. Operates on state.doc.tags
 * (array of strings). Chips list current tags with × to remove; input below
 * adds a new tag on Enter or blur. Normalises to lowercase, trims, dedupes,
 * caps tag length to 20 chars + max 8 tags per doc. */
async function editDocTags() {
    commitEdit();
    state.doc.tags = Array.isArray(state.doc.tags) ? state.doc.tags : [];
    await tagEditorDialog(state.doc, () => { markDirty(); saveNow(); });
}

async function editActiveNote() {
    commitEdit();
    const ref = state.activeRef;
    const sh = activeSheet();
    const current = (sh.cells[ref] && sh.cells[ref].n) || '';
    const result = await prompt({
        title: `Note for ${ref}`,
        label: 'Empty value removes the note.',
        initial: current,
        placeholder: 'e.g. "Provisional figure — confirm with finance"'
    });
    if (result === null) return; // cancel
    const text = result.trim();
    if (text) {
        sh.cells[ref] = sh.cells[ref] || {};
        sh.cells[ref].n = text;
    } else if (sh.cells[ref]) {
        delete sh.cells[ref].n;
        if (!sh.cells[ref].v && !sh.cells[ref].f && !sh.cells[ref].s) delete sh.cells[ref];
    }
    paintCell(ref);
    markDirty();
    commitSnapshot();
    toast(text ? 'Note saved.' : 'Note removed.');
}

function unmergeAtActive() {
    commitEdit();
    const sh = activeSheet();
    sh.merges = sh.merges || [];
    const idx = findMergeIndex(sh, state.activeRef);
    if (idx < 0) { toast('Active cell is not in a merge.', { kind: 'error' }); return; }
    sh.merges.splice(idx, 1);
    renderGrid();
    markDirty();
    commitSnapshot();
    toast('Cells unmerged.');
}

/* Apply rowOp/colOp to all merge rectangles on the modified sheet. When a
 * row/col inside a merge is deleted the corresponding op returns null for
 * that line; we shrink the merge to skip that line instead of dropping the
 * whole merge — only if BOTH corners along an axis are invalidated do we
 * give up on the merge. Collapsed (single-cell) results are dropped too. */
function shiftMerges({ rowOp, colOp, modifiedSheetIdx }) {
    const sh = state.doc.sheets[modifiedSheetIdx];
    if (!sh || !sh.merges || !sh.merges.length) return;
    // Walk all values inside [lo, hi], applying op, collecting non-null.
    // Returns null if every value invalidates (the entire axis is gone).
    const shrinkAxis = (lo, hi, op) => {
        if (!op) return [lo, hi];
        const survivors = [];
        for (let v = lo; v <= hi; v++) {
            const nv = op(v);
            if (nv != null) survivors.push(nv);
        }
        if (!survivors.length) return null;
        return [Math.min(...survivors), Math.max(...survivors)];
    };
    sh.merges = sh.merges.filter(m => {
        const box = mergeBox(m);
        const cols = shrinkAxis(box.c1, box.c2, colOp);
        if (!cols) return false;
        const rows = shrinkAxis(box.r1, box.r2, rowOp);
        if (!rows) return false;
        const [c1, c2] = cols, [r1, r2] = rows;
        if (c1 === c2 && r1 === r2) return false; // collapsed → not a merge
        m.a = numToCol(c1) + r1;
        m.b = numToCol(c2) + r2;
        return true;
    });
}

// Apply the active sheet's persistent filter (if any) by hiding rows whose
// column value isn't in the allowed-set. Called after every renderGrid so
// the filter survives sheet switches, structural edits, save/load, etc.
function applyFilter() {
    const sh = activeSheet();
    if (!sh.filter) return;
    const { col, allowed } = sh.filter;
    const allowedSet = new Set(allowed);
    const trs = state.gridTable.tBodies[0].rows;
    for (let i = 0; i < trs.length; i++) {
        const head = trs[i].querySelector('th.row-head');
        if (!head) continue;
        const r = parseInt(head.dataset.row, 10);
        if (r === 1) { trs[i].style.display = ''; continue; }
        const ref = col + r;
        const cell = sh.cells[ref];
        const v = cell
            ? (cell.f != null ? state.computed.get(cellKey(state.doc.activeSheet, ref))?.value : cell.v)
            : '';
        const key = v == null ? '' : String(v);
        trs[i].style.display = allowedSet.has(key) ? '' : 'none';
    }
}

function paintAllCells() {
    const sh = activeSheet();
    Object.keys(sh.cells).forEach(ref => paintCell(ref));
}

function paintCell(ref) {
    const td = state.gridTable.querySelector(`td[data-ref="${ref}"]`);
    if (!td) return;
    const sh = activeSheet();
    const cell = sh.cells[ref];
    // Reset
    td.className = '';
    td.style.color = '';
    td.style.background = '';

    // Re-apply freeze classes after the className reset above. Freeze state
    // lives on the sheet, not the cell, so it must survive any cell repaint.
    const fr = (sh.freeze && sh.freeze.rows) || 0;
    const fc = (sh.freeze && sh.freeze.cols) || 0;
    if (fr || fc) {
        const [col, rowStr] = splitRef(ref);
        const r = parseInt(rowStr, 10);
        const cn = colToNum(col);
        const inFR = r <= fr;
        const inFC = cn <= fc;
        if (inFR && inFC) td.classList.add('is-frozen-corner');
        else if (inFR)    td.classList.add('is-frozen-row-cell');
        else if (inFC)    td.classList.add('is-frozen-col-cell');
    }

    // Compute the value we'll evaluate CF against. Empty cells get `null`
    // (so they match `empty` rules); formula errors → null (so `> 0` won't
    // match an #ERROR! cell); raw values pass through verbatim.
    let display = '';
    let hasError = false;
    let condValue = null;
    if (cell) {
        if (cell.f != null) {
            const k = state.doc.activeSheet + '!' + ref;
            const c = state.computed.get(k);
            if (c && c.error) { display = c.value; hasError = true; }
            else if (c) { display = formatValue(c.value, cell.s); condValue = c.value; }
            else display = '';
        } else {
            display = formatValue(cell.v, cell.s);
            condValue = cell.v;
        }
        td.textContent = display;
        const isNum = isNumericDisplay(cell, display);
        if (isNum) td.classList.add('is-number');
        if (cell.s) {
            if (cell.s.b) td.classList.add('is-bold');
            if (cell.s.i) td.classList.add('is-italic');
            if (cell.s.a) td.classList.add('al-' + cell.s.a);
            if (cell.s.c)  td.style.color = cell.s.c;
            if (cell.s.bg) td.style.background = cell.s.bg;
        }
        if (hasError) td.classList.add('has-error');
    } else {
        td.textContent = '';
    }

    // Cell-note indicator + native hover tooltip. Notes survive
    // clear-contents and clear-format, so a cell with only a note still
    // shows the triangle on an otherwise-blank cell.
    if (cell && cell.n) {
        td.classList.add('has-note');
        td.title = cell.n;
    } else {
        td.removeAttribute('title');
    }

    // Conditional-format rules — applied AFTER the user's cell.s so a
    // matching rule overrides user style for that cell. Matches Excel-
    // style precedence: CF wins until the user manually re-styles a cell
    // outside the rule range (in which case the rule no longer applies).
    // refInCondRange is a cheap bounds check first; evaluateCondRule
    // only runs if the cell is actually in range.
    if (sh.condFormat && sh.condFormat.length) {
        for (const cf of sh.condFormat) {
            if (!refInCondRange(ref, cf.range)) continue;
            if (!evaluateCondRule(condValue, cf.rule)) continue;
            const s = cf.style || {};
            if (s.bg) td.style.background = s.bg;
            if (s.c)  td.style.color = s.c;
            if (s.b)  td.classList.add('is-bold');
            if (s.i)  td.classList.add('is-italic');
        }
    }
}

function isNumericDisplay(cell, display) {
    if (typeof display === 'number') return true;
    if (display === '' || display == null) return false;
    if (typeof display === 'string' && /^-?\d/.test(display) && !isNaN(parseFloat(display))) return true;
    return false;
}

function formatValue(v, style) {
    if (v == null || v === '') return '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    const nf = style && style.nf;
    if (typeof v === 'number') {
        if (!isFinite(v)) return String(v);
        if (nf === '0.00') return v.toFixed(2);
        if (nf === '0')    return Math.round(v).toString();
        if (nf === '%')    return (v * 100).toFixed(1) + '%';
        if (nf === '€')    return v.toFixed(2) + ' €';
        if (nf === '$')    return '$' + v.toFixed(2);
        if (nf === 'date') {
            // treat as days from epoch in JS (ms) — but practically v is a real number; format as YYYY-MM-DD
            try { return new Date(v).toISOString().slice(0, 10); } catch { return String(v); }
        }
        // sensible default
        if (Math.abs(v) >= 1e15 || (Math.abs(v) < 1e-4 && v !== 0)) return v.toExponential(4);
        // strip trailing zeros for non-integers
        let s = String(v);
        if (s.indexOf('.') >= 0) s = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
        return s;
    }
    return String(v);
}

/* ---------------- Selection ---------------- */

function bindGridEvents() {
    state.gridTable.addEventListener('mousedown', (e) => {
        const td = e.target.closest('td[data-ref]');
        if (td) {
            commitEdit();
            // If the clicked cell is a merge anchor, expand selection to cover
            // the full rectangle so operations on selection (delete, clear,
            // copy) act on the whole merge — not just the anchor cell.
            const sh = activeSheet();
            const ref = td.dataset.ref;
            const mIdx = findMergeIndex(sh, ref);
            const mb = mIdx >= 0 ? mergeBox(sh.merges[mIdx]) : null;
            const farRef = mb ? numToCol(mb.c2) + mb.r2 : ref;
            if (e.shiftKey) {
                state.selEnd = farRef;
                state.activeRef = ref;
            } else {
                state.activeRef = ref;
                state.selStart = ref;
                state.selEnd = farRef;
            }
            updateSelectionVisual();
            syncFormulaBar();
            // Drag-select
            let dragging = true;
            const onMove = (ev) => {
                if (!dragging) return;
                const el = document.elementFromPoint(ev.clientX, ev.clientY);
                const cell = el && el.closest && el.closest('td[data-ref]');
                if (cell) {
                    const r2 = cell.dataset.ref;
                    // If the drag passes over a merged-anchor cell, snap the
                    // selection end to that merge's far corner so the visual
                    // range includes the full merge.
                    const shD = activeSheet();
                    const mi = findMergeIndex(shD, r2);
                    if (mi >= 0) {
                        const b = mergeBox(shD.merges[mi]);
                        state.selEnd = numToCol(b.c2) + b.r2;
                    } else {
                        state.selEnd = r2;
                    }
                    updateSelectionVisual();
                    syncFormulaBar();
                }
            };
            const onUp = () => {
                dragging = false;
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            e.preventDefault();
            return;
        }
        const colHead = e.target.closest('th[data-col]');
        if (colHead) {
            const c = parseInt(colHead.dataset.col, 10);
            selectWholeCol(c);
            return;
        }
        const rowHead = e.target.closest('th[data-row]');
        if (rowHead) {
            const r = parseInt(rowHead.dataset.row, 10);
            selectWholeRow(r);
            return;
        }
    });
    state.gridTable.addEventListener('dblclick', (e) => {
        const td = e.target.closest('td[data-ref]');
        if (td) startEdit(td.dataset.ref, false);
    });
    state.gridTable.addEventListener('contextmenu', (e) => {
        const td = e.target.closest('td[data-ref]');
        if (!td) return;
        e.preventDefault();
        if (!isInSelection(td.dataset.ref)) {
            state.activeRef = td.dataset.ref;
            state.selStart = state.selEnd = td.dataset.ref;
            updateSelectionVisual(); syncFormulaBar();
        }
        showContextMenu(e.clientX, e.clientY, [
            { label: 'Cut',          onClick: () => doCut() },
            { label: 'Copy',         onClick: () => doCopy() },
            { label: 'Paste',        onClick: () => doPaste() },
            { sep: true },
            { label: 'Clear contents', onClick: () => clearSelection() },
            { label: 'Clear format',   onClick: () => clearFormat() },
            { sep: true },
            { label: 'Insert row above',   onClick: () => insertRowAtActive() },
            { label: 'Insert column left', onClick: () => insertColAtActive() },
            { label: 'Delete row',         onClick: () => deleteActiveRow() },
            { label: 'Delete column',      onClick: () => deleteActiveCol() },
            { sep: true },
            { label: 'Merge cells',        onClick: () => mergeSelection() },
            { label: 'Unmerge cells',      onClick: () => unmergeAtActive() },
            { sep: true },
            { label: 'Edit note…',         onClick: () => editActiveNote() }
        ]);
    });
}

function selectWholeCol(c) {
    const sh = activeSheet();
    const colL = numToCol(c);
    state.activeRef = colL + '1';
    state.selStart = colL + '1';
    state.selEnd = colL + sh.rows;
    updateSelectionVisual(); syncFormulaBar();
}
function selectWholeRow(r) {
    const sh = activeSheet();
    state.activeRef = 'A' + r;
    state.selStart = 'A' + r;
    state.selEnd = numToCol(sh.cols) + r;
    updateSelectionVisual(); syncFormulaBar();
}

/* ── Merges helpers ──────────────────────────────────────────────────────
 * sh.merges is `[{a, b}]` where a/b are the two corners (any order). The
 * "anchor" of a merge is the top-left cell — that's where the value lives
 * and where the rendered <td> with colspan/rowspan sits; all other cells in
 * the rectangle are skipped during renderGrid. */
function mergeBox(m) {
    const [cA, rA] = splitRef(m.a);
    const [cB, rB] = splitRef(m.b);
    const cAn = colToNum(cA), cBn = colToNum(cB);
    return {
        c1: Math.min(cAn, cBn), c2: Math.max(cAn, cBn),
        r1: Math.min(rA, rB),   r2: Math.max(rA, rB)
    };
}
function mergeAnchor(m) {
    const b = mergeBox(m);
    return numToCol(b.c1) + b.r1;
}
function findMergeIndex(sh, ref) {
    if (!sh.merges) return -1;
    const [c, r] = splitRef(ref);
    const cn = colToNum(c);
    for (let i = 0; i < sh.merges.length; i++) {
        const b = mergeBox(sh.merges[i]);
        if (cn >= b.c1 && cn <= b.c2 && r >= b.r1 && r <= b.r2) return i;
    }
    return -1;
}
function rectsOverlap(a, b) {
    return !(a.c2 < b.c1 || b.c2 < a.c1 || a.r2 < b.r1 || b.r2 < a.r1);
}
/* Move the active ref out of a merge's interior, snapping it to the
 * merge's anchor. Used by mousedown / arrow-nav / extend-selection so the
 * cursor never lands on a cell that isn't actually rendered. */
function resolveActiveRef(ref) {
    const sh = activeSheet();
    const idx = findMergeIndex(sh, ref);
    if (idx < 0) return ref;
    return mergeAnchor(sh.merges[idx]);
}

function selectionBounds() {
    const [cA, rA] = splitRef(state.selStart);
    const [cB, rB] = splitRef(state.selEnd);
    const cAn = colToNum(cA), cBn = colToNum(cB);
    return {
        c1: Math.min(cAn, cBn), c2: Math.max(cAn, cBn),
        r1: Math.min(rA, rB),   r2: Math.max(rA, rB)
    };
}
function isInSelection(ref) {
    const [c, r] = splitRef(ref);
    const cn = colToNum(c);
    const b = selectionBounds();
    return cn >= b.c1 && cn <= b.c2 && r >= b.r1 && r <= b.r2;
}
function forEachInSelection(fn) {
    const b = selectionBounds();
    for (let r = b.r1; r <= b.r2; r++) {
        for (let cn = b.c1; cn <= b.c2; cn++) {
            fn(numToCol(cn) + r);
        }
    }
}

function updateSelectionVisual() {
    const tds = state.gridTable.querySelectorAll('td.sel, td.in-range');
    tds.forEach(t => { t.classList.remove('sel'); t.classList.remove('in-range'); });
    // Clear previous row/col header highlights — Excel-style "where am I?"
    // indicator. Re-applied below based on current selection bounds.
    state.gridTable.querySelectorAll('th.is-active-header').forEach(th => th.classList.remove('is-active-header'));
    const b = selectionBounds();
    for (let r = b.r1; r <= b.r2; r++) {
        for (let cn = b.c1; cn <= b.c2; cn++) {
            const ref = numToCol(cn) + r;
            const td = state.gridTable.querySelector(`td[data-ref="${ref}"]`);
            if (!td) continue;
            if (ref === state.activeRef) td.classList.add('sel');
            else td.classList.add('in-range');
        }
    }
    // Highlight column headers in selection range
    for (let cn = b.c1; cn <= b.c2; cn++) {
        const colTh = state.gridTable.querySelector(`thead th[data-col="${cn}"]`);
        if (colTh) colTh.classList.add('is-active-header');
    }
    // Highlight row headers in selection range
    for (let r = b.r1; r <= b.r2; r++) {
        const rowTh = state.gridTable.querySelector(`tbody th.row-head[data-row="${r}"]`);
        if (rowTh) rowTh.classList.add('is-active-header');
    }
    // Scroll active into view
    const activeTd = state.gridTable.querySelector(`td[data-ref="${state.activeRef}"]`);
    if (activeTd) scrollIntoViewIfNeeded(activeTd);
    if (state.cellRefLabel) state.cellRefLabel.textContent = state.activeRef;
    renderFillHandle();
}

/* ---------------- Fill handle (Excel-style drag-fill) ---------------- */

function renderFillHandle() {
    if (!state.gridWrap || !state.gridTable) return;
    // Anchor at the bottom-right of the current selection (not just active
    // cell — multi-cell selections fill from the whole range).
    const b = selectionBounds();
    let cornerRef = numToCol(b.c2) + b.r2;
    let td = state.gridTable.querySelector(`td[data-ref="${cornerRef}"]`);
    // If the bottom-right corner is a non-rendered cell of a merge (its TD
    // is covered by the anchor's colspan/rowspan), fall back to the merge's
    // anchor TD — that's the cell whose visual bottom-right we should pin to.
    if (!td) {
        const sh = activeSheet();
        const mi = findMergeIndex(sh, cornerRef);
        if (mi >= 0) {
            const anchor = mergeAnchor(sh.merges[mi]);
            td = state.gridTable.querySelector(`td[data-ref="${anchor}"]`);
        }
    }
    if (!td) {
        if (state.fillHandle) state.fillHandle.hidden = true;
        return;
    }
    // Lazy-create the handle. Recreate if it got detached (post-unmount
    // / post-buildDOM the old reference is stale).
    if (!state.fillHandle || !state.gridWrap.contains(state.fillHandle)) {
        state.fillHandle = document.createElement('div');
        state.fillHandle.className = 'fill-handle';
        state.fillHandle.addEventListener('mousedown', onFillDragStart);
        state.gridWrap.appendChild(state.fillHandle);
    }
    // Position content-relative: td.getBoundingClientRect() is viewport-
    // relative, so subtract gridWrap rect and add scroll offsets to land
    // in scrolled-content coordinates.
    const tdR = td.getBoundingClientRect();
    const wrapR = state.gridWrap.getBoundingClientRect();
    state.fillHandle.style.left = (tdR.right  - wrapR.left + state.gridWrap.scrollLeft - 5) + 'px';
    state.fillHandle.style.top  = (tdR.bottom - wrapR.top  + state.gridWrap.scrollTop  - 5) + 'px';
    state.fillHandle.hidden = false;
}

function onFillDragStart(e) {
    e.preventDefault();
    e.stopPropagation();
    commitEdit();
    state.fillDrag = {
        srcBounds: selectionBounds(),
        fillRange: null,
        direction: null,
        lastTargetRef: null
    };
    state.fillHandle.classList.add('dragging');
    document.addEventListener('mousemove', onFillDragMove);
    document.addEventListener('mouseup', onFillDragEnd);
}

function onFillDragMove(e) {
    if (!state.fillDrag) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const td = el && el.closest && el.closest('td[data-ref]');
    if (!td) return;
    const targetRef = td.dataset.ref;
    if (targetRef === state.fillDrag.lastTargetRef) return;
    state.fillDrag.lastTargetRef = targetRef;
    computeFillPreview(targetRef);
}

function computeFillPreview(targetRef) {
    const src = state.fillDrag.srcBounds;
    const [tCol, tRow] = splitRef(targetRef);
    const tCn = colToNum(tCol);
    // Direction by which extreme of target falls outside source. If the
    // target is inside source bounds in both axes, no fill (shrink-fill
    // semantics are out of scope for v1).
    let direction = null;
    let fillRange = null;
    if (tRow > src.r2) {
        direction = 'down';
        fillRange = { c1: src.c1, c2: src.c2, r1: src.r2 + 1, r2: tRow };
    } else if (tRow < src.r1) {
        direction = 'up';
        fillRange = { c1: src.c1, c2: src.c2, r1: tRow, r2: src.r1 - 1 };
    } else if (tCn > src.c2) {
        direction = 'right';
        fillRange = { c1: src.c2 + 1, c2: tCn, r1: src.r1, r2: src.r2 };
    } else if (tCn < src.c1) {
        direction = 'left';
        fillRange = { c1: tCn, c2: src.c1 - 1, r1: src.r1, r2: src.r2 };
    }
    state.fillDrag.direction = direction;
    state.fillDrag.fillRange = fillRange;
    // Clear previous preview classes; apply to new range.
    state.gridTable.querySelectorAll('td.fill-preview').forEach(t => t.classList.remove('fill-preview'));
    if (!fillRange) return;
    for (let r = fillRange.r1; r <= fillRange.r2; r++) {
        for (let cn = fillRange.c1; cn <= fillRange.c2; cn++) {
            const ref = numToCol(cn) + r;
            const td = state.gridTable.querySelector(`td[data-ref="${ref}"]`);
            if (td) td.classList.add('fill-preview');
        }
    }
}

function onFillDragEnd() {
    document.removeEventListener('mousemove', onFillDragMove);
    document.removeEventListener('mouseup', onFillDragEnd);
    if (state.fillHandle) state.fillHandle.classList.remove('dragging');
    state.gridTable.querySelectorAll('td.fill-preview').forEach(t => t.classList.remove('fill-preview'));
    const drag = state.fillDrag;
    state.fillDrag = null;
    if (!drag || !drag.fillRange || !drag.direction) return;
    applyFill(drag.srcBounds, drag.fillRange, drag.direction);
}

/* ---- Fill-application logic ----
 *
 * Strategy per cross-axis line (one column for vertical fills, one row for
 * horizontal):
 *   1. Read the source line's cells along the fill axis.
 *   2. If all cells are numeric AND form an arithmetic progression, treat
 *      as a series — extrapolate by `step` past the last source value.
 *   3. Otherwise: wrap-copy source modulo source-length. Formula cells get
 *      their relative refs shifted by the per-target row/col delta from
 *      the source cell they were copied from.
 *
 * `idx` is the 0-based distance from the source-edge of the fill, growing
 * outward. So fillRange[0] is the cell immediately adjacent to source. */
function applyFill(srcBounds, fillRange, direction) {
    const sh = activeSheet();
    const isVertical = direction === 'down' || direction === 'up';
    const goingForward = direction === 'down' || direction === 'right';

    // Pre-analyse each cross-axis line of the source — vertical fill: one
    // analysis per column; horizontal: one per row.
    const analyses = new Map();
    if (isVertical) {
        for (let cn = srcBounds.c1; cn <= srcBounds.c2; cn++) {
            const cells = [];
            for (let r = srcBounds.r1; r <= srcBounds.r2; r++) {
                cells.push(sh.cells[numToCol(cn) + r] || null);
            }
            analyses.set(cn, analyzeSeries(cells));
        }
    } else {
        for (let r = srcBounds.r1; r <= srcBounds.r2; r++) {
            const cells = [];
            for (let cn = srcBounds.c1; cn <= srcBounds.c2; cn++) {
                cells.push(sh.cells[numToCol(cn) + r] || null);
            }
            analyses.set(r, analyzeSeries(cells));
        }
    }

    const srcLen = isVertical
        ? srcBounds.r2 - srcBounds.r1 + 1
        : srcBounds.c2 - srcBounds.c1 + 1;

    // Enumerate target cells in fill order: idx 0 = adjacent to source.
    const targets = [];
    if (direction === 'down') {
        for (let r = fillRange.r1; r <= fillRange.r2; r++)
            for (let cn = fillRange.c1; cn <= fillRange.c2; cn++)
                targets.push({ r, cn, idx: r - fillRange.r1 });
    } else if (direction === 'up') {
        for (let r = fillRange.r2; r >= fillRange.r1; r--)
            for (let cn = fillRange.c1; cn <= fillRange.c2; cn++)
                targets.push({ r, cn, idx: fillRange.r2 - r });
    } else if (direction === 'right') {
        for (let cn = fillRange.c1; cn <= fillRange.c2; cn++)
            for (let r = fillRange.r1; r <= fillRange.r2; r++)
                targets.push({ r, cn, idx: cn - fillRange.c1 });
    } else {
        for (let cn = fillRange.c2; cn >= fillRange.c1; cn--)
            for (let r = fillRange.r1; r <= fillRange.r2; r++)
                targets.push({ r, cn, idx: fillRange.c2 - cn });
    }

    for (const { r, cn, idx } of targets) {
        const ref = numToCol(cn) + r;
        const crossKey = isVertical ? cn : r;
        const a = analyses.get(crossKey);
        if (!a) continue;

        if (a.type === 'series') {
            // Arithmetic-progression extrapolation. idx 0 = first cell past
            // source; growing-forward adds steps after `last`, growing-
            // backward subtracts from `first`.
            const newVal = goingForward
                ? a.last  + a.step * (idx + 1)
                : a.first - a.step * (idx + 1);
            const styleSrc = goingForward ? a.lastCell : a.firstCell;
            const newCell = { v: newVal };
            if (styleSrc && styleSrc.s) newCell.s = { ...styleSrc.s };
            sh.cells[ref] = newCell;
            continue;
        }

        // Plain copy with wrap. Map idx → which source cell to copy from.
        // For 'up' / 'left' fills we mirror so the closest source cell is
        // copied first (idx=0 → end of source).
        const wrap = idx % srcLen;
        const srcOffset = goingForward ? wrap : (srcLen - 1 - wrap);
        const srcRow = isVertical ? srcBounds.r1 + srcOffset : r;
        const srcCn  = isVertical ? cn : srcBounds.c1 + srcOffset;
        const srcCell = a.values[srcOffset];
        if (!srcCell) { delete sh.cells[ref]; continue; }
        const newCell = {};
        if (srcCell.s) newCell.s = { ...srcCell.s };
        if (srcCell.f != null) {
            const rowDelta = r  - srcRow;
            const colDelta = cn - srcCn;
            newCell.f = shiftFormulaText(srcCell.f, rowDelta, colDelta);
        } else if (srcCell.v !== undefined) {
            newCell.v = srcCell.v;
        }
        sh.cells[ref] = newCell;
    }

    // Expand the selection to include the just-filled range. Matches
    // Excel's post-fill state — the user sees what they filled, and a
    // subsequent fill from the new bottom-right can continue.
    state.selStart = numToCol(Math.min(srcBounds.c1, fillRange.c1)) + Math.min(srcBounds.r1, fillRange.r1);
    state.selEnd   = numToCol(Math.max(srcBounds.c2, fillRange.c2)) + Math.max(srcBounds.r2, fillRange.r2);
    state.activeRef = numToCol(srcBounds.c1) + srcBounds.r1;  // active stays at source top-left

    fullRecompute();
    renderGrid();
    markDirty();
    commitSnapshot();
    const count = (fillRange.c2 - fillRange.c1 + 1) * (fillRange.r2 - fillRange.r1 + 1);
    toast(`Filled ${count} cell${count === 1 ? '' : 's'}.`, { kind: 'ok', timeout: 1400 });
}

// Determine if a set of source cells along the fill axis represent an
// arithmetic progression (constant step between successive numeric values).
// If so, callers extrapolate by stepping past `last` (or before `first`)
// instead of wrapping. A single-value source returns 'copy' — Excel's
// default for single-cell drag-fill is copy, not increment-by-1.
function analyzeSeries(values) {
    if (values.length < 2) return { type: 'copy', values };
    const nums = values.map(c => c && typeof c.v === 'number' ? c.v : null);
    if (nums.some(n => n === null)) return { type: 'copy', values };
    const step = nums[1] - nums[0];
    for (let i = 2; i < nums.length; i++) {
        if (Math.abs((nums[i] - nums[i - 1]) - step) > 1e-9) return { type: 'copy', values };
    }
    return {
        type: 'series',
        step,
        first: nums[0],
        last:  nums[nums.length - 1],
        firstCell: values[0],
        lastCell:  values[values.length - 1]
    };
}

// Shift every relative ref in a formula by (rowDelta, colDelta). Absolute
// markers ($A, A$1, $A$1) are respected — shiftRef/shiftRange skip those
// by default. Reuses the same primitives as insert/delete-row/col so the
// behaviour is consistent across all structural ops.
function shiftFormulaText(text, rowDelta, colDelta) {
    if (!rowDelta && !colDelta) return text;
    const rowOp = rowDelta ? (r => r + rowDelta) : null;
    const colOp = colDelta ? (c => c + colDelta) : null;
    return rewriteFormula(text, tk => {
        if (tk.type === 'REF')   return shiftRef(tk, rowOp, colOp);
        if (tk.type === 'RANGE') return shiftRange(tk, rowOp, colOp);
        return null;
    });
}
function scrollIntoViewIfNeeded(td) {
    const wrap = state.gridWrap;
    const r = td.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    if (r.top < w.top + 24) wrap.scrollTop -= (w.top + 24 - r.top);
    else if (r.bottom > w.bottom) wrap.scrollTop += (r.bottom - w.bottom + 4);
    if (r.left < w.left + ROW_HEAD_WIDTH) wrap.scrollLeft -= (w.left + ROW_HEAD_WIDTH - r.left);
    else if (r.right > w.right) wrap.scrollLeft += (r.right - w.right + 4);
}

/* ---------------- Editing cells ---------------- */

function startEdit(ref, replace = false) {
    const td = state.gridTable.querySelector(`td[data-ref="${ref}"]`);
    if (!td) return;
    state.editing = true;
    state.activeRef = ref;
    state.selStart = state.selEnd = ref;
    const sh = activeSheet();
    const cell = sh.cells[ref] || {};
    const text = cell.f != null ? '=' + cell.f : (cell.v != null ? String(cell.v) : '');
    td.innerHTML = '';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cell-editor';
    input.value = replace ? '' : text;
    td.appendChild(input);
    state.editorEl = input;
    input.focus();
    if (!replace) input.setSelectionRange(input.value.length, input.value.length);

    input.addEventListener('keydown', onEditorKey);
    input.addEventListener('input', () => {
        // mirror to formula bar
        state.formulaInput.value = input.value;
    });
    state.formulaInput.value = text;
}

function onEditorKey(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        commitEdit();
        moveActive(0, e.shiftKey ? -1 : 1);
    } else if (e.key === 'Tab') {
        e.preventDefault();
        commitEdit();
        moveActive(e.shiftKey ? -1 : 1, 0);
    } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelEdit();
    }
}

function commitEdit() {
    if (!state.editing) return;
    const td = state.gridTable.querySelector(`td[data-ref="${state.activeRef}"]`);
    const input = state.editorEl;
    if (!td || !input) { state.editing = false; state.editorEl = null; return; }
    const raw = input.value;
    state.editing = false;
    state.editorEl = null;
    setCellValueFromInput(state.activeRef, raw);
    syncFormulaBar();
    commitSnapshot();
}
function cancelEdit() {
    if (!state.editing) return;
    state.editing = false;
    state.editorEl = null;
    paintCell(state.activeRef);
    syncFormulaBar();
}

function setCellValueFromInput(ref, raw) {
    const sh = activeSheet();
    if (raw === '') {
        delete sh.cells[ref];
        clearForwardDeps(state.doc.activeSheet, ref);
        state.computed.delete(state.doc.activeSheet + '!' + ref);
        paintCell(ref);
        recomputeDependents(state.doc.activeSheet, ref);
        markDirty();
        return;
    }
    sh.cells[ref] = sh.cells[ref] || {};
    const cell = sh.cells[ref];
    if (raw.startsWith('=')) {
        cell.f = raw.slice(1);
        cell.v = ''; // computed later
    } else {
        delete cell.f;
        // detect number-ish
        const n = parseFloat(raw);
        cell.v = (raw.trim() !== '' && !isNaN(n) && String(n) === raw.trim()) ? n : raw;
    }
    evalCell(state.doc.activeSheet, ref);
    paintCell(ref);
    recomputeDependents(state.doc.activeSheet, ref);
    markDirty();
}

/* ---------------- Formula bar ---------------- */

function bindFormulaBar() {
    state.formulaInput.addEventListener('focus', () => {
        const cell = activeSheet().cells[state.activeRef];
        if (cell) {
            state.formulaInput.value = cell.f != null ? '=' + cell.f : (cell.v != null ? String(cell.v) : '');
        }
    });
    state.formulaInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            setCellValueFromInput(state.activeRef, state.formulaInput.value);
            commitSnapshot();
            state.gridWrap.focus();
            moveActive(0, e.shiftKey ? -1 : 1);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            syncFormulaBar();
            state.gridWrap.focus();
        }
    });
}

function syncFormulaBar() {
    if (!state.formulaInput) return;
    const cell = activeSheet().cells[state.activeRef];
    if (!cell) state.formulaInput.value = '';
    else if (cell.f != null) state.formulaInput.value = '=' + cell.f;
    else state.formulaInput.value = cell.v != null ? String(cell.v) : '';
    if (state.cellRefLabel) state.cellRefLabel.textContent = state.activeRef;
    updateStatusBar();
}

/* ---------------- Move / keyboard ---------------- */

function moveActive(dx, dy) {
    const [c, r] = splitRef(state.activeRef);
    let cn = colToNum(c) + dx;
    let rn = r + dy;
    const sh = activeSheet();
    cn = Math.max(1, Math.min(sh.cols, cn));
    rn = Math.max(1, Math.min(sh.rows, rn));
    // If the landing cell sits inside a merge, jump past it in the same
    // direction (or snap to anchor when arriving from outside via Shift+arrow
    // backtrack). Then redirect to the anchor so the cursor visually rests on
    // the rendered cell.
    let ref = numToCol(cn) + rn;
    const mi = findMergeIndex(sh, ref);
    if (mi >= 0) {
        const b = mergeBox(sh.merges[mi]);
        if (dx > 0) cn = Math.min(sh.cols, b.c2 + 1);
        else if (dx < 0) cn = Math.max(1, b.c1 - 1);
        if (dy > 0) rn = Math.min(sh.rows, b.r2 + 1);
        else if (dy < 0) rn = Math.max(1, b.r1 - 1);
        ref = numToCol(cn) + rn;
        ref = resolveActiveRef(ref); // could still be inside another merge
    }
    const mb = (() => { const i = findMergeIndex(sh, ref); return i >= 0 ? mergeBox(sh.merges[i]) : null; })();
    state.activeRef = ref;
    state.selStart = ref;
    state.selEnd = mb ? (numToCol(mb.c2) + mb.r2) : ref;
    updateSelectionVisual();
    syncFormulaBar();
}
function extendSelection(dx, dy) {
    const [c, r] = splitRef(state.selEnd);
    let cn = colToNum(c) + dx;
    let rn = r + dy;
    const sh = activeSheet();
    cn = Math.max(1, Math.min(sh.cols, cn));
    rn = Math.max(1, Math.min(sh.rows, rn));
    let ref = numToCol(cn) + rn;
    // Extending selection through a merge should snap to the far corner.
    const mi = findMergeIndex(sh, ref);
    if (mi >= 0) {
        const b = mergeBox(sh.merges[mi]);
        if (dx > 0) cn = b.c2;
        else if (dx < 0) cn = b.c1;
        if (dy > 0) rn = b.r2;
        else if (dy < 0) rn = b.r1;
        ref = numToCol(cn) + rn;
    }
    state.selEnd = ref;
    state.activeRef = ref;
    updateSelectionVisual();
    syncFormulaBar();
}

function onGlobalKey(e) {
    if (!state.mounted || state.container.hidden) return;

    // Allow typing in input fields (title, formula bar, cell editor)
    const ae = document.activeElement;
    const inField = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable);

    const meta = e.ctrlKey || e.metaKey;

    // Ctrl-shortcuts (apply even when in inputs except cell-editor)
    if (meta && !state.editing) {
        const k = e.key.toLowerCase();
        if (k === 's') { e.preventDefault(); doDownload(); return; }
        if (k === 'o') { e.preventDefault(); doOpen(); return; }
        // Undo/redo: only when not in a field — inside title/formula-bar we
        // let the browser's native input undo win (text-input undo within
        // the field is more useful than restoring an older sheet state).
        if (k === 'z' && !e.shiftKey && !inField) { e.preventDefault(); undo(); return; }
        if (!inField && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
        if (k === 'c' && !inField) { e.preventDefault(); doCopy(); return; }
        if (k === 'x' && !inField) { e.preventDefault(); doCut(); return; }
        if (k === 'v' && !inField) { e.preventDefault(); doPaste(); return; }
        if (k === 'a' && !inField) { e.preventDefault(); selectAll(); return; }
    }

    if (inField) return; // don't intercept while editing or typing in title/formula

    if (e.key === 'F2')        { e.preventDefault(); startEdit(state.activeRef, false); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); clearSelection(); return; }

    const map = {
        ArrowUp:    [0, -1], ArrowDown: [0, 1],
        ArrowLeft:  [-1, 0], ArrowRight: [1, 0],
        Enter:      [0, e.shiftKey ? -1 : 1],
        Tab:        [e.shiftKey ? -1 : 1, 0]
    };
    if (map[e.key]) {
        e.preventDefault();
        const [dx, dy] = map[e.key];
        if (e.shiftKey && (e.key.startsWith('Arrow'))) extendSelection(dx, dy);
        else moveActive(dx, dy);
        return;
    }

    // Just-type-to-edit: any printable key
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        startEdit(state.activeRef, true);
        if (state.editorEl) state.editorEl.value = e.key;
        e.preventDefault();
        return;
    }
}

/* ---------------- Recompute / dep graph ---------------- */

function cellKey(sheetIdx, ref) { return sheetIdx + '!' + ref; }

function evalCell(sheetIdx, ref) {
    const sh = state.doc.sheets[sheetIdx];
    const cell = sh.cells[ref];
    const k = cellKey(sheetIdx, ref);
    // Clear old forward deps & their reverse entries
    clearForwardDeps(sheetIdx, ref);
    if (!cell) { state.computed.delete(k); return; }
    if (cell.f == null) {
        // raw value
        state.computed.set(k, { value: cell.v });
        return;
    }
    const ctx = makeCtx(sheetIdx);
    const { value, error, deps } = evaluate(cell.f, ctx);
    state.computed.set(k, error ? { value, error } : { value });
    // Save forward deps for this cell
    state.formulaDeps.set(k, new Set(deps));
    // Register reverse deps
    deps.forEach(src => {
        if (!state.revDeps.has(src)) state.revDeps.set(src, new Set());
        state.revDeps.get(src).add(k);
    });
    cell.v = (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') ? value : (value == null ? '' : String(value));
}

function clearForwardDeps(sheetIdx, ref) {
    const k = cellKey(sheetIdx, ref);
    const fwd = state.formulaDeps.get(k);
    if (!fwd) return;
    fwd.forEach(src => {
        const rev = state.revDeps.get(src);
        if (rev) {
            rev.delete(k);
            if (!rev.size) state.revDeps.delete(src);
        }
    });
    state.formulaDeps.delete(k);
}

function makeCtx(sheetIdx) {
    return {
        sheetIdx,
        getValue(ref, sIdx) {
            const sh = state.doc.sheets[sIdx];
            if (!sh) return null;
            const c = sh.cells[ref];
            if (!c) return null;
            if (c.f != null) {
                const ck = cellKey(sIdx, ref);
                const comp = state.computed.get(ck);
                if (comp) return comp.error ? null : comp.value;
                return null;
            }
            return c.v;
        },
        getRange(start, end, sIdx) {
            const sh = state.doc.sheets[sIdx];
            if (!sh) return [];
            const [cA, rA] = splitRef(start);
            const [cB, rB] = splitRef(end);
            const c1 = Math.min(colToNum(cA), colToNum(cB));
            const c2 = Math.max(colToNum(cA), colToNum(cB));
            const r1 = Math.min(rA, rB), r2 = Math.max(rA, rB);
            const out = [];
            for (let r = r1; r <= r2; r++) {
                for (let cn = c1; cn <= c2; cn++) {
                    const ref = numToCol(cn) + r;
                    const c = sh.cells[ref];
                    if (!c) { out.push(null); continue; }
                    if (c.f != null) {
                        const comp = state.computed.get(cellKey(sIdx, ref));
                        out.push(comp && !comp.error ? comp.value : null);
                    } else out.push(c.v);
                }
            }
            return out;
        },
        sheetIndexByName(name) {
            return state.doc.sheets.findIndex(s => s.name === name);
        },
        names: state.doc.names || {}
    };
}

function recomputeDependents(sheetIdx, ref) {
    const start = cellKey(sheetIdx, ref);
    const seen = new Set();
    const queue = [start];
    // Collect transitive dependents (BFS)
    const affected = new Set();
    while (queue.length) {
        const k = queue.shift();
        const next = state.revDeps.get(k);
        if (!next) continue;
        next.forEach(d => {
            if (!seen.has(d)) {
                seen.add(d);
                affected.add(d);
                queue.push(d);
            }
        });
    }
    // Re-evaluate in arbitrary order — to handle ordering, repeat passes (max 50).
    let passes = 0;
    let changed = true;
    while (changed && passes < 50) {
        changed = false;
        affected.forEach(k => {
            const [sIdxStr, r] = k.split('!');
            const sIdx = parseInt(sIdxStr, 10);
            const prev = state.computed.get(k);
            evalCell(sIdx, r);
            const now = state.computed.get(k);
            if (!shallowEq(prev, now)) changed = true;
            if (sIdx === state.doc.activeSheet) paintCell(r);
        });
        passes++;
    }
    // Detect any cycles introduced by this edit; mark cycle cells with #CYCLE!
    markCycles();
    affected.forEach(k => {
        const [sIdxStr, r] = k.split('!');
        const sIdx = parseInt(sIdxStr, 10);
        if (sIdx === state.doc.activeSheet) paintCell(r);
    });
    renderCharts();
}
function shallowEq(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.value === b.value && a.error === b.error;
}

function fullRecompute() {
    state.computed.clear();
    state.revDeps.clear();
    state.formulaDeps.clear();
    state.doc.sheets.forEach((sh, sIdx) => {
        // First pass: literals only
        Object.keys(sh.cells).forEach(ref => {
            const c = sh.cells[ref];
            if (c.f == null) state.computed.set(cellKey(sIdx, ref), { value: c.v });
        });
    });
    // Multiple passes for formulas (deps not known upfront)
    let passes = 0;
    let changed = true;
    while (changed && passes < 30) {
        changed = false;
        state.doc.sheets.forEach((sh, sIdx) => {
            Object.keys(sh.cells).forEach(ref => {
                const c = sh.cells[ref];
                if (c.f != null) {
                    const k = cellKey(sIdx, ref);
                    const prev = state.computed.get(k);
                    evalCell(sIdx, ref);
                    const now = state.computed.get(k);
                    if (!shallowEq(prev, now)) changed = true;
                }
            });
        });
        passes++;
    }
    markCycles();
}

// Tarjan's SCC algorithm — finds strongly-connected components in the
// forward dep graph. Non-trivial SCCs (size > 1, or size 1 with a self-loop)
// are cycles. Recursive; max recursion depth is bounded by the longest
// dependency chain, well within JS stack limits for sheets up to a few
// thousand formula cells. Called at the end of fullRecompute /
// recomputeDependents — any cycle-member cell's computed value is overwritten
// with `#CYCLE!` so the user sees the error explicitly instead of a silent
// converged-or-not result from the 30-pass loop.
function markCycles() {
    const indexMap = new Map();
    const lowlink = new Map();
    const onStack = new Set();
    const sccStack = [];
    let counter = 0;
    const cycleCells = new Set();

    function strongconnect(v) {
        indexMap.set(v, counter);
        lowlink.set(v, counter);
        counter++;
        sccStack.push(v);
        onStack.add(v);
        const deps = state.formulaDeps.get(v);
        if (deps) {
            for (const w of deps) {
                if (!indexMap.has(w)) {
                    strongconnect(w);
                    lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
                } else if (onStack.has(w)) {
                    lowlink.set(v, Math.min(lowlink.get(v), indexMap.get(w)));
                }
            }
        }
        if (lowlink.get(v) === indexMap.get(v)) {
            const scc = [];
            let w;
            do {
                w = sccStack.pop();
                onStack.delete(w);
                scc.push(w);
            } while (w !== v);
            const selfLoop = scc.length === 1 && (state.formulaDeps.get(scc[0])?.has(scc[0]));
            if (scc.length > 1 || selfLoop) scc.forEach(c => cycleCells.add(c));
        }
    }
    for (const v of state.formulaDeps.keys()) {
        if (!indexMap.has(v)) strongconnect(v);
    }
    cycleCells.forEach(k => state.computed.set(k, { value: '#CYCLE!', error: '#CYCLE!' }));
}

/* ---------------- Formatting ---------------- */

function toggleFormat(field) {
    const sh = activeSheet();
    // Decide on/off based on active cell's current state.
    const cur = sh.cells[state.activeRef];
    const wasOn = cur && cur.s && cur.s[field];
    forEachInSelection(ref => {
        const cell = sh.cells[ref] = sh.cells[ref] || {};
        cell.s = cell.s || {};
        if (wasOn) delete cell.s[field]; else cell.s[field] = 1;
        if (!cell.v && !cell.f && !Object.keys(cell.s).length) delete sh.cells[ref];
        paintCell(ref);
    });
    markDirty();
    commitSnapshot();
}
function setAlign(a) {
    const sh = activeSheet();
    forEachInSelection(ref => {
        const cell = sh.cells[ref] = sh.cells[ref] || {};
        cell.s = cell.s || {};
        cell.s.a = a;
        paintCell(ref);
    });
    markDirty();
    commitSnapshot();
}
function setStyleField(field, value) {
    const sh = activeSheet();
    forEachInSelection(ref => {
        const cell = sh.cells[ref] = sh.cells[ref] || {};
        cell.s = cell.s || {};
        cell.s[field] = value;
        paintCell(ref);
    });
    markDirty();
    commitSnapshot();
}
function clearFormat() {
    const sh = activeSheet();
    forEachInSelection(ref => {
        if (sh.cells[ref]) {
            delete sh.cells[ref].s;
            // Drop the cell entry only when nothing remains — preserve notes
            // (n) so clear-format doesn't silently destroy comments.
            if (!sh.cells[ref].v && !sh.cells[ref].f && !sh.cells[ref].n) delete sh.cells[ref];
            paintCell(ref);
        }
    });
    markDirty();
    commitSnapshot();
}
function clearSelection() {
    const sh = activeSheet();
    forEachInSelection(ref => {
        if (sh.cells[ref]) {
            delete sh.cells[ref].v;
            delete sh.cells[ref].f;
            clearForwardDeps(state.doc.activeSheet, ref);
            state.computed.delete(cellKey(state.doc.activeSheet, ref));
            // Excel-like: "Clear contents" preserves both notes and format.
            if (!sh.cells[ref].s && !sh.cells[ref].n) delete sh.cells[ref];
            paintCell(ref);
            recomputeDependents(state.doc.activeSheet, ref);
        }
    });
    syncFormulaBar();
    markDirty();
    commitSnapshot();
}
function selectAll() {
    const sh = activeSheet();
    state.selStart = 'A1';
    state.selEnd = numToCol(sh.cols) + sh.rows;
    state.activeRef = 'A1';
    updateSelectionVisual();
    syncFormulaBar();
}

/* ---------------- Copy/paste (TSV) ---------------- */

function selectionAsTSV() {
    const b = selectionBounds();
    const lines = [];
    for (let r = b.r1; r <= b.r2; r++) {
        const row = [];
        for (let cn = b.c1; cn <= b.c2; cn++) {
            const ref = numToCol(cn) + r;
            const cell = activeSheet().cells[ref];
            if (!cell) { row.push(''); continue; }
            const v = cell.f != null ? '=' + cell.f : (cell.v != null ? String(cell.v) : '');
            row.push(v);
        }
        lines.push(row.join('\t'));
    }
    return lines.join('\n');
}

async function doCopy() {
    const tsv = selectionAsTSV();
    try {
        await navigator.clipboard.writeText(tsv);
        toast('Copied.', { kind: 'ok', timeout: 1200 });
    } catch {
        // fallback: textarea + execCommand
        const ta = document.createElement('textarea');
        ta.value = tsv; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch {}
        ta.remove();
        toast('Copied.', { kind: 'ok', timeout: 1200 });
    }
}
async function doCut() {
    await doCopy();
    clearSelection();
}
async function doPaste() {
    let text = '';
    try { text = await navigator.clipboard.readText(); }
    catch {
        toast('Clipboard read blocked. Use the cell editor and paste there.', { kind: 'error' });
        return;
    }
    if (!text) return;
    const rows = text.replace(/\r/g, '').split('\n');
    while (rows.length && rows[rows.length - 1] === '') rows.pop();
    const [c, r] = splitRef(state.activeRef);
    const c0 = colToNum(c);
    rows.forEach((line, ri) => {
        const cells = line.split('\t');
        cells.forEach((val, ci) => {
            const ref = numToCol(c0 + ci) + (r + ri);
            setCellValueFromInput(ref, val);
        });
    });
    markDirty();
    commitSnapshot();
}

/* ---------------- Insert/delete rows + cols ---------------- */

// Walk every formula cell in every sheet; for refs that target the modified
// sheet (bare refs in the modified sheet itself, or explicit Sheet!-prefixed
// refs from other sheets), apply rowOp/colOp. rowOp/colOp take a 1-based
// number and return either a new 1-based number or null to mean "this cell
// got deleted" — which becomes a literal "#REF!" in the formula text (the
// tokenizer rejects '#', so the evaluator surfaces the error on next eval).
// Absolute refs ($A / A$1 / $A$1) are left untouched. This matches Excel.
// Rename a sheet AND rewrite every cross-sheet reference in every formula
// cell so refs that previously named the old name now name the new name
// (quoted if the new name has spaces / special chars — refToString /
// rangeToString handle that). Returns false on validation failure (empty
// name or collision); otherwise true after the rename + recompute.
function renameSheet(idx, newName) {
    newName = (newName || '').trim();
    const old = state.doc.sheets[idx].name;
    if (!newName)         { toast('Sheet name cannot be empty.', { kind: 'error' }); return false; }
    if (newName === old)  return false;
    if (state.doc.sheets.some((s, i) => i !== idx && s.name === newName)) {
        toast(`Sheet "${newName}" already exists.`, { kind: 'error' });
        return false;
    }
    state.doc.sheets[idx].name = newName;
    state.doc.sheets.forEach(sh => {
        Object.values(sh.cells).forEach(cell => {
            if (cell.f == null) return;
            cell.f = rewriteFormula(cell.f, tk => {
                if (tk.sheet !== old) return null;
                if (tk.type === 'REF') {
                    return refToString({ col: tk.col, colAbs: tk.colAbs, row: tk.row, rowAbs: tk.rowAbs, sheet: newName });
                }
                if (tk.type === 'RANGE') {
                    return rangeToString(tk.startCell, tk.endCell, newName);
                }
                return null;
            });
        });
    });
    fullRecompute();
    renderSheetTabs();
    markDirty();
    commitSnapshot();
    return true;
}

// Apply rowOp/colOp to every chart anchored to a single ref ("A1"). Charts
// whose endpoints land out of bounds (op returns null) are dropped. Mirrors
// the formula-ref shift logic but for chart.range.{start,end} strings.
// Returns true if the chart should survive, false if it should be removed.
function shiftChartRange(chart, rowOp, colOp) {
    const shiftOne = (refStr) => {
        // Tampered JSON / format-migration debris could leave malformed ref
        // strings here; splitRef throws #REF! on those. Catch so one bad
        // chart can't break the entire structural-edit operation.
        try {
            const [c, r] = splitRef(refStr);
            const cn = colToNum(c);
            const newCn = colOp ? colOp(cn) : cn;
            const newR  = rowOp ? rowOp(r)  : r;
            if (newCn === null || newR === null) return null;
            return numToCol(newCn) + newR;
        } catch { return null; }
    };
    const newStart = shiftOne(chart.range.start);
    const newEnd = shiftOne(chart.range.end);
    if (newStart === null || newEnd === null) return false;  // broken — drop
    chart.range.start = newStart;
    chart.range.end = newEnd;
    return true;
}

// Apply chart-range shifts to every chart referencing the modified sheet,
// update the filter column if present, and shift every condFormat rule's
// range string. All three storage shapes get the SAME row/col deltas so
// inserting a row above your formatted range walks the range down by one.
function shiftChartsAndFilter({ rowOp, colOp, modifiedSheetIdx }) {
    state.doc.sheets.forEach(sh => {
        if (!sh.charts || !sh.charts.length) return;
        sh.charts = sh.charts.filter(ch => {
            if (ch.range.sheet !== modifiedSheetIdx) return true;  // unrelated sheet
            return shiftChartRange(ch, rowOp, colOp);
        });
    });
    const modSheet = state.doc.sheets[modifiedSheetIdx];
    // Filter.col tracks column letter — only colOp affects it.
    if (colOp && modSheet && modSheet.filter) {
        const fcn = colToNum(modSheet.filter.col);
        const newFcn = colOp(fcn);
        if (newFcn === null) delete modSheet.filter;
        else modSheet.filter.col = numToCol(newFcn);
    }
    // Conditional-format ranges — drop rules whose range is fully invalidated
    // (op returns null for any endpoint), otherwise update the range string.
    if (modSheet && modSheet.condFormat && modSheet.condFormat.length) {
        modSheet.condFormat = modSheet.condFormat.filter(cf => {
            const newRange = shiftRangeStr(cf.range, rowOp, colOp);
            if (!newRange) return false;
            cf.range = newRange;
            return true;
        });
    }
    // Merges — same drop-or-shift policy. A merge that loses an endpoint to a
    // deleted row/col, or collapses to a single cell, gets dropped entirely.
    shiftMerges({ rowOp, colOp, modifiedSheetIdx });
}

function shiftAllFormulaRefs({ rowOp, colOp, modifiedSheetIdx, force = false, skipRanges = false }) {
    const modifiedSheetName = state.doc.sheets[modifiedSheetIdx].name;
    const opts = { force };
    state.doc.sheets.forEach((sh, sIdx) => {
        Object.values(sh.cells).forEach(cell => {
            if (cell.f == null) return;
            cell.f = rewriteFormula(cell.f, tk => {
                const targets = tk.sheet
                    ? tk.sheet === modifiedSheetName
                    : sIdx === modifiedSheetIdx;
                if (!targets) return null;
                if (tk.type === 'REF')   return shiftRef(tk, rowOp, colOp, opts);
                if (tk.type === 'RANGE') {
                    // Sort uses skipRanges:true — data within a range is
                    // reordered, not relocated, so SUM(A1:A3) stays
                    // SUM(A1:A3) after sorting. Insert/delete still shifts
                    // ranges because their start/end ROW NUMBERS change.
                    if (skipRanges) return null;
                    return shiftRange(tk, rowOp, colOp, opts);
                }
                return null;
            });
        });
    });
}

function insertRowAtActive() {
    const [, r] = splitRef(state.activeRef);
    const sh = activeSheet();
    if (sh.rows >= 1000) { toast('Max rows reached.', { kind: 'error' }); return; }
    sh.rows += 1;
    // shift existing cells at or below r down by one
    const moves = [];
    Object.keys(sh.cells).forEach(ref => {
        const [c, rn] = splitRef(ref);
        if (rn >= r) moves.push({ from: ref, to: c + (rn + 1) });
    });
    moves.sort((a, b) => splitRef(b.from)[1] - splitRef(a.from)[1]);
    moves.forEach(m => { sh.cells[m.to] = sh.cells[m.from]; delete sh.cells[m.from]; });
    // shift formula refs (Excel-style: non-absolute rows at or below r move with the data)
    const rowOp = (row) => row >= r ? row + 1 : row;
    shiftAllFormulaRefs({
        rowOp,
        colOp: null,
        modifiedSheetIdx: state.doc.activeSheet
    });
    shiftChartsAndFilter({ rowOp, colOp: null, modifiedSheetIdx: state.doc.activeSheet });
    fullRecompute();
    renderGrid();
    markDirty();
    commitSnapshot();
}
function insertColAtActive() {
    const [c] = splitRef(state.activeRef);
    const cn = colToNum(c);
    const sh = activeSheet();
    if (sh.cols >= 80) { toast('Max columns reached.', { kind: 'error' }); return; }
    sh.cols += 1;
    const moves = [];
    Object.keys(sh.cells).forEach(ref => {
        const [cc, rr] = splitRef(ref);
        if (colToNum(cc) >= cn) moves.push({ from: ref, to: numToCol(colToNum(cc) + 1) + rr });
    });
    moves.sort((a, b) => colToNum(splitRef(b.from)[0]) - colToNum(splitRef(a.from)[0]));
    moves.forEach(m => { sh.cells[m.to] = sh.cells[m.from]; delete sh.cells[m.from]; });
    const colOp = (colNum) => colNum >= cn ? colNum + 1 : colNum;
    shiftAllFormulaRefs({
        rowOp: null,
        colOp,
        modifiedSheetIdx: state.doc.activeSheet
    });
    shiftChartsAndFilter({ rowOp: null, colOp, modifiedSheetIdx: state.doc.activeSheet });
    fullRecompute();
    renderGrid();
    markDirty();
    commitSnapshot();
}
function deleteActiveRow() {
    const [, r] = splitRef(state.activeRef);
    const sh = activeSheet();
    if (sh.rows <= 1) { toast('Cannot delete last row.', { kind: 'error' }); return; }
    Object.keys(sh.cells).forEach(ref => {
        const [, rn] = splitRef(ref);
        if (rn === r) delete sh.cells[ref];
    });
    const moves = [];
    Object.keys(sh.cells).forEach(ref => {
        const [c, rn] = splitRef(ref);
        if (rn > r) moves.push({ from: ref, to: c + (rn - 1) });
    });
    moves.sort((a, b) => splitRef(a.from)[1] - splitRef(b.from)[1]);
    moves.forEach(m => { sh.cells[m.to] = sh.cells[m.from]; delete sh.cells[m.from]; });
    sh.rows -= 1;
    // refs pointing AT row r become #REF!; refs > r shift down by 1
    const rowOp = (row) => row === r ? null : (row > r ? row - 1 : row);
    shiftAllFormulaRefs({
        rowOp,
        colOp: null,
        modifiedSheetIdx: state.doc.activeSheet
    });
    shiftChartsAndFilter({ rowOp, colOp: null, modifiedSheetIdx: state.doc.activeSheet });
    fullRecompute();
    renderGrid();
    markDirty();
    commitSnapshot();
}
function deleteActiveCol() {
    const [c] = splitRef(state.activeRef);
    const cn = colToNum(c);
    const sh = activeSheet();
    if (sh.cols <= 1) { toast('Cannot delete last column.', { kind: 'error' }); return; }
    Object.keys(sh.cells).forEach(ref => {
        const [cc] = splitRef(ref);
        if (colToNum(cc) === cn) delete sh.cells[ref];
    });
    const moves = [];
    Object.keys(sh.cells).forEach(ref => {
        const [cc, rr] = splitRef(ref);
        if (colToNum(cc) > cn) moves.push({ from: ref, to: numToCol(colToNum(cc) - 1) + rr });
    });
    moves.sort((a, b) => colToNum(splitRef(a.from)[0]) - colToNum(splitRef(b.from)[0]));
    moves.forEach(m => { sh.cells[m.to] = sh.cells[m.from]; delete sh.cells[m.from]; });
    sh.cols -= 1;
    const colOp = (colNum) => colNum === cn ? null : (colNum > cn ? colNum - 1 : colNum);
    shiftAllFormulaRefs({
        rowOp: null,
        colOp,
        modifiedSheetIdx: state.doc.activeSheet
    });
    shiftChartsAndFilter({ rowOp: null, colOp, modifiedSheetIdx: state.doc.activeSheet });
    fullRecompute();
    renderGrid();
    markDirty();
    commitSnapshot();
}

/* ---------------- Sort / filter ---------------- */

function sortByActiveCol(asc) {
    const [c] = splitRef(state.activeRef);
    const sh = activeSheet();
    // Refuse if any merge intersects the data rows being sorted — re-ordering
    // rows would break merge rectangles in unpredictable ways. The user has to
    // unmerge first; cheap, predictable, no data loss.
    if (sh.merges && sh.merges.length) {
        const dataRect = { c1: 1, c2: sh.cols, r1: 2, r2: sh.rows };
        for (const m of sh.merges) {
            if (rectsOverlap(dataRect, mergeBox(m))) {
                toast('Unmerge cells before sorting.', { kind: 'error' });
                return;
            }
        }
    }
    const firstDataRow = 2; // row 1 is the header
    const rowsData = [];
    for (let r = firstDataRow; r <= sh.rows; r++) {
        const map = {};
        let hasAny = false;
        for (let i = 1; i <= sh.cols; i++) {
            const ref = numToCol(i) + r;
            if (sh.cells[ref]) { map[numToCol(i)] = sh.cells[ref]; hasAny = true; }
        }
        if (hasAny) rowsData.push({ r, map });
    }
    rowsData.sort((a, b) => {
        const va = a.map[c] && (a.map[c].f != null
            ? state.computed.get(cellKey(state.doc.activeSheet, c + a.r))?.value
            : a.map[c].v);
        const vb = b.map[c] && (b.map[c].f != null
            ? state.computed.get(cellKey(state.doc.activeSheet, c + b.r))?.value
            : b.map[c].v);
        return cmpVal(va, vb) * (asc ? 1 : -1);
    });
    // Build rowMap (oldRow → newRow) BEFORE re-placement. Rows that don't
    // appear in rowsData (empty rows) are left out — they keep their literal
    // row number in any formulas that reference them.
    const rowMap = new Map();
    rowsData.forEach((row, idx) => rowMap.set(row.r, firstDataRow + idx));
    // Clear all data rows
    for (let r = firstDataRow; r <= sh.rows; r++) {
        for (let i = 1; i <= sh.cols; i++) delete sh.cells[numToCol(i) + r];
    }
    // Re-place at new positions
    rowsData.forEach((row, idx) => {
        const targetR = firstDataRow + idx;
        Object.entries(row.map).forEach(([col, cell]) => {
            sh.cells[col + targetR] = cell;
        });
    });
    // Update formula refs across ALL sheets: any ref to a row that just
    // moved tracks to its new row. force:true because sort moves the cell
    // physically — absolute markers must follow it too (Excel semantics).
    shiftAllFormulaRefs({
        rowOp: (row) => rowMap.has(row) ? rowMap.get(row) : row,
        colOp: null,
        modifiedSheetIdx: state.doc.activeSheet,
        force: true,
        skipRanges: true
    });
    fullRecompute();
    renderGrid();
    markDirty();
    commitSnapshot();
    toast(`Sorted column ${c} ${asc ? 'ascending' : 'descending'}.`, { kind: 'ok' });
}
function cmpVal(a, b) {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function showFilterPopover() {
    const [c] = splitRef(state.activeRef);
    const sh = activeSheet();
    // Gather distinct values in this column (rows 2..rows = data, row 1 = header).
    const distinct = new Map();
    for (let r = 2; r <= sh.rows; r++) {
        const ref = c + r;
        const cell = sh.cells[ref];
        const v = cell ? (cell.f != null ? state.computed.get(cellKey(state.doc.activeSheet, ref))?.value : cell.v) : '';
        const key = v == null ? '' : String(v);
        if (!distinct.has(key)) distinct.set(key, []);
        distinct.get(key).push(r);
    }
    if (distinct.size === 0) { toast('No data to filter.', { kind: 'error' }); return; }

    // Pre-populate based on existing filter (if it's for the same column).
    const activeFilterOnThisCol = sh.filter && sh.filter.col === c ? new Set(sh.filter.allowed) : null;
    let html = '';
    Array.from(distinct.keys()).sort().forEach(k => {
        const checked = activeFilterOnThisCol ? activeFilterOnThisCol.has(k) : true;
        html += `<label><input type="checkbox" ${checked ? 'checked' : ''} value="${escapeHtml(k)}"> ${escapeHtml(k || '(empty)')}</label>`;
    });
    html += `<div class="filter-actions">
        <button class="btn-secondary" data-act="all">All</button>
        <button class="btn-secondary" data-act="none">None</button>
    </div>`;

    const actions = [{ label: 'Cancel', kind: 'secondary' }];
    if (sh.filter) {
        actions.push({ label: 'Clear filter', kind: 'secondary', onClick: (close) => {
            delete sh.filter;
            renderGrid();
            markDirty();
            commitSnapshot();
            toast('Filter cleared.', { kind: 'ok' });
            close();
        }});
    }
    actions.push({ label: 'Apply', kind: 'primary', onClick: (close) => {
        const allowed = [];
        document.querySelectorAll('#fp-list label input[type="checkbox"]:checked').forEach(cb => allowed.push(cb.value));
        if (allowed.length === distinct.size) {
            // All checked = effectively no filter
            delete sh.filter;
        } else {
            sh.filter = { col: c, allowed };
        }
        renderGrid();
        markDirty();
        commitSnapshot();
        close();
        toast(sh.filter ? `Filter on ${c} applied.` : 'Filter cleared.', { kind: 'ok' });
    }});

    showModal({
        title: `Filter column ${c}`,
        bodyHTML: `<div class="filter-popover" id="fp-list">${html}</div>`,
        actions,
        onMount: (m) => {
            m.querySelector('[data-act="all"]').addEventListener('click', () =>
                m.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true));
            m.querySelector('[data-act="none"]').addEventListener('click', () =>
                m.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false));
        }
    });
}

/* ---------------- Sheets (tabs) ---------------- */

function renderSheetTabs() {
    state.sheetTabsEl.innerHTML = '';
    state.doc.sheets.forEach((s, idx) => {
        const t = document.createElement('div');
        t.className = 'sheet-tab' + (idx === state.doc.activeSheet ? ' active' : '');
        t.textContent = s.name;
        t.addEventListener('click', () => switchToSheet(idx));
        t.addEventListener('dblclick', async () => {
            const newName = await prompt({ title: 'Rename sheet', label: 'New name', initial: s.name });
            if (newName) renameSheet(idx, newName);
        });
        t.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showContextMenu(e.clientX, e.clientY, [
                { label: 'Rename…', onClick: async () => {
                    const n = await prompt({ title: 'Rename sheet', label: 'New name', initial: s.name });
                    if (n) renameSheet(idx, n);
                } },
                { label: 'Duplicate', onClick: () => {
                    const copy = JSON.parse(JSON.stringify(s));
                    copy.name = uniqueCopyName(s.name);
                    // Chart.range.sheet stores a sheet INDEX (not name). After
                    // splice(idx+1, 0, copy), every sheet at original position
                    // >= idx+1 shifts up by 1. Walk all existing charts and
                    // re-index. Then for the copy's own charts: self-refs
                    // (originally pointing at idx) should re-target to idx+1
                    // (the copy's new position), so the duplicate's charts
                    // render the duplicate's data — that's what Excel does.
                    state.doc.sheets.forEach(other => {
                        if (!other.charts) return;
                        other.charts.forEach(ch => {
                            if (ch.range.sheet >= idx + 1) ch.range.sheet += 1;
                        });
                    });
                    if (copy.charts) {
                        copy.charts.forEach(ch => {
                            if (ch.range.sheet === idx) ch.range.sheet = idx + 1;
                            else if (ch.range.sheet > idx) ch.range.sheet += 1;
                        });
                    }
                    state.doc.sheets.splice(idx + 1, 0, copy);
                    renderSheetTabs();
                    markDirty();
                    commitSnapshot();
                } },
                { sep: true },
                { label: 'Delete sheet', onClick: async () => {
                    if (state.doc.sheets.length <= 1) { toast('Cannot delete last sheet.', { kind: 'error' }); return; }
                    const ok = await confirm({ title: 'Delete sheet', message: `Delete "${s.name}"?`, danger: true, okLabel: 'Delete' });
                    if (!ok) return;
                    // Chart.range.sheet is an INDEX. After splice(idx, 1),
                    // sheets at original position > idx shift down by 1, and
                    // any chart that referenced the deleted sheet itself
                    // (range.sheet === idx) is now dangling and must be
                    // dropped. Without this fix, deleting Sheet2 in a
                    // 3-sheet doc silently re-pointed every "Sheet3-chart"
                    // reference to whatever now sat at index 2.
                    state.doc.sheets.forEach((other, otherIdx) => {
                        if (otherIdx === idx) return;  // about to be deleted
                        if (!other.charts) return;
                        other.charts = other.charts.filter(ch => {
                            if (ch.range.sheet === idx) return false;       // dangling
                            if (ch.range.sheet > idx)  ch.range.sheet -= 1; // shift down
                            return true;
                        });
                    });
                    state.doc.sheets.splice(idx, 1);
                    state.doc.activeSheet = Math.max(0, Math.min(state.doc.activeSheet, state.doc.sheets.length - 1));
                    fullRecompute();
                    renderGrid(); renderSheetTabs(); renderCharts();
                    markDirty();
                    commitSnapshot();
                } }
            ]);
        });
        state.sheetTabsEl.appendChild(t);
    });
    const add = document.createElement('button');
    add.className = 'sheet-tab-add';
    add.textContent = '+';
    add.title = 'New sheet';
    add.addEventListener('click', () => {
        state.doc.sheets.push(newSheet(nextSheetName()));
        state.doc.activeSheet = state.doc.sheets.length - 1;
        renderGrid(); renderSheetTabs(); renderCharts();
        markDirty();
        commitSnapshot();
    });
    state.sheetTabsEl.appendChild(add);
}

function switchToSheet(idx) {
    if (idx === state.doc.activeSheet) return;
    commitEdit();
    state.doc.activeSheet = idx;
    state.activeRef = 'A1';
    state.selStart = 'A1';
    state.selEnd = 'A1';
    renderGrid(); renderSheetTabs(); renderCharts();
    syncFormulaBar();
    updateFreezeButtonState();
}

/* ---------------- Conditional formatting ---------------- */

/* ---------------- Named ranges ---------------- */

/* Names registry lives on the document (workbook-wide, not per-sheet) and
 * maps `Name → target`. Targets are restricted to:
 *   - a single cell ref:          A1, Sheet2!B3
 *   - a rectangular range ref:    A1:B10, Data!A1:A100
 *   - a numeric literal:          0.19, 42
 * The restriction keeps substitution one-pass and side-effect-free — no
 * arbitrary expressions, no name → name chains, no precedence surprises. */

const NAME_PATTERN     = /^[A-Za-z_][A-Za-z0-9_]{0,30}$/;
const CELL_REF_PATTERN = /^([A-Za-z][A-Za-z0-9_]*!)?\$?[A-Z]{1,3}\$?\d{1,5}$/;
const RANGE_PATTERN    = /^([A-Za-z][A-Za-z0-9_]*!)?\$?[A-Z]{1,3}\$?\d{1,5}:\$?[A-Z]{1,3}\$?\d{1,5}$/;
const NUMBER_PATTERN   = /^-?\d+(\.\d+)?$/;
const RESERVED_NAMES   = new Set(['TRUE', 'FALSE', 'AND', 'OR', 'NOT']);

function isValidNameTarget(t) {
    return CELL_REF_PATTERN.test(t) || RANGE_PATTERN.test(t) || NUMBER_PATTERN.test(t);
}

function isReservedOrShadowsRef(name) {
    if (RESERVED_NAMES.has(name.toUpperCase())) return true;
    // A cell-ref-shaped name (e.g. "A1") would collide with literal refs.
    return /^[A-Z]{1,3}\d+$/i.test(name);
}

async function showNamesDialog() {
    commitEdit();
    state.doc.names = state.doc.names || {};
    const names = state.doc.names;

    const renderRows = () => {
        const entries = Object.entries(names).sort((a, b) => a[0].localeCompare(b[0]));
        if (!entries.length) return '<p class="cf-empty">No names yet — add one above.</p>';
        return entries.map(([n, t]) => `
            <div class="cf-rule-row">
                <span class="cf-rule-preview" style="font-family:var(--mono)">${escapeHtml(n)}</span>
                <span class="cf-rule-desc">→ ${escapeHtml(t)}</span>
                <button class="btn-icon cf-rule-delete" data-name="${escapeHtml(n)}" title="Delete name" type="button">✕</button>
            </div>`).join('');
    };

    // Default new-name target = current selection or active cell.
    const b = selectionBounds();
    const defaultTarget = (b.c1 === b.c2 && b.r1 === b.r2)
        ? state.activeRef
        : `${numToCol(b.c1)}${b.r1}:${numToCol(b.c2)}${b.r2}`;

    await showModal({
        title: 'Named ranges',
        bodyHTML: `
            <label>Name</label>
            <input type="text" id="nm-name" placeholder="MyRange" autocomplete="off" spellcheck="false">
            <label>Refers to</label>
            <input type="text" id="nm-target" value="${escapeHtml(defaultTarget)}" placeholder="A1, A1:B10, Sheet2!A1, or 0.19" autocomplete="off" spellcheck="false">
            <p class="cf-empty" style="margin:6px 0 0;font-size:11px;">Targets must be a single cell ref, range ref, or number — no expressions.</p>
            <hr class="cf-sep">
            <label>Defined names (workbook)</label>
            <div id="nm-list" class="cf-rules-list">${renderRows()}</div>
        `,
        actions: [
            { label: 'Close', kind: 'secondary' },
            { label: 'Add name', kind: 'primary', onClick: (close) => {
                const modal = document.querySelector('.modal-host .modal') || document;
                const nm = modal.querySelector('#nm-name').value.trim();
                const tg = modal.querySelector('#nm-target').value.trim();
                if (!nm) { toast('Name required.', { kind: 'error' }); return; }
                if (!NAME_PATTERN.test(nm)) { toast('Invalid name — use letters, digits, underscore, starting with letter.', { kind: 'error' }); return; }
                if (isReservedOrShadowsRef(nm)) { toast('Name shadows a function or cell-ref.', { kind: 'error' }); return; }
                if (!isValidNameTarget(tg)) { toast('Target must be a cell ref, range, or number.', { kind: 'error' }); return; }
                names[nm] = tg;
                fullRecompute();
                paintAllCells();
                markDirty();
                commitSnapshot();
                toast(`Name "${nm}" added.`);
                close();
            } }
        ],
        onMount: (modal) => {
            // Single delegated handler on the list — survives innerHTML
            // re-renders without re-binding.
            const list = modal.querySelector('#nm-list');
            list.addEventListener('click', (e) => {
                const btn = e.target.closest('.cf-rule-delete');
                if (!btn) return;
                e.preventDefault();
                const n = btn.dataset.name;
                delete names[n];
                fullRecompute();
                paintAllCells();
                markDirty();
                commitSnapshot();
                list.innerHTML = renderRows();
                toast(`Name "${n}" removed.`);
            });
        }
    });
}

async function showCondFormatDialog() {
    const sh = activeSheet();
    sh.condFormat = sh.condFormat || [];
    const b = selectionBounds();
    const defaultRange = (b.c1 === b.c2 && b.r1 === b.r2)
        ? `${numToCol(b.c1)}${b.r1}`
        : `${numToCol(b.c1)}${b.r1}:${numToCol(b.c2)}${b.r2}`;

    const existingHTML = sh.condFormat.length
        ? sh.condFormat.map(r => `
            <div class="cf-rule-row">
                <span class="cf-rule-preview" style="background:${escapeHtml(r.style.bg || '#222')};color:${escapeHtml(r.style.c || '#fff')};${r.style.b ? 'font-weight:700;' : ''}${r.style.i ? 'font-style:italic;' : ''}">${escapeHtml(r.range)}</span>
                <span class="cf-rule-desc">${escapeHtml(describeRule(r.rule))}</span>
                <button class="btn-icon cf-rule-delete" data-id="${escapeHtml(r.id)}" title="Delete rule" type="button">✕</button>
            </div>
        `).join('')
        : '<p class="cf-empty">No rules yet — add one above.</p>';

    await showModal({
        title: 'Conditional formatting',
        bodyHTML: `
            <label>Apply to range</label>
            <input type="text" id="cf-range" value="${escapeHtml(defaultRange)}" placeholder="A1 or A1:B10">
            <label>When cell value is</label>
            <select id="cf-type">
                <option value="gt">Greater than</option>
                <option value="lt">Less than</option>
                <option value="gte">Greater than or equal</option>
                <option value="lte">Less than or equal</option>
                <option value="eq">Equal to</option>
                <option value="neq">Not equal to</option>
                <option value="between">Between</option>
                <option value="contains">Contains text</option>
                <option value="empty">Is empty</option>
                <option value="notempty">Is not empty</option>
            </select>
            <div class="modal-row" id="cf-values-row">
                <input type="text" id="cf-value"  placeholder="Value">
                <input type="text" id="cf-value2" placeholder="Upper bound" hidden>
            </div>
            <label>Format</label>
            <div class="cf-presets">
                <button class="cf-preset" data-bg="#ff5f57" data-c="#ffffff" style="background:#ff5f57;color:#fff" type="button">Red</button>
                <button class="cf-preset" data-bg="#febc2e" data-c="#000000" style="background:#febc2e;color:#000" type="button">Yellow</button>
                <button class="cf-preset" data-bg="#27ca40" data-c="#ffffff" style="background:#27ca40;color:#fff" type="button">Green</button>
                <button class="cf-preset" data-bg="#3aa8ff" data-c="#ffffff" style="background:#3aa8ff;color:#fff" type="button">Blue</button>
                <button class="cf-preset" data-bg="#FD7D00" data-c="#ffffff" style="background:#FD7D00;color:#fff" type="button">Accent</button>
            </div>
            <div class="modal-row">
                <div><label>Background</label><input type="color" id="cf-bg" value="#ff5f57"></div>
                <div><label>Text color</label><input type="color" id="cf-c" value="#ffffff"></div>
            </div>
            <label class="cf-bold-toggle">
                <input type="checkbox" id="cf-bold"> Bold text
            </label>
            <hr class="cf-sep">
            <label>Active rules on this sheet</label>
            <div id="cf-existing" class="cf-rules-list">${existingHTML}</div>
        `,
        actions: [
            { label: 'Close', kind: 'secondary' },
            { label: 'Add rule', kind: 'primary', onClick: (close) => {
                const newRule = buildCondRuleFromModal();
                if (!newRule) return;
                sh.condFormat.push(newRule);
                paintAllCells();
                updateSelectionVisual();
                markDirty();
                commitSnapshot();
                toast('Rule added.', { kind: 'ok' });
                close();
            } }
        ],
        onMount: (modal) => {
            // Show/hide value inputs based on rule type
            const typeSel = modal.querySelector('#cf-type');
            const v1 = modal.querySelector('#cf-value');
            const v2 = modal.querySelector('#cf-value2');
            const valuesRow = modal.querySelector('#cf-values-row');
            const sync = () => {
                const t = typeSel.value;
                if (t === 'between') {
                    valuesRow.hidden = false;
                    v2.hidden = false;
                    v1.placeholder = 'Lower bound';
                    v2.placeholder = 'Upper bound';
                } else if (t === 'empty' || t === 'notempty') {
                    valuesRow.hidden = true;
                } else {
                    valuesRow.hidden = false;
                    v2.hidden = true;
                    v1.placeholder = t === 'contains' ? 'Text' : 'Value';
                }
            };
            sync();
            typeSel.addEventListener('change', sync);
            // Presets fill the color inputs
            modal.querySelectorAll('.cf-preset').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    modal.querySelector('#cf-bg').value = btn.dataset.bg;
                    modal.querySelector('#cf-c').value  = btn.dataset.c;
                });
            });
            // Delete existing rule — single delegated handler on the list so
            // it survives innerHTML re-renders without re-binding (an earlier
            // per-button approach tried `b2.addEventListener('click', btn.onclick)`
            // which silently no-op'd because btn.onclick was always null —
            // the original bind used addEventListener, not the .onclick property).
            const list = modal.querySelector('#cf-existing');
            list.addEventListener('click', (e) => {
                const btn = e.target.closest('.cf-rule-delete');
                if (!btn) return;
                e.preventDefault();
                const id = btn.dataset.id;
                sh.condFormat = sh.condFormat.filter(r => r.id !== id);
                paintAllCells();
                updateSelectionVisual();
                markDirty();
                commitSnapshot();
                if (sh.condFormat.length) {
                    list.innerHTML = sh.condFormat.map(r => `
                        <div class="cf-rule-row">
                            <span class="cf-rule-preview" style="background:${escapeHtml(r.style.bg || '#222')};color:${escapeHtml(r.style.c || '#fff')};${r.style.b ? 'font-weight:700;' : ''}${r.style.i ? 'font-style:italic;' : ''}">${escapeHtml(r.range)}</span>
                            <span class="cf-rule-desc">${escapeHtml(describeRule(r.rule))}</span>
                            <button class="btn-icon cf-rule-delete" data-id="${escapeHtml(r.id)}" title="Delete rule" type="button">✕</button>
                        </div>
                    `).join('');
                } else {
                    list.innerHTML = '<p class="cf-empty">No rules yet — add one above.</p>';
                }
            });
        }
    });
}

function buildCondRuleFromModal() {
    const range = document.getElementById('cf-range').value.trim().toUpperCase();
    if (!/^[A-Z]+\d+(:[A-Z]+\d+)?$/.test(range)) {
        toast('Invalid range. Use A1 or A1:B10.', { kind: 'error' });
        return null;
    }
    const type = document.getElementById('cf-type').value;
    const bg = document.getElementById('cf-bg').value;
    const c  = document.getElementById('cf-c').value;
    const bold = document.getElementById('cf-bold').checked;

    const rule = { type };
    if (type === 'between') {
        rule.min = parseFloat(document.getElementById('cf-value').value);
        rule.max = parseFloat(document.getElementById('cf-value2').value);
        if (isNaN(rule.min) || isNaN(rule.max)) {
            toast('Between rule needs two numbers.', { kind: 'error' });
            return null;
        }
    } else if (type !== 'empty' && type !== 'notempty') {
        const raw = document.getElementById('cf-value').value;
        if (raw === '') {
            toast('Rule needs a value.', { kind: 'error' });
            return null;
        }
        // Coerce to number if it round-trips cleanly — matches the cell-
        // edit detection in setCellValueFromInput.
        const n = parseFloat(raw);
        rule.value = (!isNaN(n) && String(n) === raw.trim()) ? n : raw;
    }

    return {
        id: uid('cf'),
        range,
        rule,
        style: { bg, c, ...(bold ? { b: 1 } : {}) }
    };
}

/* ---------------- Charts ---------------- */

async function insertChartDialog() {
    const b = selectionBounds();
    if (b.c1 === b.c2 && b.r1 === b.r2) {
        toast('Select a range first.', { kind: 'error' });
        return;
    }
    // Single-column selection: chart format reserves col 1 for labels and
    // cols 2+ for data series — a single column has labels only, no data,
    // and the chart renders "(no numeric data)". Catch early with a useful
    // message rather than letting the user click Insert and get a blank.
    if (b.c1 === b.c2) {
        toast('Select at least 2 columns: labels + data.', { kind: 'error' });
        return;
    }
    let kind = 'bar', title = '';
    await showModal({
        title: 'Insert chart',
        bodyHTML: `
            <label>Chart type</label>
            <select id="ch-kind">
                <option value="bar">Bar</option>
                <option value="line">Line</option>
                <option value="pie">Pie</option>
            </select>
            <label>Title (optional)</label>
            <input type="text" id="ch-title" placeholder="Chart title">
            <p style="color:var(--fg-muted);font-size:12px;margin:0">Range: ${numToCol(b.c1)+b.r1}:${numToCol(b.c2)+b.r2}. First column will be labels.</p>
        `,
        actions: [
            { label: 'Cancel', kind: 'secondary' },
            { label: 'Insert', kind: 'primary', onClick: (close) => {
                kind = document.getElementById('ch-kind').value;
                title = document.getElementById('ch-title').value.trim();
                const chart = {
                    id: uid('ch'),
                    kind,
                    title,
                    range: {
                        sheet: state.doc.activeSheet,
                        start: numToCol(b.c1) + b.r1,
                        end:   numToCol(b.c2) + b.r2
                    },
                    anchor: { x: 60, y: 60, w: 360, h: 240 }
                };
                activeSheet().charts.push(chart);
                renderCharts();
                markDirty();
                commitSnapshot();
                close();
            } }
        ]
    });
}

function renderCharts() {
    if (!state.chartLayer) return;
    state.chartLayer.innerHTML = '';
    const sh = activeSheet();
    (sh.charts || []).forEach(ch => {
        const box = document.createElement('div');
        box.className = 'chart-box';
        box.style.left = ch.anchor.x + 'px';
        box.style.top  = ch.anchor.y + 'px';
        box.style.width  = ch.anchor.w + 'px';
        box.style.height = ch.anchor.h + 'px';
        box.innerHTML = `
            <div class="chart-head">
                <span>${escapeHtml(ch.title || ch.kind + ' chart')}</span>
                <button class="chart-close" title="Delete">✕</button>
            </div>
            <canvas></canvas>
        `;
        const canvas = box.querySelector('canvas');
        state.chartLayer.appendChild(box);
        drawChart(canvas, ch);

        box.querySelector('.chart-close').addEventListener('click', () => {
            sh.charts = sh.charts.filter(x => x.id !== ch.id);
            renderCharts();
            markDirty();
            commitSnapshot();
        });

        // Drag
        const head = box.querySelector('.chart-head');
        head.addEventListener('mousedown', (e) => {
            if (e.target.closest('.chart-close')) return;
            const startX = e.clientX, startY = e.clientY;
            const ox = ch.anchor.x, oy = ch.anchor.y;
            const onMove = (ev) => {
                ch.anchor.x = Math.max(0, ox + (ev.clientX - startX));
                ch.anchor.y = Math.max(0, oy + (ev.clientY - startY));
                box.style.left = ch.anchor.x + 'px';
                box.style.top  = ch.anchor.y + 'px';
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                markDirty();
                commitSnapshot();
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            e.preventDefault();
        });
    });
}

function drawChart(canvas, ch) {
    // Resize canvas to box
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    const cw = rect.width, chH = rect.height - 22; // minus header
    canvas.width  = cw * dpr;
    canvas.height = chH * dpr;
    canvas.style.width  = cw + 'px';
    canvas.style.height = chH + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cw, chH);

    // Gather data: labels (first column), one or more numeric series
    const sIdx = ch.range.sheet;
    const sh = state.doc.sheets[sIdx];
    if (!sh) return;
    const [cA, rA] = splitRef(ch.range.start);
    const [cB, rB] = splitRef(ch.range.end);
    const c1 = Math.min(colToNum(cA), colToNum(cB));
    const c2 = Math.max(colToNum(cA), colToNum(cB));
    const r1 = Math.min(rA, rB), r2 = Math.max(rA, rB);
    const labels = [];
    const seriesCols = [];
    for (let cc = c1 + 1; cc <= c2; cc++) seriesCols.push(cc);
    const series = seriesCols.map(() => []);
    for (let r = r1; r <= r2; r++) {
        const labelRef = numToCol(c1) + r;
        const labelCell = sh.cells[labelRef];
        labels.push(labelCell ? (labelCell.f != null ? state.computed.get(cellKey(sIdx, labelRef))?.value : labelCell.v) : '');
        seriesCols.forEach((cc, si) => {
            const ref = numToCol(cc) + r;
            const cell = sh.cells[ref];
            let v = cell ? (cell.f != null ? state.computed.get(cellKey(sIdx, ref))?.value : cell.v) : null;
            v = (typeof v === 'number') ? v : (v == null || v === '' ? null : parseFloat(v));
            if (isNaN(v)) v = null;
            series[si].push(v);
        });
    }

    const pad = 28;
    const colors = ['#FD7D00','#3aa8ff','#6bd968','#ffd24c','#ff5f57','#a978ff'];

    if (ch.kind === 'pie') {
        // sum first series
        const data = series[0] || [];
        const total = data.reduce((s, v) => s + (v || 0), 0);
        if (!total) { ctx.fillStyle = '#9aa8ae'; ctx.font = '12px sans-serif'; ctx.fillText('(no data)', 8, 18); return; }
        const cx = cw / 2, cy = chH / 2 - 6;
        const radius = Math.min(cw, chH) / 2 - 24;
        let a0 = -Math.PI / 2;
        data.forEach((v, i) => {
            const frac = (v || 0) / total;
            const a1 = a0 + frac * Math.PI * 2;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.arc(cx, cy, radius, a0, a1);
            ctx.closePath();
            ctx.fillStyle = colors[i % colors.length];
            ctx.fill();
            a0 = a1;
        });
        // legend
        ctx.font = '11px sans-serif'; ctx.textBaseline = 'middle';
        labels.forEach((l, i) => {
            const x = 8, y = 12 + i * 14;
            ctx.fillStyle = colors[i % colors.length];
            ctx.fillRect(x, y - 4, 10, 10);
            ctx.fillStyle = '#e8eef1';
            ctx.fillText(String(l == null ? '' : l), x + 16, y);
        });
        return;
    }

    // Bar / Line — common axes
    const allNums = series.flat().filter(v => v != null && !isNaN(v));
    if (!allNums.length) { ctx.fillStyle = '#9aa8ae'; ctx.font = '12px sans-serif'; ctx.fillText('(no numeric data)', 8, 18); return; }
    const yMin = Math.min(0, ...allNums);
    const yMax = Math.max(0, ...allNums);
    const yRange = yMax - yMin || 1;
    const plotX0 = pad + 18, plotY0 = 8;
    const plotW = cw - plotX0 - 12;
    const plotH = chH - plotY0 - 22;

    // axes
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(plotX0, plotY0); ctx.lineTo(plotX0, plotY0 + plotH); ctx.lineTo(plotX0 + plotW, plotY0 + plotH); ctx.stroke();
    // y zero line if visible
    const yToPx = (y) => plotY0 + plotH - ((y - yMin) / yRange) * plotH;
    if (yMin < 0 && yMax > 0) {
        ctx.beginPath(); ctx.moveTo(plotX0, yToPx(0)); ctx.lineTo(plotX0 + plotW, yToPx(0)); ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.stroke();
    }
    // y labels (min, max)
    ctx.fillStyle = '#9aa8ae'; ctx.font = '10px sans-serif'; ctx.textBaseline = 'middle';
    ctx.fillText(formatNum(yMax), 2, plotY0);
    ctx.fillText(formatNum(yMin), 2, plotY0 + plotH);

    const groups = labels.length;
    if (ch.kind === 'bar') {
        const groupW = plotW / Math.max(1, groups);
        const barW = Math.max(2, (groupW - 4) / series.length);
        series.forEach((sArr, si) => {
            ctx.fillStyle = colors[si % colors.length];
            sArr.forEach((v, gi) => {
                if (v == null) return;
                const x = plotX0 + gi * groupW + 2 + si * barW;
                const y0 = yToPx(0);
                const y1 = yToPx(v);
                ctx.fillRect(x, Math.min(y0, y1), barW, Math.abs(y1 - y0));
            });
        });
    } else if (ch.kind === 'line') {
        series.forEach((sArr, si) => {
            ctx.strokeStyle = colors[si % colors.length];
            ctx.lineWidth = 2;
            ctx.beginPath();
            let started = false;
            sArr.forEach((v, gi) => {
                if (v == null) return;
                const x = plotX0 + (groups > 1 ? gi / (groups - 1) * plotW : plotW / 2);
                const y = yToPx(v);
                if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
            });
            ctx.stroke();
            // dots
            sArr.forEach((v, gi) => {
                if (v == null) return;
                const x = plotX0 + (groups > 1 ? gi / (groups - 1) * plotW : plotW / 2);
                const y = yToPx(v);
                ctx.fillStyle = colors[si % colors.length];
                ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
            });
        });
    }

    // x labels (sparse)
    ctx.fillStyle = '#9aa8ae'; ctx.font = '10px sans-serif'; ctx.textBaseline = 'top'; ctx.textAlign = 'center';
    const step = Math.max(1, Math.ceil(groups / 8));
    labels.forEach((l, gi) => {
        if (gi % step !== 0) return;
        const x = ch.kind === 'bar'
            ? plotX0 + (gi + 0.5) * (plotW / Math.max(1, groups))
            : plotX0 + (groups > 1 ? gi / (groups - 1) * plotW : plotW / 2);
        ctx.fillText(String(l == null ? '' : l).slice(0, 10), x, plotY0 + plotH + 4);
    });
    ctx.textAlign = 'left';
}

function formatNum(n) {
    if (!isFinite(n)) return String(n);
    if (Math.abs(n) >= 1000) return n.toFixed(0);
    if (Math.abs(n) >= 1) return n.toFixed(1).replace(/\.0$/, '');
    return n.toPrecision(2);
}

/* ---------------- Save / Open / Export ---------------- */

function saveNow() {
    state.doc.updatedAt = nowIso();
    const ok = docs.save(state.doc);
    setIndicator(ok ? 'saved' : 'error');
}

function markDirty() {
    setIndicator('saving');
    state.saveDebounced && state.saveDebounced();
    updateStatusBar();
}

function doDownload() {
    saveNow();
    file.download(safeFilename(state.doc.title) + '.bytesheet.json', state.doc);
    toast('Downloaded.', { kind: 'ok' });
}

async function doOpen() {
    // Accept either a .bytesheet.json file (existing flow) or a .csv file —
    // CSV gets parsed and loaded as a fresh sheet inside the CURRENT doc.
    // Keeping it in the current doc (vs. opening a separate file) means
    // the user's existing sheets stay around — they can copy/paste data
    // across sheets if they're consolidating.
    const picked = await file.openPicker('.json,.csv,.txt,application/json,text/csv,text/plain');
    if (!picked) return;
    if (picked.json) {
        const j = picked.json;
        if (j.app !== APP_MIME) { toast('Not a byteSheet file.', { kind: 'error' }); return; }
        const id = j.id || uid('s');
        j.id = id;
        j.updatedAt = nowIso();
        docs.save(j);
        location.hash = '#/sheet/' + id;
        return;
    }
    if (picked.content) {
        importCSVToCurrentDoc(picked.content, picked.name);
        return;
    }
    toast('Unsupported file.', { kind: 'error' });
}

function importCSVToCurrentDoc(text, filename) {
    const rows = parseCSV(text);
    if (!rows.length) {
        toast('CSV is empty.', { kind: 'error' });
        return;
    }
    const baseName = (filename || 'CSV').replace(/\.[^.]+$/, '').slice(0, 30) || 'CSV';
    const sh = newSheet(uniqueSheetName(baseName));
    const { cells, rowsLoaded, colsLoaded } = csvToCellsObj(rows, { maxRows: sh.rows, maxCols: sh.cols });
    sh.cells = cells;
    state.doc.sheets.push(sh);
    state.doc.activeSheet = state.doc.sheets.length - 1;
    state.activeRef = 'A1';
    state.selStart = state.selEnd = 'A1';
    fullRecompute();
    renderGrid();
    renderSheetTabs();
    renderCharts();
    syncFormulaBar();
    markDirty();
    commitSnapshot();
    const truncated = rows.length > rowsLoaded
        ? ` (truncated from ${rows.length} rows)`
        : '';
    toast(`Imported ${rowsLoaded} × ${colsLoaded}${truncated}.`, { kind: 'ok' });
}

// Match-by-name uniqueness for CSV-derived sheet names. Differs from
// uniqueCopyName in that the suffix is "(2)" not "(copy 2)" — the source
// here isn't a duplicate of an existing sheet.
function uniqueSheetName(base) {
    if (!state.doc.sheets.some(s => s.name === base)) return base;
    let n = 2;
    while (state.doc.sheets.some(s => s.name === `${base} (${n})`)) n++;
    return `${base} (${n})`;
}

function doExportCSV() {
    const sh = activeSheet();
    const lines = [];
    for (let r = 1; r <= sh.rows; r++) {
        const row = [];
        let nonEmpty = false;
        for (let cn = 1; cn <= sh.cols; cn++) {
            const ref = numToCol(cn) + r;
            const cell = sh.cells[ref];
            let v = '';
            if (cell) {
                if (cell.f != null) {
                    const comp = state.computed.get(cellKey(state.doc.activeSheet, ref));
                    v = comp && !comp.error ? (comp.value == null ? '' : String(comp.value)) : '';
                } else {
                    v = cell.v == null ? '' : String(cell.v);
                }
                if (v !== '') nonEmpty = true;
            }
            // CSV quote
            if (v.includes(',') || v.includes('"') || v.includes('\n')) {
                v = '"' + v.replace(/"/g, '""') + '"';
            }
            row.push(v);
        }
        // Trim trailing empty cells per row
        while (row.length && row[row.length - 1] === '') row.pop();
        if (nonEmpty || lines.length > 0) lines.push(row.join(','));
    }
    file.download(safeFilename(sh.name) + '.csv', lines.join('\n'), 'text/csv');
    toast('CSV exported.', { kind: 'ok' });
}

function safeFilename(s) {
    return (s || 'sheet').replace(/[^\w\-]+/g, '_').slice(0, 60);
}

/* ---------------- Status bar ---------------- */

function updateStatusBar() {
    if (!state.statusBar) return;
    const sh = activeSheet();
    const b = selectionBounds();
    const count = (b.c2 - b.c1 + 1) * (b.r2 - b.r1 + 1);
    let sum = 0, n = 0, hasNum = false;
    forEachInSelection(ref => {
        const cell = sh.cells[ref];
        if (!cell) return;
        let v = cell.f != null ? state.computed.get(cellKey(state.doc.activeSheet, ref))?.value : cell.v;
        if (typeof v === 'string') { const f = parseFloat(v); if (!isNaN(f)) v = f; }
        if (typeof v === 'number') { sum += v; n++; hasNum = true; }
    });
    const parts = [`<span class="status-chip status-cell"><span class="status-label">CELL</span><strong>${state.activeRef}</strong></span>`];
    if (count > 1) parts.push(`<span class="status-chip">${count} selected</span>`);
    if (hasNum) {
        parts.push(`<span class="status-chip"><span class="status-label">∑</span><strong>${formatNum(sum)}</strong></span>`);
        parts.push(`<span class="status-chip"><span class="status-label">x̄</span><strong>${formatNum(sum/n)}</strong></span>`);
        parts.push(`<span class="status-chip"><span class="status-label">N</span><strong>${n}</strong></span>`);
    }
    parts.push(`<span class="spacer"></span>`);
    parts.push(`<span class="status-brand">byteSheet</span>`);
    state.statusBar.innerHTML = parts.join('');
}

/* ---------------- Undo / Redo (snapshot stack) ----------------
 *
 * Linear history pattern, same shape as byteDoc's per-tab undo from v0.2.2:
 *   stack[cursor] is the CURRENT state. Undo decrements cursor and restores.
 *   Redo advances. A fresh commit truncates everything past cursor (kills
 *   the redo-branch). Cap at HISTORY_LIMIT to bound memory.
 *
 * Snapshot scope:
 *   - state.doc.sheets (cells, charts, filter, sheet names, cols/rows)
 *   - state.doc.activeSheet (which sheet is in view)
 *   - state.activeRef / selStart / selEnd (UI cursor + selection)
 *   NOT in snapshot: state.doc.title — title rename is treated as metadata
 *   (Excel-style, not undoable). Preserved across restores.
 *
 * Snapshot trigger: end of every USER-FACING mutation. Not inside
 * lower-level helpers like setCellValueFromInput (which would over-snapshot
 * during batch paste / fill / CSV import). Callers commit once per action.
 */

function captureSnapshot() {
    return {
        sheets: deepClone(state.doc.sheets),
        activeSheet: state.doc.activeSheet,
        activeRef: state.activeRef,
        selStart: state.selStart,
        selEnd: state.selEnd
    };
}

function commitSnapshot() {
    const snap = captureSnapshot();
    const h = state.history;
    // Dedup: skip the commit if state is identical to the current cursor
    // entry. Cheap-ish JSON.stringify compare — for typical sheets ~1-5ms.
    // Prevents pressing Enter on an unchanged cell from spamming the stack.
    if (h.cursor >= 0) {
        const prev = h.stack[h.cursor];
        if (JSON.stringify(prev) === JSON.stringify(snap)) return;
    }
    // Truncate redo branch — once the user makes a new change after undoing,
    // the previously-redoable future is gone.
    h.stack = h.stack.slice(0, h.cursor + 1);
    h.stack.push(snap);
    h.cursor++;
    if (h.stack.length > HISTORY_LIMIT) {
        h.stack.shift();
        h.cursor--;
    }
}

function restoreSnapshot(snap) {
    // Title is preserved across restores (not in snapshot). Everything else
    // gets rebuilt from the snapshot, then dep-graph + visuals refresh.
    state.doc.sheets = deepClone(snap.sheets);
    state.doc.activeSheet = snap.activeSheet;
    state.activeRef = snap.activeRef;
    state.selStart = snap.selStart;
    state.selEnd = snap.selEnd;
    fullRecompute();
    renderGrid();
    renderSheetTabs();
    renderCharts();
    syncFormulaBar();
    markDirty();
    if (state.gridWrap) state.gridWrap.focus();
}

function undo() {
    if (state.history.cursor <= 0) return;
    state.history.cursor--;
    restoreSnapshot(state.history.stack[state.history.cursor]);
}
function redo() {
    if (state.history.cursor >= state.history.stack.length - 1) return;
    state.history.cursor++;
    restoreSnapshot(state.history.stack[state.history.cursor]);
}

/* ---------------- Register ---------------- */

window.ByteWorkz.apps.push({
    id: APP_ID,
    title: APP_TITLE,
    mount, unmount
});
