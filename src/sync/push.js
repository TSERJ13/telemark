'use strict';

/**
 * Push computed placings back to dancesport.ge (tournament_registrations.result_place),
 * so results appear on the public site. entry.src_id == registration id.
 */

const { audit, getActiveCompetition } = require('../db');

async function pushResults(db, supabase) {
  const comp = getActiveCompetition(db);
  if (!comp) return { ok: 0, fail: 0, errors: [] };

  const rows = db.prepare(
    `SELECT p.id AS pid, p.place, e.src_id
     FROM placing p JOIN entry e ON e.id = p.entry_id
     WHERE e.src_id IS NOT NULL AND e.competition_id = ?`
  ).all(comp.id);

  let ok = 0, fail = 0;
  const errors = [];
  const markPushed = db.prepare("UPDATE placing SET pushed_at=datetime('now') WHERE id=?");

  for (const r of rows) {
    try {
      await supabase.pushResult(r.src_id, r.place);
      markPushed.run(r.pid);
      ok++;
    } catch (e) {
      fail++;
      errors.push({ src_id: r.src_id, error: e.message });
    }
  }
  audit(db, 'system', 'sync.push_results', { ok, fail });
  return { ok, fail, errors };
}

module.exports = { pushResults };
