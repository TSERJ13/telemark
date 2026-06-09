'use strict';

/**
 * WDSF result export (WDSF section 4).
 *   buildPayload  — structured result payload for a category (incl. missing couples)
 *   toHtml        — HTML export (recommended export format)
 *   send          — POST the payload to a configurable WDSF endpoint (fetch injectable)
 *
 * Note: official WDSF submission keys couples by their WDSF MIN. entry carries
 * athlete source ids; MINs are attached at sync time when dancesport.ge provides
 * them. The payload shape below is ready to carry min1/min2 once available.
 */

const { audit, getActiveCompetition } = require('../db');

const coupleName = (e) => (e.name2 ? `${e.name1} & ${e.name2}` : e.name1);
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function buildPayload(db, categoryId) {
  const comp = getActiveCompetition(db) || {};
  const cat = db.prepare('SELECT * FROM category WHERE id=?').get(categoryId);
  if (!cat) throw new Error('category not found');

  const results = db.prepare(
    `SELECT p.place, p.tie, e.start_number, e.name1, e.name2,
            e.athlete1_src_id, e.athlete2_src_id
     FROM placing p JOIN entry e ON e.id = p.entry_id
     WHERE p.category_id=? ORDER BY p.place, e.start_number`
  ).all(categoryId);

  const missing = db.prepare(
    `SELECT start_number, name1, name2, status, athlete1_src_id, athlete2_src_id
     FROM entry WHERE category_id=? AND status IN ('missing','excused')
     ORDER BY start_number`
  ).all(categoryId);

  return {
    competition: { name: comp.name, date: comp.event_date, location: comp.location, source: comp.src_id },
    category: { name: cat.name, discipline: cat.discipline, dances: cat.dances },
    results: results.map((r) => ({
      placement: r.place,
      tie: !!r.tie,
      startNumber: r.start_number,
      couple: coupleName(r),
      athletes: [r.athlete1_src_id, r.athlete2_src_id].filter(Boolean),
      // min1/min2 attached here once MINs are synced from dancesport.ge
    })),
    missing: missing.map((m) => ({
      startNumber: m.start_number,
      couple: coupleName(m),
      reason: m.status,
      athletes: [m.athlete1_src_id, m.athlete2_src_id].filter(Boolean),
    })),
    generatedAt: new Date().toISOString(),
  };
}

function toHtml(db, categoryId) {
  const p = buildPayload(db, categoryId);
  const rows = p.results.map((r) =>
    `<tr><td>${r.placement}${r.tie ? '=' : ''}</td><td>${r.startNumber}</td><td>${esc(r.couple)}</td></tr>`
  ).join('');
  const missing = p.missing.length
    ? `<h3>Missing / excused</h3><ul>${p.missing.map((m) => `<li>${m.startNumber} — ${esc(m.couple)} (${m.reason})</li>`).join('')}</ul>`
    : '';
  return `<!doctype html><meta charset="utf-8"><title>${esc(p.category.name)} results</title>
<h1>${esc(p.competition.name)}</h1><h2>${esc(p.category.name)} — results</h2>
<table border="1" cellpadding="6" cellspacing="0"><tr><th>Place</th><th>No.</th><th>Couple</th></tr>${rows}</table>${missing}`;
}

/**
 * Send the payload to a WDSF endpoint.
 * @param cfg { url, apiKey, fetchImpl }
 */
async function send(db, categoryId, cfg = {}) {
  const f = cfg.fetchImpl || globalThis.fetch;
  if (!cfg.url) throw new Error('WDSF endpoint url not configured');
  const payload = buildPayload(db, categoryId);
  const res = await f(cfg.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  const okText = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`WDSF ${res.status}: ${okText}`);
  audit(db, 'system', 'wdsf.send', { category: categoryId, status: res.status });
  return { ok: true, status: res.status, response: okText };
}

module.exports = { buildPayload, toHtml, send };
