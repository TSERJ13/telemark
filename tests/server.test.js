'use strict';

const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { openDb } = require('../src/db');
const { createRound, drawRound } = require('../src/core/draw');
const { createServer } = require('../src/server');

/* build: competition + final category (6 couples) + 3 judges + drawn round */
function seed() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO competition (src_id,name) VALUES ('C','Cup')").run();
  const compId = db.prepare('SELECT id FROM competition').get().id;
  db.prepare("INSERT INTO category (src_id,competition_id,name,dances) VALUES ('CAT',?,'Adults Std','W')").run(compId);
  const catId = db.prepare('SELECT id FROM category').get().id;
  for (let i = 1; i <= 6; i++)
    db.prepare("INSERT INTO entry (src_id,competition_id,category_id,start_number,name1) VALUES (?,?,?,?,?)")
      .run('E' + i, compId, catId, i, 'Couple ' + i);
  for (const L of ['A', 'B', 'C'])
    db.prepare("INSERT INTO official (src_id,competition_id,full_name,role,judge_letter) VALUES (?,?,?,'judge',?)")
      .run('J' + L, compId, 'Judge ' + L, L);

  db.prepare("UPDATE competition SET is_locked = 0").run();

  createRound(db, catId, { ordinal: 1, kind: 'final', dances: ['W'], drawMode: 'fixed_heats' });
  const roundId = db.prepare('SELECT id FROM round WHERE category_id=?').get(catId).id;
  drawRound(db, roundId, { numHeats: 1 });
  const rdId = db.prepare('SELECT id FROM round_dance WHERE round_id=?').get(roundId).id;
  const judges = db.prepare("SELECT id, judge_letter FROM official WHERE role='judge' ORDER BY judge_letter").all();
  const entries = db.prepare('SELECT id, start_number FROM entry ORDER BY start_number').all();
  return { db, catId, roundId, rdId, judges, entries };
}

const post = (base, path, body) =>
  fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());

test('full real-time flow: open -> mark -> confirm -> compute final', async () => {
  const { db, roundId, rdId, judges, entries } = seed();
  const { server, close } = createServer(db);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  // collect WS events (scrutineer screen)
  const events = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r) => ws.on('open', r));
  ws.on('message', (d) => events.push(JSON.parse(d.toString())));

  // scrutineer opens the dance
  const opened = await post(base, `/api/scrutineer/dance/${rdId}/open`);
  assert.strictEqual(opened.ok, true);

  // each judge places couples 1..6 in start order (clean -> couple1 wins)
  for (const j of judges) {
    for (let i = 0; i < entries.length; i++) {
      const r = await post(base, `/api/judge/${j.id}/dance/${rdId}/place`, { entryId: entries[i].id, place: i + 1 });
      assert.strictEqual(r.ok, true);
    }
    const c = await post(base, `/api/judge/${j.id}/dance/${rdId}/confirm`);
    assert.strictEqual(c.ok, true);
    assert.strictEqual(c.checksum.value, 'Σ21/21');
  }

  // give the event loop a tick to flush WS frames
  await new Promise((r) => setTimeout(r, 50));

  // scrutineer saw the dance open + 3 confirmations
  const types = events.map((e) => e.type);
  assert.ok(types.includes('dance:open'));
  assert.strictEqual(types.filter((t) => t === 'dance:confirmed').length, 3);

  // progress endpoint shows all 3 judges done
  const prog = await fetch(base + `/api/scrutineer/round/${roundId}/progress`).then((r) => r.json());
  const doneCount = prog.matrix[0].confirmed.filter((c) => c.done).length;
  assert.strictEqual(doneCount, 3);

  // compute the final
  const fin = await post(base, `/api/scrutineer/round/${roundId}/final`);
  assert.strictEqual(fin.final[0].number, 1); // couple 1 placed 1st
  assert.strictEqual(fin.final[0].place, 1);
  assert.strictEqual(fin.final[5].number, 6);

  // entry.final_place persisted
  const fp = db.prepare("SELECT final_place FROM entry WHERE start_number=1").get();
  assert.strictEqual(fp.final_place, 1);

  ws.close();
  await close();
});
