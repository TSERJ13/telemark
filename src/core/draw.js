'use strict';

/**
 * Round drawing engine.
 *
 * WDSF requirements covered:
 *   5.1  random, separated for every dance        -> 'random_per_dance'
 *   5.2  random but all dances the same           -> 'random_all_same'
 *   5.3  fixed heats sorted by numbers            -> 'fixed_heats'
 *   5.8  seeded (star) couples spread across heats
 *   3.7  numbers in ascending order (within heat, on read-back)
 *   3.8  sort by heats then numbers ascending
 *
 * A round has one or more dances (round_dance). For each dance we assign
 * every entry a heat_number and store it in heat_entry.
 */

const { audit } = require('../db');

/* --- tiny seedable PRNG (mulberry32) so draws are reproducible ----- */
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* --- which entries belong to a round ------------------------------- */
function entriesForRound(db, round) {
  const starCouplesEnabled = round.star_couples_enabled === 1;

  if (round.ordinal === 1) {
    if (starCouplesEnabled) {
      const hasNonSeeded = db.prepare("SELECT 1 FROM entry WHERE category_id=? AND is_seeded=0 AND status NOT IN ('withdrawn','disqualified') LIMIT 1").get(round.category_id);
      if (hasNonSeeded) {
        return db
          .prepare(
            `SELECT id, start_number, is_seeded FROM entry
             WHERE category_id=? AND is_seeded=0 AND status NOT IN ('withdrawn','disqualified')
             ORDER BY start_number`
          )
          .all(round.category_id);
      }
    }
    return db
      .prepare(
        `SELECT id, start_number, is_seeded FROM entry
         WHERE category_id=? AND status NOT IN ('withdrawn','disqualified')
         ORDER BY start_number`
      )
      .all(round.category_id);
  }

  const prev = db
    .prepare(
      'SELECT id, kind, ordinal FROM round WHERE category_id=? AND ordinal=?'
    )
    .get(round.category_id, round.ordinal - 1);
  if (!prev) throw new Error('Previous round not found for recall');

  if (round.kind === 'redance') {
    return db
      .prepare(
        `SELECT e.id, e.start_number, e.is_seeded
         FROM recall_result rr JOIN entry e ON e.id = rr.entry_id
         WHERE rr.round_id=? AND rr.borderline_tie=1 AND e.status NOT IN ('withdrawn','disqualified')
         ORDER BY e.start_number`
      )
      .all(prev.id);
  }

  if (prev.kind === 'redance') {
    const redanceRecalled = db
      .prepare(
        `SELECT e.id, e.start_number, e.is_seeded
         FROM recall_result rr JOIN entry e ON e.id = rr.entry_id
         WHERE rr.round_id=? AND rr.recalled=1 AND e.status NOT IN ('withdrawn','disqualified')`
      )
      .all(prev.id);

    const grandPrev = db
      .prepare(
        'SELECT id FROM round WHERE category_id=? AND ordinal=?'
      )
      .get(round.category_id, prev.ordinal - 1);

    let clearlyIn = [];
    if (grandPrev) {
      const tiedEntry = db.prepare('SELECT entry_id FROM recall_result WHERE round_id=? LIMIT 1').get(prev.id);
      let cutCrosses = 0;
      if (tiedEntry) {
        const row = db.prepare('SELECT crosses FROM recall_result WHERE round_id=? AND entry_id=?').get(grandPrev.id, tiedEntry.entry_id);
        if (row) cutCrosses = row.crosses;
      }

      clearlyIn = db
        .prepare(
          `SELECT e.id, e.start_number, e.is_seeded
           FROM recall_result rr JOIN entry e ON e.id = rr.entry_id
           WHERE rr.round_id=? AND rr.crosses>? AND e.status NOT IN ('withdrawn','disqualified')`
        )
        .all(grandPrev.id, cutCrosses);
    }

    const combined = [...redanceRecalled];
    const seen = new Set(combined.map((c) => c.id));
    for (const c of clearlyIn) {
      if (!seen.has(c.id)) combined.push(c);
    }
    return combined.sort((a, b) => a.start_number - b.start_number);
  }

  const recalled = db
    .prepare(
      `SELECT e.id, e.start_number, e.is_seeded
       FROM recall_result rr JOIN entry e ON e.id = rr.entry_id
       WHERE rr.round_id=? AND rr.recalled=1 AND e.status NOT IN ('withdrawn','disqualified')
       ORDER BY e.start_number`
    )
    .all(prev.id);

  if (round.ordinal === 2 && starCouplesEnabled) {
    const starCouples = db
      .prepare(
        `SELECT id, start_number, is_seeded FROM entry
         WHERE category_id=? AND is_seeded=1 AND status NOT IN ('withdrawn','disqualified')`
      )
      .all(round.category_id);
    const seen = new Set(recalled.map((r) => r.id));
    for (const sc of starCouples) {
      if (!seen.has(sc.id)) recalled.push(sc);
    }
  }

  return recalled.sort((a, b) => a.start_number - b.start_number);
}

