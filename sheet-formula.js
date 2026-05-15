/* byteworkz/sheet-formula.js — formula tokenizer + evaluator.
 *
 * Supports:
 *   numbers, strings ("…"), booleans (TRUE/FALSE), cell refs (A1, $A$1 treated as A1),
 *   range refs (A1:B5), cross-sheet refs (Sheet2!A1, Sheet2!A1:B5),
 *   operators: + - * / ^ %, comparison: = <> < > <= >=, concat: &,
 *   functions: SUM, AVERAGE/AVG, MIN, MAX, COUNT, COUNTA, IF, CONCAT/CONCATENATE,
 *              ABS, ROUND, FLOOR, CEILING, SQRT, AND, OR, NOT, LEN, UPPER, LOWER, TRIM
 *
 * Public:
 *   tokenize(text) → [token]                     (mostly internal; exported for tests)
 *   evaluate(formula, ctx) → { value, error?, deps:Set<string>, rangeDeps:Set<string> }
 *     ctx = {
 *       sheetIdx: number,
 *       getValue(ref, sheetIdx) → number|string|boolean|null,
 *       getRange(startRef, endRef, sheetIdx) → Array<value>,
 *       sheetIndexByName(name) → number | -1
 *     }
 *
 *   deps are individual cell keys "sheetIdx!REF" (uppercased) that this formula depends on.
 */

export const FUNCTIONS = new Set([
    'SUM','AVERAGE','AVG','MIN','MAX','COUNT','COUNTA','IF','CONCAT','CONCATENATE',
    'ABS','ROUND','FLOOR','CEILING','SQRT','POWER','AND','OR','NOT',
    'LEN','UPPER','LOWER','TRIM','MOD','INT'
]);

const OP_INFO = {
    '+':  { prec: 4, assoc: 'L', arity: 2 },
    '-':  { prec: 4, assoc: 'L', arity: 2 },
    '*':  { prec: 5, assoc: 'L', arity: 2 },
    '/':  { prec: 5, assoc: 'L', arity: 2 },
    '%':  { prec: 6, assoc: 'L', arity: 1, postfix: true }, // 50% → 0.5
    '^':  { prec: 7, assoc: 'R', arity: 2 },
    '&':  { prec: 3, assoc: 'L', arity: 2 },
    '=':  { prec: 2, assoc: 'L', arity: 2 },
    '<>': { prec: 2, assoc: 'L', arity: 2 },
    '<':  { prec: 2, assoc: 'L', arity: 2 },
    '>':  { prec: 2, assoc: 'L', arity: 2 },
    '<=': { prec: 2, assoc: 'L', arity: 2 },
    '>=': { prec: 2, assoc: 'L', arity: 2 },
    'u-': { prec: 8, assoc: 'R', arity: 1 }    // unary minus (synthetic)
};

// REF_RE captures four groups so callers know which $-markers were present:
//   1 = colAbs marker ('' or '$')
//   2 = column letters
//   3 = rowAbs marker ('' or '$')
//   4 = row digits
const REF_RE = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,5})/;

function parseRefMatch(m) {
    const col = m[2].toUpperCase();
    const row = parseInt(m[4], 10);
    return {
        col, row,
        colAbs: m[1] === '$',
        rowAbs: m[3] === '$',
        ref: col + row
    };
}

/* ------------- Tokenizer ------------- */

