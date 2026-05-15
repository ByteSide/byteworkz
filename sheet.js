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
    escapeHtml, uid, debounce
} from './ui.js';
import { evaluate, colToNum, numToCol, splitRef } from './sheet-formula.js';

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
    sheetTabsEl: null
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
    return { name, cols: DEFAULT_COLS, rows: DEFAULT_ROWS, cells: {}, charts: [] };
}
function activeSheet() { return state.doc.sheets[state.doc.activeSheet]; }

/* ---------------- Mount / Unmount ---------------- */

function mount(container, params) {
    state.container = container;

    // Build DOM (once)
    if (!state.mounted) buildDOM();
    state.mounted = true;

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
        // Replace URL to canonical
        location.replace('#/sheet/' + state.doc.id);
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
}

function unmount() {
    topbar.clearCenter();
    document.removeEventListener('keydown', onGlobalKey, true);
    state.mounted = false;
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
    });
    doc.activeSheet = Math.min(Math.max(0, doc.activeSheet || 0), doc.sheets.length - 1);
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
        case 'save':         return doDownload();
        case 'open':         return doOpen();
        case 'export-csv':   return doExportCSV();
        case 'sort-asc':     return sortByActiveCol(true);
        case 'sort-desc':    return sortByActiveCol(false);
        case 'filter':       return showFilterPopover();
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
    let html = '';
    // header row
    html += '<thead><tr><th class="sheet-corner"></th>';
    for (let c = 1; c <= cols; c++) {
        html += `<th data-col="${c}" style="min-width:${COL_WIDTH}px;width:${COL_WIDTH}px">${numToCol(c)}</th>`;
    }
    html += '</tr></thead><tbody>';
    for (let r = 1; r <= rows; r++) {
        html += `<tr><th class="row-head" data-row="${r}">${r}</th>`;
        for (let c = 1; c <= cols; c++) {
            const ref = numToCol(c) + r;
            html += `<td data-ref="${ref}"></td>`;
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
    if (!cell) { td.textContent = ''; return; }

    let display = '';
    let hasError = false;
    if (cell.f != null) {
        const k = state.doc.activeSheet + '!' + ref;
        const c = state.computed.get(k);
        if (c && c.error) { display = c.value; hasError = true; }
        else if (c) display = formatValue(c.value, cell.s);
        else display = '';
    } else {
        display = formatValue(cell.v, cell.s);
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
            if (e.shiftKey) {
                state.selEnd = td.dataset.ref;
                state.activeRef = td.dataset.ref;
            } else {
                state.activeRef = td.dataset.ref;
                state.selStart = td.dataset.ref;
                state.selEnd = td.dataset.ref;
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
                    state.selEnd = cell.dataset.ref;
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
            { label: 'Delete column',      onClick: () => deleteActiveCol() }
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
    // Scroll active into view
    const activeTd = state.gridTable.querySelector(`td[data-ref="${state.activeRef}"]`);
    if (activeTd) scrollIntoViewIfNeeded(activeTd);
    if (state.cellRefLabel) state.cellRefLabel.textContent = state.activeRef;
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
        cell.f = undefined;
        if (cell.f === undefined) delete cell.f;
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
    const ref = numToCol(cn) + rn;
    state.activeRef = ref;
    state.selStart = ref;
    state.selEnd = ref;
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
    state.selEnd = numToCol(cn) + rn;
    state.activeRef = state.selEnd;
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
        }
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
}
function clearFormat() {
    const sh = activeSheet();
    forEachInSelection(ref => {
        if (sh.cells[ref]) {
            delete sh.cells[ref].s;
            if (!sh.cells[ref].v && !sh.cells[ref].f) delete sh.cells[ref];
            paintCell(ref);
        }
    });
    markDirty();
}
function clearSelection() {
    const sh = activeSheet();
    forEachInSelection(ref => {
        if (sh.cells[ref]) {
            delete sh.cells[ref].v;
            delete sh.cells[ref].f;
            clearForwardDeps(state.doc.activeSheet, ref);
            state.computed.delete(cellKey(state.doc.activeSheet, ref));
            if (!sh.cells[ref].s) delete sh.cells[ref];
            paintCell(ref);
            recomputeDependents(state.doc.activeSheet, ref);
        }
    });
    syncFormulaBar();
    markDirty();
}
function selectAll() {
    const sh = activeSheet();
    state.selStart = 'A1';
    state.selEnd = numToCol(sh.cols) + sh.rows;
    state.activeRef = 'A1';
    updateSelectionVisual();
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
}

/* ---------------- Insert/delete rows + cols ---------------- */

function insertRowAtActive() {
    const [, r] = splitRef(state.activeRef);
    const sh = activeSheet();
    if (sh.rows >= 1000) { toast('Max rows reached.', { kind: 'error' }); return; }
    sh.rows += 1;
    // shift cells at or below r down by one
    const moves = [];
    Object.keys(sh.cells).forEach(ref => {
        const [c, rn] = splitRef(ref);
        if (rn >= r) moves.push({ from: ref, to: c + (rn + 1) });
    });
    moves.sort((a, b) => splitRef(b.from)[1] - splitRef(a.from)[1]);
    moves.forEach(m => { sh.cells[m.to] = sh.cells[m.from]; delete sh.cells[m.from]; });
    fullRecompute();
    renderGrid();
    markDirty();
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
    fullRecompute();
    renderGrid();
    markDirty();
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
    fullRecompute();
    renderGrid();
    markDirty();
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
    fullRecompute();
    renderGrid();
    markDirty();
}

/* ---------------- Sort / filter ---------------- */

function sortByActiveCol(asc) {
    const [c] = splitRef(state.activeRef);
    const sh = activeSheet();
    const cn = colToNum(c);
    // Sort rows 2..rows (assume row 1 is header)
    const headerRow = 1;
    const firstDataRow = headerRow + 1;
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
    // Clear all data rows
    for (let r = firstDataRow; r <= sh.rows; r++) {
        for (let i = 1; i <= sh.cols; i++) delete sh.cells[numToCol(i) + r];
    }
    // Re-place
    rowsData.forEach((row, idx) => {
        const targetR = firstDataRow + idx;
        Object.entries(row.map).forEach(([col, cell]) => {
            sh.cells[col + targetR] = cell;
        });
    });
    fullRecompute();
    renderGrid();
    markDirty();
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
    const cn = colToNum(c);
    // gather distinct values in this column (rows 2..rows)
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
    let html = '';
    Array.from(distinct.keys()).sort().forEach(k => {
        html += `<label><input type="checkbox" checked value="${escapeHtml(k)}"> ${escapeHtml(k || '(empty)')}</label>`;
    });
    html += `<div class="filter-actions">
        <button class="btn-secondary" data-act="all">All</button>
        <button class="btn-secondary" data-act="none">None</button>
    </div>`;
    showModal({
        title: `Filter column ${c}`,
        bodyHTML: `<div class="filter-popover" id="fp-list">${html}</div>`,
        actions: [
            { label: 'Cancel', kind: 'secondary' },
            { label: 'Apply', kind: 'primary', onClick: (close) => {
                const checked = new Set();
                document.querySelectorAll('#fp-list label input[type="checkbox"]:checked').forEach(cb => checked.add(cb.value));
                distinct.forEach((rows, val) => {
                    if (!checked.has(val)) {
                        rows.forEach(r => {
                            const tr = state.gridTable.querySelector(`tr:has(td[data-ref="A${r}"])`);
                            // Fallback if :has not supported
                            const trs = state.gridTable.tBodies[0].rows;
                            for (let i = 0; i < trs.length; i++) {
                                const head = trs[i].querySelector('th.row-head');
                                if (head && parseInt(head.dataset.row, 10) === r) { trs[i].style.display = 'none'; break; }
                            }
                        });
                    } else {
                        rows.forEach(r => {
                            const trs = state.gridTable.tBodies[0].rows;
                            for (let i = 0; i < trs.length; i++) {
                                const head = trs[i].querySelector('th.row-head');
                                if (head && parseInt(head.dataset.row, 10) === r) { trs[i].style.display = ''; break; }
                            }
                        });
                    }
                });
                close();
                toast('Filter applied. (View-only — clear by re-rendering.)', { kind: 'ok' });
            } }
        ],
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
            if (newName && newName !== s.name) {
                // Update references in other sheets? — keep simple, only rename label.
                s.name = newName;
                renderSheetTabs();
                markDirty();
            }
        });
        t.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showContextMenu(e.clientX, e.clientY, [
                { label: 'Rename…', onClick: async () => {
                    const n = await prompt({ title: 'Rename sheet', label: 'New name', initial: s.name });
                    if (n) { s.name = n; renderSheetTabs(); markDirty(); }
                } },
                { label: 'Duplicate', onClick: () => {
                    const copy = JSON.parse(JSON.stringify(s));
                    copy.name = s.name + ' (copy)';
                    state.doc.sheets.splice(idx + 1, 0, copy);
                    renderSheetTabs();
                    markDirty();
                } },
                { sep: true },
                { label: 'Delete sheet', onClick: async () => {
                    if (state.doc.sheets.length <= 1) { toast('Cannot delete last sheet.', { kind: 'error' }); return; }
                    const ok = await confirm({ title: 'Delete sheet', message: `Delete "${s.name}"?`, danger: true, okLabel: 'Delete' });
                    if (!ok) return;
                    state.doc.sheets.splice(idx, 1);
                    state.doc.activeSheet = Math.max(0, Math.min(state.doc.activeSheet, state.doc.sheets.length - 1));
                    fullRecompute();
                    renderGrid(); renderSheetTabs(); renderCharts();
                    markDirty();
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
        const n = `Sheet${state.doc.sheets.length + 1}`;
        state.doc.sheets.push(newSheet(n));
        state.doc.activeSheet = state.doc.sheets.length - 1;
        renderGrid(); renderSheetTabs(); renderCharts();
        markDirty();
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
}

/* ---------------- Charts ---------------- */

async function insertChartDialog() {
    const b = selectionBounds();
    if (b.c1 === b.c2 && b.r1 === b.r2) {
        toast('Select a range first.', { kind: 'error' });
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
    const picked = await file.openPicker('.json,application/json');
    if (!picked || !picked.json) return;
    const j = picked.json;
    if (j.app !== APP_MIME) { toast('Not a byteSheet file.', { kind: 'error' }); return; }
    const id = j.id || uid('s');
    j.id = id;
    j.updatedAt = nowIso();
    docs.save(j);
    location.hash = '#/sheet/' + id;
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
    const stats = hasNum ? `sum ${formatNum(sum)} • avg ${formatNum(sum/n)} • count ${n}` : '';
    state.statusBar.innerHTML = `<span>${state.activeRef}</span><span>${count} cell${count===1?'':'s'} selected</span><span>${stats}</span><span class="spacer"></span><span>byteSheet</span>`;
}

/* ---------------- Register ---------------- */

window.ByteWorkz.apps.push({
    id: APP_ID,
    title: APP_TITLE,
    mount, unmount
});