/* --- distribute entries into N heats ------------------------------- *
 * Seeded couples are placed first, one per heat round-robin, so they
 * never share a heat until every heat has one (WDSF 5.8). The rest are
 * distributed round-robin for balanced heat sizes.
 * Returns Map(entryId -> heatNumber).
 */
function distribute(entries, numHeats) {
  const seeded = entries.filter((e) => e.is_seeded);
  const rest = entries.filter((e) => !e.is_seeded);
  const heatOf = new Map();
  let h = 0;
  for (const e of seeded) { heatOf.set(e.id, (h % numHeats) + 1); h++; }
  for (const e of rest)   { heatOf.set(e.id, (h % numHeats) + 1); h++; }
  return heatOf;
}

/* --- fixed: sorted by number, balanced sequential chunks ----------- */
function distributeFixed(entries, numHeats) {
  const sorted = entries.slice().sort((a, b) => a.start_number - b.start_number);
  const heatOf = new Map();
  const per = Math.ceil(sorted.length / numHeats);
  sorted.forEach((e, i) => heatOf.set(e.id, Math.floor(i / per) + 1));
  return heatOf;
}

/**
 * Create a round (+ its round_dance rows) for a category.
 * @param opts { ordinal, kind, dances:[codes], recallCount, drawMode, maxPerHeat, starCouplesEnabled }
 */
function createRound(db, categoryId, opts) {
  const {
    ordinal, kind, dances, recallCount = null,
    drawMode = 'random_per_dance', maxPerHeat = 8,
    starCouplesEnabled = 0,
  } = opts;

  db.prepare(
    `INSERT INTO round (category_id, ordinal, kind, recall_count, draw_mode, star_couples_enabled, status)
     VALUES (?,?,?,?,?,?, 'pending')
     ON CONFLICT(category_id, ordinal) DO UPDATE SET
       kind=excluded.kind, recall_count=excluded.recall_count,
       draw_mode=excluded.draw_mode, star_couples_enabled=excluded.star_couples_enabled`
  ).run(categoryId, ordinal, kind, recallCount, drawMode, starCouplesEnabled ? 1 : 0);

  const round = db
    .prepare('SELECT * FROM round WHERE category_id=? AND ordinal=?')
    .get(categoryId, ordinal);

  // (re)create round_dance rows
  db.prepare('DELETE FROM round_dance WHERE round_id=?').run(round.id);
  dances.forEach((code, i) => {
    db.prepare(
      'INSERT INTO round_dance (round_id, dance_code, dance_order) VALUES (?,?,?)'
    ).run(round.id, code, i + 1);
  });

  round._maxPerHeat = maxPerHeat;
  return round;
}

/**
 * Generate the draw (heats) for a round.
 * @param opts { numHeats, maxPerHeat, seed }
 * @returns { numHeats, dances:[{dance, heats:{n:[numbers...]}}] }
 */