export function tokenize(text) {
    const t = String(text);
    const tokens = [];
    let i = 0;
    while (i < t.length) {
        const c = t[i];
        if (c === ' ' || c === '\t') { i++; continue; }
        const tokStart = i;

        // number
        if (/\d/.test(c) || (c === '.' && /\d/.test(t[i+1]))) {
            let j = i;
            while (j < t.length && /[0-9.]/.test(t[j])) j++;
            // scientific?
            if (t[j] === 'e' || t[j] === 'E') {
                j++;
                if (t[j] === '+' || t[j] === '-') j++;
                while (j < t.length && /[0-9]/.test(t[j])) j++;
            }
            tokens.push({ type: 'NUM', value: parseFloat(t.slice(i, j)), loc: { start: tokStart, end: j } });
            i = j; continue;
        }

        // string literal "…"
        if (c === '"') {
            let j = i + 1;
            let s = '';
            while (j < t.length) {
                if (t[j] === '"') {
                    if (t[j+1] === '"') { s += '"'; j += 2; continue; }
                    break;
                }
                s += t[j]; j++;
            }
            const end = j + 1;
            tokens.push({ type: 'STR', value: s, loc: { start: tokStart, end } });
            i = end; continue;
        }

        // quoted sheet name: 'Q1 Sales'!A1[:B5]  (Excel-style; '' inside = literal ')
        if (c === "'") {
            let j = i + 1;
            let name = '';
            while (j < t.length) {
                if (t[j] === "'") {
                    if (t[j+1] === "'") { name += "'"; j += 2; continue; }
                    break;
                }
                name += t[j]; j++;
            }
            if (t[j] !== "'") throw new FormulaError('#ERROR! unterminated sheet name');
            j++;
            if (t[j] !== '!') throw new FormulaError('#ERROR! expected ! after quoted sheet name');
            j++;
            const m = t.slice(j).match(REF_RE);
            if (!m) throw new FormulaError('#REF! after ' + name);
            const startRef = parseRefMatch(m);
            let endJ = j + m[0].length;
            let endRef = null;
            if (t[endJ] === ':') {
                const m2 = t.slice(endJ + 1).match(REF_RE);
                if (m2) {
                    endRef = parseRefMatch(m2);
                    endJ += 1 + m2[0].length;
                }
            }
            const loc = { start: tokStart, end: endJ };
            tokens.push(endRef
                ? { type: 'RANGE', sheet: name, start: startRef.ref, end: endRef.ref, startCell: startRef, endCell: endRef, loc }
                : { type: 'REF', sheet: name, ref: startRef.ref, col: startRef.col, colAbs: startRef.colAbs, row: startRef.row, rowAbs: startRef.rowAbs, loc });
            i = endJ; continue;
        }

        // sheet-qualified ref or plain ref or function or boolean
        // `$` is also a valid leading/internal char so absolute refs like
        // $A$1, A$1, $A1 tokenize correctly. The match patterns below preserve
        // the abs flags so rewriteFormula can shift non-absolute refs while
        // keeping absolute ones fixed.
        if (/[A-Za-z_$]/.test(c)) {
            let j = i;
            while (j < t.length && /[A-Za-z0-9_.$]/.test(t[j])) j++;
            let word = t.slice(i, j);
            // unquoted sheet!ref ?
            if (t[j] === '!') {
                const sheetName = word;
                j++;
                const m = t.slice(j).match(REF_RE);
                if (m) {
                    const startRef = parseRefMatch(m);
                    let endJ = j + m[0].length;
                    let endRef = null;
                    if (t[endJ] === ':') {
                        const m2 = t.slice(endJ + 1).match(REF_RE);
                        if (m2) {
                            endRef = parseRefMatch(m2);
                            endJ += 1 + m2[0].length;
                        }
                    }
                    const loc = { start: tokStart, end: endJ };
                    tokens.push(endRef
                        ? { type: 'RANGE', sheet: sheetName, start: startRef.ref, end: endRef.ref, startCell: startRef, endCell: endRef, loc }
                        : { type: 'REF', sheet: sheetName, ref: startRef.ref, col: startRef.col, colAbs: startRef.colAbs, row: startRef.row, rowAbs: startRef.rowAbs, loc });
                    i = endJ; continue;
                }
                // fallthrough: identifier followed by '!' but no valid ref —
                // emit the identifier, leave '!' for next iter (the previous
                // code did `i = j - 1` which was an infinite-loop trap).
                tokens.push({ type: 'IDENT', value: word, loc: { start: tokStart, end: j } });
                i = j;
                continue;
            }
            // bare ref like A1 or absolute $A$1 / A$1 / $A1 or range A1:B5
            const refMatch = word.match(/^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,5})$/);
            if (refMatch) {
                const startRef = {
                    col: refMatch[2].toUpperCase(),
                    colAbs: refMatch[1] === '$',
                    row: parseInt(refMatch[4], 10),
                    rowAbs: refMatch[3] === '$',
                    ref: refMatch[2].toUpperCase() + refMatch[4]
                };
                let endJ = j;
                let endRef = null;
                if (t[endJ] === ':') {
                    const m2 = t.slice(endJ + 1).match(REF_RE);
                    if (m2) {
                        endRef = parseRefMatch(m2);
                        endJ += 1 + m2[0].length;
                    }
                }
                const loc = { start: tokStart, end: endJ };
                tokens.push(endRef
                    ? { type: 'RANGE', sheet: null, start: startRef.ref, end: endRef.ref, startCell: startRef, endCell: endRef, loc }
                    : { type: 'REF', sheet: null, ref: startRef.ref, col: startRef.col, colAbs: startRef.colAbs, row: startRef.row, rowAbs: startRef.rowAbs, loc });
                i = endJ; continue;
            }
            // function or boolean
            const upper = word.toUpperCase();
            if (upper === 'TRUE')  { tokens.push({ type: 'BOOL', value: true,  loc: { start: tokStart, end: j } }); i = j; continue; }
            if (upper === 'FALSE') { tokens.push({ type: 'BOOL', value: false, loc: { start: tokStart, end: j } }); i = j; continue; }
            let k = j;
            while (k < t.length && /\s/.test(t[k])) k++;
            if (t[k] === '(' && FUNCTIONS.has(upper)) {
                tokens.push({ type: 'FUNC', name: upper, loc: { start: tokStart, end: k } });
                i = k; continue;
            }
            tokens.push({ type: 'IDENT', value: word, loc: { start: tokStart, end: j } });
            i = j; continue;
        }

        if (c === '(') { tokens.push({ type: 'LP',    loc: { start: tokStart, end: i + 1 } }); i++; continue; }
        if (c === ')') { tokens.push({ type: 'RP',    loc: { start: tokStart, end: i + 1 } }); i++; continue; }
        if (c === ',') { tokens.push({ type: 'COMMA', loc: { start: tokStart, end: i + 1 } }); i++; continue; }
        if (c === ':') { tokens.push({ type: 'OP', op: ':', loc: { start: tokStart, end: i + 1 } }); i++; continue; }

        if (c === '<' && t[i+1] === '=') { tokens.push({ type: 'OP', op: '<=', loc: { start: tokStart, end: i + 2 } }); i += 2; continue; }
        if (c === '>' && t[i+1] === '=') { tokens.push({ type: 'OP', op: '>=', loc: { start: tokStart, end: i + 2 } }); i += 2; continue; }
        if (c === '<' && t[i+1] === '>') { tokens.push({ type: 'OP', op: '<>', loc: { start: tokStart, end: i + 2 } }); i += 2; continue; }
        if ('+-*/^%&=<>'.includes(c)) { tokens.push({ type: 'OP', op: c, loc: { start: tokStart, end: i + 1 } }); i++; continue; }

        // Unknown char — emit error token
        throw new FormulaError('#ERROR! unexpected char "' + c + '"');
    }
    return tokens;
}

