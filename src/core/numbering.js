'use strict';

/**
 * Start-number generation.
 * Continuous across categories ordered by (session_number, category_order, name).
 * If session_number is passed, only numbers for that session's categories are generated.
 */

const { audit } = require('../db');

const ORDERS = {
  studio: 'ORDER BY studio_name COLLATE NOCASE, name1 COLLATE NOCASE',
  name:   'ORDER BY name1 COLLATE NOCASE',
  entry:  'ORDER BY id',
};

function generateStartNumbers(db, competitionSrcId, opts = {}) {
  const startFrom   = opts.startFrom ?? 1;
  const orderSql    = ORDERS[opts.order] || ORDERS.studio;
  const sessionNum  = opts.session_number != null ? opts.session_number : null;

  const comp = db.prepare('SELECT id FROM competition WHERE src_id=?').get(competitionSrcId);
  if (!comp) throw new Error(`Competition ${competitionSrcId} not synced`);

  // Determine starting counter: if numbering a specific session, continue from
  // the highest existing number across the whole competition.
  let counter = startFrom;
  if (sessionNum != null) {
    const maxNum = db.prepare('SELECT MAX(start_number) n FROM entry WHERE competition_id=?').get(comp.id).n;
    if (maxNum != null) counter = maxNum + 1;
  }

  const catQuery = sessionNum != null
    ? `SELECT id, name FROM category WHERE competition_id=? AND session_number=?
       AND chairman_confirmed=1
       ORDER BY category_order ASC, name COLLATE NOCASE ASC`
    : `SELECT id, name FROM category WHERE competition_id=?
       AND chairman_confirmed=1
       ORDER BY session_number ASC, category_order ASC, name COLLATE NOCASE ASC`;

  const categories = sessionNum != null
    ? db.prepare(catQuery).all(comp.id, sessionNum)
    : db.prepare(catQuery).all(comp.id);

  if (!categories.length) return { startFrom: counter, lastNumber: counter - 1, categories: [] };

  const selectEntries = db.prepare(
    `SELECT id FROM entry WHERE category_id=? AND status != 'withdrawn' ${orderSql}`
  );
  const setNumber = db.prepare('UPDATE entry SET start_number=? WHERE id=?');

  const summary = [];
  db.exec('BEGIN');
  try {
    for (const cat of categories) {
      const entries = selectEntries.all(cat.id);
      if (!entries.length) {
        summary.push({ name: cat.name, from: null, to: null, count: 0 });
        continue;
      }
      const from = counter;
      for (const e of entries) setNumber.run(counter++, e.id);
      summary.push({ name: cat.name, from, to: counter - 1, count: entries.length });
    }
    audit(db, 'system', 'numbering.generate', {
      competitionSrcId, startFrom, sessionNum,
      lastNumber: counter - 1, order: opts.order || 'studio',
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return { startFrom, lastNumber: counter - 1, categories: summary };
}

module.exports = { generateStartNumbers };
