'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { createRound, drawRound } = require('../src/core/draw');
const J = require('../src/core/judging');
const results = require('../src/core/results');
const { pushResults } = require('../src/sync/push');
const wdsf = require('../src/sync/wdsfExport');

/* build + judge + compute a 6-couple final, return ids */
function finishedFinal() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO competition (src_id,name,event_date,location) VALUES ('T','Cup','2026-07-01','Tbilisi')").run();
  const compId = db.prepare('SELECT id FROM competition').get().id;
  db.prepare("INSERT INTO category (src_id,competition_id,name,dances) VALUES ('CAT',?,'Std','W')").run(compId);
  const catId = db.prepare('SELECT id FROM category').get().id;
  for (let i = 1; i <= 6; i++)
    db.prepare("INSERT INTO entry (src_id,competition_id,category_id,start_number,name1,name2) VALUES (?,?,?,?,?,?)")
      .run('REG' + i, compId, catId, i, 'A' + i, 'B' + i);
  // one couple missing
  db.prepare("UPDATE entry SET status='missing' WHERE start_number=6").run();
  for (const L of ['A', 'B', 'C'])
    db.prepare("INSERT INTO official (src_id,competition_id,full_name,role,judge_letter) VALUES (?,?,?,'judge',?)")
      .run('J' + L, compId, 'Judge ' + L, L);
  createRound(db, catId, { ordinal: 1, kind: 'final', dances: ['W'], drawMode: 'fixed_heats' });
  const roundId = db.prepare('SELECT id FROM round WHERE category_id=?').get(catId).id;
  drawRound(db, roundId, { numHeats: 1 });
  const rdId = db.prepare('SELECT id FROM round_dance WHERE round_id=?').get(roundId).id;
  const judges = db.prepare("SELECT id FROM official WHERE role='judge'").all();
  const entries = db.prepare('SELECT id FROM entry ORDER BY start_number').all();
  for (const j of judges) { entries.forEach((e, i) => J.setPlace(db, rdId, j.id, e.id, i + 1)); J.confirmDance(db, rdId, j.id); }
  results.computeFinal(db, roundId);
  return { db, catId };
}

test('WDSF payload: results + missing couples', () => {
  const { db, catId } = finishedFinal();
  const p = wdsf.buildPayload(db, catId);
  assert.strictEqual(p.competition.name, 'Cup');
  assert.strictEqual(p.category.name, 'Std');
  assert.strictEqual(p.results[0].placement, 1);
  assert.strictEqual(p.results[0].couple, 'A1 & B1');
  assert.strictEqual(p.results.length, 6);
  // couple 6 is missing -> appears in missing list
  assert.ok(p.missing.some((m) => m.startNumber === 6 && m.reason === 'missing'));
});

test('WDSF send posts the payload to the configured endpoint', async () => {
  const { db, catId } = finishedFinal();
  let captured = null;
  const fetchImpl = (url, opts) => {
    captured = { url, body: JSON.parse(opts.body), auth: opts.headers.Authorization };
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('OK') });
  };
  const r = await wdsf.send(db, catId, { url: 'https://wdsf.example/api/results', apiKey: 'secret', fetchImpl });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(captured.url, 'https://wdsf.example/api/results');
  assert.strictEqual(captured.auth, 'Bearer secret');
  assert.strictEqual(captured.body.results.length, 6);
});

test('push writes result_place back to dancesport.ge and marks pushed_at', async () => {
  const { db, catId } = finishedFinal();
  const calls = [];
  const supabaseMock = {
    pushResult: (regId, place) => { calls.push({ regId, place }); return Promise.resolve(true); },
  };
  const r = await pushResults(db, supabaseMock);
  assert.strictEqual(r.ok, 6);
  assert.strictEqual(r.fail, 0);
  // couple 1 (REG1) pushed place 1
  assert.ok(calls.find((c) => c.regId === 'REG1' && c.place === 1));
  // pushed_at set on all placings
  const notPushed = db.prepare('SELECT COUNT(*) n FROM placing WHERE pushed_at IS NULL').get().n;
  assert.strictEqual(notPushed, 0);
});

test('push reports failures without aborting the batch', async () => {
  const { db } = finishedFinal();
  const supabaseMock = {
    pushResult: (regId) => regId === 'REG3'
      ? Promise.reject(new Error('network'))
      : Promise.resolve(true),
  };
  const r = await pushResults(db, supabaseMock);
  assert.strictEqual(r.fail, 1);
  assert.strictEqual(r.ok, 5);
  assert.strictEqual(r.errors[0].src_id, 'REG3');
});
