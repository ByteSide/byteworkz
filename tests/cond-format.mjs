// byteworkz/tests/cond-format.mjs — pure-function tests for conditional formatting.
// Run with: node tests/cond-format.mjs

import { evaluateCondRule, refInCondRange, shiftRangeStr, describeRule } from '../cond-format.js';

let pass = 0, fail = 0;
function eq(label, got, expected) {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) pass++;
    else { fail++; console.log(`FAIL: ${label}\n  got:      ${JSON.stringify(got)}\n  expected: ${JSON.stringify(expected)}`); }
}

// ── evaluateCondRule: numeric comparisons ──
eq('gt: 150 > 100',  evaluateCondRule(150, { type: 'gt', value: 100 }),  true);
eq('gt: 50 > 100',   evaluateCondRule(50,  { type: 'gt', value: 100 }),  false);
eq('gt: 100 > 100',  evaluateCondRule(100, { type: 'gt', value: 100 }),  false);
eq('gte: 100 >= 100', evaluateCondRule(100, { type: 'gte', value: 100 }), true);
eq('lt:  50 < 100',  evaluateCondRule(50,  { type: 'lt', value: 100 }),  true);
eq('lte: 100 <= 100', evaluateCondRule(100, { type: 'lte', value: 100 }), true);

// ── numeric coercion from string ──
eq('gt: "150" > 100 (str → num)', evaluateCondRule("150", { type: 'gt', value: 100 }), true);
eq('gt: "abc" > 100 (non-num)',   evaluateCondRule("abc", { type: 'gt', value: 100 }), false);

// ── between ──
eq('between: 50 in [0..100]',    evaluateCondRule(50,  { type: 'between', min: 0, max: 100 }), true);
eq('between: 0 in [0..100]',     evaluateCondRule(0,   { type: 'between', min: 0, max: 100 }), true);
eq('between: 100 in [0..100]',   evaluateCondRule(100, { type: 'between', min: 0, max: 100 }), true);
eq('between: 150 outside',       evaluateCondRule(150, { type: 'between', min: 0, max: 100 }), false);
eq('between: -50 outside',       evaluateCondRule(-50, { type: 'between', min: 0, max: 100 }), false);

// ── equality ──
eq('eq: "ok" = "ok"',     evaluateCondRule('ok', { type: 'eq', value: 'ok' }), true);
eq('eq: "OK" = "ok"',     evaluateCondRule('OK', { type: 'eq', value: 'ok' }), false);  // case-sensitive
eq('eq: 100 = "100"',     evaluateCondRule(100,  { type: 'eq', value: '100' }), true);  // string-coerced
eq('neq: "a" != "b"',     evaluateCondRule('a',  { type: 'neq', value: 'b' }), true);

// ── contains ──
eq('contains: "hello world" ⊃ "world"', evaluateCondRule('hello world', { type: 'contains', value: 'world' }), true);
eq('contains: "Hello" ⊃ "hello" (case-insensitive)', evaluateCondRule('Hello', { type: 'contains', value: 'hello' }), true);
eq('contains: "" ⊃ anything (empty)', evaluateCondRule('', { type: 'contains', value: 'x' }), false);

// ── empty / notempty ──
eq('empty: ""',        evaluateCondRule('',   { type: 'empty' }), true);
eq('empty: null',      evaluateCondRule(null, { type: 'empty' }), true);
eq('empty: 0 (number)', evaluateCondRule(0,    { type: 'empty' }), false);  // 0 is not empty
eq('notempty: "a"',    evaluateCondRule('a',  { type: 'notempty' }), true);
eq('notempty: 0',      evaluateCondRule(0,    { type: 'notempty' }), true);
eq('notempty: null',   evaluateCondRule(null, { type: 'notempty' }), false);

// ── refInCondRange ──
eq('range A1:C5 ⊃ B3',        refInCondRange('B3', 'A1:C5'),  true);
eq('range A1:C5 ∌ D3',        refInCondRange('D3', 'A1:C5'),  false);
eq('range A1:C5 ⊃ A1',        refInCondRange('A1', 'A1:C5'),  true);
eq('range A1:C5 ⊃ C5',        refInCondRange('C5', 'A1:C5'),  true);
eq('range A1 ⊃ A1 (single)',  refInCondRange('A1', 'A1'),    true);
eq('range A1 ∌ A2 (single)',  refInCondRange('A2', 'A1'),    false);
eq('range invalid',           refInCondRange('A1', 'not-a-range'), false);

// ── shiftRangeStr ──
eq('shift A1:C5 down by row 1+', shiftRangeStr('A1:C5', r => r + 1, null), 'A2:C6');
eq('shift A1:C5 col +1',         shiftRangeStr('A1:C5', null, c => c + 1), 'B1:D5');
eq('shift single-cell A1',        shiftRangeStr('A1', r => r + 2, null), 'A3');
eq('shift drops if endpoint null', shiftRangeStr('A1:C5', r => r === 1 ? null : r, null), null);

// ── describeRule ──
eq('describe gt',       describeRule({ type: 'gt', value: 100 }),        '> 100');
eq('describe between',  describeRule({ type: 'between', min: 0, max: 100 }), '0 … 100');
eq('describe contains', describeRule({ type: 'contains', value: 'OK' }), 'contains "OK"');
eq('describe empty',    describeRule({ type: 'empty' }),                 'is empty');

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
