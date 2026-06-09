'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { createRound, drawRound } = require('../src/core/draw');

/* helper: build a competition with one category + N numbered entries */
function setup(numEntries, seededNumbers = []) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO competition (src_id,name) VALUES ('C','Cup')").run();
  const compId = db.prepare("SELECT id FROM competition").get().id;
  db.prepare(
    "INSERT INTO category (src_id,competition_id,name,dances,category_order) VALUES ('CAT',?,'Adults Std','W,T,VW,F,Q',1)"
  ).run(compId);
  const catId = db.prepare("SELECT id FROM category").get().id;
  for (let i = 1; i <= numEntries; i++) {
    db.prepare(
      "INSERT INTO entry (src_id,competition_id,category_id,start_number,name1,is_seeded) VALUES (?,?,?,?,?,?)"
    ).run('E' + i, compId, catId, i, 'Couple ' + i, seededNumbers.includes(i) ? 1 : 0);
  }
  return { db, catId };
}

const allNumbers = (dance) =>
  Object.values(dance.heats).flat().sort((a, b) => a - b);

test('fixed_heats: sorted by number, balanced, same across dances', () => {
  const { db, catId } = setup(20);
  createRound(db, catId, { ordinal: 1, kind: 'qualification', dances: ['W', 'T', 'VW'], drawMode: 'fixed_heats' });
  const r = db.prepare('SELECT id FROM round WHERE category_id=?').get(catId).id;
  const res = drawRound(db, r, { maxPerHeat: 7 }); // 20/7 -> 3 heats

  assert.strictEqual(res.numHeats, 3);
  // every dance identical in fixed mode
  const h0 = JSON.stringify(res.dances[0].heats);
  assert.ok(res.dances.every((d) => JSON.stringify(d.heats) === h0));
  // heat 1 holds the lowest numbers (sorted)
  assert.deepStrictEqual(res.dances[0].heats[1], [1, 2, 3, 4, 5, 6, 7]);
  // all 20 numbers present, no dupes
  assert.deepStrictEqual(allNumbers(res.dances[0]), Array.from({ length: 20 }, (_, i) => i + 1));
});

test('random_all_same: heats differ from fixed but identical across dances', () => {
  const { db, catId } = setup(18);
  createRound(db, catId, { ordinal: 1, kind: 'qualification', dances: ['W', 'T'], drawMode: 'random_all_same' });
  const r = db.prepare('SELECT id FROM round WHERE category_id=?').get(catId).id;
  const res = drawRound(db, r, { numHeats: 3, seed: 42 });

  const h0 = JSON.stringify(res.dances[0].heats);
  assert.ok(res.dances.every((d) => JSON.stringify(d.heats) === h0)); // same every dance
  assert.deepStrictEqual(allNumbers(res.dances[0]), Array.from({ length: 18 }, (_, i) => i + 1));
});

test('random_per_dance: each dance an independent draw', () => {
  const { db, catId } = setup(24);
  createRound(db, catId, { ordinal: 1, kind: 'qualification', dances: ['W', 'T', 'VW', 'F', 'Q'], drawMode: 'random_per_dance' });
  const r = db.prepare('SELECT id FROM round WHERE category_id=?').get(catId).id;
  const res = drawRound(db, r, { numHeats: 4, seed: 7 });

  // at least two dances should differ (independent shuffles)
  const sigs = new Set(res.dances.map((d) => JSON.stringify(d.heats)));
  assert.ok(sigs.size > 1, 'dances should have different draws');
  // each dance still contains all 24 numbers
  res.dances.forEach((d) =>
    assert.deepStrictEqual(allNumbers(d), Array.from({ length: 24 }, (_, i) => i + 1))
  );
});

test('seeded couples land in separate heats', () => {
  // 12 couples, 3 seeded -> each seeded in a different heat
  const { db, catId } = setup(12, [1, 2, 3]);
  createRound(db, catId, { ordinal: 1, kind: 'qualification', dances: ['W'], drawMode: 'random_all_same' });
  const r = db.prepare('SELECT id FROM round WHERE category_id=?').get(catId).id;
  const res = drawRound(db, r, { numHeats: 3, seed: 99 });

  // find which heat each seeded number (1,2,3) is in
  const heatByNum = {};
  for (const [h, nums] of Object.entries(res.dances[0].heats))
    nums.forEach((n) => (heatByNum[n] = h));
  const seededHeats = [heatByNum[1], heatByNum[2], heatByNum[3]];
  assert.strictEqual(new Set(seededHeats).size, 3, 'seeded couples must be in distinct heats');
});

