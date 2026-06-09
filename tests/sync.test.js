'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { createSupabase } = require('../src/sync/supabaseClient');
const { pullCompetition } = require('../src/sync/pull');
const { generateStartNumbers } = require('../src/core/numbering');

/* ---- build mock dancesport.ge dataset ----------------------------- */
function buildMockData() {
  const TID = 'T1';
  const cats = [
    { id: 'CA', tournament_id: TID, category_name: 'Solo 2 Dance Juveniles', category_order: 1, allowed_classes: 'E,D', min_age: 8, max_age: 11 },
    { id: 'CB', tournament_id: TID, category_name: 'Solo 2 Dance Juniors',   category_order: 2, allowed_classes: 'D,C', min_age: 12, max_age: 15 },
    { id: 'CC', tournament_id: TID, category_name: 'Couples Latin Youth',    category_order: 3, allowed_classes: 'C,B', min_age: 16, max_age: 18 },
  ];

  const athletes = [];
  const registrations = [];
  let aId = 0;

  // Category A: 33 solo entries. Names crafted so sorting by name puts
  // "Zzz Nini" last -> she should receive #33.
  for (let i = 1; i <= 33; i++) {
    const id = 'A' + i;
    const isLast = i === 33;
    athletes.push({
      id, first_name: isLast ? 'Zzz' : 'Kid' + String(i).padStart(2, '0'),
      last_name: isLast ? 'Nini' : 'Solo', first_name_ka: 'ბავშვი', last_name_ka: 'სოლო',
      is_couple: false,
    });
    registrations.push({ id: 'RA' + i, tournament_id: TID, category_id: 'CA', studio_id: 'S1', athlete1_id: id, athlete2_id: null });
  }

  // Category B: 10 solo entries
  for (let i = 1; i <= 10; i++) {
    const id = 'B' + i;
    athletes.push({ id, first_name: 'Jun' + String(i).padStart(2, '0'), last_name: 'Solo', is_couple: false });
    registrations.push({ id: 'RB' + i, tournament_id: TID, category_id: 'CB', studio_id: 'S1', athlete1_id: id, athlete2_id: null });
  }

  // Category C: 5 couples (two athletes each)
  for (let i = 1; i <= 5; i++) {
    const m = 'CM' + i, w = 'CW' + i;
    athletes.push({ id: m, first_name: 'Man' + i, last_name: 'Lat', is_couple: true });
    athletes.push({ id: w, first_name: 'Woman' + i, last_name: 'Lat', is_couple: true });
    registrations.push({ id: 'RC' + i, tournament_id: TID, category_id: 'CC', studio_id: 'S2', athlete1_id: m, athlete2_id: w });
  }

  const tournament = { id: TID, name: 'Tbilisi Open', event_date: '2026-07-01', location: 'Tbilisi', organizer_names: 'DanceSport Georgia' };
  const judges = [
    { id: 'J1', tournament_id: TID, full_name: 'John Smith', role: 'judge' },
    { id: 'J2', tournament_id: TID, full_name: 'Anna Lee', role: 'judge' },
    { id: 'J3', tournament_id: TID, full_name: 'Mike Brown', role: 'judge' },
    { id: 'CH', tournament_id: TID, full_name: 'Big Boss', role: 'chairman' },
  ];
  const studios = [
    { id: 'S1', studio_name: 'Alpha Studio' },
    { id: 'S2', studio_name: 'Beta Studio' },
  ];

  return { TID, tournament, cats, judges, registrations, athletes, studios };
}

/* ---- mock fetch that speaks PostgREST ----------------------------- */
function mockFetch(data) {
  const ok = (body) => Promise.resolve({
    ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(''),
  });
  return (url) => {
    const u = new URL(url);
    const table = u.pathname.split('/').pop();
    const idIn = (u.searchParams.get('id') || '');
    if (table === 'tournaments') return ok([data.tournament]);
    if (table === 'tournament_categories') return ok(data.cats);
    if (table === 'tournament_judges') return ok(data.judges);
    if (table === 'tournament_registrations') return ok(data.registrations);
    if (table === 'athletes') {
      const ids = idIn.replace('in.(', '').replace(')', '').split(',');
      return ok(data.athletes.filter((a) => ids.includes(a.id)));
    }
    if (table === 'studios') {
      const ids = idIn.replace('in.(', '').replace(')', '').split(',');
      return ok(data.studios.filter((s) => ids.includes(s.id)));
    }
    return ok([]);
  };
}

/* ------------------------------------------------------------------- */
test('pull + numbering: continuous across categories', async () => {
  const data = buildMockData();
  const db = openDb(':memory:');
  const supa = createSupabase({ url: 'https://x.supabase.co', key: 'k', fetchImpl: mockFetch(data) });

  const res = await pullCompetition(db, supa, data.TID);
  assert.strictEqual(res.categories, 3);
  assert.strictEqual(res.entries, 48); // 33 + 10 + 5
  assert.strictEqual(res.judges, 4);

  // judge letters A,B,C for the 3 judges, none for chairman
  const letters = db.prepare("SELECT full_name, judge_letter FROM official WHERE role='judge' ORDER BY judge_letter").all();
  assert.deepStrictEqual(letters.map((l) => l.judge_letter), ['A', 'B', 'C']);
  const chair = db.prepare("SELECT judge_letter FROM official WHERE role='chairman'").get();
  assert.strictEqual(chair.judge_letter, null);

  // couple name resolution (Latin, two names)
  const couple = db.prepare("SELECT name1, name2 FROM entry WHERE src_id='RC1'").get();
  assert.strictEqual(couple.name1, 'Man1 Lat');
  assert.strictEqual(couple.name2, 'Woman1 Lat');

  // generate numbers
  db.prepare('UPDATE category SET chairman_confirmed=1').run();
  const num = generateStartNumbers(db, data.TID, { order: 'name' });
  assert.strictEqual(num.startFrom, 1);
  assert.strictEqual(num.lastNumber, 48);

  // Category A: 1..33, B: 34..43, C: 44..48
  const byName = num.categories;
  assert.deepStrictEqual(byName[0], { name: 'Solo 2 Dance Juveniles', from: 1, to: 33, count: 33 });
  assert.deepStrictEqual(byName[1], { name: 'Solo 2 Dance Juniors', from: 34, to: 43, count: 10 });
  assert.deepStrictEqual(byName[2], { name: 'Couples Latin Youth', from: 44, to: 48, count: 5 });

  // "Zzz Nini" sorts last in category A -> number 33
  const nini = db.prepare("SELECT start_number FROM entry WHERE name1='Zzz Nini'").get();
  assert.strictEqual(nini.start_number, 33);
});

test('pull is idempotent (re-run does not duplicate)', async () => {
  const data = buildMockData();
  const db = openDb(':memory:');
  const supa = createSupabase({ url: 'https://x.supabase.co', key: 'k', fetchImpl: mockFetch(data) });
  await pullCompetition(db, supa, data.TID);
  await pullCompetition(db, supa, data.TID); // second pull
  const n = db.prepare('SELECT COUNT(*) c FROM entry').get().c;
  assert.strictEqual(n, 48); // not 96
});
