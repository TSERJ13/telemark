'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { gradeForAverage, computeGrades } = require('../src/core/grading');

test('gradeForAverage: thresholds map correctly', () => {
  assert.strictEqual(gradeForAverage(3.0).grade, 'I');
  assert.strictEqual(gradeForAverage(2.5).grade, 'I');
  assert.strictEqual(gradeForAverage(2.49).grade, 'II');
  assert.strictEqual(gradeForAverage(1.8).grade, 'II');
  assert.strictEqual(gradeForAverage(1.79).grade, 'III');
  assert.strictEqual(gradeForAverage(1.0).grade, 'III');
});

test('gradeForAverage: labels are Gold/Silver/Bronze', () => {
  assert.strictEqual(gradeForAverage(2.8).label, 'Gold');
  assert.strictEqual(gradeForAverage(2.0).label, 'Silver');
  assert.strictEqual(gradeForAverage(1.2).label, 'Bronze');
});

test('computeGrades: averages across judges and assigns grades', () => {
  const rows = [
    { entry_id: 1, scores: [3, 3, 2] },   // avg 2.67 -> I
    { entry_id: 2, scores: [2, 2, 2] },   // avg 2.00 -> II
    { entry_id: 3, scores: [1, 2, 1] },   // avg 1.33 -> III
  ];
  const res = computeGrades(rows);
  const byId = Object.fromEntries(res.map((r) => [r.entry_id, r]));
  assert.strictEqual(byId[1].grade, 'I');
  assert.strictEqual(byId[2].grade, 'II');
  assert.strictEqual(byId[3].grade, 'III');
  assert.strictEqual(byId[1].average, 2.67);
  assert.strictEqual(byId[2].average, 2);
});

test('computeGrades: sorted by average descending', () => {
  const rows = [
    { entry_id: 1, scores: [1, 1] },
    { entry_id: 2, scores: [3, 3] },
    { entry_id: 3, scores: [2, 2] },
  ];
  const res = computeGrades(rows);
  assert.deepStrictEqual(res.map((r) => r.entry_id), [2, 3, 1]);
});

test('computeGrades: dancer with no scores -> average 0, grade III', () => {
  const res = computeGrades([{ entry_id: 9, scores: [] }]);
  assert.strictEqual(res[0].average, 0);
  assert.strictEqual(res[0].grade, 'III');
  assert.strictEqual(res[0].count, 0);
});

test('computeGrades: custom thresholds (1-5 scale)', () => {
  const thresholds = [
    { min: 4.0, grade: 'I', label: 'Gold' },
    { min: 3.0, grade: 'II', label: 'Silver' },
    { min: 0, grade: 'III', label: 'Bronze' },
  ];
  const res = computeGrades([{ entry_id: 1, scores: [5, 4, 4] }], { thresholds }); // avg 4.33
  assert.strictEqual(res[0].grade, 'I');
});