test('final with <=8 couples uses a single heat', () => {
  const { db, catId } = setup(6);
  createRound(db, catId, { ordinal: 1, kind: 'final', dances: ['W', 'T', 'VW', 'F', 'Q'], drawMode: 'random_per_dance' });
  const r = db.prepare('SELECT id FROM round WHERE category_id=?').get(catId).id;
  const res = drawRound(db, r, {});
  assert.strictEqual(res.numHeats, 1);
  assert.deepStrictEqual(res.dances[0].heats[1], [1, 2, 3, 4, 5, 6]);
});

test('star couples: skip round 1, enter round 2', () => {
  // 10 couples, 2 seeded (9 and 10)
  const { db, catId } = setup(10, [9, 10]);
  
  // Create Round 1 with starCouplesEnabled: true
  const r1 = createRound(db, catId, { ordinal: 1, kind: 'qualification', dances: ['W'], drawMode: 'random_all_same', starCouplesEnabled: true });
  const draw1 = drawRound(db, r1.id, { numHeats: 2 });
  
  // Check that 9 and 10 are NOT in Round 1 draw
  const r1Nums = allNumbers(draw1.dances[0]);
  assert.ok(!r1Nums.includes(9));
  assert.ok(!r1Nums.includes(10));
  assert.strictEqual(r1Nums.length, 8);
  
  // Simulate recall of 4 couples from Round 1
  db.prepare("INSERT INTO recall_result (round_id, entry_id, crosses, recalled) VALUES (?, ?, ?, ?)").run(r1.id, 1, 5, 1);
  db.prepare("INSERT INTO recall_result (round_id, entry_id, crosses, recalled) VALUES (?, ?, ?, ?)").run(r1.id, 2, 5, 1);
  db.prepare("INSERT INTO recall_result (round_id, entry_id, crosses, recalled) VALUES (?, ?, ?, ?)").run(r1.id, 3, 4, 1);
  db.prepare("INSERT INTO recall_result (round_id, entry_id, crosses, recalled) VALUES (?, ?, ?, ?)").run(r1.id, 4, 4, 1);
  db.prepare("INSERT INTO recall_result (round_id, entry_id, crosses, recalled) VALUES (?, ?, ?, ?)").run(r1.id, 5, 1, 0);
  db.prepare("INSERT INTO recall_result (round_id, entry_id, crosses, recalled) VALUES (?, ?, ?, ?)").run(r1.id, 6, 1, 0);
  db.prepare("INSERT INTO recall_result (round_id, entry_id, crosses, recalled) VALUES (?, ?, ?, ?)").run(r1.id, 7, 0, 0);
  db.prepare("INSERT INTO recall_result (round_id, entry_id, crosses, recalled) VALUES (?, ?, ?, ?)").run(r1.id, 8, 0, 0);
  db.prepare("UPDATE round SET status='closed' WHERE id=?").run(r1.id);
  
  // Create Round 2 (propagating starCouplesEnabled)
  const r2 = createRound(db, catId, { ordinal: 2, kind: 'semifinal', dances: ['W'], drawMode: 'random_all_same', starCouplesEnabled: true });
  const draw2 = drawRound(db, r2.id, { numHeats: 2 });
  
  // Check that Round 2 contains the 4 recalled couples (1, 2, 3, 4) AND the 2 star couples (9, 10)
  const r2Nums = allNumbers(draw2.dances[0]);
  assert.deepStrictEqual(r2Nums, [1, 2, 3, 4, 9, 10]);
});

