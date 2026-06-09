'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  majorityOf,
  compareByRules,
  placeFinal,
  placeMultiDanceFinal,
  recall,
} = require('../src/core/skating');

const placesOf = (res) => res.map((r) => ({ id: r.id, place: r.place }));

/* ---------------------------------------------------------------- *
 * Rule 1 — clean majority, single dance final, 5 judges 6 couples
 * ---------------------------------------------------------------- */
test('Rule 1: clean single-dance final', () => {
  assert.strictEqual(majorityOf(5), 3);
  const couples = [
    { id: 'A', marks: [1, 1, 2, 1, 2] },
    { id: 'B', marks: [2, 3, 1, 2, 1] },
    { id: 'C', marks: [3, 2, 3, 4, 3] },
    { id: 'D', marks: [4, 5, 4, 3, 5] },
    { id: 'E', marks: [5, 4, 6, 5, 4] },
    { id: 'F', marks: [6, 6, 5, 6, 6] },
  ];
  const res = placeFinal(couples);
  assert.deepStrictEqual(placesOf(res), [
    { id: 'A', place: 1 },
    { id: 'B', place: 2 },
    { id: 'C', place: 3 },
    { id: 'D', place: 4 },
    { id: 'E', place: 5 },
    { id: 'F', place: 6 },
  ]);
});

/* ---------------------------------------------------------------- *
 * Rule 2 — equal majority place, larger count wins
 *   Both reach majority at place 2, X has 4 marks <=2, Y has 3.
 * ---------------------------------------------------------------- */
test('Rule 2: larger count at same place wins', () => {
  // 5 judges, majority 3
  const X = [1, 2, 2, 2, 3]; // <=2 : 4
  const Y = [1, 1, 2, 3, 3]; // <=2 : 3
  const r = compareByRules(X, Y, 5, 5);
  assert.ok(r < 0, 'X should rank higher than Y by rule 2');
});

/* ---------------------------------------------------------------- *
 * Rule 3 — equal majority + equal count, lower sum wins
 *   Both <=2 count = 3; X sum of counted = 1+2+2=5, Y = 2+2+2=6.
 * ---------------------------------------------------------------- */
test('Rule 3: lower sum breaks equal count', () => {
  const X = [1, 2, 2, 4, 5]; // <=2: count 3, sum 5
  const Y = [2, 2, 2, 4, 5]; // <=2: count 3, sum 6
  const r = compareByRules(X, Y, 5, 5);
  assert.ok(r < 0, 'X (lower sum) should rank higher by rule 3');
});

/* ---------------------------------------------------------------- *
 * Rule 4 — equal count & sum at a place, drop to next lower place
 *   At place 2 both identical; resolved at place 3 by count.
 * ---------------------------------------------------------------- */
test('Rule 4: drop to next place to break tie', () => {
  // <=2 identical (count 3, sum 5 each). Differ at <=3.
  const X = [1, 2, 2, 3, 5]; // <=3: count 4
  const Y = [1, 2, 2, 4, 4]; // <=3: count 3
  const r = compareByRules(X, Y, 5, 5);
  assert.ok(r < 0, 'X should win at place 3 (rule 4)');
});

/* ---------------------------------------------------------------- *
 * Genuine tie — identical marks share the same place
 * ---------------------------------------------------------------- */
test('Genuine tie produces shared place', () => {
  const couples = [
    { id: 'A', marks: [1, 1, 2] },
    { id: 'B', marks: [1, 1, 2] },
    { id: 'C', marks: [3, 3, 3] },
  ];
  const res = placeFinal(couples);
  const a = res.find((r) => r.id === 'A');
  const b = res.find((r) => r.id === 'B');
  assert.strictEqual(a.place, b.place);
  assert.ok(a.tie && b.tie);
});

/* ---------------------------------------------------------------- *
 * Multi-dance final (rules 5-11) — 5 dances, lowest total wins
 * ---------------------------------------------------------------- */
test('Multi-dance final sums placings', () => {
  // Build 3 dances where A consistently beats B beats C.
  const mk = (a, b, c) => ({
    couples: [
      { id: 'A', marks: a },
      { id: 'B', marks: b },
      { id: 'C', marks: c },
    ],
  });
  const dances = [
    { name: 'W', ...mk([1, 1, 1], [2, 2, 2], [3, 3, 3]) },
    { name: 'T', ...mk([1, 1, 2], [2, 2, 1], [3, 3, 3]) },
    { name: 'V', ...mk([1, 1, 1], [2, 2, 2], [3, 3, 3]) },
  ];
  const { final } = placeMultiDanceFinal(dances);
  assert.deepStrictEqual(placesOf(final), [
    { id: 'A', place: 1 },
    { id: 'B', place: 2 },
    { id: 'C', place: 3 },
  ]);
  assert.strictEqual(final.find((r) => r.id === 'A').total, 3);
});

/* ---------------------------------------------------------------- *
 * Recall (intermediate rounds) — clean cut
 * ---------------------------------------------------------------- */
test('Recall: clean cut, no tie', () => {
  const couples = [
    { id: 'A', crosses: 5 },
    { id: 'B', crosses: 5 },
    { id: 'C', crosses: 4 },
    { id: 'D', crosses: 2 },
    { id: 'E', crosses: 1 },
  ];
  const r = recall(couples, 3);
  assert.deepStrictEqual(r.recalled.sort(), ['A', 'B', 'C']);
  assert.strictEqual(r.borderlineTie, false);
  assert.strictEqual(r.needsRedance, false);
});

/* ---------------------------------------------------------------- *
 * Recall — tie across the cut line flags chairman decision / redance
 * ---------------------------------------------------------------- */
test('Recall: borderline tie flags redance', () => {
  const couples = [
    { id: 'A', crosses: 5 },
    { id: 'B', crosses: 4 },
    { id: 'C', crosses: 3 }, // tie at cut
    { id: 'D', crosses: 3 }, // tie at cut
    { id: 'E', crosses: 1 },
  ];
  const r = recall(couples, 3); // want 3, but C & D tie for the 3rd slot
  assert.strictEqual(r.borderlineTie, true);
  assert.strictEqual(r.needsRedance, true);
  assert.deepStrictEqual(r.tiedAtCut.sort(), ['C', 'D']);
  // recall-all behaviour: A, B clearly in + C, D tied => 4 recalled
  assert.deepStrictEqual(r.recalled.sort(), ['A', 'B', 'C', 'D']);
});
