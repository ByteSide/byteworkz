/* byteworkz/cond-format.js — conditional-formatting primitives.
 *
 * Pure functions: no state, no DOM. Tested via tests/cond-format.mjs.
 * Used by sheet.js for the per-sheet `condFormat` array.
 *
 * Rule shape: { type, value?, min?, max? }
 *   types: 'gt' | 'lt' | 'gte' | 'lte' | 'eq' | 'neq' | 'between'
 *        | 'contains' | 'empty' | 'notempty'
 *
 * Range string: 'A1' or 'A1:B10' — uppercase, no sheet prefix (CF is
 * per-sheet only, no cross-sheet rules in v1).
 */

import { splitRef, colToNum, numToCol } from './sheet-formula.js';

// Evaluate a rule against a cell value. Numeric comparisons coerce string
// → number where possible (so a string "100" still passes "> 50"). Empty
// cells never match comparison rules (no number to compare), but DO match
// 'empty' rule specifically.
export function evaluateCondRule(value, rule) {
    if (!rule) return false;
    if (rule.type === 'empty')    return value == null || value === '';
    if (rule.type === 'notempty') return value != null && value !== '';
    if (rule.type === 'contains') {
        if (value == null || value === '') return false;
        return String(value).toLowerCase().includes(String(rule.value).toLowerCase());
    }
    if (rule.type === 'eq')  return String(value == null ? '' : value) === String(rule.value);
    if (rule.type === 'neq') return String(value == null ? '' : value) !== String(rule.value);
    // Numeric comparisons
    const nVal = typeof value === 'number' ? value : parseFloat(value);
    if (isNaN(nVal)) return false;
    if (rule.type === 'between') {
        const min = typeof rule.min === 'number' ? rule.min : parseFloat(rule.min);
        const max = typeof rule.max === 'number' ? rule.max : parseFloat(rule.max);
        if (isNaN(min) || isNaN(max)) return false;
        return nVal >= min && nVal <= max;
    }
    const target = typeof rule.value === 'number' ? rule.value : parseFloat(rule.value);
    if (isNaN(target)) return false;
    if (rule.type === 'gt')  return nVal >  target;
    if (rule.type === 'lt')  return nVal <  target;
    if (rule.type === 'gte') return nVal >= target;
    if (rule.type === 'lte') return nVal <= target;
    return false;
}

// Is `ref` (e.g. "B5") inside the range string `rangeStr` (e.g. "A1:C10")?
// Single-cell ranges ("A1") work too (treated as 1×1).
export function refInCondRange(ref, rangeStr) {
    const m = /^([A-Z]+\d+)(?::([A-Z]+\d+))?$/.exec(rangeStr);
    if (!m) return false;
    const startStr = m[1], endStr = m[2] || m[1];
    const [c1, r1] = splitRef(startStr);
    const [c2, r2] = splitRef(endStr);
    const [c, r] = splitRef(ref);
    const cn = colToNum(c);
    const c1n = colToNum(c1), c2n = colToNum(c2);
    return cn >= Math.min(c1n, c2n) && cn <= Math.max(c1n, c2n)
        && r  >= Math.min(r1, r2)   && r  <= Math.max(r1, r2);
}

// Apply rowOp/colOp to a range string (mirrors the chart-range shifting
// done in sheet.js's shiftChartRange, but for string-formatted ranges).
// Returns the new range string, or null if any endpoint is invalidated
// (op returns null) — caller drops the rule in that case.
export function shiftRangeStr(rangeStr, rowOp, colOp) {
    const m = /^([A-Z]+\d+)(?::([A-Z]+\d+))?$/.exec(rangeStr);
    if (!m) return null;
    const shiftOne = (refStr) => {
        try {
            const [c, r] = splitRef(refStr);
            const cn = colToNum(c);
            const newCn = colOp ? colOp(cn) : cn;
            const newR  = rowOp ? rowOp(r)  : r;
            if (newCn === null || newR === null) return null;
            return numToCol(newCn) + newR;
        } catch { return null; }
    };
    const newStart = shiftOne(m[1]);
    if (newStart === null) return null;
    if (!m[2]) return newStart;
    const newEnd = shiftOne(m[2]);
    if (newEnd === null) return null;
    return newStart + ':' + newEnd;
}

// Human-readable rule description for the rule-list UI.
export function describeRule(rule) {
    if (!rule) return '';
    switch (rule.type) {
        case 'gt':       return `> ${rule.value}`;
        case 'lt':       return `< ${rule.value}`;
        case 'gte':      return `≥ ${rule.value}`;
        case 'lte':      return `≤ ${rule.value}`;
        case 'eq':       return `= ${rule.value}`;
        case 'neq':      return `≠ ${rule.value}`;
        case 'between':  return `${rule.min} … ${rule.max}`;
        case 'contains': return `contains "${rule.value}"`;
        case 'empty':    return 'is empty';
        case 'notempty': return 'is not empty';
        default:         return rule.type;
    }
}