function normalizeRef(ref) {
    return ref.toUpperCase().replace(/\$/g, '');
}

class FormulaError extends Error {
    constructor(msg) { super(msg); this.name = 'FormulaError'; this.isFormulaError = true; }
}

/* ------------- Shunting-Yard to RPN ------------- */

function toRPN(tokens) {
    const out = [];
    const ops = [];
    let prev = null; // for distinguishing unary minus
    for (let i = 0; i < tokens.length; i++) {
        const tk = tokens[i];
        if (tk.type === 'NUM' || tk.type === 'STR' || tk.type === 'BOOL' || tk.type === 'REF' || tk.type === 'RANGE') {
            out.push(tk);
        } else if (tk.type === 'FUNC') {
            ops.push(tk);
        } else if (tk.type === 'COMMA') {
            while (ops.length && ops[ops.length - 1].type !== 'LP') out.push(ops.pop());
            if (!ops.length) throw new FormulaError('#ERROR! comma outside function');
            // bump argc on the function below the LP (LP is at top, FUNC at top-1)
            const fn = ops[ops.length - 2];
            if (fn && fn.type === 'FUNC') fn.argc = (fn.argc || 1) + 1;
        } else if (tk.type === 'OP') {
            let op = tk.op;
            // detect unary minus
            if (op === '-' && (!prev || prev.type === 'OP' || prev.type === 'LP' || prev.type === 'COMMA' || prev.type === 'FUNC')) {
                op = 'u-';
            } else if (op === '+' && (!prev || prev.type === 'OP' || prev.type === 'LP' || prev.type === 'COMMA' || prev.type === 'FUNC')) {
                tk._skip = true; prev = tk; continue; // unary plus, no-op
            }
            const info = OP_INFO[op];
            if (!info) throw new FormulaError('#ERROR! unknown op ' + op);
            while (ops.length) {
                const top = ops[ops.length - 1];
                if (top.type !== 'OP') break;
                const topInfo = OP_INFO[top.op];
                if (!topInfo) break;
                if ((info.assoc === 'L' && topInfo.prec >= info.prec) ||
                    (info.assoc === 'R' && topInfo.prec > info.prec)) {
                    out.push(ops.pop());
                } else break;
            }
            ops.push({ type: 'OP', op });
        } else if (tk.type === 'LP') {
            // If previous was FUNC, mark argc
            const top = ops[ops.length - 1];
            if (top && top.type === 'FUNC' && top.argc === undefined) {
                top.argc = 0; // will become 1 on first operand below if any
            }
            ops.push(tk);
            // Look ahead: if next is RP, function has 0 args (handled by argc=0)
            if (tokens[i+1] && tokens[i+1].type !== 'RP') {
                if (top && top.type === 'FUNC') top.argc = 1;
            }
        } else if (tk.type === 'RP') {
            while (ops.length && ops[ops.length - 1].type !== 'LP') out.push(ops.pop());
            if (!ops.length) throw new FormulaError('#ERROR! mismatched parens');
            ops.pop(); // discard LP
            if (ops.length && ops[ops.length - 1].type === 'FUNC') {
                out.push(ops.pop());
            }
        } else if (tk.type === 'IDENT') {
            throw new FormulaError('#NAME? "' + tk.value + '"');
        }
        prev = tk;
    }
    while (ops.length) {
        const top = ops.pop();
        if (top.type === 'LP' || top.type === 'RP') throw new FormulaError('#ERROR! mismatched parens');
        out.push(top);
    }
    return out;
}

