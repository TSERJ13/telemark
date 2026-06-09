'use strict';

/**
 * Pull a competition from dancesport.ge into the local telemark DB.
 * Uses UPSERT (ON CONFLICT ... DO UPDATE) throughout so local IDs
 * (category.id, entry.id, official.id) are NEVER changed on re-sync.
 * This prevents the "Category not found" bug when the browser still
 * holds the old ID.
 *
 * Scrutiny data (rounds, marks, placings) is never touched here.
 */

const { audit } = require('../db');

const latin = (f, l) => [f, l].filter(Boolean).join(' ').trim() || null;
const geo   = (f, l) => [f, l].filter(Boolean).join(' ').trim() || null;

function upsertCompetition(db, t) {
  db.prepare(
    `INSERT INTO competition (src_id, name, event_date, location, organizer_names, is_locked, synced_at)
     VALUES (?,?,?,?,?, 0, datetime('now'))
     ON CONFLICT(src_id) DO UPDATE SET
       name=excluded.name, event_date=excluded.event_date,
       location=excluded.location, organizer_names=excluded.organizer_names,
       synced_at=datetime('now')`
  ).run(t.id, t.name, t.event_date ?? null, t.location ?? null, t.organizer_names ?? null);
  return db.prepare('SELECT id FROM competition WHERE src_id=?').get(t.id).id;
}

function upsertCategory(db, compId, c) {
  db.prepare(
    `INSERT INTO category
       (src_id, competition_id, name, allowed_classes, dances,
        min_age, max_age, session_number, session_time, category_order, entry_fee, synced_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
     ON CONFLICT(src_id) DO UPDATE SET
       competition_id=excluded.competition_id,
       name=excluded.name, allowed_classes=excluded.allowed_classes,
       dances=excluded.dances,
       min_age=excluded.min_age, max_age=excluded.max_age,
       session_number=excluded.session_number, session_time=excluded.session_time,
       category_order=excluded.category_order, entry_fee=excluded.entry_fee,
       synced_at=datetime('now')`
  ).run(
    c.id, compId, c.category_name, c.allowed_classes ?? '', c.dances ?? '',
    c.min_age ?? 0, c.max_age ?? 99, c.session_number ?? 0,
    c.session_time ?? '', c.category_order ?? 0, c.entry_fee ?? 0
  );
  return db.prepare('SELECT id FROM category WHERE src_id=?').get(c.id).id;
}

function upsertOfficial(db, compId, j, letter) {
  db.prepare(
    `INSERT INTO official (src_id, competition_id, full_name, role, judge_letter, synced_at)
     VALUES (?,?,?,?,?, datetime('now'))
     ON CONFLICT(src_id) DO UPDATE SET
       competition_id=excluded.competition_id,
       full_name=excluded.full_name, role=excluded.role,
       judge_letter=excluded.judge_letter, synced_at=datetime('now')`
  ).run(j.id, compId, j.full_name, j.role ?? 'judge', letter);
}

function upsertEntry(db, compId, catLocalId, r, athletes, studios) {
  const a1 = athletes.get(r.athlete1_id);
  const a2 = r.athlete2_id ? athletes.get(r.athlete2_id) : null;

  const name1    = a1 ? latin(a1.first_name, a1.last_name) : '(unknown)';
  const name1_ka = a1 ? geo(a1.first_name_ka, a1.last_name_ka) : null;

  let name2 = null, name2_ka = null;
  if (a2) {
    name2    = latin(a2.first_name, a2.last_name);
    name2_ka = geo(a2.first_name_ka, a2.last_name_ka);
  } else if (a1 && a1.is_couple && a1.partner_first_name) {
    name2    = latin(a1.partner_first_name, a1.partner_last_name);
    name2_ka = geo(a1.partner_first_name_ka, a1.partner_last_name_ka);
  }

  const studio = r.studio_id ? studios.get(r.studio_id) : null;

  db.prepare(
    `INSERT INTO entry
       (src_id, competition_id, category_id, athlete1_src_id, name1, name1_ka,
        athlete2_src_id, name2, name2_ka, studio_src_id, studio_name, final_place, synced_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
     ON CONFLICT(src_id) DO UPDATE SET
       category_id=excluded.category_id,
       name1=excluded.name1, name1_ka=excluded.name1_ka,
       name2=excluded.name2, name2_ka=excluded.name2_ka,
       studio_name=excluded.studio_name,
       synced_at=datetime('now')`
  ).run(
    r.id, compId, catLocalId, r.athlete1_id ?? null, name1, name1_ka,
    r.athlete2_id ?? null, name2, name2_ka,
    r.studio_id ?? null, studio ? studio.studio_name : null, r.result_place ?? null
  );
}

async function pullCompetition(db, supabase, srcId) {
  // 1. Fetch all data remotely (async, read-only)
  const [tournamentRows, categories, judges, registrations] = await Promise.all([
    supabase.tournament(srcId),
    supabase.categories(srcId),
    supabase.judges(srcId),
    supabase.registrations(srcId),
  ]);
  const tournament = Array.isArray(tournamentRows) ? tournamentRows[0] : tournamentRows;
  if (!tournament) throw new Error(`Tournament ${srcId} not found on dancesport.ge`);

  const athleteIds = [...new Set(registrations.flatMap(r => [r.athlete1_id, r.athlete2_id]).filter(Boolean))];
  const studioIds  = [...new Set(registrations.map(r => r.studio_id).filter(Boolean))];
  const [athleteRows, studioRows] = await Promise.all([
    supabase.athletes(athleteIds),
    supabase.studios(studioIds),
  ]);
  const athletes = new Map(athleteRows.map(a => [a.id, a]));
  const studios  = new Map(studioRows.map(s => [s.id, s]));

  // 2. Write everything in one transaction — UPSERT only, no DELETE
  db.exec('BEGIN');
  try {
    const compId = upsertCompetition(db, tournament);

    const catLocal = new Map();
    for (const c of categories) {
      catLocal.set(c.id, upsertCategory(db, compId, c));
    }

    // Assign letters A,B,C... to judges in fetch order, preserving existing ones
    const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const usedLetters = new Set(
      db.prepare("SELECT judge_letter FROM official WHERE competition_id=? AND judge_letter IS NOT NULL").all(compId).map(r => r.judge_letter)
    );
    let li = 0;
    for (const j of judges) {
      const isJudge = (j.role ?? 'judge') === 'judge';
      // If this official already has a letter, keep it
      const existing = db.prepare("SELECT judge_letter FROM official WHERE src_id=?").get(j.id);
      let letter = existing ? existing.judge_letter : null;
      if (isJudge && !letter) {
        while (li < LETTERS.length && usedLetters.has(LETTERS[li])) li++;
        letter = LETTERS[li++] ?? null;
        if (letter) usedLetters.add(letter);
      }
      upsertOfficial(db, compId, j, letter);
    }

    for (const r of registrations) {
      const catLocalId = catLocal.get(r.category_id);
      if (!catLocalId) continue;
      upsertEntry(db, compId, catLocalId, r, athletes, studios);
    }

    db.prepare("UPDATE sync_state SET last_pull_at=datetime('now'), active_competition_id=? WHERE id=1").run(compId);
    audit(db, 'system', 'sync.pull', {
      srcId,
      categories: categories.length,
      judges: judges.length,
      registrations: registrations.length,
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return {
    competitionSrcId: srcId,
    categories: categories.length,
    judges: judges.length,
    entries: registrations.length,
  };
}

module.exports = { pullCompetition };
