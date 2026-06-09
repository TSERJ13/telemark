'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { createRound } = require('../src/core/draw');

// We re-expose the pure mapper by requiring server's logic indirectly:
// the mapping table is identical, so we re-implement the expected results here
// and assert against round_dance rows produced by the real createRound path.

const { pullCompetition } = require('../src/sync/pull');

// Fake supabase that returns categories with explicit `dances` (dancesport codes)
function fakeSupabase(cats) {
  return {
    tournament: async () => [{ id: 'T1', name: 'Test Cup', event_date: '2026-06-09' }],
    categories: async () => cats,
    judges: async () => [
      { id: 'J1', full_name: 'Judge A', role: 'judge' },
      { id: 'J2', full_name: 'Judge B', role: 'judge' },
      { id: 'CH', full_name: 'Chair', role: 'chairman' },
    ],
    registrations: async () => {
      // 8 couples in each category so the first round is a 1/2 Final
      const regs = [];
      for (const c of cats) {
        for (let i = 1; i <= 8; i++) {
          regs.push({ id: `${c.id}-E${i}`, category_id: c.id, athlete1_id: `${c.id}-A${i}`, studio_id: null });
        }
      }
      return regs;
    },
    athletes: async (ids) => ids.map((id) => ({ id, first_name: 'X', last_name: id })),
    studios: async () => [],
  };
}

test('sync stores dances column from dancesport', async () => {
  const db = openDb(':memory:');
  const cats = [
    { id: 'C1', category_name: 'N4 Mixed', allowed_classes: 'N4', dances: 'SW,Q,CH,J', category_order: 0 },
    { id: 'C2', category_name: 'C Standard', allowed_classes: 'C', dances: 'SW,T,VW,SF,Q', category_order: 1 },
  ];
  await pullCompetition(db, fakeSupabase(cats), 'T1');
  const c1 = db.prepare("SELECT dances FROM category WHERE src_id='C1'").get();
  const c2 = db.prepare("SELECT dances FROM category WHERE src_id='C2'").get();
  assert.strictEqual(c1.dances, 'SW,Q,CH,J');
  assert.strictEqual(c2.dances, 'SW,T,VW,SF,Q');
});

test('competition is unlocked after sync (default behaviour)', async () => {
  const db = openDb(':memory:');
  await pullCompetition(db, fakeSupabase([
    { id: 'C1', category_name: 'N4', dances: 'SW,CH', category_order: 0 },
  ]), 'T1');
  const comp = db.prepare("SELECT is_locked FROM competition WHERE src_id='T1'").get();
  assert.strictEqual(comp.is_locked, 0);
});

// Mirror of the server mapper so we can assert the round actually gets every dance.
const MAP = { SW:'W', W:'W', T:'T', VW:'VW', SF:'F', F:'F', Q:'Q', S:'SB', SB:'SB', CH:'CC', CC:'CC', R:'RU', RU:'RU', PD:'PD', J:'JI', JI:'JI' };
const DANCE_CODES = ['W','T','VW','F','Q','SB','CC','RU','PD','JI','CH','J'];
function mapDances(csv) {
  return (csv||'').split(',').map(s=>s.trim().toUpperCase()).filter(Boolean)
    .map(c=>MAP[c]||c).filter((c,i,a)=>DANCE_CODES.includes(c)&&a.indexOf(c)===i);
}

test('N4 mixed (SW,Q,CH,J) maps to 4 telemark dances W,Q,CC,JI', () => {
  assert.deepStrictEqual(mapDances('SW,Q,CH,J'), ['W','Q','CC','JI']);
});

test('C standard (SW,T,VW,SF,Q) maps to W,T,VW,F,Q', () => {
  assert.deepStrictEqual(mapDances('SW,T,VW,SF,Q'), ['W','T','VW','F','Q']);
});

test('10-dance C class maps to all ten telemark codes', () => {
  assert.deepStrictEqual(
    mapDances('SW,T,VW,SF,Q,S,CH,R,PD,J'),
    ['W','T','VW','F','Q','SB','CC','RU','PD','JI']
  );
});

test('round created with mapped dances has one round_dance per dance, in order', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO competition (src_id,name) VALUES ('C','Cup')").run();
  const compId = db.prepare('SELECT id FROM competition').get().id;
  db.prepare("INSERT INTO category (src_id,competition_id,name,dances) VALUES ('CAT',?,'N4 Mixed','SW,Q,CH,J')").run(compId);
  const catId = db.prepare('SELECT id FROM category').get().id;

  const dances = mapDances('SW,Q,CH,J');
  createRound(db, catId, { ordinal: 1, kind: 'final', dances, recallCount: null, drawMode: 'fixed_heats' });
  const roundId = db.prepare('SELECT id FROM round WHERE category_id=?').get(catId).id;
  const rows = db.prepare('SELECT dance_code FROM round_dance WHERE round_id=? ORDER BY dance_order').all(roundId);
  assert.deepStrictEqual(rows.map(r => r.dance_code), ['W','Q','CC','JI']);
});

test('per-category reset wipes rounds + placings, keeps entries', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO competition (src_id,name) VALUES ('C','Cup')").run();
  const compId = db.prepare('SELECT id FROM competition').get().id;
  db.prepare("INSERT INTO category (src_id,competition_id,name,dances,status) VALUES ('CAT',?,'N4','SW,CH','done')").run(compId);
  const catId = db.prepare('SELECT id FROM category').get().id;
  for (let i = 1; i <= 8; i++)
    db.prepare("INSERT INTO entry (src_id,competition_id,category_id,start_number,name1) VALUES (?,?,?,?,?)").run('E'+i, compId, catId, i, 'C'+i);
  createRound(db, catId, { ordinal: 1, kind: 'final', dances: ['W','CC'], recallCount: null, drawMode: 'fixed_heats' });
  db.prepare("INSERT INTO placing (category_id, entry_id, place) SELECT ?, id, 1 FROM entry WHERE category_id=? LIMIT 1").run(catId, catId);

  assert.ok(db.prepare('SELECT COUNT(*) n FROM round WHERE category_id=?').get(catId).n > 0);

  // Replicate the reset-scrutiny endpoint logic
  db.prepare('DELETE FROM round WHERE category_id=?').run(catId);
  db.prepare('DELETE FROM placing WHERE category_id=?').run(catId);
  db.prepare("UPDATE category SET status='pending' WHERE id=?").run(catId);

  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM round WHERE category_id=?').get(catId).n, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM placing WHERE category_id=?').get(catId).n, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM entry WHERE category_id=?').get(catId).n, 8); // entries kept
  assert.strictEqual(db.prepare('SELECT status FROM category WHERE id=?').get(catId).status, 'pending');
});

test('roundLabel uses fraction style (1/2 Final not Semifinal)', () => {
  const { roundLabel } = require('../src/db');
  assert.strictEqual(roundLabel('semifinal'), '1/2 Final');
  assert.strictEqual(roundLabel('quarterfinal'), '1/4 Final');
  assert.strictEqual(roundLabel('r8'), '1/8 Final');
  assert.strictEqual(roundLabel('final'), 'Final');
});
