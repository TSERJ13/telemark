'use strict';

/**
 * Results — turns stored marks into placings via the skating engine.
 *
 *   computeRecall(db, roundId)  -> intermediate rounds (cross counting, rules 9-11)
 *   computeFinal(db, roundId)   -> final rounds (rules 1-8), writes placing + entry.final_place
 *
 * WDSF requirements: 2.1/2.2/2.4 (correct skating placing), 5.6 (redance flag).
 */

const skating = require('./skating');
const { audit } = require('../db');

/* judges (officials) that participate, ordered by letter for stable columns */
function judgesOf(db, competitionId) {
  return db
    .prepare(
      `SELECT id, judge_letter FROM official
       WHERE competition_id=? AND role='judge'
       ORDER BY judge_letter`
    )
    .all(competitionId);
}

function roundContext(db, roundId) {
  const round = db.prepare('SELECT * FROM round WHERE id=?').get(roundId);
  if (!round) throw new Error('round not found');
  const cat = db.prepare('SELECT * FROM category WHERE id=?').get(round.category_id);
  const dances = db
    .prepare('SELECT * FROM round_dance WHERE round_id=? ORDER BY dance_order')
    .all(roundId);
  let judges;
  const assigned = db.prepare(`
    SELECT o.id, o.judge_letter FROM category_judge cj
    JOIN official o ON o.id = cj.official_id
    WHERE cj.category_id=? AND o.role='judge'
    ORDER BY o.judge_letter
  `).all(round.category_id);
  if (assigned.length > 0) {
    judges = assigned;
  } else {
    judges = judgesOf(db, cat.competition_id);
  }
  if (round.active_judges_limit) {
    judges = judges.slice(0, round.active_judges_limit);
  }
  return { round, cat, dances, judges };
}

/* entries actually dancing this round (drawn into at least one dance) */
function entriesInRound(db, roundId) {
  return db
    .prepare(
      `SELECT DISTINCT e.id, e.start_number
       FROM heat_entry he
       JOIN round_dance rd ON rd.id = he.round_dance_id
       JOIN entry e ON e.id = he.entry_id
       WHERE rd.round_id=?
       ORDER BY e.start_number`
    )
    .all(roundId);
}