function drawRound(db, roundId, opts = {}) {
  const round = db.prepare('SELECT * FROM round WHERE id=?').get(roundId);
  if (!round) throw new Error('Round not found');

  const entries = entriesForRound(db, round);
  if (!entries.length) throw new Error('No entries to draw');

  const maxPerHeat = opts.maxPerHeat ?? 8;
  const numHeats = round.draw_mode === 'solo_rotation' ? 1 : (opts.numHeats ?? Math.max(1, Math.ceil(entries.length / maxPerHeat)));
  const seed = opts.seed ?? (Date.now() & 0x7fffffff);
  const rand = rng(seed);

  const dancesRows = db
    .prepare('SELECT * FROM round_dance WHERE round_id=? ORDER BY dance_order')
    .all(roundId);

  const setNumHeats = db.prepare('UPDATE round SET num_heats=?, status=? WHERE id=?');
  const clearHeats = db.prepare(
    'DELETE FROM heat_entry WHERE round_dance_id=?'
  );
  const insHeat = db.prepare(
    'INSERT INTO heat_entry (round_dance_id, entry_id, heat_number, order_index) VALUES (?,?,?,?)'
  );
  const numberOf = new Map(entries.map((e) => [e.id, e.start_number]));

  const result = { numHeats, mode: round.draw_mode, dances: [] };

  db.exec('BEGIN');
  try {
    let sharedAssign = null;
    if (round.draw_mode === 'random_all_same') {
      sharedAssign = distribute(shuffle(entries, rand), numHeats);
    }

    for (let dIdx = 0; dIdx < dancesRows.length; dIdx++) {
      const rd = dancesRows[dIdx];
      let assign;

      if (round.draw_mode === 'fixed_heats') {
        const temp = distributeFixed(entries, numHeats);
        assign = new Map();
        const counts = {};
        for (const [eid, hNo] of temp) {
          const oIdx = (counts[hNo] = (counts[hNo] || 0) + 1) - 1;
          assign.set(eid, { heatNo: hNo, orderIdx: oIdx });
        }
      } else if (round.draw_mode === 'solo_rotation') {
        assign = new Map();
        const sorted = entries.slice().sort((a, b) => a.start_number - b.start_number);
        const rotated = [...sorted];
        const shift = dIdx % rotated.length;
        for (let s = 0; s < shift; s++) {
          rotated.push(rotated.shift());
        }
        rotated.forEach((entry, orderIdx) => {
          assign.set(entry.id, { heatNo: 1, orderIdx });
        });
      } else {
        let hMap;
        if (round.draw_mode === 'random_all_same') {
          hMap = sharedAssign;
        } else {
          hMap = distribute(shuffle(entries, rand), numHeats);
        }
        assign = new Map();
        const counts = {};
        for (const [eid, hNo] of hMap) {
          const oIdx = (counts[hNo] = (counts[hNo] || 0) + 1) - 1;
          assign.set(eid, { heatNo: hNo, orderIdx: oIdx });
        }
      }

      clearHeats.run(rd.id);
      for (const [entryId, info] of assign) {
        insHeat.run(rd.id, entryId, info.heatNo, info.orderIdx);
      }

      const heats = {};
      // For solo_rotation we want to preserve order_index order!
      const sortedAssign = Array.from(assign.entries()).sort((x, y) => x[1].orderIdx - y[1].orderIdx);
      for (const [entryId, info] of sortedAssign) {
        (heats[info.heatNo] ||= []).push(numberOf.get(entryId));
      }
      if (round.draw_mode !== 'solo_rotation') {
        Object.values(heats).forEach((arr) => arr.sort((a, b) => a - b));
      }
      result.dances.push({ dance: rd.dance_code, heats });
    }

    setNumHeats.run(numHeats, 'drawn', roundId);
    audit(db, 'system', 'round.draw', {
      roundId, mode: round.draw_mode, numHeats, entries: entries.length, seed,
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  result.seed = seed;
  return result;
}

module.exports = { createRound, drawRound, entriesForRound };
