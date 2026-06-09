'use strict';

/**
 * Judging core — the logic a judge's tablet drives.
 *
 * WDSF requirements covered:
 *   7.2  judge sees couples heat by heat
 *   7.3  show a checksum of the marks (computed on device)
 *   7.4  confirm marks after each dance
 *   7.6/7.7 helpmarks (remember-only, NOT a recall)
 *   7.10 marks immutable after confirmation (reopen = chairman only)
 *   7.22 checksum computed locally, not fetched from server
 *   5.5  number of marks for next round is configurable (recall_count)
 *
 * FINAL round       : judge gives each couple a unique place 1..N.
 * INTERMEDIATE round: judge gives crosses to exactly `recall_count` couples.
 */

const { audit } = require('../db');

/* ---- read: the marking view for one judge on one dance ------------ */
function getMarkingView(db, roundDanceId, officialId) {
  const rd = db
    .prepare(
      `SELECT rd.id, rd.dance_code, rd.round_id, r.kind, r.recall_count, r.category_id
       FROM round_dance rd JOIN round r ON r.id = rd.round_id
       WHERE rd.id=?`
    )
    .get(roundDanceId);
  if (!rd) throw new Error('round_dance not found');

  const cat = db.prepare('SELECT judging_system FROM category WHERE id=?').get(rd.category_id);
  const judgingSystem = cat ? cat.judging_system : 'relative';

  const couples = db
    .prepare(
      `SELECT he.heat_number, e.id AS entry_id, e.start_number, e.name1, e.name2, e.status,
              m.place, m.cross_mark, m.is_helpmark, m.confirmed_at,
              m.score_tq, m.score_mm, m.score_ps, m.score_cp
       FROM heat_entry he
       JOIN entry e ON e.id = he.entry_id
       LEFT JOIN mark m ON m.entry_id = e.id AND m.round_dance_id = he.round_dance_id
                       AND m.official_id = ?
       WHERE he.round_dance_id = ?
       ORDER BY he.heat_number, he.order_index, e.start_number`
    )
    .all(officialId, roundDanceId);

  const heats = {};
  let confirmed = false;
  for (const c of couples) {
    if (c.confirmed_at) confirmed = true;
    (heats[c.heat_number] ||= []).push({
      entry_id: c.entry_id,
      number: c.start_number,
      name: c.name2 ? `${c.name1} & ${c.name2}` : c.name1,
      status: c.status,
      place: c.place ?? null,
      cross: !!c.cross_mark,
      help: c.is_helpmark ?? 0,
      score_tq: c.score_tq ?? null,
      score_mm: c.score_mm ?? null,
      score_ps: c.score_ps ?? null,
      score_cp: c.score_cp ?? null,
    });
  }

  const isFinal = String(rd.kind).toLowerCase() === 'final';
  const numCouples = couples.length;
  const target = isFinal ? numCouples : rd.recall_count;

  const cs = db
    .prepare('SELECT value, signed_at FROM checksum WHERE round_dance_id=? AND official_id=?')
    .get(roundDanceId, officialId);

  return {
    round_dance_id: roundDanceId,
    dance: rd.dance_code,
    kind: rd.kind,
    isFinal,
    target,               // final: place 1..N ; intermediate: crosses to give
    numCouples,
    confirmed,
    checksum: cs ? cs.value : null,
    signed: cs ? !!cs.signed_at : false,
    heats,
    judgingSystem,
  };
}

/* ---- guard: is this dance locked for this judge? ------------------ */
function isConfirmed(db, roundDanceId, officialId) {
  const row = db
    .prepare(
      `SELECT 1 FROM mark WHERE round_dance_id=? AND official_id=? AND confirmed_at IS NOT NULL LIMIT 1`
    )
    .get(roundDanceId, officialId);
  return !!row;
}

function upsertMark(db, roundDanceId, officialId, entryId, fields) {
  const existing = db
    .prepare(
      'SELECT id FROM mark WHERE round_dance_id=? AND official_id=? AND entry_id=?'
    )
    .get(roundDanceId, officialId, entryId);
  if (existing) {
    const sets = Object.keys(fields).map((k) => `${k}=?`).join(', ');
    db.prepare(`UPDATE mark SET ${sets} WHERE id=?`).run(
      ...Object.values(fields), existing.id
    );
  } else {
    const cols = ['round_dance_id', 'official_id', 'entry_id', ...Object.keys(fields)];
    const ph = cols.map(() => '?').join(',');
    db.prepare(`INSERT INTO mark (${cols.join(',')}) VALUES (${ph})`).run(
      roundDanceId, officialId, entryId, ...Object.values(fields)
    );
  }
}

/* ---- write: set a place (final). Place is unique -> swaps out. ---- */
function setPlace(db, roundDanceId, officialId, entryId, place) {
  if (isConfirmed(db, roundDanceId, officialId))
    return { ok: false, reason: 'locked' };
  // clear this place from any other couple this judge gave it to
  db.prepare(
    `UPDATE mark SET place=NULL
     WHERE round_dance_id=? AND official_id=? AND place=? AND entry_id<>?`
  ).run(roundDanceId, officialId, place, entryId);
  upsertMark(db, roundDanceId, officialId, entryId, { place });
  return { ok: true };
}

