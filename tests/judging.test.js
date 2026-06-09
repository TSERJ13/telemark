'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { createRound, drawRound } = require('../src/core/draw');
const J = require('../src/core/judging');

/* build comp + category + N entries + a judge, then a round */
function setup({ entries = 6, kind = 'final', recall = null, dances = ['W'] } = {}) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO competition (src_id,name) VALUES ('C','Cup')").run();
  const compId = db.prepare('SELECT id FROM competition').get().id;
  db.prepare("INSERT INTO category (src_id,competition_id,name,dances) VALUES ('CAT',?,'Std','W')").run(compId);
  const catId = db.prepare('SELECT id FROM category').get().id;
  for (let i = 1; i <= entries; i++)
    db.prepare("INSERT INTO entry (src_id,competition_id,category_id,start_number,name1) VALUES (?,?,?,?,?)")
      .run('E' + i, compId, catId, i, 'Couple ' + i);
  db.prepare("INSERT INTO official (src_id,competition_id,full_name,role,judge_letter) VALUES ('J1',?,'Judge A','judge','A')").run(compId);
  const judge = db.prepare('SELECT id FROM official').get().id;

  createRound(db, catId, { ordinal: 1, kind, dances, recallCount: recall, drawMode: 'fixed_heats' });
  const roundId = db.prepare('SELECT id FROM round WHERE category_id=?').get(catId).id;
  drawRound(db, roundId, { numHeats: 1 });
  const rdId = db.prepare('SELECT id FROM round_dance WHERE round_id=? ORDER BY dance_order').get(roundId).id;
  return { db, judge, rdId, catId };
}

test('final: place is unique, swaps out duplicates', () => {
  const { db, judge, rdId } = setup({ entries: 6, kind: 'final' });
  const view = J.getMarkingView(db, rdId, judge);
  const couples = Object.values(view.heats).flat();
  // give couple #1 place 1, couple #2 place 2 ... then reassign place 1 to #2
  J.setPlace(db, rdId, judge, couples[0].entry_id, 1);
  J.setPlace(db, rdId, judge, couples[1].entry_id, 2);
  J.setPlace(db, rdId, judge, couples[1].entry_id, 1); // steal place 1
  const v2 = J.getMarkingView(db, rdId, judge);
  const c = Object.values(v2.heats).flat();
  assert.strictEqual(c.find((x) => x.number === 2).place, 1);
  assert.strictEqual(c.find((x) => x.number === 1).place, null); // lost place 1
});

test('final: confirm requires a full valid permutation', () => {
  const { db, judge, rdId } = setup({ entries: 6, kind: 'final' });
  const couples = Object.values(J.getMarkingView(db, rdId, judge).heats).flat();
  // incomplete -> invalid
  J.setPlace(db, rdId, judge, couples[0].entry_id, 1);
  let r = J.confirmDance(db, rdId, judge);
  assert.strictEqual(r.ok, false);
  // full permutation 1..6
  couples.forEach((c, i) => J.setPlace(db, rdId, judge, c.entry_id, i + 1));
  r = J.confirmDance(db, rdId, judge);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.checksum.value, 'Σ21/21'); // 1+..+6 = 21
  assert.ok(r.checksum.valid);
});

test('final: locked after confirm, chairman can reopen', () => {
  const { db, judge, rdId } = setup({ entries: 6, kind: 'final' });
  const couples = Object.values(J.getMarkingView(db, rdId, judge).heats).flat();
  couples.forEach((c, i) => J.setPlace(db, rdId, judge, c.entry_id, i + 1));
  J.confirmDance(db, rdId, judge);
  // attempts to change are blocked
  const blocked = J.setPlace(db, rdId, judge, couples[0].entry_id, 6);
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.reason, 'locked');
  // chairman reopens
  J.reopenDance(db, rdId, judge);
  const ok = J.setPlace(db, rdId, judge, couples[0].entry_id, 6);
  assert.strictEqual(ok.ok, true);
});

test('intermediate: crosses capped at recall target', () => {
  const { db, judge, rdId } = setup({ entries: 10, kind: 'intermediate', recall: 6 });
  const couples = Object.values(J.getMarkingView(db, rdId, judge).heats).flat();
  // mark 6 -> ok
  for (let i = 0; i < 6; i++) {
    const r = J.setCross(db, rdId, judge, couples[i].entry_id, true);
    assert.strictEqual(r.ok, true);
  }
  // 7th -> blocked by limit
  const over = J.setCross(db, rdId, judge, couples[6].entry_id, true);
  assert.strictEqual(over.ok, false);
  assert.strictEqual(over.reason, 'limit');
  // confirm valid at exactly target
  const r = J.confirmDance(db, rdId, judge);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.checksum.value, '×6/6');
});

test('helpmark is independent of cross', () => {
  const { db, judge, rdId } = setup({ entries: 10, kind: 'intermediate', recall: 6 });
  const couples = Object.values(J.getMarkingView(db, rdId, judge).heats).flat();
  J.setHelp(db, rdId, judge, couples[8].entry_id, 1);
  const v = J.getMarkingView(db, rdId, judge);
  const c = Object.values(v.heats).flat().find((x) => x.entry_id === couples[8].entry_id);
  assert.strictEqual(c.help, 1);
  assert.strictEqual(c.cross, false); // help did not become a recall
});

test('judge can sign the checksum', () => {
  const { db, judge, rdId } = setup({ entries: 6, kind: 'final' });
  const couples = Object.values(J.getMarkingView(db, rdId, judge).heats).flat();
  couples.forEach((c, i) => J.setPlace(db, rdId, judge, c.entry_id, i + 1));
  J.confirmDance(db, rdId, judge);
  const s = J.signChecksum(db, rdId, judge, 'sig-data');
  assert.strictEqual(s.ok, true);
  const v = J.getMarkingView(db, rdId, judge);
  assert.strictEqual(v.signed, true);
});
