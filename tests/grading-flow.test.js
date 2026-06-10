'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { createRound, drawRound } = require('../src/core/draw');
const J = require('../src/core/judging');
const results = require('../src/core/results');

/* grading category: one round, judges give scores 1..3, finalize -> grades */
function setupGrading({ entries = 4, judges = 3 } = {}) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO competition (src_id,name) VALUES ('C','Cup')").run();
  const compId = db.prepare('SELECT id FROM competition').get().id;
  db.prepare("INSERT INTO category (src_id,competition_id,name,dances,judging_system) VALUES ('CAT',?,'Beginners','W','grading')").run(compId);
  const catId = db.prepare('SELECT id FROM category').get().id;
  for (let i = 1; i <= entries; i++)
    db.prepare("INSERT INTO entry (src_id,competition_id,category_id,start_number,name1) VALUES (?,?,?,?,?)")
      .run('E' + i, compId, catId, i, 'Dancer ' + i);
  const judgeIds = [];
  for (let j = 0; j < judges; j++) {
    const letter = String.fromCharCode(65 + j);
    db.prepare("INSERT INTO official (src_id,competition_id,full_name,role,judge_letter) VALUES (?,?,?,'judge',?)")
      .run('J' + letter, compId, 'Judge ' + letter, letter);
  }
  db.prepare('SELECT id FROM official').all().forEach((o) => judgeIds.push(o.id));

  createRound(db, catId, { ordinal: 1, kind: 'grading', dances: ['W'], recallCount: null, drawMode: 'fixed_heats' });
  const roundId = db.prepare('SELECT id FROM round WHERE category_id=?').get(catId).id;
  drawRound(db, roundId, { numHeats: 1 });
  const rdId = db.prepare('SELECT id FROM round_dance WHERE round_id=?').get(roundId).id;
  return { db, judgeIds, rdId, roundId, catId };
}

test('grading: marking view reports isGrading', () => {
  const { db, judgeIds, rdId } = setupGrading();
  const view = J.getMarkingView(db, rdId, judgeIds[0]);
  assert.strictEqual(view.isGrading, true);
  assert.strictEqual(view.gradingScaleMax, 3);
});

test('grading: judge can score and confirm when everyone is scored', () => {
  const { db, judgeIds, rdId } = setupGrading({ entries: 4, judges: 1 });
  const couples = Object.values(J.getMarkingView(db, rdId, judgeIds[0]).heats).flat();
  // score only 3 of 4 -> not valid
  J.setScore(db, rdId, judgeIds[0], couples[0].entry_id, 3);
  J.setScore(db, rdId, judgeIds[0], couples[1].entry_id, 2);
  J.setScore(db, rdId, judgeIds[0], couples[2].entry_id, 2);
  assert.strictEqual(J.confirmDance(db, rdId, judgeIds[0]).ok, false);
  // score the 4th -> valid
  J.setScore(db, rdId, judgeIds[0], couples[3].entry_id, 1);
  assert.strictEqual(J.confirmDance(db, rdId, judgeIds[0]).ok, true);
});

test('grading: finalize computes Gold/Silver/Bronze from averages', () => {
  const { db, judgeIds, rdId, roundId } = setupGrading({ entries: 3, judges: 3 });
  const couples = Object.values(J.getMarkingView(db, rdId, judgeIds[0]).heats).flat();
  const byNum = Object.fromEntries(couples.map((c) => [c.number, c.entry_id]));
  // Dancer 1: all 3s (avg 3 -> I/Gold); Dancer 2: all 2s (II/Silver); Dancer 3: all 1s (III/Bronze)
  for (const j of judgeIds) {
    J.setScore(db, rdId, j, byNum[1], 3);
    J.setScore(db, rdId, j, byNum[2], 2);
    J.setScore(db, rdId, j, byNum[3], 1);
  }
  const r = results.computeFinal(db, roundId);
  assert.strictEqual(r.kind, 'grading');
  const byEntry = Object.fromEntries(r.results.map((x) => [x.entry_id, x]));
  assert.strictEqual(byEntry[byNum[1]].grade, 'I');
  assert.strictEqual(byEntry[byNum[2]].grade, 'II');
  assert.strictEqual(byEntry[byNum[3]].grade, 'III');
  // persisted on entry
  const e1 = db.prepare('SELECT grade, grade_average FROM entry WHERE id=?').get(byNum[1]);
  assert.strictEqual(e1.grade, 'I');
  assert.strictEqual(e1.grade_average, 3);
});
