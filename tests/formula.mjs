// byteworkz/tests/formula.mjs
//
// Pure-Node test suite for the formula engine. Runs without a browser or
// build step:
//
//     node tests/formula.mjs
//
// Exits 0 on all-green, 1 on any failure. Add cases to the `cases` array.

import { evaluate, colToNum, numToCol, splitRef } from '../sheet-formula.js';

const data = [
    // Sheet 0
    { A1: 10, A2: 20, A3: 30, B1: 5, B2: 7, B3: 'hello', C1: 'x', D1: -3 },
    // Sheet 1 (named "Other")
    { A1: 100, A2: 200 }
];
const sheetNames = ['Sheet1', 'Other'];

const ctx = {
    sheetIdx: 0,
    getValue(ref, sIdx) { return data[sIdx][ref] == null ? null : data[sIdx][ref]; },
    getRange(start, end, sIdx) {
        const [cA, rA] = splitRef(start);
        const [cB, rB] = splitRef(end);
        const c1 = Math.min(colToNum(cA), colToNum(cB));
        const c2 = Math.max(colToNum(cA), colToNum(cB));
        const r1 = Math.min(rA, rB), r2 = Math.max(rA, rB);
        const out = [];
        for (let r = r1; r <= r2; r++) {
            for (let cn = c1; cn <= c2; cn++) {
                const ref = numToCol(cn) + r;
                out.push(data[sIdx][ref] == null ? null : data[sIdx][ref]);
            }
        }
        return out;
    },
    sheetIndexByName(name) { return sheetNames.indexOf(name); }
};

const cases = [
    // arithmetic + precedence
    ['1+2*3', 7],
    ['(1+2)*3', 9],
    ['-5+10', 5],
    ['2^10', 1024],
    ['50%', 0.5],
    ['10/2', 5],
    ['10/0', '#DIV/0!'],

    // references + ranges
    ['A1+B1', 15],
    ['SUM(A1:A3)', 60],
    ['AVERAGE(A1:A3)', 20],
    ['MIN(A1:B2)', 5],
    ['MAX(A1:B2)', 20],
    ['COUNT(A1:B3)', 5],

    // logic
    ['IF(A1>5, "big", "small")', 'big'],
    ['IF(A1<5, "big", "small")', 'small'],
    ['AND(TRUE, A1>5)', true],
    ['OR(FALSE, A1<5)', false],
    ['NOT(TRUE)', false],

    // string
    ['CONCAT("hello ", "world")', 'hello world'],
    ['"x" & "y"', 'xy'],
    ['LEN("hello")', 5],
    ['UPPER("hi")', 'HI'],

    // math fns
    ['ABS(-7)', 7],
    ['ROUND(3.14159, 2)', 3.14],
    ['MOD(10, 3)', 1],
    ['SQRT(16)', 4],

    // cross-sheet
    ['Other!A1', 100],
    ['SUM(Other!A1:A2)', 300],

    // comparison
    ['A1=10', true],
    ['A1<>10', false],

    // absolute refs ($ markers accepted, normalised to plain refs)
    ['$A$1+1', 11],
    ['$A1+1', 11],
    ['A$1+1', 11],
    ['SUM($A$1:$A$3)', 60]
];

let pass = 0, fail = 0;
for (const [f, expected] of cases) {
    const r = evaluate(f, ctx);
    const v = r.value;
    let ok = false;
    if (typeof expected === 'number' && typeof v === 'number') ok = Math.abs(v - expected) < 1e-9;
    else ok = v === expected || String(v).includes(String(expected));
    if (ok) { pass++; }
    else { fail++; console.log(`FAIL: ${f}  →  got ${JSON.stringify(v)}  expected ${JSON.stringify(expected)}`); }
}
console.log(`\n${pass}/${pass+fail} passed`);
process.exit(fail === 0 ? 0 : 1);
