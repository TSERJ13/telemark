'use strict';

/**
 * Telemark.one — print-ready A4 HTML documents (WDSF section 3).
 *
 * New documents added:
 *   judgesPinSheet      — PIN list per session (for judges envelope)
 *   judgesSessionSheet  — all judges with categories by session
 *   resultsAllRounds    — full competition sheet: every round per category
 */

const skating = require('./skating');
const { getActiveCompetition, roundLabel } = require('../db');

const esc = (s) => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

/** Both partners shown — boy & girl names */
const coupleName = (e) => e.name2 ? `${e.name1} & ${e.name2}` : e.name1;

const DANCE = {
  W:'Waltz', T:'Tango', VW:'Viennese Waltz', F:'Foxtrot', Q:'Quickstep',
  SB:'Samba', CC:'Cha Cha', RU:'Rumba', PD:'Paso Doble', JI:'Jive',
};
const dname = (c) => DANCE[c] || c;

function comp(db) { return getActiveCompetition(db) || {}; }

/* ─── shared A4 page shell ─────────────────────────────────────────── */
function page(title, c, bodyHtml, opts = {}) {
  const w = opts.landscape ? '270mm' : '182mm';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<title>${esc(title)}</title>
<style>
  @page{size:A4 ${opts.landscape?'landscape':'portrait'};margin:12mm}
  *{box-sizing:border-box}
  body{font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
       color:#0d0d0d;margin:0;font-size:11.5px;line-height:1.4}
  .doc{max-width:${w};margin:0 auto;padding:8mm}
  /* ── header ── */
  .head{display:flex;justify-content:space-between;align-items:flex-end;
        border-bottom:2.5px solid #111;padding-bottom:8px;margin-bottom:16px}
  .head .ttl{font-size:17px;font-weight:800;margin:0;letter-spacing:-.02em}
  .head .sub{font-size:11px;color:#555;margin-top:2px}
  .head .meta{text-align:right;font-size:10.5px;color:#555}
  .head .meta strong{display:block;font-size:13px;color:#111}
  /* ── section headers ── */
  h2{font-size:13px;font-weight:700;margin:18px 0 6px;border-left:3px solid #111;
     padding-left:8px;letter-spacing:-.01em}
  h3{font-size:11.5px;font-weight:600;margin:12px 0 4px;color:#444}
  /* ── tables ── */
  table{width:100%;border-collapse:collapse;margin-bottom:12px;font-size:11px}
  th{background:#1a1a1a;color:#fff;padding:5px 7px;text-align:left;font-size:10px;
     letter-spacing:.04em;text-transform:uppercase}
  td{border-bottom:1px solid #e0e0e0;padding:5px 7px;vertical-align:middle}
  tr:last-child td{border-bottom:2px solid #ccc}
  tr:nth-child(even) td{background:#f8f8f8}
  td.n,th.n{text-align:center;font-variant-numeric:tabular-nums;width:36px}
  td.c{text-align:center}
  /* ── status pills ── */
  .pill{display:inline-block;padding:1px 7px;border-radius:3px;font-size:9.5px;
        font-weight:700;letter-spacing:.03em}
  .pill-ok{background:#d4f0e0;color:#0a6638}
  .pill-warn{background:#fff3cd;color:#856404}
  .pill-danger{background:#fde8e8;color:#9b1c1c}
  .pill-muted{background:#f0f0f0;color:#555}
  /* ── signatures ── */
  .sign{margin-top:16px;display:flex;gap:32px;page-break-inside:avoid}
  .sign .line{flex:1;border-top:1.5px solid #111;padding-top:5px;font-size:10.5px;color:#555}
  /* ── page breaks ── */
  .copy{page-break-after:always}
  .copy:last-child{page-break-after:auto}
  .pb{page-break-before:always}
  .copytag{float:right;font-size:10px;border:1px solid #333;padding:2px 8px;border-radius:3px}
  /* ── PIN card ── */
  .pin-card{display:inline-block;border:2px solid #111;border-radius:6px;padding:10px 16px;
            margin:6px 4px;text-align:center;min-width:100px;page-break-inside:avoid}
  .pin-card .pname{font-size:13px;font-weight:700}
  .pin-card .pletter{font-size:20px;font-weight:800;font-variant-numeric:tabular-nums;
                     font-family:monospace;letter-spacing:.1em;margin:4px 0}
  .pin-card .psess{font-size:9px;color:#666;margin-top:2px}
  /* ── toolbar ── */
  .toolbar{position:sticky;top:0;background:#fff;border-bottom:1px solid #ddd;
           padding:8px 12px;display:flex;gap:8px;align-items:center;z-index:99}
  .toolbar button{padding:7px 16px;font-size:12px;cursor:pointer;border-radius:4px;
                  border:1px solid #888;background:#f5f5f5;font-weight:600}
  .toolbar button:hover{background:#eee}
  .toolbar .spacer{flex:1}
  @media print{.toolbar{display:none}}
  .muted{color:#777;font-size:10.5px}
  /* ── recalled highlight ── */
  tr.recalled td{background:#f0fff4 !important}
  tr.dropped td{color:#aaa}
  tr.dq td{background:#fff0f0 !important;color:#888;text-decoration:line-through}
</style></head><body>
<div class="toolbar">
  <button onclick="window.print()">🖨 Print / PDF</button>
  <span class="spacer"></span>
  <span style="font-size:11px;color:#888">telemark.one</span>
</div>
<div class="doc">
${opts.noHeader ? '' : `
<div class="head">
  <div>
    <div class="ttl">${esc(c.name || 'Competition')}</div>
    <div class="sub">${esc(c.location||'')}${c.event_date?' · '+esc(c.event_date):''}</div>
  </div>
  <div class="meta"><strong>${esc(title)}</strong>Printed: ${new Date().toLocaleString()}</div>
</div>
`}
${bodyHtml}
</div></body></html>`;
}

/* ─── 3.1 couples / start list ─────────────────────────────────────── */
function couplesList(db, categoryId) {
  const c = comp(db);
  const cat = db.prepare('SELECT * FROM category WHERE id=?').get(categoryId);
  const rows = db.prepare(
    `SELECT start_number, name1, name2, studio_name, status, disqualified
     FROM entry WHERE category_id=? ORDER BY start_number NULLS LAST, name1`
  ).all(categoryId);
  const active = rows.filter(e => e.status !== 'withdrawn').length;
  const body = `
<h2>${esc(cat.name)} — Start List (${active} active / ${rows.length} total)</h2>
<table>
  <thead><tr>
    <th class="n">No.</th><th>Partner 1</th><th>Partner 2</th>
    <th>Studio</th><th>Status</th>
  </tr></thead>
  <tbody>
    ${rows.map(e => `<tr class="${e.disqualified?'dq':e.status==='withdrawn'?'dropped':''}">
      <td class="n">${e.start_number??'—'}</td>
      <td>${esc(e.name1)}</td>
      <td>${esc(e.name2||'—')}</td>
      <td>${esc(e.studio_name||'')}</td>
      <td><span class="pill ${e.disqualified?'pill-danger':e.status==='active'?'pill-ok':'pill-muted'}">${e.disqualified?'DQ':esc(e.status)}</span></td>
    </tr>`).join('')}
  </tbody>
</table>
<div class="sign">
  <div class="line">Scrutineer</div>
  <div class="line">Chairman</div>
  <div class="line">Date / Time</div>
</div>`;
  return page(`Start List — ${cat.name}`, c, body);
}

/* ─── 3.2 round draw by heat ─────────────────────────────────────────── */
function roundDraw(db, roundId) {
  const c = comp(db);
  const round = db.prepare('SELECT * FROM round WHERE id=?').get(roundId);
  const cat   = db.prepare('SELECT * FROM category WHERE id=?').get(round.category_id);
  const dances = db.prepare('SELECT * FROM round_dance WHERE round_id=? ORDER BY dance_order').all(roundId);
  let body = `<h2>${esc(cat.name)} — Round ${round.ordinal} · ${roundLabel(round.kind)} · Draw by Heat</h2>`;
  for (const rd of dances) {
    const rows = db.prepare(
      `SELECT he.heat_number, e.start_number, e.name1, e.name2, e.studio_name
       FROM heat_entry he JOIN entry e ON e.id=he.entry_id
       WHERE he.round_dance_id=? ORDER BY he.heat_number, e.start_number`
    ).all(rd.id);
    const heats = {};
    rows.forEach(r => (heats[r.heat_number]||=[]).push(r));
    body += `<h3>${dname(rd.dance_code)}</h3>
    <table><thead><tr><th class="n">Heat</th><th class="n">No.</th><th>Partner 1</th><th>Partner 2</th><th>Studio</th></tr></thead><tbody>`;
    for (const [h, entries] of Object.entries(heats)) {
      entries.forEach((e, i) => {
        body += `<tr>
          ${i===0?`<td class="n" rowspan="${entries.length}"><b>H${h}</b></td>`:''}
          <td class="n">${e.start_number}</td>
          <td>${esc(e.name1)}</td><td>${esc(e.name2||'—')}</td>
          <td>${esc(e.studio_name||'')}</td>
        </tr>`;
      });
    }
    body += `</tbody></table>`;
  }
  body += `<div class="sign"><div class="line">Scrutineer</div><div class="line">Chairman</div></div>`;
  return page(`Draw — ${cat.name} R${round.ordinal}`, c, body);
}

/* ─── draw ordered by couple ─────────────────────────────────────────── */
function roundDrawByCouple(db, roundId) {
  const c = comp(db);
  const round  = db.prepare('SELECT * FROM round WHERE id=?').get(roundId);
  const cat    = db.prepare('SELECT * FROM category WHERE id=?').get(round.category_id);
  const dances = db.prepare('SELECT * FROM round_dance WHERE round_id=? ORDER BY dance_order').all(roundId);
  const entries = db.prepare(
    `SELECT DISTINCT e.id, e.start_number, e.name1, e.name2, e.studio_name
     FROM heat_entry he JOIN round_dance rd ON rd.id=he.round_dance_id
     JOIN entry e ON e.id=he.entry_id WHERE rd.round_id=? ORDER BY e.start_number`
  ).all(roundId);
  const heatMap = {};
  const heatStmt = db.prepare(
    `SELECT he.heat_number, rd.dance_code FROM heat_entry he
     JOIN round_dance rd ON rd.id=he.round_dance_id WHERE rd.round_id=? AND he.entry_id=?`
  );
  for (const e of entries) {
    heatMap[e.id] = {};
    for (const r of heatStmt.all(roundId, e.id)) heatMap[e.id][r.dance_code] = r.heat_number;
  }
  const danceHeaders = dances.map(d=>`<th class="n">${esc(d.dance_code)}</th>`).join('');
  const rowsHtml = entries.map(e => {
    const cells = dances.map(d => {
      const h = heatMap[e.id][d.dance_code];
      return `<td class="n">${h?`H${h}`:'—'}</td>`;
    }).join('');
    return `<tr><td class="n">${e.start_number}</td><td>${esc(e.name1)}</td><td>${esc(e.name2||'—')}</td><td>${esc(e.studio_name||'')}</td>${cells}</tr>`;
  }).join('');
  const body = `
<h2>${esc(cat.name)} — Round ${round.ordinal} · ${roundLabel(round.kind)} · Draw by Couple</h2>
<table><thead><tr>
  <th class="n">No.</th><th>Partner 1</th><th>Partner 2</th><th>Studio</th>${danceHeaders}
</tr></thead><tbody>${rowsHtml}</tbody></table>
<div class="sign"><div class="line">Scrutineer</div><div class="line">Chairman</div></div>`;
  return page(`Draw by Couple — ${cat.name} R${round.ordinal}`, c, body, { landscape: dances.length > 3 });
}

/* ─── blank judging sheet ─────────────────────────────────────────────── */
function judgingSheet(db, roundId, officialId) {
  const c    = comp(db);
  const round = db.prepare('SELECT * FROM round WHERE id=?').get(roundId);
  const cat   = db.prepare('SELECT * FROM category WHERE id=?').get(round.category_id);
  const judge = db.prepare('SELECT * FROM official WHERE id=?').get(officialId);
  const dances = db.prepare('SELECT * FROM round_dance WHERE round_id=? ORDER BY dance_order').all(roundId);
  const entries = db.prepare(
    `SELECT DISTINCT e.start_number, e.name1, e.name2 FROM heat_entry he
     JOIN round_dance rd ON rd.id=he.round_dance_id JOIN entry e ON e.id=he.entry_id
     WHERE rd.round_id=? ORDER BY e.start_number`
  ).all(roundId);
  const isFinal = round.kind === 'final';
  const cols = dances.map(d=>`<th class="n">${esc(d.dance_code)}</th>`).join('');
  const note = isFinal ? 'Place (1…N) in each dance' : 'X = recall, − = no';
  const body = `
<h2>${esc(cat.name)} · Round ${round.ordinal} · ${roundLabel(round.kind)}
   — Judge ${esc(judge.judge_letter||'')} · ${esc(judge.full_name)}</h2>
<p class="muted">${note} &nbsp;|&nbsp; Recalls required: ${round.recall_count??'—'}</p>
<table><thead><tr>
  <th class="n">No.</th><th>Partner 1</th><th>Partner 2</th>${cols}<th>Remarks</th>
</tr></thead><tbody>
${entries.map(e=>`<tr>
  <td class="n">${e.start_number}</td>
  <td>${esc(e.name1)}</td><td>${esc(e.name2||'')}</td>
  ${dances.map(()=>'<td class="n" style="min-width:28px">&nbsp;</td>').join('')}
  <td style="min-width:60px"></td>
</tr>`).join('')}
</tbody></table>
<div class="sign">
  <div class="line">Signature — Judge ${esc(judge.judge_letter||'')} · ${esc(judge.full_name)}</div>
  <div class="line">Date / Time</div>
</div>`;
  return page(`Judging Sheet — Judge ${judge.judge_letter||''}`, c, body);
}

/* ─── 3.14 checksum report (3 copies) ───────────────────────────────── */
function checksumReport(db, roundId, copies = 3) {
  const c = comp(db);
  const round  = db.prepare('SELECT * FROM round WHERE id=?').get(roundId);
  const cat    = db.prepare('SELECT * FROM category WHERE id=?').get(round.category_id);
  const dances = db.prepare('SELECT * FROM round_dance WHERE round_id=? ORDER BY dance_order').all(roundId);
  let judges = db.prepare(
    `SELECT o.id, o.judge_letter, o.full_name FROM category_judge cj
     JOIN official o ON o.id=cj.official_id
     WHERE cj.category_id=? AND o.role='judge' ORDER BY o.judge_letter`
  ).all(cat.id);
  if (!judges.length)
    judges = db.prepare("SELECT id, judge_letter, full_name FROM official WHERE competition_id=? AND role='judge' ORDER BY judge_letter").all(cat.competition_id);
  if (round.active_judges_limit) judges = judges.slice(0, round.active_judges_limit);
  const csOf = db.prepare('SELECT value, signed_at FROM checksum WHERE round_dance_id=? AND official_id=?');
  const header = `<tr><th>Judge</th>${dances.map(d=>`<th class="n">${esc(d.dance_code)}</th>`).join('')}<th>Signed</th></tr>`;
  const rows = judges.map(j => {
    const cells = dances.map(d => {
      const cs = csOf.get(d.id, j.id);
      return `<td class="c" style="font-family:monospace;font-size:10px">${cs ? esc(cs.value) : '—'}</td>`;
    }).join('');
    const cs0 = csOf.get(dances[0]?.id, j.id);
    return `<tr><td>${esc(j.judge_letter||'')} · ${esc(j.full_name)}</td>${cells}<td>${cs0?.signed_at||''}</td></tr>`;
  }).join('');
  const oneCopy = (tag) => `<div class="copy">
    <span class="copytag">Copy ${tag}</span>
    <h2>${esc(cat.name)} — Round ${round.ordinal} · ${roundLabel(round.kind)} · Scoring Checksum</h2>
    <table><thead>${header}</thead><tbody>${rows}</tbody></table>
    <div class="sign">
      <div class="line">Scrutineer signature</div>
      <div class="line">Chairman signature</div>
      <div class="line">Date</div>
    </div></div>`;
  let body = '';
  for (let i = 1; i <= copies; i++) body += oneCopy(`${i}/${copies}`);
  return page(`Checksum — ${cat.name} R${round.ordinal}`, c, body);
}

/* ─── 3.12 final results + skating table ────────────────────────────── */
function resultsSkating(db, roundId) {
  const c = comp(db);
  const round  = db.prepare('SELECT * FROM round WHERE id=?').get(roundId);
  const cat    = db.prepare('SELECT * FROM category WHERE id=?').get(round.category_id);
  const dances = db.prepare('SELECT * FROM round_dance WHERE round_id=? ORDER BY dance_order').all(roundId);
  let judges = db.prepare(
    `SELECT o.id, o.judge_letter FROM category_judge cj
     JOIN official o ON o.id=cj.official_id
     WHERE cj.category_id=? AND o.role='judge' ORDER BY o.judge_letter`
  ).all(cat.id);
  if (!judges.length)
    judges = db.prepare("SELECT id, judge_letter FROM official WHERE competition_id=? AND role='judge' ORDER BY judge_letter").all(cat.competition_id);
  if (round.active_judges_limit) judges = judges.slice(0, round.active_judges_limit);
  const entries = db.prepare(
    `SELECT DISTINCT e.id, e.start_number, e.name1, e.name2, e.disqualified
     FROM heat_entry he JOIN round_dance rd ON rd.id=he.round_dance_id JOIN entry e ON e.id=he.entry_id
     WHERE rd.round_id=? ORDER BY e.start_number`
  ).all(roundId);

  // JS 3.0
  if (cat.judging_system === 'js3.0') {
    const markStmt = db.prepare('SELECT score_tq,score_mm,score_ps,score_cp FROM mark WHERE round_dance_id=? AND official_id=? AND entry_id=?');
    const couplesPoints = entries.map(e => ({ id: e.id, total: 0 }));
    const danceDetails = {};
    for (const rd of dances) {
      for (const e of entries) {
        const sums = {tq:0,mm:0,ps:0,cp:0}, counts = {tq:0,mm:0,ps:0,cp:0};
        for (const j of judges) {
          const m = markStmt.get(rd.id, j.id, e.id);
          if (m) { for (const k of ['tq','mm','ps','cp']) if (m[`score_${k}`]!=null) { sums[k]+=m[`score_${k}`]; counts[k]++; } }
        }
        const tq=counts.tq?sums.tq/counts.tq:0, mm=counts.mm?sums.mm/counts.mm:0,
              ps=counts.ps?sums.ps/counts.ps:0, cp=counts.cp?sums.cp/counts.cp:0;
        const dt = tq+mm+ps+cp;
        couplesPoints.find(cp=>cp.id===e.id).total += dt;
        if (!danceDetails[e.id]) danceDetails[e.id]={};
        danceDetails[e.id][rd.dance_code]={tq,mm,ps,cp,total:dt};
      }
    }
    const finalPlacings = skating.placePointsFinal(couplesPoints);
    const numById = new Map(entries.map(e=>[e.id,e]));
    let rows = '';
    for (const f of finalPlacings) {
      const e = numById.get(f.id);
      for (let i=0; i<dances.length; i++) {
        const d = dances[i]; const det = danceDetails[f.id][d.dance_code];
        const rs = i===0?` rowspan="${dances.length}"`:'';
        rows += `<tr class="${e.disqualified?'dq':''}">
          ${i===0?`<td class="n"${rs}><b>${f.place}${f.tie?'=':''}</b></td>`:''}
          ${i===0?`<td class="n"${rs}>${e.start_number}</td>`:''}
          ${i===0?`<td${rs}>${esc(e.name1)}<br><small>${esc(e.name2||'')}</small></td>`:''}
          <td class="n">${esc(d.dance_code)}</td>
          <td class="n">${det.tq.toFixed(2)}</td><td class="n">${det.mm.toFixed(2)}</td>
          <td class="n">${det.ps.toFixed(2)}</td><td class="n">${det.cp.toFixed(2)}</td>
          <td class="n">${det.total.toFixed(2)}</td>
          ${i===0?`<td class="n"${rs}><b>${f.total.toFixed(2)}</b></td>`:''}
        </tr>`;
      }
    }
    const body = `
<h2>${esc(cat.name)} — Final Results · JS 3.0 Component Scoring</h2>
<table><thead><tr>
  <th class="n">Pl.</th><th class="n">No.</th><th>Couple</th><th class="n">Dance</th>
  <th class="n">TQ</th><th class="n">MM</th><th class="n">PS</th><th class="n">CP</th>
  <th class="n">Dance</th><th class="n">Total</th>
</tr></thead><tbody>${rows}</tbody></table>
<p class="muted">TQ: Technical Quality · MM: Movement to Music · PS: Partnering Skills · CP: Choreography &amp; Presentation</p>
<div class="sign"><div class="line">Scrutineer</div><div class="line">Chairman</div></div>`;
    return page(`Results — ${cat.name}`, c, body, { landscape: true });
  }

  // Skating system
  const markOf = db.prepare('SELECT place FROM mark WHERE round_dance_id=? AND official_id=? AND entry_id=?');
  const engine = dances.map(rd => ({
    name: rd.dance_code,
    couples: entries.map(e => ({
      id: e.id,
      marks: judges.map(j => { const m = markOf.get(rd.id,j.id,e.id); return m?.place??entries.length; }),
    })),
  }));
  const { final, perDance } = skating.placeMultiDanceFinal(engine);
  const numById = new Map(entries.map(e=>[e.id,e]));
  const placeInDance = {};
  perDance.forEach(d => { placeInDance[d.name]={};  d.placing.forEach(p=>(placeInDance[d.name][p.id]=p.place)); });

  // Judge letters header
  const judgeLetterCols = judges.map(j=>`<th class="n" style="font-size:9px">${esc(j.judge_letter||'?')}</th>`).join('');
  // Mark detail per dance
  const markDetail = dances.map(rd => {
    return entries.map(e => {
      const jMarks = judges.map(j=>{ const m=markOf.get(rd.id,j.id,e.id); return m?.place??null; });
      return { entryId: e.id, dance: rd.dance_code, jMarks, place: placeInDance[rd.dance_code][e.id] };
    });
  });

  const danceCols = dances.map(d=>`<th class="n">${esc(d.dance_code)}</th>`).join('');
  const rows = final.map(f => {
    const e = numById.get(f.id);
    const cells = dances.map(d=>`<td class="n">${placeInDance[d.dance_code][f.id]??''}</td>`).join('');
    return `<tr class="${e.disqualified?'dq':''}">
      <td class="n"><b>${f.place}${f.tie?'=':''}</b></td>
      <td class="n">${e.start_number}</td>
      <td>${esc(e.name1)}<br><small style="color:#888">${esc(e.name2||'')}</small></td>
      ${cells}
      <td class="n"><b>${f.total}</b></td>
      ${e.disqualified?'<td><span class="pill pill-danger">DQ</span></td>':'<td></td>'}
    </tr>`;
  }).join('');

  // Detailed Judge Placings per Dance
  let detailedTablesHtml = '';
  if (dances.length > 0) {
    let tablesContent = '';
    for (const rd of dances) {
      let tableRows = '';
      const sortedEntries = [...entries].sort((a, b) => a.start_number - b.start_number);
      for (const e of sortedEntries) {
        let judgeCells = '';
        for (const j of judges) {
          const m = markOf.get(rd.id, j.id, e.id);
          const placeVal = m ? m.place : '—';
          judgeCells += `<td class="n">${placeVal}</td>`;
        }
        const calcPlace = placeInDance[rd.dance_code][e.id] ?? '—';
        tableRows += `<tr class="${e.disqualified ? 'dq' : ''}">
          <td class="n"><b>${e.start_number}</b></td>
          ${judgeCells}
          <td class="n" style="font-weight:700; background:#f0f0f0">${calcPlace}</td>
        </tr>`;
      }
      
      const judgeHeaders = judges.map(j => `<th class="n" style="font-size:9px">${esc(j.judge_letter || '?')}</th>`).join('');
      
      tablesContent += `
        <div style="flex:1 1 200px; min-width:180px; max-width: 320px; page-break-inside:avoid; margin-bottom:12px;">
          <h3 style="margin:4px 0; text-align:center; font-size:11px;">${esc(dname(rd.dance_code))}</h3>
          <table style="margin-bottom:0">
            <thead>
              <tr>
                <th class="n">No.</th>
                ${judgeHeaders}
                <th class="n" style="background:#555">Pl.</th>
              </tr>
            </thead>
            <tbody>
              ${tableRows}
            </tbody>
          </table>
        </div>
      `;
    }
    
    detailedTablesHtml = `
      <h2>Detailed Judge Placings</h2>
      <div style="display:flex; flex-wrap:wrap; gap:16px; margin-top:8px; margin-bottom:16px;">
        ${tablesContent}
      </div>
    `;
  }

  const body = `
<h2>${esc(cat.name)} — Final Results · Skating System</h2>
<table><thead><tr>
  <th class="n">Pl.</th><th class="n">No.</th><th>Couple</th>${danceCols}<th class="n">Sum</th><th></th>
</tr></thead><tbody>${rows}</tbody></table>
${detailedTablesHtml}
<p class="muted">Judged by: ${judges.map(j=>`${j.judge_letter}: ${j.full_name??''}`).join(' · ')}</p>
<p class="muted">Skating Rules 1–4 per dance; Rules 5–11 for final (lowest sum, ties by majority).</p>
<div class="sign"><div class="line">Scrutineer</div><div class="line">Chairman</div></div>`;
  return page(`Results — ${cat.name}`, c, body, { landscape: dances.length > 3 });
}

/* ─── qualification round results (crosses) ─────────────────────────── */
function resultsQualification(db, roundId) {
  const c = comp(db);
  const round  = db.prepare('SELECT * FROM round WHERE id=?').get(roundId);
  const cat    = db.prepare('SELECT * FROM category WHERE id=?').get(round.category_id);
  const dances = db.prepare('SELECT * FROM round_dance WHERE round_id=? ORDER BY dance_order').all(roundId);
  let judges = db.prepare(
    `SELECT o.id, o.judge_letter, o.full_name FROM category_judge cj
     JOIN official o ON o.id=cj.official_id
     WHERE cj.category_id=? AND o.role='judge' ORDER BY o.judge_letter`
  ).all(cat.id);
  if (!judges.length)
    judges = db.prepare("SELECT id, judge_letter, full_name FROM official WHERE competition_id=? AND role='judge' ORDER BY judge_letter").all(cat.competition_id);
  if (round.active_judges_limit) judges = judges.slice(0, round.active_judges_limit);

  const entries = db.prepare(
    `SELECT DISTINCT e.id, e.start_number, e.name1, e.name2, e.disqualified
     FROM heat_entry he JOIN round_dance rd ON rd.id=he.round_dance_id JOIN entry e ON e.id=he.entry_id
     WHERE rd.round_id=? ORDER BY e.start_number`
  ).all(roundId);

  const markStmt = db.prepare('SELECT cross_mark FROM mark WHERE round_dance_id=? AND official_id=? AND entry_id=?');
  const rrStmt   = db.prepare('SELECT crosses, recalled FROM recall_result WHERE round_id=? AND entry_id=?');

  const rows = entries.map(e => {
    let totalCrosses = 0;
    const danceMarks = {}, danceSums = {};
    for (const rd of dances) {
      danceMarks[rd.dance_code] = {};
      let dsum = 0;
      for (const j of judges) {
        const m = markStmt.get(rd.id, j.id, e.id);
        const cross = m?.cross_mark === 1;
        danceMarks[rd.dance_code][j.id] = cross;
        if (cross) dsum++;
      }
      danceSums[rd.dance_code] = dsum;
      totalCrosses += dsum;
    }
    const rr = rrStmt.get(roundId, e.id);
    return {
      id: e.id, number: e.start_number, name1: e.name1, name2: e.name2,
      dq: !!e.disqualified, danceMarks, danceSums,
      crosses: rr ? rr.crosses : totalCrosses,
      recalled: rr ? rr.recalled === 1 : false,
    };
  }).sort((a, b) => b.crosses - a.crosses);

  // rank
  let rank = 1;
  rows.forEach((s, i) => {
    if (i > 0 && s.crosses !== rows[i-1].crosses) rank = i + 1;
    s.rank = rank;
  });
  const counts = {};
  rows.forEach(s => (counts[s.rank] = (counts[s.rank]||0)+1));
  rows.forEach(s => (s.tie = counts[s.rank] > 1));

  // header: dance | j1 j2 j3 | Σ
  let th1 = `<tr><th rowspan="2" class="n">Rk</th><th rowspan="2" class="n">No.</th><th rowspan="2">Partner 1</th><th rowspan="2">Partner 2</th>`;
  let th2 = `<tr>`;
  for (const rd of dances) {
    th1 += `<th colspan="${judges.length+1}" class="c" style="background:#333">${esc(rd.dance_code)}</th>`;
    for (const j of judges) th2 += `<th class="n" style="font-size:9px">${esc(j.judge_letter||'?')}</th>`;
    th2 += `<th class="n" style="font-weight:700;background:#555;color:#fff">Σ</th>`;
  }
  th1 += `<th rowspan="2" class="n" style="background:#111">Total</th><th rowspan="2"></th></tr>`;
  th2 += `</tr>`;

  const rowsHtml = rows.map(s => {
    let cells = '';
    for (const rd of dances) {
      for (const j of judges) {
        const x = s.danceMarks[rd.dance_code][j.id];
        cells += `<td class="c" style="font-weight:800;color:${x?'#0a6638':'#ddd'}">${x?'✕':'·'}</td>`;
      }
      cells += `<td class="n" style="font-weight:700;background:#f5f5f5">${s.danceSums[rd.dance_code]}</td>`;
    }
    return `<tr class="${s.dq?'dq':s.recalled?'recalled':'dropped'}">
      <td class="n"><b>${s.rank}${s.tie?'=':''}</b></td>
      <td class="n">${s.number}</td>
      <td>${esc(s.name1)}</td><td>${esc(s.name2||'—')}</td>
      ${cells}
      <td class="n" style="font-weight:800">${s.crosses}</td>
      <td><span class="pill ${s.dq?'pill-danger':s.recalled?'pill-ok':'pill-muted'}">${s.dq?'DQ':s.recalled?'Recalled':'Dropped'}</span></td>
    </tr>`;
  }).join('');

  const body = `
<h2>${esc(cat.name)} — Round ${round.ordinal} · ${roundLabel(round.kind)} · Results</h2>
<p class="muted">Recalls required: <b>${round.recall_count??'—'}</b> &nbsp;|&nbsp;
  Judges: ${judges.map(j=>`${j.judge_letter}: ${j.full_name}`).join(', ')}</p>
<table style="font-size:10.5px">
  <thead>${th1}${th2}</thead>
  <tbody>${rowsHtml}</tbody>
</table>
<p class="muted" style="margin-top:4px">✕ = Recall mark &nbsp;·&nbsp; · = No recall &nbsp;·&nbsp; Green rows = recalled</p>
<div class="sign"><div class="line">Scrutineer</div><div class="line">Chairman</div></div>`;
  return page(`Results — ${cat.name} R${round.ordinal}`, c, body, { landscape: true });
}

/* ─── 3.10 officials list ─────────────────────────────────────────────── */
function officialsList(db) {
  const c = comp(db);
  if (!c.id) return page('Officials', c, '<p>No competition loaded.</p>');
  const rows = db.prepare(
    'SELECT full_name, role, judge_letter, studio_name FROM official WHERE competition_id=? ORDER BY role DESC, judge_letter NULLS LAST'
  ).all(c.id);
  const body = `
<h2>Officials List</h2>
<table><thead><tr><th class="n">#</th><th>Full Name</th><th>Role</th><th>Studio</th></tr></thead><tbody>
${rows.map(o=>`<tr>
  <td class="n">${esc(o.judge_letter||'')}</td>
  <td><b>${esc(o.full_name)}</b></td>
  <td><span class="pill pill-muted">${esc(o.role)}</span></td>
  <td>${esc(o.studio_name||'')}</td>
</tr>`).join('')}
</tbody></table>
<div class="sign"><div class="line">Scrutineer</div><div class="line">Chairman</div></div>`;
  return page('Officials List', c, body);
}

/* ─── 5.11 missing / excused ─────────────────────────────────────────── */
function missingList(db) {
  const c = comp(db);
  if (!c.id) return page('Missing', c, '<p>No competition loaded.</p>');
  const rows = db.prepare(
    `SELECT e.start_number, e.name1, e.name2, e.status, cat.name AS category, cat.session_number
     FROM entry e JOIN category cat ON cat.id=e.category_id
     WHERE e.competition_id=? AND e.status IN ('missing','excused')
     ORDER BY cat.session_number, cat.category_order, e.start_number`
  ).all(c.id);
  const body = `
<h2>Missing / Excused Couples (${rows.length})</h2>
<table><thead><tr><th class="n">No.</th><th>Partner 1</th><th>Partner 2</th><th>Category</th><th class="n">Session</th><th>Status</th></tr></thead>
<tbody>${rows.map(e=>`<tr>
  <td class="n">${e.start_number}</td>
  <td>${esc(e.name1)}</td><td>${esc(e.name2||'—')}</td>
  <td>${esc(e.category)}</td>
  <td class="n">${e.session_number||1}</td>
  <td><span class="pill pill-warn">${esc(e.status)}</span></td>
</tr>`).join('') || '<tr><td colspan="6" class="muted" style="text-align:center">None</td></tr>'}
</tbody></table>`;
  return page('Missing / Excused', c, body);
}

/* ─── Dropped out list ────────────────────────────────────────────────── */
function droppedOutList(db, roundId) {
  const c = comp(db);
  const round = db.prepare('SELECT * FROM round WHERE id=?').get(roundId);
  const cat   = db.prepare('SELECT * FROM category WHERE id=?').get(round.category_id);
  const entries = db.prepare(
    `SELECT DISTINCT e.id, e.start_number, e.name1, e.name2 FROM heat_entry he
     JOIN round_dance rd ON rd.id=he.round_dance_id JOIN entry e ON e.id=he.entry_id
     WHERE rd.round_id=? ORDER BY e.start_number`
  ).all(roundId);
  const rrStmt = db.prepare('SELECT crosses, recalled FROM recall_result WHERE round_id=? AND entry_id=?');
  const rows = entries.map(e => {
    const rr = rrStmt.get(roundId, e.id);
    return { number: e.start_number, name1: e.name1, name2: e.name2, crosses: rr?.crosses??0, recalled: rr?.recalled===1 };
  }).sort((a,b)=>b.crosses-a.crosses);
  let rank=1;
  rows.forEach((s,i)=>{ if(i>0&&s.crosses!==rows[i-1].crosses) rank=i+1; s.place=rank; });
  const counts={}; rows.forEach(s=>(counts[s.place]=(counts[s.place]||0)+1));
  rows.forEach(s=>(s.tie=counts[s.place]>1));
  const dropped = rows.filter(s=>!s.recalled);
  const body = `
<h2>${esc(cat.name)} — Round ${round.ordinal} · ${roundLabel(round.kind)} · Dropped Couples</h2>
<table><thead><tr><th class="n">Pl.</th><th class="n">No.</th><th>Partner 1</th><th>Partner 2</th><th class="n">Crosses</th></tr></thead>
<tbody>${dropped.map(s=>`<tr class="dropped">
  <td class="n">${s.place}${s.tie?'=':''}</td>
  <td class="n">${s.number}</td>
  <td>${esc(s.name1)}</td><td>${esc(s.name2||'—')}</td>
  <td class="n">${s.crosses}</td>
</tr>`).join('')||'<tr><td colspan="5" class="muted" style="text-align:center">All couples recalled.</td></tr>'}
</tbody></table>`;
  return page(`Dropped — ${cat.name} R${round.ordinal}`, c, body);
}

/* ─── NEW: Judge PIN sheet (per session) ─────────────────────────────── */
function judgesPinSheet(db, sessionNumber, host) {
  const c = comp(db);
  if (!c.id) return page('Judge PINs', c, '<p>No competition loaded.</p>');
  // Get all judges for the competition
  const judges = db.prepare(
    `SELECT o.id, o.full_name, o.judge_letter, o.pin_hash AS pin, o.studio_name
     FROM official o WHERE o.competition_id=? AND o.role IN ('judge','chairman')
     ORDER BY o.role DESC, o.judge_letter NULLS LAST`
  ).all(c.id);

  // If sessionNumber specified, filter to judges assigned to that session
  let filteredJudges = judges;
  if (sessionNumber != null) {
    const catIds = db.prepare(
      'SELECT id FROM category WHERE competition_id=? AND session_number=?'
    ).all(c.id, sessionNumber).map(r=>r.id);
    if (catIds.length) {
      const assignedIds = new Set(
        db.prepare(`SELECT DISTINCT official_id FROM category_judge WHERE category_id IN (${catIds.map(()=>'?').join(',')})`).all(...catIds).map(r=>r.official_id)
      );
      filteredJudges = judges.filter(j => assignedIds.has(j.id) || j.role === 'chairman');
    }
  }

  const sessionLabel = sessionNumber != null ? `Session ${sessionNumber}` : 'All Sessions';
  const cards = filteredJudges.map(j => {
    const protocol = (host && (host.includes('localhost') || host.includes('192.168.') || host.includes('10.') || host.includes('172.') || host.includes('127.0.0.1'))) ? 'http' : 'https';
    const finalHost = host || 'telemark.one';
    const qrUrl = `${protocol}://${finalHost}/judge.html?pin=${j.pin}`;
    const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=80x80&data=${encodeURIComponent(qrUrl)}`;

    return `
    <div class="pin-card" style="min-width:140px; padding:10px 12px">
      <div class="pletter">${esc(j.judge_letter||'CH')}</div>
      <div class="pname" style="min-height:36px; display:flex; align-items:center; justify-content:center">${esc(j.full_name)}</div>
      <div style="font-size:22px;font-weight:900;font-family:monospace;letter-spacing:.15em;
                  margin:4px 0;border:2px dashed #ccc;padding:2px 6px;border-radius:4px">
        ${esc(j.pin||'????')}
      </div>
      <div style="display:flex; justify-content:center; margin-top:6px">
        <img src="${qrSrc}" width="80" height="80" style="border:1px solid #eee; padding:2px; border-radius:4px" alt="Login QR" />
      </div>
      <div class="psess" style="margin-top:6px">${esc(j.studio_name||'')}</div>
    </div>`;
  }).join('');

  // Also a printable table version
  const tableRows = filteredJudges.map(j=>`<tr>
    <td class="n">${esc(j.judge_letter||'CH')}</td>
    <td><b>${esc(j.full_name)}</b></td>
    <td>${esc(j.studio_name||'')}</td>
    <td class="c" style="font-family:monospace;font-size:16px;font-weight:900;letter-spacing:.15em">${esc(j.pin||'????')}</td>
  </tr>`).join('');

  const body = `
<h2>Judge PINs — ${sessionLabel}</h2>
<p class="muted" style="margin-bottom:16px">⚠ CONFIDENTIAL — distribute individually in sealed envelopes</p>
<div style="margin-bottom:24px">${cards}</div>
<hr style="border:1px solid #eee;margin:20px 0">
<h2>PIN Table (for scrutineer reference)</h2>
<table><thead><tr><th class="n">#</th><th>Full Name</th><th>Studio</th><th class="c">PIN</th></tr></thead>
<tbody>${tableRows}</tbody></table>
<div class="sign">
  <div class="line">Scrutineer (keep sealed)</div>
  <div class="line">Chairman (keep sealed)</div>
</div>`;
  return page(`Judge PINs — ${sessionLabel}`, c, body);
}

/* ─── NEW: Judges by session (categories they judge) ─────────────────── */
function judgesSessionSheet(db, sessionNumber) {
  const c = comp(db);
  if (!c.id) return page('Judges by Session', c, '<p>No competition loaded.</p>');

  // Get all sessions
  const sessions = sessionNumber != null
    ? [sessionNumber]
    : [...new Set(db.prepare('SELECT DISTINCT session_number FROM category WHERE competition_id=? ORDER BY session_number').all(c.id).map(r=>r.session_number))];

  let body = '';
  for (const sess of sessions) {
    const cats = db.prepare(
      `SELECT id, name, session_time, category_order FROM category
       WHERE competition_id=? AND session_number=? ORDER BY category_order, name`
    ).all(c.id, sess);

    body += `<h2>Session ${sess}${cats[0]?.session_time?' · '+cats[0].session_time:''}</h2>`;

    // All judges assigned to any category in this session
    const catIds = cats.map(c=>c.id);
    if (!catIds.length) { body += '<p class="muted">No categories.</p>'; continue; }

    const assignedJudges = db.prepare(
      `SELECT DISTINCT o.id, o.full_name, o.judge_letter, o.studio_name
       FROM official o JOIN category_judge cj ON cj.official_id=o.id
       WHERE cj.category_id IN (${catIds.map(()=>'?').join(',')}) AND o.role='judge'
       ORDER BY o.judge_letter`
    ).all(...catIds);

    // Build matrix: judge × category
    const cjStmt = db.prepare('SELECT official_id FROM category_judge WHERE category_id=?');
    const matrix = cats.map(cat => {
      const assigned = new Set(cjStmt.all(cat.id).map(r=>r.official_id));
      return { cat, assigned };
    });

    const catHeaders = cats.map(cat=>`<th style="font-size:9px;max-width:80px;word-break:break-word">${esc(cat.name)}</th>`).join('');
    const rows = assignedJudges.map(j => {
      const cells = matrix.map(({assigned})=>`<td class="c">${assigned.has(j.id)?'✓':''}</td>`).join('');
      return `<tr><td class="n"><b>${esc(j.judge_letter||'')}</b></td><td>${esc(j.full_name)}</td><td>${esc(j.studio_name||'')}</td>${cells}</tr>`;
    }).join('');

    body += `<table><thead><tr>
      <th class="n">#</th><th>Full Name</th><th>Studio</th>${catHeaders}
    </tr></thead><tbody>${rows||'<tr><td colspan="100" class="muted">No judge assignments.</td></tr>'}</tbody></table>`;
  }

  body += `<div class="sign"><div class="line">Scrutineer</div><div class="line">Chairman</div></div>`;
  return page(`Judges by Session`, c, body, { landscape: true });
}

/* ─── NEW: All rounds summary for a category ─────────────────────────── */
function resultsAllRounds(db, categoryId) {
  const c = comp(db);
  const cat    = db.prepare('SELECT * FROM category WHERE id=?').get(categoryId);
  const rounds = db.prepare('SELECT * FROM round WHERE category_id=? ORDER BY ordinal').all(categoryId);
  if (!rounds.length) return page(`Results — ${cat?.name}`, c, '<p>No rounds yet.</p>');

  let body = `<h2>${esc(cat.name)} — Complete Results (All Rounds)</h2>`;

  for (const round of rounds) {
    body += `<h3>Round ${round.ordinal} · ${roundLabel(round.kind)} · <span style="color:#777;font-weight:400">Status: ${round.status}</span></h3>`;
    if (round.kind === 'final') {
      const rows = db.prepare(
        `SELECT p.place, p.tie, e.start_number, e.name1, e.name2, e.disqualified
         FROM placing p JOIN entry e ON e.id=p.entry_id
         WHERE p.category_id=? ORDER BY p.place, e.start_number`
      ).all(categoryId);
      body += `<table><thead><tr><th class="n">Pl.</th><th class="n">No.</th><th>Partner 1</th><th>Partner 2</th><th></th></tr></thead><tbody>
      ${rows.map(r=>`<tr class="${r.disqualified?'dq':''}">
        <td class="n"><b>${r.place}${r.tie?'=':''}</b></td>
        <td class="n">${r.start_number}</td>
        <td>${esc(r.name1)}</td><td>${esc(r.name2||'—')}</td>
        <td>${r.disqualified?'<span class="pill pill-danger">DQ</span>':''}</td>
      </tr>`).join('')}
      </tbody></table>`;
    } else {
      const rr = db.prepare(
        `SELECT rr.crosses, rr.recalled, rr.borderline_tie, e.start_number, e.name1, e.name2
         FROM recall_result rr JOIN entry e ON e.id=rr.entry_id
         WHERE rr.round_id=? ORDER BY rr.recalled DESC, rr.crosses DESC, e.start_number`
      ).all(round.id);
      if (!rr.length) { body += '<p class="muted">No results yet.</p>'; continue; }
      body += `<table><thead><tr>
        <th class="n">No.</th><th>Partner 1</th><th>Partner 2</th>
        <th class="n">Crosses</th><th></th>
      </tr></thead><tbody>
      ${rr.map(r=>`<tr class="${r.recalled?'recalled':'dropped'}">
        <td class="n">${r.start_number}</td>
        <td>${esc(r.name1)}</td><td>${esc(r.name2||'—')}</td>
        <td class="n"><b>${r.crosses}</b></td>
        <td>
          <span class="pill ${r.recalled?'pill-ok':'pill-muted'}">${r.recalled?'Recalled':'Dropped'}</span>
          ${r.borderline_tie?'<span class="pill pill-warn" style="margin-left:4px">Tied</span>':''}
        </td>
      </tr>`).join('')}
      </tbody></table>`;
    }
  }

  body += `<div class="sign"><div class="line">Scrutineer</div><div class="line">Chairman</div></div>`;
  return page(`All Rounds — ${cat.name}`, c, body);
}

/* ─── NEW: Judges Summary (Together) ─────────────────────────────────── */
function judgesSummaryList(db) {
  const c = comp(db);
  if (!c.id) return page('Judges Summary', c, '<p>No competition loaded.</p>');
  
  const judges = db.prepare(
    `SELECT id, full_name, judge_letter, pin_hash AS pin, studio_name
     FROM official WHERE competition_id=? AND role='judge'
     ORDER BY judge_letter NULLS LAST, full_name`
  ).all(c.id);

  const rowsHtml = judges.map(j => {
    const cats = db.prepare(
      `SELECT c.name FROM category_judge cj
       JOIN category c ON c.id=cj.category_id
       WHERE cj.official_id=? ORDER BY c.category_order, c.name`
    ).all(j.id).map(r => r.name);

    return `<tr>
      <td class="n"><b>${esc(j.judge_letter || '')}</b></td>
      <td><b>${esc(j.full_name)}</b></td>
      <td>${esc(j.studio_name || '—')}</td>
      <td class="c" style="font-family:monospace;font-size:14px;font-weight:900;letter-spacing:.1em">${esc(j.pin || '----')}</td>
      <td>${cats.length ? cats.map(cat => `<span class="pill pill-ok" style="margin:2px">${esc(cat)}</span>`).join(' ') : '<span class="pill pill-muted">კატეგორიები არ არის / No categories</span>'}</td>
    </tr>`;
  }).join('');

  const body = `
    <h2>მსაჯების განაწილების შეჯამება / Judges Assignment Summary</h2>
    <p class="muted" style="margin-bottom:16px">ყველა მსაჯის, შესასვლელი პინ-კოდებისა და მინიჭებული კატეგორიების სია. / Summary of all judges, their login PINs, and assigned categories.</p>
    <table>
      <thead>
        <tr>
          <th class="n">#</th>
          <th>მსაჯის სახელი / Full Name</th>
          <th>სტუდია / Studio</th>
          <th class="c">ტაბლეტის პინი / Tablet PIN</th>
          <th>კატეგორიები / Assigned Categories</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml || '<tr><td colspan="5" class="muted" style="text-align:center">მსაჯები არ არის ნაპოვნი / No judges found.</td></tr>'}
      </tbody>
    </table>
    <div class="sign">
      <div class="line">რეგისტრატორი / Scrutineer</div>
      <div class="line">მთავარი მსაჯი / Chairman</div>
    </div>
  `;
  return page('მსაჯების შეჯამება / Judges Summary', c, body);
}

/* ─── NEW: Judges Slips (Separately) ─────────────────────────────────── */
function judgesSlips(db, host) {
  const c = comp(db);
  if (!c.id) return page('Judges Slips', c, '<p>No competition loaded.</p>');

  const judges = db.prepare(
    `SELECT id, full_name, judge_letter, pin_hash AS pin, studio_name
     FROM official WHERE competition_id=? AND role='judge'
     ORDER BY judge_letter NULLS LAST, full_name`
  ).all(c.id);

  let body = '';
  judges.forEach((j, idx) => {
    const cats = db.prepare(
      `SELECT c.name FROM category_judge cj
       JOIN category c ON c.id=cj.category_id
       WHERE cj.official_id=? ORDER BY c.category_order, c.name`
    ).all(j.id).map(r => r.name);

    const protocol = (host && (host.includes('localhost') || host.includes('192.168.') || host.includes('10.') || host.includes('172.') || host.includes('127.0.0.1'))) ? 'http' : 'https';
    const finalHost = host || 'telemark.one';
    const qrUrl = `${protocol}://${finalHost}/judge.html?pin=${j.pin}`;
    const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=${encodeURIComponent(qrUrl)}`;

    const catList = cats.map(cat => `<li>${esc(cat)}</li>`).join('');

    body += `
    <div class="copy" style="padding: 20px 0; page-break-inside: avoid;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; border-bottom: 2px solid #333; padding-bottom: 12px; margin-bottom: 20px;">
        <div>
          <h1 style="margin:0; font-size:20px; font-weight:800; color:#111;">მსაჯის სამუშაო ბარათი / Judge Adjudication Card</h1>
          <div style="font-size:11px; color:#555; margin-top:4px;">ტაბლეტით სისტემაში შესვლის მონაცემები / Telemark Adjudicator tablet access details</div>
        </div>
        <div style="font-size:36px; font-weight:900; font-family:monospace; background:#111; color:#fff; width:60px; height:60px; display:flex; align-items:center; justify-content:center; border-radius:8px;">
          ${esc(j.judge_letter || '?')}
        </div>
      </div>

      <div style="display:grid; grid-template-columns: 1fr 120px; gap: 24px; margin-bottom: 24px;">
        <div>
          <div style="margin-bottom: 16px;">
            <span style="font-size:10px; text-transform:uppercase; color:#666; font-weight:700; display:block;">მსაჯის სახელი / Judge Name</span>
            <strong style="font-size:16px; color:#111;">${esc(j.full_name)}</strong>
            ${j.studio_name ? `<span style="font-size:12px; color:#555; display:block; margin-top:2px;">სტუდია / Studio: ${esc(j.studio_name)}</span>` : ''}
          </div>

          <div style="margin-bottom: 16px;">
            <span style="font-size:10px; text-transform:uppercase; color:#666; font-weight:700; display:block;">ტაბლეტის PIN კოდი / Secure Tablet PIN</span>
            <div style="font-size:28px; font-weight:900; font-family:monospace; letter-spacing:0.1em; background:#f5f5f5; border:1px solid #ccc; padding:6px 16px; border-radius:6px; display:inline-block; margin-top:4px;">
              ${esc(j.pin || '----')}
            </div>
          </div>
        </div>

        <div style="text-align:center;">
          <span style="font-size:9px; text-transform:uppercase; color:#666; font-weight:700; display:block; margin-bottom:6px;">სკანირება შესასვლელად / Scan to Login</span>
          <img src="${qrSrc}" width="100" height="100" style="border:1px solid #ddd; padding:4px; border-radius:6px;" alt="QR Code" />
        </div>
      </div>

      <div style="background:#fff3cd; border:1px solid #ffeeba; color:#856404; padding:12px 16px; border-radius:8px; font-size:11px; margin-bottom: 24px; line-height:1.5;">
        <strong>ინსტრუქცია:</strong> გახსენით <strong>telemark.one</strong> თქვენს ტაბლეტში ან ტელეფონში, აირჩიეთ თქვენი სახელი და შეიყვანეთ 4-ნიშნა PIN კოდი. ან უბრალოდ დაასკანირეთ ზემოთ მოცემული QR კოდი ავტომატურად შესასვლელად.<br>
        <strong>Instructions:</strong> Open <strong>telemark.one</strong> on your tablet or phone, select your name and enter your 4-digit secure PIN, or scan the QR code to login.
      </div>

      <div style="border:1px solid #e0e0e0; border-radius:12px; padding:20px; background:#fafafa;">
        <h3 style="margin-top:0; margin-bottom:12px; font-size:12px; text-transform:uppercase; letter-spacing:0.05em; border-bottom:1px solid #e0e0e0; padding-bottom:8px; color:#333;">კატეგორიები შესაფასებლად / Assigned Categories to Judge</h3>
        ${cats.length ? `<ul style="margin:0; padding-left:20px; font-size:13px; line-height:1.6; font-weight:600; color:#111;">${catList}</ul>` : '<p style="margin:0; font-style:italic; color:#666;">კატეგორიები ჯერ არ არის მინიჭებული / No categories assigned yet.</p>'}
      </div>
      
      <div style="margin-top: 40px; border-top: 1px dashed #ccc; padding-top: 20px; font-size: 10px; color: #888; text-align: center;">
        ტურნირი / Competition: ${esc(c.name)} &middot; მდებარეობა / Location: ${esc(c.location || '')} &middot; თარიღი / Date: ${esc(c.event_date || '')}
      </div>
    </div>
    `;
  });

  return page('მსაჯების ბარათები / Judges Cards', c, body, { noHeader: true });
}

module.exports = {
  couplesList, roundDraw, roundDrawByCouple, judgingSheet,
  checksumReport, resultsSkating, resultsQualification,
  officialsList, missingList, droppedOutList,
  judgesPinSheet, judgesSessionSheet, resultsAllRounds,
  judgesSummaryList, judgesSlips,
};
