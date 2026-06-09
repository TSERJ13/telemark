'use strict';

/**
 * Demo seed — populates a sample competition so the online demo isn't empty.
 * Runs only when SEED is truthy AND the database has no competition yet.
 * Never touches a database that already holds real data.
 */

const { createRound, drawRound } = require('./core/draw');
const security = require('./core/security');

function seedDemo(db) {
  const existing = db.prepare('SELECT id FROM competition LIMIT 1').get();
  if (existing) return false; // never overwrite real data

  db.prepare("INSERT INTO competition (src_id,name,event_date,location) VALUES ('demo','Tbilisi Open 2026 (Demo)','2026-07-01','Tbilisi, Georgia')").run();
  const compId = db.prepare('SELECT id FROM competition').get().id;
  security.setChairmanPin(db, '1234'); // demo chairman PIN

  for (const L of ['A', 'B', 'C', 'D', 'E'])
    db.prepare("INSERT INTO official (src_id,competition_id,full_name,role,judge_letter) VALUES (?,?,?,'judge',?)")
      .run('J' + L, compId, 'Judge ' + L, L);
  db.prepare("INSERT INTO official (src_id,competition_id,full_name,role) VALUES ('CH',?,'Chairman','chairman')").run(compId);

  const names = [
    ['Giorgi Beridze', 'Nino Kapanadze', 'Imedi Dance'],
    ['Luka Tsiklauri', 'Mariam Lomidze', 'Rhythm Studio'],
    ['Sandro Gelashvili', 'Elene Maisuradze', 'Imedi Dance'],
    ['Davit Kvaratskhelia', 'Ana Tabidze', 'Star Ballroom'],
    ['Nika Mchedlidze', 'Tamar Gogoladze', 'Rhythm Studio'],
    ['Irakli Dvali', 'Keti Shengelia', 'Star Ballroom'],
    ['Zura Kiknadze', 'Salome Ramishvili', 'Imedi Dance'],
    ['Beka Tatishvili', 'Lika Janelidze', 'Rhythm Studio'],
  ];

  // Category 1: a 6-couple Standard FINAL, drawn and ready to judge
  db.prepare("INSERT INTO category (src_id,competition_id,name,dances,category_order,discipline) VALUES ('C1',?,'Adults Standard','W,T,VW,F,Q',1,'STD')").run(compId);
  const cat1 = db.prepare("SELECT id FROM category WHERE src_id='C1'").get().id;
  names.slice(0, 6).forEach((n, i) =>
    db.prepare("INSERT INTO entry (src_id,competition_id,category_id,start_number,name1,name2,studio_name) VALUES (?,?,?,?,?,?,?)")
      .run('C1E' + (i + 1), compId, cat1, i + 1, n[0], n[1], n[2]));
  createRound(db, cat1, { ordinal: 1, kind: 'final', dances: ['W', 'T', 'VW', 'F', 'Q'], drawMode: 'fixed_heats' });
  const r1 = db.prepare('SELECT id FROM round WHERE category_id=?').get(cat1).id;
  drawRound(db, r1, { numHeats: 1 });

  // Category 2: an 8-couple Latin QUALIFICATION (recall 6), drawn
  db.prepare("INSERT INTO category (src_id,competition_id,name,dances,category_order,discipline) VALUES ('C2',?,'Youth Latin',' SB,CC,RU,JI',2,'LAT')").run(compId);
  const cat2 = db.prepare("SELECT id FROM category WHERE src_id='C2'").get().id;
  names.forEach((n, i) =>
    db.prepare("INSERT INTO entry (src_id,competition_id,category_id,start_number,name1,name2,studio_name) VALUES (?,?,?,?,?,?,?)")
      .run('C2E' + (i + 1), compId, cat2, i + 7, n[0], n[1], n[2]));
  createRound(db, cat2, { ordinal: 1, kind: 'intermediate', dances: ['SB', 'CC', 'RU', 'JI'], recallCount: 6, drawMode: 'random_all_same' });
  const r2 = db.prepare('SELECT id FROM round WHERE category_id=?').get(cat2).id;
  drawRound(db, r2, { numHeats: 2, seed: 7 });

  return true;
}

module.exports = { seedDemo };