test('redance: borderline tie creates redance, subsequent round merges recalled and clearly-in', () => {
  const { db, catId } = setup(10);
  
  // Create Round 1
  const r1 = createRound(db, catId, { ordinal: 1, kind: 'qualification', dances: ['W'], drawMode: 'random_all_same' });
  const draw1 = drawRound(db, r1.id, { numHeats: 2 });
  
  // Set up borderline recall tie in Round 1:
  // We want to recall 4 couples. 2 are clearly in (crosses=5), 4 are tied at the cut (crosses=3), rest are out.
  db.prepare("INSERT INTO recall_result (round_id, entry_id, crosses, recalled, borderline_tie) VALUES (?, ?, ?, ?, ?)").run(r1.id, 1, 5, 1, 0);
  db.prepare("INSERT INTO recall_result (round_id, entry_id, crosses, recalled, borderline_tie) VALUES (?, ?, ?, ?, ?)").run(r1.id, 2, 5, 1, 0);
  db.prepare("INSERT INTO recall_result (round_id, entry_id, crosses, recalled, borderline_tie) VALUES (?, ?, ?, ?, ?)").run(r1.id, 3, 3, 1, 1);
  db.prepare("INSERT INTO recall_result (round_id, entry_id, crosses, recalled, borderline_tie) VALUES (?, ?, ?, ?, ?)").run(r1.id, 4, 3, 1, 1);
  db.prepare("INSERT INTO recall_result (round_id, entry_id, crosses, recalled, borderline_tie) VALUES (?, ?, ?, ?, ?)").run(r1.id, 5, 3, 1, 1);
  db.prepare("INSERT INTO recall_result (round_id, entry_id, crosses, recalled, borderline_tie) VALUES (?, ?, ?, ?, ?)").run(r1.id, 6, 3, 1, 1);
  db.prepare("INSERT INTO recall_result (round_id, entry_id, crosses, recalled, borderline_tie) VALUES (?, ?, ?, ?, ?)").run(r1.id, 7, 1, 0, 0);
  db.prepare("INSERT INTO recall_result (round_id, entry_id, crosses, recalled, borderline_tie) VALUES (?, ?, ?, ?, ?)").run(r1.id, 8, 1, 0, 0);
  db.prepare("INSERT INTO recall_result (round_id, entry_id, crosses, recalled, borderline_tie) VALUES (?, ?, ?, ?, ?)").run(r1.id, 9, 0, 0, 0);
  db.prepare("INSERT INTO recall_result (round_id, entry_id, crosses, recalled, borderline_tie) VALUES (?, ?, ?, ?, ?)").run(r1.id, 10, 0, 0, 0);
  db.prepare("UPDATE round SET status='closed' WHERE id=?").run(r1.id);
  
  // Create Redance Round
  const rRedance = createRound(db, catId, { ordinal: 2, kind: 'redance', dances: ['W'], drawMode: 'random_all_same' });
  const drawRedance = drawRound(db, rRedance.id, { numHeats: 1 });
  
  // Verify only tied couples (3, 4, 5, 6) are drawn in redance
  const redanceNums = allNumbers(drawRedance.dances[0]);
  assert.deepStrictEqual(redanceNums, [3, 4, 5, 6]);
  
  // Simulate redance recall: 2 couples recalled (3 and 4)
  db.prepare("INSERT INTO recall_result (round_id, entry_id, crosses, recalled) VALUES (?, ?, ?, ?)").run(rRedance.id, 3, 5, 1);
  db.prepare("INSERT INTO recall_result (round_id, entry_id, crosses, recalled) VALUES (?, ?, ?, ?)").run(rRedance.id, 4, 5, 1);
  db.prepare("INSERT INTO recall_result (round_id, entry_id, crosses, recalled) VALUES (?, ?, ?, ?)").run(rRedance.id, 5, 1, 0);
  db.prepare("INSERT INTO recall_result (round_id, entry_id, crosses, recalled) VALUES (?, ?, ?, ?)").run(rRedance.id, 6, 1, 0);
  db.prepare("UPDATE round SET status='closed' WHERE id=?").run(rRedance.id);
  
  // Create Next Round (semifinal, ordinal = 3)
  const r3 = createRound(db, catId, { ordinal: 3, kind: 'semifinal', dances: ['W'], drawMode: 'random_all_same' });
  const draw3 = drawRound(db, r3.id, { numHeats: 1 });
  
  // Verify next round contains clearly-in couples from Round 1 (1 and 2) AND recalled couples from Redance (3 and 4)
  const r3Nums = allNumbers(draw3.dances[0]);
  assert.deepStrictEqual(r3Nums, [1, 2, 3, 4]);
});