/* ------------- Evaluator ------------- */

export function evaluate(formula, ctx) {
    const deps = new Set();
    const rangeDeps = new Set();
    try {
        const tokens = tokenize(formula);
        const rpn = toRPN(tokens);
        const stack = [];
        for (const tk of rpn) {
            if (tk.type === 'NUM' || tk.type === 'STR' || tk.type === 'BOOL') {
                stack.push(tk.value);
            } else if (tk.type === 'REF') {
                const sheetIdx = tk.sheet ? ctx.sheetIndexByName(tk.sheet) : ctx.sheetIdx;
                if (sheetIdx < 0) throw new FormulaError('#REF! sheet ' + tk.sheet);
                deps.add(sheetIdx + '!' + tk.ref);
                stack.push(ctx.getValue(tk.ref, sheetIdx));
            } else if (tk.type === 'RANGE') {
                const sheetIdx = tk.sheet ? ctx.sheetIndexByName(tk.sheet) : ctx.sheetIdx;
                if (sheetIdx < 0) throw new FormulaError('#REF! sheet ' + tk.sheet);
                const arr = ctx.getRange(tk.start, tk.end, sheetIdx);
                // Track range — add each cell key in range to deps
                const cells = enumerateRange(tk.start, tk.end);
                cells.forEach(r => deps.add(sheetIdx + '!' + r));
                rangeDeps.add(sheetIdx + '!' + tk.start + ':' + tk.end);
                stack.push({ __isArray: true, values: arr });
            } else if (tk.type === 'OP') {
                applyOp(stack, tk.op);
            } else if (tk.type === 'FUNC') {
                const argc = tk.argc || 0;
                const args = argc ? stack.splice(stack.length - argc, argc) : [];
                stack.push(applyFunc(tk.name, args));
            }
        }
        if (stack.length !== 1) throw new FormulaError('#ERROR! eval stack');
        let v = stack[0];
        if (v && v.__isArray) v = v.values[0]; // array → first cell (Excel-ish implicit intersection)
        return { value: v, deps, rangeDeps };
    } catch (e) {
        if (e && e.isFormulaError) return { value: e.message, error: e.message, deps, rangeDeps };
        return { value: '#ERROR!', error: String(e.message || e), deps, rangeDeps };
    }
}

