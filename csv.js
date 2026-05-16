/* byteworkz/csv.js — small CSV parser + cell converter.
 *
 * Public:
 *   parseCSV(text, delimiter?)      → string[][]
 *   sniffDelimiter(text)            → ',' | '\t' | ';'
 *   detectHeader(rows)              → boolean
 *   csvToCellsObj(rows, opts?)      → { cells, rowsLoaded, colsLoaded }
 *
 * RFC 4180 enough: handles quoted fields, doubled `""` escape, CRLF + LF
 * endings, UTF-8 BOM strip, optional trailing newline. Doesn't try to
 * handle malformed cases like stray quotes mid-unquoted-field — those go
 * through literally, which is the same behaviour Excel offers.
 */

import { numToCol } from './sheet-formula.js';

export function parseCSV(text, delimiter) {
    if (!text) return [];
    // Strip UTF-8 BOM if present — Excel exports often have it.
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    if (delimiter === undefined) delimiter = sniffDelimiter(text);

    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
                inQuotes = false;
                i++; continue;
            }
            field += c; i++; continue;
        }
        // Field starts with `"` → enters quoted mode. Mid-field `"` in an
        // unquoted field is treated as a literal char (Excel-compat).
        if (c === '"' && field === '') {
            inQuotes = true; i++; continue;
        }
        if (c === delimiter) {
            row.push(field); field = ''; i++; continue;
        }
        if (c === '\r') { i++; continue; }
        if (c === '\n') {
            row.push(field); rows.push(row);
            field = ''; row = []; i++; continue;
        }
        field += c; i++;
    }
    // Trailing field / row (no final newline)
    if (field !== '' || row.length) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

export function sniffDelimiter(text) {
    // Count candidate delimiters in a sample of the file. The best
    // delimiter is the one that appears most consistently per line — but
    // for v1 we just pick the most frequent in the first ~2KB. Quoting
    // can throw this off in pathological cases; users can always work
    // around by saving with a comma-separator.
    const sample = text.slice(0, 2000);
    const counts = { ',': 0, '\t': 0, ';': 0 };
    for (let i = 0; i < sample.length; i++) {
        const c = sample[i];
        if (c in counts) counts[c]++;
    }
    let best = ',', max = 0;
    for (const [k, v] of Object.entries(counts)) {
        if (v > max) { best = k; max = v; }
    }
    return best;
}

// Heuristic: row 0 is a header if it's entirely non-numeric AND row 1
// has at least one numeric value. Matches the typical "Name, Age" pattern.
// Avoids treating "1, 2, 3 / 4, 5, 6" (all numeric) as having a header.
export function detectHeader(rows) {
    if (rows.length < 2) return false;
    const r1 = rows[0], r2 = rows[1];
    const r1AllText = r1.every(v => v === '' || isNaN(parseFloat(v)));
    const r2HasNum  = r2.some(v => v !== '' && !isNaN(parseFloat(v)));
    return r1AllText && r2HasNum;
}

/* Convert a parsed CSV (string[][]) into a byteSheet `cells` object.
 *
 * opts:
 *   maxRows     — cap rows (default 1000, matches sheet grid limit)
 *   maxCols     — cap cols (default 80, matches sheet grid limit)
 *   headerStyle — if true and detectHeader matches, row 1 gets bold+accent (default true)
 *
 * Number detection: if `parseFloat(trim) === n` AND `String(n) === trim`,
 * stored as a number. This rejects "1.0" → 1 mismatches and "1e10" → wide
 * format mismatches, keeping them as text — matches our existing edit-time
 * detection in setCellValueFromInput.
 */
export function csvToCellsObj(rows, opts = {}) {
    const maxRows = Math.min(rows.length, opts.maxRows || 1000);
    const colCap  = opts.maxCols || 80;
    const headerOpt = opts.headerStyle !== false;
    const headerRow = headerOpt && detectHeader(rows);
    const cells = {};
    let maxCols = 0;
    for (let r = 0; r < maxRows; r++) {
        const row = rows[r] || [];
        const ncols = Math.min(row.length, colCap);
        if (ncols > maxCols) maxCols = ncols;
        for (let c = 0; c < ncols; c++) {
            const raw = row[c];
            if (raw === '' || raw == null) continue;
            const trimmed = String(raw).trim();
            const n = parseFloat(trimmed);
            const isNum = trimmed !== '' && !isNaN(n) && String(n) === trimmed;
            const cell = isNum ? { v: n } : { v: String(raw) };
            if (r === 0 && headerRow) {
                cell.s = { b: 1, c: '#FD7D00' };
            }
            cells[numToCol(c + 1) + (r + 1)] = cell;
        }
    }
    return { cells, rowsLoaded: maxRows, colsLoaded: maxCols };
}