/* ---- write: toggle a cross (intermediate). Enforces target cap. --- */
function setCross(db, roundDanceId, officialId, entryId, value) {
  if (isConfirmed(db, roundDanceId, officialId))
    return { ok: false, reason: 'locked' };
  if (value) {
    const view = getMarkingView(db, roundDanceId, officialId);
    const current = Object.values(view.heats).flat().filter((c) => c.cross).length;
    const already = db
      .prepare('SELECT cross_mark FROM mark WHERE round_dance_id=? AND official_id=? AND entry_id=?')
      .get(roundDanceId, officialId, entryId);
    if (!(already && already.cross_mark) && current >= view.target) {
      return { ok: false, reason: 'limit', target: view.target };
    }
  }
  upsertMark(db, roundDanceId, officialId, entryId, { cross_mark: value ? 1 : 0 });
  return { ok: true };
}

/* ---- write: toggle helpmark (independent, never a recall) --------- */
function setHelp(db, roundDanceId, officialId, entryId, value) {
  if (isConfirmed(db, roundDanceId, officialId))
    return { ok: false, reason: 'locked' };
  upsertMark(db, roundDanceId, officialId, entryId, { is_helpmark: parseInt(value, 10) || 0 });
  return { ok: true };
}

/* ---- checksum (computed from the judge's marks, on device) -------- */
function computeChecksum(view, marks) {
  if (view.judgingSystem === 'js3.0') {
    const allScores = [];
    let complete = true;
    for (const m of marks) {
      if (m.score_tq == null || m.score_mm == null || m.score_ps == null || m.score_cp == null) {
        complete = false;
      } else {
        allScores.push(m.score_tq, m.score_mm, m.score_ps, m.score_cp);
      }
    }
    if (marks.length < view.numCouples) {
      complete = false;
    }
    const sum = allScores.reduce((a, b) => a + b, 0);
    return {
      value: `Σ${sum.toFixed(2)}`,
      valid: complete,
      detail: { sum, complete, expectedCount: view.numCouples * 4, actualCount: allScores.length },
    };
  }
  if (view.isFinal) {
    const places = marks.map((m) => m.place).filter((p) => p != null);
    const sum = places.reduce((a, b) => a + b, 0);
    const expected = (view.numCouples * (view.numCouples + 1)) / 2;
    const unique = new Set(places).size === places.length;
    const complete = places.length === view.numCouples;
    return {
      value: `Σ${sum}/${expected}`,
      valid: complete && unique && sum === expected,
      detail: { sum, expected, unique, complete, given: places.length },
    };
  }
  const crosses = marks.filter((m) => m.cross_mark).length;
  return {
    value: `×${crosses}/${view.target}`,
    valid: crosses === view.target,
    detail: { crosses, target: view.target },
  };
}

/* ---- write: set component scores (JS 3.0 points scoring) ----------- */
function setComponents(db, roundDanceId, officialId, entryId, scores) {
  if (isConfirmed(db, roundDanceId, officialId))
    return { ok: false, reason: 'locked' };
  upsertMark(db, roundDanceId, officialId, entryId, {
    score_tq: scores.tq,
    score_mm: scores.mm,
    score_ps: scores.ps,
    score_cp: scores.cp,
  });
  return { ok: true };
}

/* ---- confirm a dance: validate, store checksum, lock marks -------- */
function confirmDance(db, roundDanceId, officialId) {
  const view = getMarkingView(db, roundDanceId, officialId);
  const marks = db
    .prepare('SELECT place, cross_mark, score_tq, score_mm, score_ps, score_cp FROM mark WHERE round_dance_id=? AND official_id=?')
    .all(roundDanceId, officialId);
  const cs = computeChecksum(view, marks);
  if (!cs.valid) return { ok: false, reason: 'invalid', checksum: cs };

  db.exec('BEGIN');
  try {
    const ts = db.prepare("SELECT datetime('now') t").get().t;
    db.prepare(
      'UPDATE mark SET confirmed_at=? WHERE round_dance_id=? AND official_id=?'
    ).run(ts, roundDanceId, officialId);
    db.prepare(
      `INSERT INTO checksum (round_dance_id, official_id, value)
       VALUES (?,?,?)
       ON CONFLICT(round_dance_id, official_id) DO UPDATE SET value=excluded.value`
    ).run(roundDanceId, officialId, cs.value);
    audit(db, officialId, 'mark.confirm', { roundDanceId, checksum: cs.value });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { ok: true, checksum: cs, confirmedAt: true };
}

/* ---- judge signs the checksum (WDSF 7.5 digital signature) -------- */
function signChecksum(db, roundDanceId, officialId, signatureBlob) {
  const ts = db.prepare("SELECT datetime('now') t").get().t;
  const r = db
    .prepare(
      'UPDATE checksum SET signed_at=?, signature_blob=? WHERE round_dance_id=? AND official_id=?'
    )
    .run(ts, signatureBlob ?? null, roundDanceId, officialId);
  if (r.changes === 0) return { ok: false, reason: 'no-checksum' };
  audit(db, officialId, 'checksum.sign', { roundDanceId });
  return { ok: true, signedAt: ts };
}

/* ---- chairman reopens a confirmed dance (WDSF 1.1 / 7.10) --------- */
function reopenDance(db, roundDanceId, officialId) {
  db.exec('BEGIN');
  try {
    db.prepare(
      'UPDATE mark SET confirmed_at=NULL WHERE round_dance_id=? AND official_id=?'
    ).run(roundDanceId, officialId);
    db.prepare(
      'DELETE FROM checksum WHERE round_dance_id=? AND official_id=?'
    ).run(roundDanceId, officialId);
    audit(db, 'chairman', 'mark.reopen', { roundDanceId, officialId });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { ok: true };
}

module.exports = {
  getMarkingView, setPlace, setCross, setHelp, setComponents,
  confirmDance, signChecksum, reopenDance, computeChecksum,
};
