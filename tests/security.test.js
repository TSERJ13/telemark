'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('../src/db');
const sec = require('../src/core/security');
const backup = require('../src/core/backup');
const { createRound, drawRound } = require('../src/core/draw');
const { createServer } = require('../src/server');

function baseDb() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO competition (src_id,name) VALUES ('C','Cup')").run();
  return db;
}

test('chairman PIN: hashed, verified, wrong pin rejected', () => {
  const db = baseDb();
  assert.strictEqual(sec.isPinSet(db), false);
  sec.setChairmanPin(db, '2468');
  assert.strictEqual(sec.isPinSet(db), true);
  // not stored in clear
  const row = db.prepare('SELECT chairman_pin_hash FROM sync_state WHERE id=1').get();
  assert.ok(!row.chairman_pin_hash.includes('2468'));
  assert.strictEqual(sec.verifyPin(db, '2468'), true);
  assert.strictEqual(sec.verifyPin(db, '0000'), false);
});

test('lock state toggles', () => {
  const db = baseDb();
  sec.setLocked(db, true);
  assert.strictEqual(sec.isLocked(db), true);
  sec.setLocked(db, false);
  assert.strictEqual(sec.isLocked(db), false);
});

test('backup creates a readable consistent copy', () => {
  const db = baseDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmbk-'));
  const file = backup.backupNow(db, dir);
  assert.ok(fs.existsSync(file));
  const db2 = openDb(file, { applySchema: false });
  assert.strictEqual(db2.prepare('SELECT name FROM competition').get().name, 'Cup');
  assert.strictEqual(backup.listBackups(dir).length, 1);
});

test('reopen is blocked without chairman token, allowed with it', async () => {
  // build a confirmed final so there is something to reopen
  const db = baseDb();
  const compId = db.prepare('SELECT id FROM competition').get().id;
  db.prepare("INSERT INTO category (src_id,competition_id,name,dances) VALUES ('CAT',?,'Std','W')").run(compId);
  const catId = db.prepare('SELECT id FROM category').get().id;
  for (let i = 1; i <= 6; i++) db.prepare("INSERT INTO entry (src_id,competition_id,category_id,start_number,name1) VALUES (?,?,?,?,?)").run('E'+i,compId,catId,i,'C'+i);
  db.prepare("INSERT INTO official (src_id,competition_id,full_name,role,judge_letter) VALUES ('J1',?,'A','judge','A')").run(compId);
  const judge = db.prepare('SELECT id FROM official').get().id;
  createRound(db, catId, { ordinal:1, kind:'final', dances:['W'], drawMode:'fixed_heats' });
  const roundId = db.prepare('SELECT id FROM round WHERE category_id=?').get(catId).id;
  drawRound(db, roundId, { numHeats:1 });
  const rdId = db.prepare('SELECT id FROM round_dance WHERE round_id=?').get(roundId).id;
  const J = require('../src/core/judging');
  db.prepare('SELECT id FROM entry ORDER BY start_number').all().forEach((e,i)=>J.setPlace(db, rdId, judge, e.id, i+1));
  J.confirmDance(db, rdId, judge);

  sec.setChairmanPin(db, '1234');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmbk-'));
  const { server, close } = createServer(db, { backupDir: dir });
  await new Promise((r) => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const POST = (p, b, h) => fetch(base+p, { method:'POST', headers:{'Content-Type':'application/json',...(h||{})}, body:JSON.stringify(b||{}) });

  // no token -> 401
  let r = await POST(`/api/scrutineer/dance/${rdId}/reopen/${judge}`);
  assert.strictEqual(r.status, 401);

  // wrong pin -> 401, no token
  r = await POST('/api/chairman/login', { pin:'0000' });
  assert.strictEqual(r.status, 401);

  // correct pin -> token
  r = await POST('/api/chairman/login', { pin:'1234' });
  const { token } = await r.json();
  assert.ok(token);

  // with token -> reopen ok
  r = await POST(`/api/scrutineer/dance/${rdId}/reopen/${judge}`, {}, { 'x-chairman-token': token });
  const body = await r.json();
  assert.strictEqual(r.status, 200);
  assert.strictEqual(body.ok, true);

  await close();
});

test('setup pin once, second setup rejected', async () => {
  const db = baseDb();
  const { server, close } = createServer(db, { backupDir: fs.mkdtempSync(path.join(os.tmpdir(),'tmbk-')) });
  await new Promise((r) => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const POST = (p,b)=>fetch(base+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})});
  let r = await POST('/api/chairman/setup', { pin:'4321' });
  assert.strictEqual(r.status, 200);
  r = await POST('/api/chairman/setup', { pin:'9999' });
  assert.strictEqual(r.status, 409); // already set
  await close();
});
