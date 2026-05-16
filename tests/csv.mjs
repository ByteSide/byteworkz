// byteworkz/tests/csv.mjs
//
// Pure-Node tests for the CSV parser. No browser, no DOM. Run with:
//     node tests/csv.mjs
//
// Exits 0 on all-green, 1 on any failure.

import { parseCSV, sniffDelimiter, detectHeader, csvToCellsObj } from '../csv.js';

let pass = 0, fail = 0;
function eq(label, got, expected) {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { pass++; }
    else { fail++; console.log(`FAIL: ${label}\n  got:      ${JSON.stringify(got)}\n  expected: ${JSON.stringify(expected)}`); }
}

// ── parseCSV ──
eq('simple', parseCSV('a,b,c\n1,2,3'),                     [['a','b','c'], ['1','2','3']]);
eq('trailing newline', parseCSV('a,b\n1,2\n'),              [['a','b'], ['1','2']]);
eq('CRLF', parseCSV('a,b\r\n1,2\r\n'),                      [['a','b'], ['1','2']]);
eq('empty fields', parseCSV('a,,c\n,,'),                    [['a','','c'], ['','','']]);
eq('quoted comma', parseCSV('a,"b,c",d'),                   [['a','b,c','d']]);
eq('escaped quote', parseCSV('a,"b""c",d'),                 [['a','b"c','d']]);
eq('quoted newline', parseCSV('a,"b\nc",d'),                [['a','b\nc','d']]);
eq('all quoted', parseCSV('"a","b","c"'),                   [['a','b','c']]);
eq('BOM stripped', parseCSV('﻿a,b\n1,2'),              [['a','b'], ['1','2']]);
eq('empty input', parseCSV(''),                             []);
eq('only newlines', parseCSV('\n\n'),                       [[''], ['']]);

// ── sniffDelimiter ──
eq('sniff comma', sniffDelimiter('a,b,c\n1,2,3'),           ',');
eq('sniff tab',   sniffDelimiter('a\tb\tc\n1\t2\t3'),       '\t');
eq('sniff semicolon', sniffDelimiter('a;b;c\n1;2;3'),       ';');
eq('sniff mixed → most freq', sniffDelimiter('a;b,c\n1;2;3'), ';');

// ── detectHeader ──
eq('header: text/num',   detectHeader([['Name','Age'], ['Alice','30']]), true);
eq('header: all numeric', detectHeader([['1','2'], ['3','4']]),          false);
eq('header: single row', detectHeader([['Name','Age']]),                 false);
eq('header: text/text', detectHeader([['Name','Age'], ['Alice','Bob']]), false);

// ── csvToCellsObj ──
const c1 = csvToCellsObj([['Name','Age'], ['Alice','30'], ['Bob','25']]);
eq('cells basic structure', Object.keys(c1.cells).sort(),
   ['A1','A2','A3','B1','B2','B3']);
eq('header style applied', c1.cells.A1.s, { b: 1, c: '#FD7D00' });
eq('number coercion', c1.cells.B2.v, 30);
eq('string preserved', c1.cells.A2.v, 'Alice');
eq('rowsLoaded',   c1.rowsLoaded, 3);
eq('colsLoaded',   c1.colsLoaded, 2);

// number-like but not roundtrip → string
const c2 = csvToCellsObj([['x'], ['1.00']]);  // 1.00 parses to 1, "1" != "1.00"
eq('1.00 stays string', c2.cells.A2.v, '1.00');

// Truncation at maxRows
const big = Array.from({length: 5}, (_, i) => [String(i)]);
const c3 = csvToCellsObj(big, { maxRows: 3 });
eq('truncated rowsLoaded', c3.rowsLoaded, 3);
eq('truncated has only A1..A3', Object.keys(c3.cells).sort(), ['A1','A2','A3']);

// Empty row handling
const c4 = csvToCellsObj([['a','b'], ['','']]);
eq('empty fields skipped', Object.keys(c4.cells).sort(), ['A1','B1']);

console.log(`\n${pass}/${pass+fail} passed`);
process.exit(fail ? 1 : 0);