/* ---- INTERMEDIATE: recall by total crosses ------------------------ */
function computeRecall(db, roundId) {
  const { round, dances } = roundContext(db, roundId);
  const entries = entriesInRound(db, roundId);

  const danceIds = dances.map((d) => d.id);
  const crossStmt = db.prepare(
    `SELECT COALESCE(SUM(cross_mark),0) c FROM mark
     WHERE entry_id=? AND round_dance_id IN (${danceIds.map(() => '?').join(',')})`
  );

  const couples = entries.map((e) => ({
    id: e.id,
    crosses: crossStmt.get(e.id, ...danceIds).c,
  }));

  const res = skating.recall(couples, round.recall_count);

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM recall_result WHERE round_id=?').run(roundId);
    const ins = db.prepare(
      `INSERT INTO recall_result (round_id, entry_id, crosses, recalled, borderline_tie)
       VALUES (?,?,?,?,?)`
    );
    for (const r of res.ranked) {
      ins.run(roundId, r.id, r.crosses, r.recalled ? 1 : 0, res.borderlineTie ? 1 : 0);
    }
    db.prepare("UPDATE round SET status='closed' WHERE id=?").run(roundId);
    audit(db, 'system', 'round.recall', {
      roundId, recalled: res.recalled.length, borderlineTie: res.borderlineTie,
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return {
    recalled: res.recalled,
    needsRedance: res.needsRedance,
    tiedAtCut: res.tiedAtCut,
    ranked: res.ranked,
  };
}

/* ---- FINAL: rules 1-8, write placing + final_place --------------- */
function computeFinal(db, roundId) {
  const { round, cat, dances, judges } = roundContext(db, roundId);
  const entries = entriesInRound(db, roundId);

  if (cat.judging_system === 'js3.0') {
    const markStmt = db.prepare(
      'SELECT score_tq, score_mm, score_ps, score_cp FROM mark WHERE round_dance_id=? AND official_id=? AND entry_id=?'
    );

    const perDance = [];
    const couplesPoints = entries.map((e) => ({ id: e.id, total: 0 }));

    for (const rd of dances) {
      const dancePlacingCouples = entries.map((e) => {
        const componentSums = { tq: 0, mm: 0, ps: 0, cp: 0 };
        const componentCounts = { tq: 0, mm: 0, ps: 0, cp: 0 };

        for (const j of judges) {
          const m = markStmt.get(rd.id, j.id, e.id);
          if (m) {
            if (m.score_tq != null) { componentSums.tq += m.score_tq; componentCounts.tq++; }
            if (m.score_mm != null) { componentSums.mm += m.score_mm; componentCounts.mm++; }
            if (m.score_ps != null) { componentSums.ps += m.score_ps; componentCounts.ps++; }
            if (m.score_cp != null) { componentSums.cp += m.score_cp; componentCounts.cp++; }
          }
        }

        const tq = componentCounts.tq > 0 ? componentSums.tq / componentCounts.tq : 0;
        const mm = componentCounts.mm > 0 ? componentSums.mm / componentCounts.mm : 0;
        const ps = componentCounts.ps > 0 ? componentSums.ps / componentCounts.ps : 0;
        const cp = componentCounts.cp > 0 ? componentSums.cp / componentCounts.cp : 0;

        const danceTotal = tq + mm + ps + cp;

        const overallCouple = couplesPoints.find((cpVal) => cpVal.id === e.id);
        if (overallCouple) {
          overallCouple.total += danceTotal;
        }

        return {
          id: e.id,
          total: danceTotal,
        };
      });

      const dancePlacings = skating.placePointsFinal(dancePlacingCouples);
      perDance.push({
        name: rd.dance_code,
        placing: dancePlacings,
      });
    }

    const finalPlacings = skating.placePointsFinal(couplesPoints);

    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM placing WHERE category_id=?').run(cat.id);
      const ins = db.prepare(
        'INSERT INTO placing (category_id, entry_id, place, tie) VALUES (?,?,?,?)'
      );
      const setFinal = db.prepare('UPDATE entry SET final_place=? WHERE id=?');
      for (const r of finalPlacings) {
        ins.run(cat.id, r.id, r.place, r.tie ? 1 : 0);
        setFinal.run(r.place, r.id);
      }
      db.prepare("UPDATE round SET status='closed' WHERE id=?").run(roundId);
      db.prepare("UPDATE category SET status='finished' WHERE id=?").run(cat.id);
      audit(db, 'system', 'round.final', { roundId, placed: finalPlacings.length });
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    const numById = new Map(entries.map((e) => [e.id, e.start_number]));
    return {
      final: finalPlacings.map((r) => ({ ...r, number: numById.get(r.id) })),
      perDance,
    };
  }

  const markStmt = db.prepare(
    'SELECT place FROM mark WHERE round_dance_id=? AND official_id=? AND entry_id=?'
  );

  // build dances[] for the engine: each couple has a row of judge places
  const enginedances = dances.map((rd) => ({
    name: rd.dance_code,
    couples: entries.map((e) => ({
      id: e.id,
      marks: judges.map((j) => {
        const m = markStmt.get(rd.id, j.id, e.id);
        return m && m.place != null ? m.place : entries.length; // unmarked -> worst
      }),
    })),
  }));

  const { final, perDance } = skating.placeMultiDanceFinal(enginedances);

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM placing WHERE category_id=?').run(cat.id);
    const ins = db.prepare(
      'INSERT INTO placing (category_id, entry_id, place, tie) VALUES (?,?,?,?)'
    );
    const setFinal = db.prepare('UPDATE entry SET final_place=? WHERE id=?');
    for (const r of final) {
      ins.run(cat.id, r.id, r.place, r.tie ? 1 : 0);
      setFinal.run(r.place, r.id);
    }
    db.prepare("UPDATE round SET status='closed' WHERE id=?").run(roundId);
    db.prepare("UPDATE category SET status='finished' WHERE id=?").run(cat.id);
    audit(db, 'system', 'round.final', { roundId, placed: final.length });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  // attach start numbers for display
  const numById = new Map(entries.map((e) => [e.id, e.start_number]));
  return {
    final: final.map((r) => ({ ...r, number: numById.get(r.id) })),
    perDance,
  };
}

module.exports = { computeRecall, computeFinal, entriesInRound, judgesOf };
