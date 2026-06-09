'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { createRound, drawRound } = require('../src/core/draw');
const { computeFinal } = require('../src/core/results');
const { placePointsFinal } = require('../src/core/skating');

test('placePointsFinal - basic ranking and ties', () => {
  const couples = [
    { id: 1, total: 35.5 },
    { id: 2, total: 38.0 },
    { id: 3, total: 35.5 },
    { id: 4, total: 32.25 },
  ];

  const results = placePointsFinal(couples);

  // Expected ranking:
  // 1. Couple 2 (38.0) - place 1
  // 2. Couple 1 (35.5) - place 2 (tie: true)
  // 3. Couple 3 (35.5) - place 2 (tie: true)
  // 4. Couple 4 (32.25) - place 4
  assert.strictEqual(results[0].id, 2);
  assert.strictEqual(results[0].place, 1);
  assert.strictEqual(results[0].tie, false);

  assert.strictEqual(results[1].place, 2);
  assert.strictEqual(results[1].tie, true);

  assert.strictEqual(results[2].place, 2);
  assert.strictEqual(results[2].tie, true);

  assert.strictEqual(results[3].id, 4);
  assert.strictEqual(results[3].place, 4);
  assert.strictEqual(results[3].tie, false);
});

test('WDSF JS 3.0 points scoring flow in computeFinal', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO competition (src_id,name) VALUES ('C','Cup')").run();
  const compId = db.prepare('SELECT id FROM competition').get().id;
  
  // Create category with js3.0 judging system
  db.prepare("INSERT INTO category (src_id,competition_id,name,dances,judging_system) VALUES ('CAT',?,'Adults Std','W','js3.0')").run(compId);
  const catId = db.prepare('SELECT id FROM category').get().id;
  
  // Seed entries
  db.prepare("INSERT INTO entry (src_id,competition_id,category_id,start_number,name1) VALUES ('E1',?,?,1,'Couple 1')").run(compId, catId);
  db.prepare("INSERT INTO entry (src_id,competition_id,category_id,start_number,name1) VALUES ('E2',?,?,2,'Couple 2')").run(compId, catId);
  const e1 = db.prepare('SELECT id FROM entry WHERE start_number=1').get().id;
  const e2 = db.prepare('SELECT id FROM entry WHERE start_number=2').get().id;

  // Seed judges
  db.prepare("INSERT INTO official (src_id,competition_id,full_name,role,judge_letter) VALUES ('J1',?, 'Judge A', 'judge', 'A')").run(compId);
  db.prepare("INSERT INTO official (src_id,competition_id,full_name,role,judge_letter) VALUES ('J2',?, 'Judge B', 'judge', 'B')").run(compId);
  const j1 = db.prepare("SELECT id FROM official WHERE judge_letter='A'").get().id;
  const j2 = db.prepare("SELECT id FROM official WHERE judge_letter='B'").get().id;

  // Create round & draw
  const round = createRound(db, catId, { ordinal: 1, kind: 'final', dances: ['W'], drawMode: 'fixed_heats' });
  drawRound(db, round.id);
  const rdId = db.prepare('SELECT id FROM round_dance WHERE round_id=?').get(round.id).id;

  // Seed marks: Couple 1 gets higher component scores than Couple 2
  // Judge A scores Couple 1
  db.prepare(`
    INSERT INTO mark (round_dance_id, official_id, entry_id, score_tq, score_mm, score_ps, score_cp)
    VALUES (?, ?, ?, 8.5, 8.75, 8.5, 8.5)
  `).run(rdId, j1, e1);
  // Judge B scores Couple 1
  db.prepare(`
    INSERT INTO mark (round_dance_id, official_id, entry_id, score_tq, score_mm, score_ps, score_cp)
    VALUES (?, ?, ?, 9.0, 9.0, 9.0, 9.0)
  `).run(rdId, j2, e1);

  // Judge A scores Couple 2
  db.prepare(`
    INSERT INTO mark (round_dance_id, official_id, entry_id, score_tq, score_mm, score_ps, score_cp)
    VALUES (?, ?, ?, 7.5, 7.75, 7.5, 7.5)
  `).run(rdId, j1, e2);
  // Judge B scores Couple 2
  db.prepare(`
    INSERT INTO mark (round_dance_id, official_id, entry_id, score_tq, score_mm, score_ps, score_cp)
    VALUES (?, ?, ?, 8.0, 8.0, 8.0, 8.0)
  `).run(rdId, j2, e2);

  // Compute final results
  const res = computeFinal(db, round.id);

  // Verify Couple 1 placed 1st, Couple 2 placed 2nd
  assert.strictEqual(res.final.length, 2);
  const first = res.final.find(f => f.place === 1);
  const second = res.final.find(f => f.place === 2);

  assert.strictEqual(first.id, e1);
  assert.strictEqual(second.id, e2);

  // Check calculated scores
  // Couple 1: TQ avg = 8.75, MM avg = 8.875, PS avg = 8.75, CP avg = 8.75. Total = 35.125
  // Couple 2: TQ avg = 7.75, MM avg = 7.875, PS avg = 7.75, CP avg = 7.75. Total = 31.125
  assert.strictEqual(first.total, 35.125);
  assert.strictEqual(second.total, 31.125);
});