function enumerateRange(a, b) {
    const [c1, r1] = splitRef(a);
    const [c2, r2] = splitRef(b);
    const c1n = colToNum(c1), c2n = colToNum(c2);
    const rs = Math.min(r1, r2), re = Math.max(r1, r2);
    const cs = Math.min(c1n, c2n), ce = Math.max(c1n, c2n);
    const out = [];
    for (let r = rs; r <= re; r++) {
        for (let c = cs; c <= ce; c++) {
            out.push(numToCol(c) + r);
        }
    }
    return out;
}
export function splitRef(ref) {
    const m = ref.match(/^([A-Z]{1,3})(\d{1,5})$/);
    if (!m) throw new FormulaError('#REF! ' + ref);
    return [m[1], parseInt(m[2], 10)];
}
export function colToNum(col) {
    let n = 0;
    for (let i = 0; i < col.length; i++) n = n * 26 + (col.charCodeAt(i) - 64);
    return n;
}
export function numToCol(n) {
    let s = '';
    while (n > 0) {
        const r = (n - 1) % 26;
        s = String.fromCharCode(65 + r) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

function toNum(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    const n = parseFloat(v);
    if (isNaN(n)) throw new FormulaError('#VALUE! "' + v + '" not a number');
    return n;
}
function toStr(v) {
    if (v == null) return '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return String(v);
}
function flatten(arr) {
    const out = [];
    arr.forEach(v => {
        if (v && v.__isArray) v.values.forEach(x => out.push(x));
        else out.push(v);
    });
    return out;
}

function applyOp(stack, op) {
    if (op === 'u-') {
        const a = stack.pop(); stack.push(-toNum(a)); return;
    }
    if (op === '%') {
        const a = stack.pop(); stack.push(toNum(a) / 100); return;
    }
    const b = stack.pop();
    const a = stack.pop();
    let av = a && a.__isArray ? a.values[0] : a;
    let bv = b && b.__isArray ? b.values[0] : b;
    switch (op) {
        case '+': stack.push(toNum(av) + toNum(bv)); return;
        case '-': stack.push(toNum(av) - toNum(bv)); return;
        case '*': stack.push(toNum(av) * toNum(bv)); return;
        case '/': {
            const d = toNum(bv);
            if (d === 0) throw new FormulaError('#DIV/0!');
            stack.push(toNum(av) / d); return;
        }
        case '^': stack.push(Math.pow(toNum(av), toNum(bv))); return;
        case '&': stack.push(toStr(av) + toStr(bv)); return;
        case '=':  stack.push(equalsLoose(av, bv)); return;
        case '<>': stack.push(!equalsLoose(av, bv)); return;
        case '<':  stack.push(cmp(av, bv) < 0); return;
        case '>':  stack.push(cmp(av, bv) > 0); return;
        case '<=': stack.push(cmp(av, bv) <= 0); return;
        case '>=': stack.push(cmp(av, bv) >= 0); return;
    }
    throw new FormulaError('#ERROR! op ' + op);
}
function equalsLoose(a, b) {
    if (typeof a === 'number' || typeof b === 'number') {
        try { return toNum(a) === toNum(b); } catch { return false; }
    }
    return toStr(a) === toStr(b);
}
function cmp(a, b) {
    if (typeof a === 'number' || typeof b === 'number') return toNum(a) - toNum(b);
    return toStr(a) < toStr(b) ? -1 : toStr(a) > toStr(b) ? 1 : 0;
}

function applyFunc(name, args) {
    const flat = flatten(args);
    switch (name) {
        case 'SUM':     return flat.reduce((s, v) => s + safeNumOrZero(v), 0);
        case 'AVERAGE':
        case 'AVG': {
            const nums = flat.map(safeNumOrNaN).filter(n => !isNaN(n));
            if (!nums.length) throw new FormulaError('#DIV/0!');
            return nums.reduce((a, b) => a + b, 0) / nums.length;
        }
        case 'MIN': {
            const nums = flat.map(safeNumOrNaN).filter(n => !isNaN(n));
            if (!nums.length) return 0;
            return Math.min(...nums);
        }
        case 'MAX': {
            const nums = flat.map(safeNumOrNaN).filter(n => !isNaN(n));
            if (!nums.length) return 0;
            return Math.max(...nums);
        }
        case 'COUNT':   return flat.filter(v => typeof v === 'number' || (typeof v === 'string' && v !== '' && !isNaN(parseFloat(v)))).length;
        case 'COUNTA':  return flat.filter(v => v != null && v !== '').length;
        case 'IF': {
            const [cond, a, b] = [args[0], args[1], args[2]];
            const c = cond && cond.__isArray ? cond.values[0] : cond;
            const truthy = (typeof c === 'boolean') ? c : (typeof c === 'number' ? c !== 0 : (c != null && c !== '' && c !== 'FALSE'));
            const v = truthy ? a : b;
            if (v == null) return truthy ? true : false;
            return (v && v.__isArray) ? v.values[0] : v;
        }
        case 'CONCAT':
        case 'CONCATENATE': return flat.map(toStr).join('');
        case 'ABS':    return Math.abs(toNum(flat[0]));
        case 'ROUND': {
            const x = toNum(flat[0]); const d = flat.length > 1 ? Math.floor(toNum(flat[1])) : 0;
            const f = Math.pow(10, d);
            return Math.round(x * f) / f;
        }
        case 'FLOOR':  return Math.floor(toNum(flat[0]));
        case 'CEILING':return Math.ceil(toNum(flat[0]));
        case 'SQRT':   { const x = toNum(flat[0]); if (x < 0) throw new FormulaError('#NUM!'); return Math.sqrt(x); }
        case 'POWER':  return Math.pow(toNum(flat[0]), toNum(flat[1]));
        case 'AND':    return flat.every(v => Boolean(typeof v === 'number' ? v !== 0 : (typeof v === 'boolean' ? v : (v && v !== 'FALSE'))));
        case 'OR':     return flat.some(v => Boolean(typeof v === 'number' ? v !== 0 : (typeof v === 'boolean' ? v : (v && v !== 'FALSE'))));
        case 'NOT':    return !(typeof flat[0] === 'boolean' ? flat[0] : (typeof flat[0] === 'number' ? flat[0] !== 0 : !!flat[0]));
        case 'LEN':    return toStr(flat[0]).length;
        case 'UPPER':  return toStr(flat[0]).toUpperCase();
        case 'LOWER':  return toStr(flat[0]).toLowerCase();
        case 'TRIM':   return toStr(flat[0]).trim();
        case 'MOD':    { const b = toNum(flat[1]); if (b === 0) throw new FormulaError('#DIV/0!'); return toNum(flat[0]) % b; }
        case 'INT':    return Math.floor(toNum(flat[0]));
    }
    throw new FormulaError('#NAME? ' + name);
}

function safeNumOrZero(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
}
function safeNumOrNaN(v) {
    if (v == null || v === '') return NaN;
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    const n = parseFloat(v);
    return isNaN(n) ? NaN : n;
}

/* ------------- Re-serialisation / rewrite helpers ------------- */

// Sheet names that don't fit the bare-identifier shape need quoting in
// formula text. Excel-style: 'Name with spaces', with '' escaping a literal '.
function needsQuoting(name) {
    return !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name));
}
function quoteSheetName(name) {
    return "'" + String(name).replace(/'/g, "''") + "'";
}

// Serialize a parsed ref (`{col,colAbs,row,rowAbs}` + optional sheet) back to
// formula text. Preserves the absolute-marker positions so a round-trip of
// `$A$1` → tokenize → refToString → `$A$1` is byte-identical.
export function refToString(parts) {
    let s = '';
    if (parts.sheet) {
        s += needsQuoting(parts.sheet) ? quoteSheetName(parts.sheet) : parts.sheet;
        s += '!';
    }
    if (parts.colAbs) s += '$';
    s += parts.col;
    if (parts.rowAbs) s += '$';
    s += parts.row;
    return s;
}

export function rangeToString(startCell, endCell, sheet) {
    let s = '';
    if (sheet) {
        s += needsQuoting(sheet) ? quoteSheetName(sheet) : sheet;
        s += '!';
    }
    if (startCell.colAbs) s += '$';
    s += startCell.col;
    if (startCell.rowAbs) s += '$';
    s += startCell.row;
    s += ':';
    if (endCell.colAbs) s += '$';
    s += endCell.col;
    if (endCell.rowAbs) s += '$';
    s += endCell.row;
    return s;
}

// Apply rowOp/colOp to a single REF token, returning the new ref text.
// rowOp/colOp are functions (1-based number → new number | null). `null`
// means "this row/col was deleted" → produces literal `#REF!`. Absolute
// markers ($A, A$1) skip the transform.
export function shiftRef(tk, rowOp, colOp) {
    let row = tk.row, col = tk.col;
    if (!tk.rowAbs && rowOp) {
        const r = rowOp(tk.row);
        if (r === null) return '#REF!';
        row = r;
    }
    if (!tk.colAbs && colOp) {
        const c = colOp(colToNum(tk.col));
        if (c === null) return '#REF!';
        col = numToCol(c);
    }
    return refToString({ col, colAbs: tk.colAbs, row, rowAbs: tk.rowAbs, sheet: tk.sheet });
}

// Apply rowOp/colOp to a RANGE token. If any endpoint is invalidated, the
// whole range becomes `#REF!` (matches Excel's behaviour — a partial-overlap
// shrink would be nicer but is out of scope).
export function shiftRange(tk, rowOp, colOp) {
    const ns = { ...tk.startCell }, ne = { ...tk.endCell };
    for (const cell of [ns, ne]) {
        if (!cell.rowAbs && rowOp) {
            const r = rowOp(cell.row);
            if (r === null) return '#REF!';
            cell.row = r;
        }
        if (!cell.colAbs && colOp) {
            const c = colOp(colToNum(cell.col));
            if (c === null) return '#REF!';
            cell.col = numToCol(c);
        }
    }
    return rangeToString(ns, ne, tk.sheet);
}

// Walk a formula's tokens and call `transform(token)` for each REF / RANGE
// token. If `transform` returns a string, it replaces the source slice for
// that token; if it returns null/undefined, the original text is kept.
// Whitespace between tokens, operator forms, function names, parens —
// everything non-ref — is preserved byte-for-byte via source slicing.
// If tokenisation fails, the input is returned unchanged (we'd rather leak
// a broken formula than silently corrupt it).
export function rewriteFormula(formula, transform) {
    let tokens;
    try { tokens = tokenize(formula); } catch { return formula; }
    const parts = [];
    let last = 0;
    for (const tk of tokens) {
        if (!tk.loc) continue;
        const { start, end } = tk.loc;
        if (start > last) parts.push(formula.slice(last, start));
        if (tk.type === 'REF' || tk.type === 'RANGE') {
            const replaced = transform(tk);
            parts.push(replaced != null ? replaced : formula.slice(start, end));
        } else {
            parts.push(formula.slice(start, end));
        }
        last = end;
    }
    if (last < formula.length) parts.push(formula.slice(last));
    return parts.join('');
}
