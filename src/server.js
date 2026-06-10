'use strict';

/**
 * Telemark.one — venue WiFi server.
 * Express REST API + WebSocket real-time bus.
 *
 * NO serverless sync — this runs on a persistent server (Render/Railway/VPS).
 */

const express = require('express');
const http    = require('http');
const path    = require('path');
const crypto  = require('crypto');
const { WebSocketServer } = require('ws');

const J         = require('./core/judging');
const results   = require('./core/results');
const security  = require('./core/security');
const backup    = require('./core/backup');
const printouts = require('./core/printouts');
const { createSupabase } = require('./sync/supabaseClient');
const { pushResults }    = require('./sync/push');
const { pullCompetition } = require('./sync/pull');
const { generateStartNumbers } = require('./core/numbering');
const { createRound, drawRound } = require('./core/draw');
const wdsf = require('./sync/wdsfExport');
const { getActiveCompetition, audit, firstRoundKind, nextRoundKind, roundLabel, suggestedFirstRound, ROUND_LADDER, getStartingRoundOptions } = require('./db');

// ─── Round kind helpers ───────────────────────────────────────────────────────
const DANCE_CODES = ['W','T','VW','F','Q','SB','CC','RU','PD','JI','CH','J'];

// dancesport.ge stores dances as short codes (SW,T,VW,SF,Q,S,CH,R,PD,J).
// Telemark uses its own codes (W,T,VW,F,Q,SB,CC,RU,PD,JI). Map between them.
const DANCESPORT_TO_TELEMARK = {
  SW: 'W',  W: 'W',  T: 'T',  VW: 'VW', SF: 'F',  F: 'F',  Q: 'Q',
  S: 'SB',  SB: 'SB', CH: 'CC', CC: 'CC', R: 'RU', RU: 'RU',
  PD: 'PD', J: 'JI',  JI: 'JI',
};
function mapDancesportDances(csv) {
  return (csv || '')
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)
    .map(code => DANCESPORT_TO_TELEMARK[code] || code)
    .filter((code, i, arr) => DANCE_CODES.includes(code) && arr.indexOf(code) === i);
}

function parseDancesFromName(name) {
  const up = name.toUpperCase();
  const found = [];
  const re = /\b(VW|SB|CC|RU|PD|JI|CH|W|T|F|Q|J)\b/g;
  let m;
  while ((m = re.exec(up)) !== null) {
    let code = m[1];
    if (code === 'CH') code = 'CC';
    if (code === 'J')  code = 'JI';
    if (!found.includes(code)) found.push(code);
  }
  return found.length ? found : ['W'];
}

// The authoritative dance list for a category: prefer the explicit `dances`
// column synced from dancesport.ge; fall back to parsing the category name.
function dancesForCategory(cat) {
  const fromColumn = mapDancesportDances(cat && cat.dances);
  if (fromColumn.length) return fromColumn;
  return parseDancesFromName(cat ? cat.name : '');
}

// ─── Outlier detection for chairman live view ─────────────────────────────────
/**
 * For a given round_dance, compute each judge's marks and flag outliers.
 * An outlier is a judge whose median rank differs from the group median by ≥ 2.
 */
function computeOutliers(db, roundDanceId) {
  const marks = db.prepare(
    `SELECT m.official_id, o.judge_letter, m.entry_id,
            m.place, m.cross_mark
     FROM mark m
     JOIN official o ON o.id = m.official_id
     WHERE m.round_dance_id=?
     ORDER BY m.official_id, m.entry_id`
  ).all(roundDanceId);

  if (!marks.length) return [];

  const byJudge = new Map();
  for (const m of marks) {
    if (!byJudge.has(m.official_id)) byJudge.set(m.official_id, { letter: m.judge_letter, places: [] });
    if (m.place != null) byJudge.get(m.official_id).places.push(m.place);
  }

  // Per entry, collect all judges' places
  const byEntry = new Map();
  for (const m of marks) {
    if (m.place == null) continue;
    if (!byEntry.has(m.entry_id)) byEntry.set(m.entry_id, []);
    byEntry.get(m.entry_id).push(m.place);
  }

  const median = arr => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };

  // For each judge, compare their places to group median per entry
  const outliers = [];
  for (const [judgeId, judgeData] of byJudge) {
    const judgePlaces = marks.filter(m => m.official_id === judgeId && m.place != null);
    const deviations = [];
    for (const m of judgePlaces) {
      const allPlaces = byEntry.get(m.entry_id) || [];
      const groupMedian = median(allPlaces);
      if (groupMedian != null) deviations.push(Math.abs(m.place - groupMedian));
    }
    const avgDeviation = deviations.length ? deviations.reduce((a, b) => a + b, 0) / deviations.length : 0;
    if (avgDeviation >= 2) {
      outliers.push({
        officialId: judgeId,
        letter: judgeData.letter,
        avgDeviation: Math.round(avgDeviation * 10) / 10,
      });
    }
  }
  return outliers;
}

function createServer(db, opts = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, x-chairman-token, x-auth-token');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const sessions    = security.createSessionStore(db);
  try { sessions.cleanup(); } catch (_) {}

  const backupDir   = opts.backupDir || process.env.BACKUP_DIR || 'backups';
  const supaCfg     = opts.supabase || { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_KEY };
  const dancesportCfg = {
    url: process.env.DANCESPORT_URL || supaCfg.url,
    key: process.env.DANCESPORT_KEY || supaCfg.key,
  };
  const wdsfCfg = opts.wdsf || { url: process.env.WDSF_URL, apiKey: process.env.WDSF_KEY };

  // ── HTTP + WebSocket server ────────────────────────────────────────────────
  const server = http.createServer(app);
  const wss    = new WebSocketServer({ server });
  const judgeDiagnostics = new Map();

  function broadcast(type, payload) {
    const msg = JSON.stringify({ type, payload, ts: Date.now() });
    for (const c of wss.clients) {
      if (c.readyState === 1) c.send(msg);
    }
  }

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'hello', payload: { ok: true } }));
    ws.send(JSON.stringify({ type: 'judges:diagnostics', payload: Array.from(judgeDiagnostics.values()) }));
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg?.type === 'judge:diagnostics') {
          const { officialId, battery, ping } = msg.payload;
          judgeDiagnostics.set(officialId, { officialId, battery, ping, lastSeen: Date.now() });
          broadcast('judges:diagnostics', Array.from(judgeDiagnostics.values()));
        }
      } catch (_) {}
    });
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  function wrap(fn) {
    return (req, res) => {
      try {
        Promise.resolve(fn(req, res)).catch((e) => {
          console.error(e);
          if (!res.headersSent) res.status(500).json({ error: e.message });
        });
      } catch (e) {
        console.error(e);
        if (!res.headersSent) res.status(500).json({ error: e.message });
      }
    };
  }

  const requireAuth = (req, res) => {
    const t = req.header('x-auth-token') || req.header('authorization')?.replace('Bearer ', '');
    if (!t || !sessions.valid(t)) { res.status(401).json({ error: 'Authentication required' }); return false; }
    return true;
  };

  const requireChairman = (req, res) => {
    const t = req.header('x-chairman-token');
    if (!t || !sessions.valid(t)) { res.status(401).json({ error: 'Chairman auth required' }); return false; }
    return true;
  };

  const autoBackup = () => { try { backup.backupNow(db, backupDir); backup.prune(backupDir); } catch (_) {} };
  const html = (res, s) => res.type('html').send(s);

  // ══════════════════════════════════════════════════════════════════════════
  // COMPETITION
  // ══════════════════════════════════════════════════════════════════════════

  app.get('/api/competition', wrap((req, res) => {
    res.json(getActiveCompetition(db) || null);
  }));

  app.get('/api/competitions', wrap((req, res) => {
    res.json(db.prepare('SELECT id, src_id, name, event_date, location, is_locked FROM competition ORDER BY event_date DESC, id DESC').all());
  }));

  app.post('/api/active-competition', wrap((req, res) => {
    const { id } = req.body;
    db.prepare('UPDATE sync_state SET active_competition_id=? WHERE id=1').run(id);
    res.json({ ok: true });
  }));

  app.delete('/api/competition/:id', wrap((req, res) => {
    const id = +req.params.id;
    const state = db.prepare('SELECT active_competition_id FROM sync_state WHERE id=1').get();
    db.exec('PRAGMA foreign_keys = ON;');
    db.prepare('DELETE FROM competition WHERE id=?').run(id);
    if (state?.active_competition_id === id) {
      db.prepare('UPDATE sync_state SET active_competition_id=NULL WHERE id=1').run();
    }
    res.json({ ok: true });
  }));

  // ══════════════════════════════════════════════════════════════════════════
  // OFFICIALS (judges, chairman)
  // ══════════════════════════════════════════════════════════════════════════

  app.get('/api/judges', wrap((req, res) => {
    const comp = getActiveCompetition(db);
    if (!comp) return res.json([]);
    res.json(db.prepare(
      `SELECT id, full_name, role, judge_letter, studio_name, pin_hash AS pin
       FROM official WHERE competition_id=? ORDER BY role DESC, judge_letter NULLS LAST`
    ).all(comp.id));
  }));

  /** Add a judge or chairman manually */
  app.post('/api/judges', wrap((req, res) => {
    const comp = getActiveCompetition(db);
    if (!comp) return res.status(400).json({ error: 'No competition loaded.' });
    const { full_name, studio_name, role = 'judge' } = req.body;
    if (!full_name?.trim()) return res.status(400).json({ error: 'full_name is required' });
    if (!['judge', 'chairman'].includes(role)) return res.status(400).json({ error: 'role must be judge or chairman' });

    let letter = null;
    if (role === 'judge') {
      const usedLetters = new Set(
        db.prepare("SELECT judge_letter FROM official WHERE role='judge' AND competition_id=? AND judge_letter IS NOT NULL").all(comp.id).map(r => r.judge_letter)
      );
      const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      letter = LETTERS.split('').find(l => !usedLetters.has(l)) || null;
    }

    const existingPins = new Set(
      db.prepare("SELECT pin_hash FROM official WHERE competition_id=? AND pin_hash IS NOT NULL").all(comp.id).map(r => r.pin_hash)
    );
    let pin;
    do { pin = String(1000 + Math.floor(Math.random() * 9000)); } while (existingPins.has(pin));

    const result = db.prepare(
      'INSERT INTO official (competition_id, full_name, role, judge_letter, studio_name, pin_hash) VALUES (?,?,?,?,?,?)'
    ).run(comp.id, full_name.trim(), role, letter, studio_name?.trim() || null, pin);

    broadcast('judges:updated', {});
    res.json({ id: result.lastInsertRowid, full_name: full_name.trim(), role, judge_letter: letter, studio_name: studio_name?.trim() || null, pin });
  }));

  app.post('/api/judges/login', wrap((req, res) => {
    const { pin } = req.body;
    if (!pin) return res.status(400).json({ error: 'PIN is required' });
    const comp = getActiveCompetition(db);
    if (!comp) return res.status(400).json({ error: 'No competition loaded' });
    const judge = db.prepare(
      "SELECT id, full_name, role, judge_letter FROM official WHERE pin_hash=? AND competition_id=?"
    ).get(String(pin), comp.id);
    if (!judge) return res.status(401).json({ error: 'error_invalid_pin' });

    // Check if this judge is assigned to the currently active category
    if (judge.role === 'judge') {
      const activeRound = db.prepare(
        `SELECT r.id, r.category_id FROM round r JOIN category c ON c.id=r.category_id
         WHERE r.status='judging' AND c.competition_id=? LIMIT 1`
      ).get(comp.id);
      
      if (!activeRound) {
        return res.status(403).json({ error: 'error_no_active_categories' });
      }
      
      const assigned = db.prepare('SELECT official_id FROM category_judge WHERE category_id=?').all(activeRound.category_id);
      if (assigned.length > 0 && !assigned.some(a => a.official_id === judge.id)) {
        return res.status(403).json({ error: 'error_not_scheduled' });
      }
    }

    res.json(judge);
  }));

  app.delete('/api/judges/:id', wrap((req, res) => {
    const id = +req.params.id;
    const comp = getActiveCompetition(db);
    if (!comp) return res.status(400).json({ error: 'No active competition' });
    db.prepare('DELETE FROM official WHERE id=?').run(id);
    // Re-sequence letters A,B,C...
    const remaining = db.prepare("SELECT id FROM official WHERE role='judge' AND competition_id=? ORDER BY id").all(comp.id);
    const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    remaining.forEach((r, i) => db.prepare('UPDATE official SET judge_letter=? WHERE id=?').run(L[i] || null, r.id));
    broadcast('judges:updated', {});
    res.json({ ok: true });
  }));

  app.post('/api/judges/:id/update', wrap((req, res) => {
    const id = +req.params.id;
    const { full_name, role, pin, studio_name } = req.body;
    if (!full_name?.trim()) return res.status(400).json({ error: 'full_name is required' });
    if (!['judge', 'chairman'].includes(role)) return res.status(400).json({ error: 'invalid role' });
    if (!pin || String(pin).trim().length !== 4 || isNaN(pin)) return res.status(400).json({ error: 'PIN must be a 4-digit number' });

    const comp = getActiveCompetition(db);
    if (!comp) return res.status(400).json({ error: 'No active competition' });
    const old = db.prepare('SELECT role, judge_letter FROM official WHERE id=?').get(id);
    if (!old) return res.status(404).json({ error: 'Official not found' });

    db.exec('BEGIN');
    try {
      let newLetter = old.judge_letter;
      if (old.role === 'judge' && role === 'chairman') {
        newLetter = null;
        db.prepare('DELETE FROM category_judge WHERE official_id=?').run(id);
      } else if (old.role === 'chairman' && role === 'judge') {
        const usedLetters = new Set(
          db.prepare("SELECT judge_letter FROM official WHERE role='judge' AND competition_id=? AND judge_letter IS NOT NULL").all(comp.id).map(r => r.judge_letter)
        );
        const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        newLetter = L.split('').find(l => !usedLetters.has(l)) || null;
      }
      db.prepare('UPDATE official SET full_name=?, role=?, judge_letter=?, pin_hash=?, studio_name=? WHERE id=?')
        .run(full_name.trim(), role, newLetter, pin.trim(), studio_name?.trim() || null, id);

      // Re-sequence letters
      const remaining = db.prepare("SELECT id FROM official WHERE role='judge' AND competition_id=? ORDER BY id").all(comp.id);
      const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      remaining.forEach((r, i) => db.prepare('UPDATE official SET judge_letter=? WHERE id=?').run(L[i] || null, r.id));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }

    broadcast('judges:updated', {});
    res.json({ ok: true });
  }));

  app.get('/api/judges/assignments', wrap((req, res) => {
    const comp = getActiveCompetition(db);
    if (!comp) return res.json([]);
    const judges = db.prepare(
      `SELECT id, full_name, role, judge_letter, studio_name, pin_hash AS pin
       FROM official WHERE competition_id=? ORDER BY role DESC, judge_letter NULLS LAST`
    ).all(comp.id);
    const assignments = db.prepare(
      `SELECT cj.official_id, cj.category_id FROM category_judge cj
       JOIN category c ON c.id=cj.category_id WHERE c.competition_id=?`
    ).all(comp.id);
    const map = {};
    for (const a of assignments) (map[a.official_id] ||= []).push(a.category_id);
    judges.forEach(j => { j.categories = map[j.id] || []; });
    res.json(judges);
  }));

  // ══════════════════════════════════════════════════════════════════════════
  // ENTRIES (manual add/remove/status/DQ)
  // ══════════════════════════════════════════════════════════════════════════

  app.get('/api/categories/:catId/entries', wrap((req, res) => {
    const catId = +req.params.catId;
    const rows = db.prepare(
      `SELECT id, start_number, name1, name1_ka, name2, name2_ka,
              studio_name, status, is_present, is_seeded, added_manually,
              disqualified, dq_reason, final_place
       FROM entry WHERE category_id=? ORDER BY start_number NULLS LAST, name1`
    ).all(catId);
    res.json(rows);
  }));

  /** Manually add an entry to a category */
  app.post('/api/categories/:catId/entries', wrap((req, res) => {
    const catId = +req.params.catId;
    const cat = db.prepare('SELECT competition_id FROM category WHERE id=?').get(catId);
    if (!cat) return res.status(404).json({ error: 'Category not found' });
    const { name1, name2, studio_name } = req.body;
    if (!name1?.trim()) return res.status(400).json({ error: 'name1 is required' });
    const r = db.prepare(
      `INSERT INTO entry (competition_id, category_id, name1, name2, studio_name, added_manually, status)
       VALUES (?,?,?,?,?,1,'active')`
    ).run(cat.competition_id, catId, name1.trim(), name2?.trim() || null, studio_name?.trim() || null);
    broadcast('entries:updated', { categoryId: catId });
    res.json({ id: r.lastInsertRowid, name1: name1.trim() });
  }));

  /** Update entry status (present/missing/withdrawn/excused) */
  app.post('/api/entries/:id/status', wrap((req, res) => {
    const { status } = req.body;
    const allowed = ['active', 'missing', 'excused', 'withdrawn'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'invalid status' });
    db.prepare('UPDATE entry SET status=? WHERE id=?').run(status, +req.params.id);
    broadcast('entries:updated', {});
    res.json({ ok: true });
  }));

  /** Disqualify / un-disqualify an entry */
  app.post('/api/entries/:id/disqualify', wrap((req, res) => {
    const { disqualified, reason } = req.body;
    const dq = disqualified ? 1 : 0;
    db.prepare('UPDATE entry SET disqualified=?, dq_reason=? WHERE id=?').run(dq, reason || null, +req.params.id);
    // If disqualified and this entry has a final placing, push it to last
    if (dq) {
      const entry = db.prepare('SELECT category_id FROM entry WHERE id=?').get(+req.params.id);
      if (entry) {
        // Re-compute placings to push DQ to last
        const allPlacings = db.prepare('SELECT id, place FROM placing WHERE category_id=? ORDER BY place').all(entry.category_id);
        if (allPlacings.length) {
          const maxPlace = allPlacings[allPlacings.length - 1].place;
          db.prepare('UPDATE placing SET place=? WHERE entry_id=? AND category_id=?').run(maxPlace + 1, +req.params.id, entry.category_id);
          db.prepare('UPDATE entry SET final_place=? WHERE id=?').run(maxPlace + 1, +req.params.id);
        }
      }
    }
    audit(db, 'system', dq ? 'entry.disqualify' : 'entry.reinstate', { entryId: +req.params.id, reason });
    broadcast('entries:updated', {});
    res.json({ ok: true });
  }));

  // ══════════════════════════════════════════════════════════════════════════
  // CATEGORY ↔ JUDGE ASSIGNMENTS
  // ══════════════════════════════════════════════════════════════════════════

  app.post('/api/categories/:catId/judges/:judgeId', wrap((req, res) => {
    db.prepare('INSERT OR IGNORE INTO category_judge (category_id, official_id) VALUES (?,?)').run(+req.params.catId, +req.params.judgeId);
    res.json({ ok: true });
  }));

  app.delete('/api/categories/:catId/judges/:judgeId', wrap((req, res) => {
    db.prepare('DELETE FROM category_judge WHERE category_id=? AND official_id=?').run(+req.params.catId, +req.params.judgeId);
    res.json({ ok: true });
  }));

  app.put('/api/categories/:catId/judges', wrap((req, res) => {
    const catId = +req.params.catId;
    const { judgeIds } = req.body;
    if (!Array.isArray(judgeIds)) return res.status(400).json({ error: 'judgeIds array required' });
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM category_judge WHERE category_id=?').run(catId);
      const ins = db.prepare('INSERT INTO category_judge (category_id, official_id) VALUES (?,?)');
      for (const jid of judgeIds) ins.run(catId, jid);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    res.json({ ok: true, count: judgeIds.length });
  }));

  app.get('/api/categories/:catId/judge-conflicts', wrap((req, res) => {
    const catId = +req.params.catId;
    const judges = db.prepare(
      `SELECT o.id, o.full_name, o.judge_letter, o.studio_name
       FROM official o JOIN category_judge cj ON cj.official_id=o.id
       WHERE cj.category_id=? AND o.studio_name IS NOT NULL AND trim(o.studio_name)!=''`
    ).all(catId);
    if (!judges.length) return res.json({ conflicts: [] });
    const entries = db.prepare(
      `SELECT start_number, name1, name2, studio_name FROM entry
       WHERE category_id=? AND status='active' AND studio_name IS NOT NULL AND trim(studio_name)!=''`
    ).all(catId);
    const conflicts = [];
    for (const j of judges) {
      const js = j.studio_name.toLowerCase().trim();
      const conflicting = entries.filter(e => {
        const es = e.studio_name.toLowerCase().trim();
        return js === es || js.includes(es) || es.includes(js);
      });
      if (conflicting.length) conflicts.push({
        judgeId: j.id, judgeName: j.full_name, judgeLetter: j.judge_letter, studio: j.studio_name,
        entries: conflicting.map(e => ({ startNumber: e.start_number, couple: e.name2 ? `${e.name1} & ${e.name2}` : e.name1, studio: e.studio_name })),
      });
    }
    res.json({ conflicts });
  }));

  // ══════════════════════════════════════════════════════════════════════════
  // SCRUTINEER AUTH
  // ══════════════════════════════════════════════════════════════════════════

  app.post('/api/auth/login', wrap((req, res) => {
    let { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    email    = String(email).trim().toLowerCase();
    password = String(password).trim();
    let user = db.prepare('SELECT * FROM scrutineer_user WHERE email=?').get(email);
    if (!user && email === 'dancesportgeo@gmail.com') {
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.pbkdf2Sync('@Kjkszpj13', salt, 120000, 32, 'sha256').toString('hex');
      db.prepare('INSERT OR IGNORE INTO scrutineer_user (email,password_hash,password_salt,has_license) VALUES(?,?,?,?)').run(email, hash, salt, 1);
      user = db.prepare('SELECT * FROM scrutineer_user WHERE email=?').get(email);
    }
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    const got = crypto.pbkdf2Sync(password, user.password_salt, 120000, 32, 'sha256').toString('hex');
    if (got !== user.password_hash) return res.status(401).json({ error: 'Invalid email or password' });
    if (!user.has_license) return res.status(403).json({ error: 'No active Scrutineer License.' });
    res.json({ ok: true, token: sessions.issue(), email: user.email });
  }));

  app.all('/api/auth/reset', wrap((req, res) => {
    db.exec("DELETE FROM scrutineer_user WHERE email='dancesportgeo@gmail.com'");
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync('@Kjkszpj13', salt, 120000, 32, 'sha256').toString('hex');
    db.prepare('INSERT INTO scrutineer_user (email,password_hash,password_salt,has_license) VALUES(?,?,?,?)').run('dancesportgeo@gmail.com', hash, salt, 1);
    res.json({ ok: true, message: 'Password reset to @Kjkszpj13' });
  }));

  // ══════════════════════════════════════════════════════════════════════════
  // CHAIRMAN SECURITY
  // ══════════════════════════════════════════════════════════════════════════

  app.get('/api/chairman/status', wrap((req, res) => {
    res.json({ pinSet: security.isPinSet(db), locked: security.isLocked(db) });
  }));

  app.post('/api/chairman/setup', wrap((req, res) => {
    if (security.isPinSet(db)) return res.status(409).json({ error: 'PIN already set. Use /reset to change it.' });
    if (!req.body.pin || String(req.body.pin).length < 4) return res.status(400).json({ error: 'PIN too short (min 4 digits)' });
    security.setChairmanPin(db, req.body.pin);
    res.json({ ok: true });
  }));

  /** Change PIN — requires current PIN */
  app.post('/api/chairman/change-pin', wrap((req, res) => {
    const { currentPin, newPin } = req.body;
    if (!security.verifyPin(db, currentPin)) return res.status(401).json({ error: 'Current PIN incorrect' });
    if (!newPin || String(newPin).length < 4) return res.status(400).json({ error: 'New PIN too short' });
    security.setChairmanPin(db, newPin);
    res.json({ ok: true });
  }));

  /** Reset PIN (scrutineer-only, from the judges management page) */
  app.post('/api/chairman/reset-pin', wrap((req, res) => {
    if (!requireAuth(req, res)) return;
    security.resetPin(db);
    res.json({ ok: true, message: 'Chairman PIN has been reset. A new PIN must be set.' });
  }));

  app.post('/api/chairman/login', wrap((req, res) => {
    if (!security.verifyPin(db, req.body.pin)) return res.status(401).json({ error: 'Wrong PIN' });
    res.json({ ok: true, token: sessions.issue() });
  }));

  app.post('/api/chairman/lock', wrap((req, res) => {
    if (!requireChairman(req, res)) return;
    security.setLocked(db, true); broadcast('comp:lock', { locked: true }); res.json({ ok: true });
  }));

  app.post('/api/chairman/unlock', wrap((req, res) => {
    if (!requireChairman(req, res)) return;
    security.setLocked(db, false); broadcast('comp:lock', { locked: false }); res.json({ ok: true });
  }));

  // ── Chairman: category structure confirmation ──────────────────────────────

  /**
   * GET all categories with entry counts for the chairman to review.
   * Grouped by session so the chairman can approve one session at a time.
   */
  app.get('/api/chairman/categories', wrap((req, res) => {
    if (!requireChairman(req, res)) return;
    const comp = getActiveCompetition(db);
    if (!comp) return res.json([]);
    const cats = db.prepare(
      `SELECT id, name, session_number, session_time, category_order,
              chairman_confirmed, finals_count, first_round_kind, status
       FROM category WHERE competition_id=? ORDER BY session_number, category_order, name`
    ).all(comp.id);
    for (const c of cats) {
      c.entry_count = db.prepare("SELECT COUNT(*) n FROM entry WHERE category_id=? AND status!='withdrawn'").get(c.id).n;
      c.starting_round_options = getStartingRoundOptions(c.entry_count);
      const { kind, recallCount } = firstRoundKind(c.entry_count, c.finals_count || 6);
      c.suggested_first_round = suggestedFirstRound(c.entry_count, c.finals_count || 6);
      c.suggested_recall = recallCount;
    }
    res.json(cats);
  }));

  /**
   * Confirm a category's structure (finals_count + first_round_kind + confirm flag).
   * After ALL categories in a session are confirmed, numbering can be triggered.
   */
  app.post('/api/chairman/category/:catId/confirm-structure', wrap((req, res) => {
    if (!requireChairman(req, res)) return;
    const catId = +req.params.catId;
    const { finals_count, first_round_kind } = req.body;
    if (finals_count != null) {
      const fc = +finals_count;
      if (![6, 8].includes(fc)) return res.status(400).json({ error: 'finals_count must be 6 or 8' });
      db.prepare('UPDATE category SET finals_count=? WHERE id=?').run(fc, catId);
    }
    if (first_round_kind != null) {
      db.prepare('UPDATE category SET first_round_kind=? WHERE id=?').run(first_round_kind, catId);
    }
    db.prepare('UPDATE category SET chairman_confirmed=1 WHERE id=?').run(catId);
    broadcast('category:confirmed', { catId });
    audit(db, 'chairman', 'category.confirm', { catId, finals_count, first_round_kind });
    res.json({ ok: true });
  }));

  /** Un-confirm a category (before numbering) */
  app.post('/api/chairman/category/:catId/unconfirm', wrap((req, res) => {
    if (!requireChairman(req, res)) return;
    db.prepare('UPDATE category SET chairman_confirmed=0 WHERE id=?').run(+req.params.catId);
    broadcast('category:unconfirmed', { catId: +req.params.catId });
    res.json({ ok: true });
  }));

  /** Confirm all categories in a session at once */
  app.post('/api/chairman/session/:session/confirm', wrap((req, res) => {
    if (!requireChairman(req, res)) return;
    const comp = getActiveCompetition(db);
    if (!comp) return res.status(400).json({ error: 'No active competition' });
    const session = +req.params.session;
    const cats = db.prepare('SELECT id FROM category WHERE competition_id=? AND session_number=?').all(comp.id, session);
    for (const c of cats) db.prepare('UPDATE category SET chairman_confirmed=1 WHERE id=?').run(c.id);
    broadcast('session:confirmed', { session });
    res.json({ ok: true, confirmed: cats.length });
  }));

  // ── Chairman: override recall ──────────────────────────────────────────────

  app.post('/api/chairman/round/:rid/override-recall', wrap((req, res) => {
    if (!requireChairman(req, res)) return;
    const rid = +req.params.rid;
    const { entryIds } = req.body;
    if (!Array.isArray(entryIds)) return res.status(400).json({ error: 'entryIds must be an array' });
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE recall_result SET recalled=0, borderline_tie=0 WHERE round_id=?').run(rid);
      const upd = db.prepare('UPDATE recall_result SET recalled=1 WHERE round_id=? AND entry_id=?');
      for (const eid of entryIds) upd.run(rid, eid);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    audit(db, 'chairman', 'recall.override', { rid, entryIds });
    broadcast('round:result', { roundId: rid, kind: 'recall_override' });
    res.json({ ok: true });
  }));

  app.post('/api/chairman/round/:rid/redance', wrap((req, res) => {
    if (!requireChairman(req, res)) return;
    const prevRound = db.prepare('SELECT * FROM round WHERE id=?').get(+req.params.rid);
    if (!prevRound) return res.status(404).json({ error: 'Round not found' });
    const cat = db.prepare('SELECT * FROM category WHERE id=?').get(prevRound.category_id);
    const prevDances = db.prepare('SELECT dance_code FROM round_dance WHERE round_id=? ORDER BY dance_order').all(prevRound.id);
    const round = createRound(db, prevRound.category_id, {
      ordinal: prevRound.ordinal + 1,
      kind: 'redance',
      dances: prevDances.map(d => d.dance_code),
      recallCount: null,
      drawMode: 'fixed_heats',
    });
    const draw = drawRound(db, round.id);
    broadcast('round:created', { roundId: round.id, kind: 'redance' });
    res.json({ ok: true, roundId: round.id, numHeats: draw.numHeats });
  }));

  app.post('/api/chairman/round/:rid/make-final', wrap(async (req, res) => {
    if (!requireChairman(req, res)) return;
    const rid = +req.params.rid;
    const round = db.prepare('SELECT * FROM round WHERE id=?').get(rid);
    if (!round) return res.status(404).json({ error: 'Round not found' });
    const recalled = db.prepare('SELECT entry_id FROM recall_result WHERE round_id=? AND recalled=1').all(rid);
    if (!recalled.length) return res.status(400).json({ error: 'No recalled entries — run recall first' });
    const cat = db.prepare('SELECT * FROM category WHERE id=?').get(round.category_id);
    const dances = db.prepare('SELECT dance_code FROM round_dance WHERE round_id=? ORDER BY dance_order').all(round.id);
    const nextRound = createRound(db, round.category_id, {
      ordinal: round.ordinal + 1,
      kind: 'final',
      dances: dances.map(d => d.dance_code),
      recallCount: null,
      drawMode: 'fixed_heats',
    });
    if (round.active_judges_limit)
      db.prepare('UPDATE round SET active_judges_limit=? WHERE id=?').run(round.active_judges_limit, nextRound.id);
    const draw = drawRound(db, nextRound.id);
    broadcast('round:created', { roundId: nextRound.id, kind: 'final' });
    res.json({ ok: true, roundId: nextRound.id });
  }));

  // ── Chairman: judge ↔ category bulk assignment ────────────────────────────

  app.get('/api/chairman/category-judges', wrap((req, res) => {
    if (!requireChairman(req, res)) return;
    const comp = getActiveCompetition(db);
    if (!comp) return res.json([]);
    const rows = db.prepare(
      `SELECT cj.category_id, cj.official_id FROM category_judge cj
       JOIN category c ON c.id=cj.category_id WHERE c.competition_id=?`
    ).all(comp.id);
    res.json(rows);
  }));

  app.post('/api/chairman/category-judges', wrap((req, res) => {
    if (!requireChairman(req, res)) return;
    const { assignments } = req.body;
    const comp = getActiveCompetition(db);
    if (!comp) return res.status(400).json({ error: 'No active competition' });
    db.exec('BEGIN');
    try {
      db.prepare(`DELETE FROM category_judge WHERE category_id IN (SELECT id FROM category WHERE competition_id=?)`).run(comp.id);
      const ins = db.prepare('INSERT INTO category_judge (category_id, official_id) VALUES (?,?)');
      for (const a of assignments) ins.run(a.category_id, a.official_id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    res.json({ ok: true });
  }));

  // ── Chairman: LIVE monitoring ─────────────────────────────────────────────

  /**
   * Live marks view: for a round_dance, return all judges' current marks
   * and flag outliers (judges whose average rank deviates ≥ 2 from group).
   */
  app.get('/api/chairman/live/:roundDanceId', wrap((req, res) => {
    if (!requireChairman(req, res)) return;
    const rdid = +req.params.roundDanceId;
    const rd = db.prepare(
      `SELECT rd.id, rd.dance_code, r.id AS round_id, r.kind, r.category_id,
              c.name AS category_name, c.finals_count
       FROM round_dance rd JOIN round r ON r.id=rd.round_id JOIN category c ON c.id=r.category_id
       WHERE rd.id=?`
    ).get(rdid);
    if (!rd) return res.status(404).json({ error: 'round_dance not found' });

    // All marks for this dance
    const marks = db.prepare(
      `SELECT m.official_id, o.judge_letter, m.entry_id, e.start_number,
              e.name1, e.name2, m.place, m.cross_mark, m.is_helpmark,
              m.confirmed_at, e.disqualified
       FROM mark m
       JOIN official o ON o.id=m.official_id
       JOIN entry e ON e.id=m.entry_id
       WHERE m.round_dance_id=?
       ORDER BY o.judge_letter, e.start_number`
    ).all(rdid);

    const outliers = computeOutliers(db, rdid);
    const outlierIds = new Set(outliers.map(o => o.officialId));

    // Group by judge
    const byJudge = {};
    for (const m of marks) {
      if (!byJudge[m.official_id]) {
        byJudge[m.official_id] = {
          officialId: m.official_id,
          letter: m.judge_letter,
          isOutlier: outlierIds.has(m.official_id),
          marks: [],
        };
      }
      byJudge[m.official_id].marks.push({
        entryId: m.entry_id,
        startNumber: m.start_number,
        name: m.name2 ? `${m.name1} & ${m.name2}` : m.name1,
        place: m.place,
        crossMark: m.cross_mark,
        confirmed: !!m.confirmed_at,
        disqualified: !!m.disqualified,
      });
    }

    res.json({
      roundDanceId: rdid,
      dance: rd.dance_code,
      categoryName: rd.category_name,
      kind: rd.kind,
      judges: Object.values(byJudge),
      outliers,
    });
  }));

  /** Active round dances right now — for chairman dashboard */
  app.get('/api/chairman/active-dances', wrap((req, res) => {
    if (!requireChairman(req, res)) return;
    const comp = getActiveCompetition(db);
    if (!comp) return res.json([]);
    const rows = db.prepare(
      `SELECT rd.id AS round_dance_id, rd.dance_code, r.id AS round_id, r.kind,
              c.id AS category_id, c.name AS category_name
       FROM round_dance rd
       JOIN round r ON r.id=rd.round_id
       JOIN category c ON c.id=r.category_id
       WHERE r.status='judging' AND c.competition_id=?`
    ).all(comp.id);
    res.json(rows);
  }));

  // ══════════════════════════════════════════════════════════════════════════
  // BACKUPS
  // ══════════════════════════════════════════════════════════════════════════

  app.post('/api/backup', wrap((req, res) => {
    const file = backup.backupNow(db, backupDir);
    res.json({ ok: true, file, all: backup.listBackups(backupDir) });
  }));
  app.get('/api/backups', wrap((req, res) => {
    res.json({ backups: backup.listBackups(backupDir) });
  }));

  /** Network info endpoint for settings page */
  app.get("/api/network-info", wrap((req, res) => {
    const os = require("os");
    const addresses = [];
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const ni of (nets[name] || [])) {
        if (ni.family === "IPv4" && !ni.internal) addresses.push(ni.address);
      }
    }
    const port = server.address()?.port || process.env.PORT || 4000;
    res.json({ addresses, port, mode: process.env.DB_PATH?.startsWith("/data") ? "render" : "local" });
  }));

  // ══════════════════════════════════════════════════════════════════════════
  // PRINTOUTS & EXPORTS
  // ══════════════════════════════════════════════════════════════════════════

  app.get('/print/couples/:catId',       wrap((req, res) => html(res, printouts.couplesList(db, +req.params.catId))));
  app.get('/print/draw/:roundId',        wrap((req, res) => html(res, printouts.roundDraw(db, +req.params.roundId))));
  app.get('/print/draw-by-couple/:roundId', wrap((req, res) => html(res, printouts.roundDrawByCouple(db, +req.params.roundId))));
  app.get('/print/sheet/:roundId/:oid',  wrap((req, res) => html(res, printouts.judgingSheet(db, +req.params.roundId, +req.params.oid))));
  app.get('/print/checksum/:roundId',    wrap((req, res) => html(res, printouts.checksumReport(db, +req.params.roundId))));
  app.get('/print/results/:roundId', wrap((req, res) => {
    const rd = db.prepare('SELECT kind FROM round WHERE id=?').get(+req.params.roundId);
    const isFinal = rd && rd.kind === 'final';
    html(res, isFinal ? printouts.resultsSkating(db, +req.params.roundId) : printouts.resultsQualification(db, +req.params.roundId));
  }));
  app.get('/print/dropped/:roundId',     wrap((req, res) => html(res, printouts.droppedOutList(db, +req.params.roundId))));
  app.get('/print/officials',            wrap((req, res) => html(res, printouts.officialsList(db))));
  app.get('/print/missing',              wrap((req, res) => html(res, printouts.missingList(db))));
  app.get('/print/judges-summary',       wrap((req, res) => html(res, printouts.judgesSummaryList(db))));
  app.get('/print/judges-slips',         wrap((req, res) => html(res, printouts.judgesSlips(db, req.headers.host))));

  // ── NEW print routes ──────────────────────────────────────────────────────
  /** PIN sheet: /print/pins  or  /print/pins/2  (session 2) */
  app.get('/print/pins/:session?', wrap((req, res) => {
    const sess = req.params.session != null ? +req.params.session : null;
    html(res, printouts.judgesPinSheet(db, sess, req.headers.host));
  }));
  /** Judges by session matrix */
  app.get('/print/judges-session/:session?', wrap((req, res) => {
    const sess = req.params.session != null ? +req.params.session : null;
    html(res, printouts.judgesSessionSheet(db, sess));
  }));
  /** All rounds of a category */
  app.get('/print/all-rounds/:catId', wrap((req, res) => html(res, printouts.resultsAllRounds(db, +req.params.catId))));
  /** Results by round + judges (full detail) */
  app.get('/print/results-full/:roundId', wrap((req, res) => {
    const rd = db.prepare('SELECT kind FROM round WHERE id=?').get(+req.params.roundId);
    const isFinal = rd?.kind === 'final';
    html(res, isFinal ? printouts.resultsSkating(db, +req.params.roundId) : printouts.resultsQualification(db, +req.params.roundId));
  }));

  app.get('/api/export/wdsf/:catId',         wrap((req, res) => res.json(wdsf.buildPayload(db, +req.params.catId))));
  app.get('/api/export/html/:catId',         wrap((req, res) => res.type('html').send(wdsf.toHtml(db, +req.params.catId))));
  app.post('/api/export/wdsf/:catId/send',   wrap(async (req, res) => {
    try { res.json(await wdsf.send(db, +req.params.catId, { ...wdsfCfg, ...(req.body || {}) })); }
    catch (e) { res.status(502).json({ error: e.message }); }
  }));

  // ══════════════════════════════════════════════════════════════════════════
  // SYNC (pull from dancesport.ge, push results)
  // ══════════════════════════════════════════════════════════════════════════

  app.post('/api/push-results', wrap(async (req, res) => {
    if (!dancesportCfg.url || !dancesportCfg.key) return res.status(400).json({ error: 'dancesport.ge credentials not configured' });
    try {
      const supa = createSupabase(dancesportCfg);
      const r = await pushResults(db, supa);
      broadcast('results:pushed', r);
      res.json(r);
    } catch (e) { res.status(502).json({ error: e.message }); }
  }));

  app.post('/api/pull-competition', wrap(async (req, res) => {
    if (!dancesportCfg.url || !dancesportCfg.key) return res.status(400).json({ error: 'dancesport.ge credentials not configured' });
    const { srcId } = req.body;
    if (!srcId) return res.status(400).json({ error: 'srcId is required' });
    try {
      const supa = createSupabase(dancesportCfg);
      const r = await pullCompetition(db, supa, srcId);
      broadcast('competition:pulled', r);
      res.json(r);
    } catch (e) { res.status(502).json({ error: e.message }); }
  }));

  app.get('/api/tournaments', wrap(async (req, res) => {
    if (!dancesportCfg.url || !dancesportCfg.key) return res.status(400).json({ error: 'dancesport.ge credentials not configured' });
    try {
      const supa = createSupabase(dancesportCfg);
      const list = await supa.tournamentsList();
      res.json(list);
    } catch (e) { res.status(502).json({ error: e.message }); }
  }));

  // ══════════════════════════════════════════════════════════════════════════
  // SCRUTINEER: NUMBERING & ROUND INIT
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Generate start numbers for a session.
   * Requires all categories in that session to be chairman_confirmed=1.
   */
  app.post('/api/scrutineer/numbering', wrap(async (req, res) => {
    const { session_number } = req.body;
    let comp = null;
    const tid = req.query.tid;
    if (tid) comp = db.prepare('SELECT * FROM competition WHERE src_id=?').get(tid);
    if (!comp) comp = getActiveCompetition(db);
    if (!comp) return res.status(400).json({ error: 'No competition loaded' });

    // If session_number specified, check all cats in session are confirmed
    if (session_number != null) {
      const unconfirmed = db.prepare(
        "SELECT COUNT(*) n FROM category WHERE competition_id=? AND session_number=? AND chairman_confirmed=0"
      ).get(comp.id, session_number).n;
      if (unconfirmed > 0) {
        return res.status(400).json({ error: `${unconfirmed} categories in session ${session_number} not yet confirmed by chairman.` });
      }
    }

    const r = generateStartNumbers(db, comp.src_id, { session_number });
    broadcast('numbering:done', r);
    res.json(r);
  }));

  app.post('/api/scrutineer/reset-database', wrap((req, res) => {
    db.prepare('DELETE FROM competition').run();
    db.prepare('DELETE FROM audit_log').run();
    db.prepare('UPDATE sync_state SET active_competition_id = NULL, last_pull_at = NULL, last_push_at = NULL WHERE id = 1').run();
    audit(db, 'system', 'database.reset', { msg: 'Database reset by scrutineer.' });
    res.json({ ok: true });
  }));

  // Wipe the scrutiny (rounds, marks, placings) of ONE category, but keep the
  // entries, start numbers and judges. Lets you re-run a single category from
  // scratch without resetting the whole event.
  app.post('/api/scrutineer/category/:catId/reset-scrutiny', wrap((req, res) => {
    const catId = +req.params.catId;
    const cat = db.prepare('SELECT id, name FROM category WHERE id=?').get(catId);
    if (!cat) return res.status(404).json({ error: 'Category not found. Please refresh the page.' });
    db.exec('BEGIN');
    try {
      // rounds cascade to round_dance -> heat_entry/mark/checksum/recall_result
      db.prepare('DELETE FROM round WHERE category_id=?').run(catId);
      db.prepare('DELETE FROM placing WHERE category_id=?').run(catId);
      db.prepare("UPDATE category SET status='pending' WHERE id=?").run(catId);
      audit(db, 'system', 'category.reset-scrutiny', { catId, name: cat.name });
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    broadcast('category:reset', { categoryId: catId });
    res.json({ ok: true });
  }));

  // Wipe the scrutiny of ALL categories in the active competition, keeping the
  // synced data (categories, entries, start numbers) and all judges intact.
  app.post('/api/scrutineer/reset-categories', wrap((req, res) => {
    const comp = getActiveCompetition(db);
    if (!comp) return res.status(400).json({ error: 'No active competition' });
    db.exec('BEGIN');
    try {
      const catIds = db.prepare('SELECT id FROM category WHERE competition_id=?').all(comp.id).map(r => r.id);
      const delRound   = db.prepare('DELETE FROM round WHERE category_id=?');
      const delPlacing = db.prepare('DELETE FROM placing WHERE category_id=?');
      const setPending = db.prepare("UPDATE category SET status='pending' WHERE id=?");
      for (const id of catIds) { delRound.run(id); delPlacing.run(id); setPending.run(id); }
      audit(db, 'system', 'categories.reset-scrutiny', { count: catIds.length });
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    broadcast('categories:reset', {});
    res.json({ ok: true });
  }));

  app.post('/api/scrutineer/category/:catId/judging-system', wrap((req, res) => {
    if (security.isLocked(db)) return res.status(403).json({ error: 'Competition is locked.' });
    db.prepare('UPDATE category SET judging_system=? WHERE id=?').run(req.body.system, +req.params.catId);
    res.json({ ok: true });
  }));

  app.post('/api/scrutineer/category/:catId/init-round', wrap(async (req, res) => {
    const catId = +req.params.catId;
    const { judgesLimit, starCouplesEnabled } = req.body;
    const cat = db.prepare('SELECT * FROM category WHERE id=?').get(catId);
    if (!cat) return res.status(404).json({ error: 'Category not found. Please refresh the page.' });

    if (!cat.chairman_confirmed)
      return res.status(400).json({ error: 'This category has not been confirmed by the chairman yet.' });

    const entriesCount = db.prepare("SELECT COUNT(*) n FROM entry WHERE category_id=? AND status!='withdrawn'").get(catId).n;
    if (entriesCount === 0) return res.status(400).json({ error: 'No active entries in this category.' });

    const missingNumbers = db.prepare('SELECT COUNT(*) n FROM entry WHERE category_id=? AND start_number IS NULL').get(catId).n;
    if (missingNumbers > 0) return res.status(400).json({ error: 'Start numbers not yet generated for this category.' });

    // Check no round already exists
    const existingRound = db.prepare('SELECT id FROM round WHERE category_id=? ORDER BY ordinal DESC LIMIT 1').get(catId);
    if (existingRound) return res.status(409).json({ error: 'Round already initialised for this category.', roundId: existingRound.id });

    const finalDances = dancesForCategory(cat);
    const finalsCount = cat.finals_count || 6;

    let kind, recallCount;
    if (cat.judging_system === 'grading') {
      // Festival/Grading: one round, everyone dances once, no recall/elimination.
      kind = 'grading';
      recallCount = null;
    } else if (cat.first_round_kind) {
      kind = cat.first_round_kind;
      const step = ROUND_LADDER.find(s => s.kind === kind);
      recallCount = step ? step.recallTo : null;
      if (kind === 'semifinal') recallCount = finalsCount;
      if (kind === 'quarterfinal') recallCount = Math.min(12, finalsCount * 2);
    } else {
      const resKind = firstRoundKind(entriesCount, finalsCount);
      kind = resKind.kind;
      recallCount = resKind.recallCount;
    }
    const drawMode = (kind === 'final' || kind === 'grading') ? 'fixed_heats' : 'random_all_same';

    const round = createRound(db, catId, {
      ordinal: 1, kind, dances: finalDances, recallCount, drawMode,
      starCouplesEnabled: !!starCouplesEnabled,
    });

    if (judgesLimit) db.prepare('UPDATE round SET active_judges_limit=? WHERE id=?').run(+judgesLimit, round.id);

    const draw = drawRound(db, round.id);
    broadcast('round:created', { categoryId: catId, roundId: round.id, kind });
    res.json({ ok: true, roundId: round.id, kind: roundLabel(kind), dances: finalDances, numHeats: draw.numHeats });
  }));

  // ══════════════════════════════════════════════════════════════════════════
  // SCRUTINEER: OVERVIEW & RESULTS
  // ══════════════════════════════════════════════════════════════════════════

  app.get('/api/scrutineer/overview', wrap((req, res) => {
    const tid = req.query.tournament_id || req.query.tid;
    let comp = tid ? db.prepare('SELECT * FROM competition WHERE src_id=?').get(tid) : null;
    if (!comp) comp = getActiveCompetition(db);
    if (!comp) return res.json({ categories: [], numberingRequired: false });

    const cats = db.prepare(
      `SELECT id, src_id, name, status, category_order, session_number, session_time,
              judging_system, chairman_confirmed, finals_count
       FROM category WHERE competition_id=? ORDER BY session_number, category_order, name`
    ).all(comp.id);

    for (const c of cats) {
      c.entry_count = db.prepare("SELECT COUNT(*) n FROM entry WHERE category_id=? AND status!='withdrawn'").get(c.id).n;
      c.rounds = db.prepare('SELECT id, ordinal, kind, recall_count, status, num_heats FROM round WHERE category_id=? ORDER BY ordinal').all(c.id);
      for (const r of c.rounds) {
        r.dances = db.prepare('SELECT id, dance_code, dance_order FROM round_dance WHERE round_id=? ORDER BY dance_order').all(r.id);
        r.label  = roundLabel(r.kind);
      }
      c.suggested_first_round = suggestedFirstRound(c.entry_count, c.finals_count || 6);
    }

    const missingNums = db.prepare("SELECT COUNT(*) n FROM entry WHERE competition_id=? AND start_number IS NULL").get(comp.id).n;
    res.json({ categories: cats, numberingRequired: missingNums > 0, competition: comp });
  }));

  app.get('/api/scrutineer/round/:rid/progress', wrap((req, res) => {
    const rid = +req.params.rid;
    const dances = db.prepare('SELECT id, dance_code FROM round_dance WHERE round_id=? ORDER BY dance_order').all(rid);
    const round  = db.prepare('SELECT category_id, active_judges_limit FROM round WHERE id=?').get(rid);
    if (!round) return res.status(404).json({ error: 'Round not found' });

    let judges = db.prepare(
      `SELECT o.id, o.judge_letter, o.full_name FROM category_judge cj
       JOIN official o ON o.id=cj.official_id
       WHERE cj.category_id=? AND o.role='judge' ORDER BY o.judge_letter`
    ).all(round.category_id);

    if (!judges.length) {
      const cat = db.prepare('SELECT competition_id FROM category WHERE id=?').get(round.category_id);
      judges = db.prepare("SELECT id, judge_letter, full_name FROM official WHERE competition_id=? AND role='judge' ORDER BY judge_letter").all(cat.competition_id);
    }
    if (round.active_judges_limit) judges = judges.slice(0, round.active_judges_limit);

    const danceIds = dances.map(d => d.id);
    const rows = danceIds.length
      ? db.prepare(`SELECT round_dance_id, official_id FROM checksum WHERE round_dance_id IN (${danceIds.map(() => '?').join(',')})`).all(...danceIds)
      : [];
    const done = new Set(rows.map(r => r.round_dance_id + ':' + r.official_id));

    res.json({
      dances, judges,
      matrix: dances.map(d => ({
        roundDanceId: d.id, dance: d.dance_code,
        confirmed: judges.map(j => ({ officialId: j.id, letter: j.judge_letter, done: done.has(d.id + ':' + j.id) })),
      })),
    });
  }));

  app.get('/api/scrutineer/round-dance/:rdid/draw', wrap((req, res) => {
    const rows = db.prepare(
      `SELECT he.entry_id, he.heat_number, he.order_index,
              e.start_number, e.name1, e.name2
       FROM heat_entry he JOIN entry e ON e.id=he.entry_id
       WHERE he.round_dance_id=?
       ORDER BY he.heat_number, he.order_index, e.start_number`
    ).all(+req.params.rdid);
    res.json(rows);
  }));

  app.get('/api/scrutineer/round/:rid/results', wrap((req, res) => {
    const round = db.prepare('SELECT * FROM round WHERE id=?').get(+req.params.rid);
    if (!round) return res.status(404).json({ error: 'Round not found' });
    if (round.kind === 'grading') {
      const rows = db.prepare(
        `SELECT e.start_number AS number, e.name1, e.name2, e.grade, e.grade_average, e.disqualified
         FROM entry e
         WHERE e.category_id=? AND e.grade IS NOT NULL
         ORDER BY e.grade_average DESC, e.start_number`
      ).all(round.category_id);
      return res.json({ kind: 'grading', label: 'Grading', rows });
    }
    if (round.kind === 'final') {
      const rows = db.prepare(
        `SELECT p.place, p.tie, e.start_number AS number, e.name1, e.name2, e.disqualified
         FROM placing p JOIN entry e ON e.id=p.entry_id
         WHERE p.category_id=? ORDER BY p.place, e.start_number`
      ).all(round.category_id);
      return res.json({ kind: 'final', label: 'Final', rows });
    }
    const rows = db.prepare(
      `SELECT rr.crosses, rr.recalled, rr.borderline_tie,
              e.start_number AS number, e.name1, e.name2, e.disqualified
       FROM recall_result rr JOIN entry e ON e.id=rr.entry_id
       WHERE rr.round_id=? ORDER BY rr.recalled DESC, rr.crosses DESC, e.start_number`
    ).all(round.id);
    res.json({ kind: 'recall', label: roundLabel(round.kind), rows });
  }));

  app.post('/api/scrutineer/round/:rid/recall', wrap((req, res) => {
    const r = results.computeRecall(db, +req.params.rid);
    autoBackup();
    broadcast('round:result', { roundId: +req.params.rid, kind: 'recall' });
    res.json(r);
  }));

  app.post('/api/scrutineer/round/:rid/final', wrap((req, res) => {
    const r = results.computeFinal(db, +req.params.rid);
    autoBackup();
    broadcast('round:result', { roundId: +req.params.rid, kind: 'final' });
    res.json(r);
  }));

  app.post('/api/scrutineer/round/:rid/move-heat', wrap((req, res) => {
    const { entryId, heatNumber, orderIndex, roundDanceId } = req.body;
    db.prepare('UPDATE heat_entry SET heat_number=?, order_index=? WHERE round_dance_id=? AND entry_id=?')
      .run(heatNumber, orderIndex, roundDanceId, entryId);
    broadcast('draw:update', { roundId: +req.params.rid });
    res.json({ ok: true });
  }));

  app.post('/api/scrutineer/round/:rid/next-round', wrap(async (req, res) => {
    const prevRound = db.prepare('SELECT * FROM round WHERE id=?').get(+req.params.rid);
    if (!prevRound) return res.status(404).json({ error: 'Round not found' });
    if (prevRound.status !== 'closed') return res.status(400).json({ error: 'Round must be closed before creating the next one.' });

    const recalledCount = db.prepare('SELECT COUNT(*) n FROM recall_result WHERE round_id=? AND recalled=1').get(prevRound.id).n;
    if (recalledCount === 0) return res.status(400).json({ error: 'No recalled entries.' });

    const cat = db.prepare('SELECT finals_count FROM category WHERE id=?').get(prevRound.category_id);
    const finalsCount = cat?.finals_count || 6;
    const { kind, recallCount } = nextRoundKind(prevRound.kind, recalledCount, finalsCount);
    const drawMode = kind === 'final' ? 'fixed_heats' : 'random_all_same';
    const prevDances = db.prepare('SELECT dance_code FROM round_dance WHERE round_id=? ORDER BY dance_order').all(prevRound.id);

    const round = createRound(db, prevRound.category_id, {
      ordinal: prevRound.ordinal + 1,
      kind, dances: prevDances.map(d => d.dance_code), recallCount, drawMode,
      starCouplesEnabled: prevRound.star_couples_enabled === 1,
    });
    if (prevRound.active_judges_limit)
      db.prepare('UPDATE round SET active_judges_limit=? WHERE id=?').run(prevRound.active_judges_limit, round.id);

    const draw = drawRound(db, round.id);
    broadcast('round:created', { roundId: round.id, kind });
    res.json({ ok: true, roundId: round.id, kind: roundLabel(kind), numHeats: draw.numHeats });
  }));

  // ══════════════════════════════════════════════════════════════════════════
  // JUDGE: marking
  // ══════════════════════════════════════════════════════════════════════════

  app.get('/api/judge/:oid/active-dance', wrap((req, res) => {
    const comp = getActiveCompetition(db);
    if (!comp) return res.json({ activeDanceId: null });
    const activeRound = db.prepare(
      `SELECT rd.id, r.active_judges_limit, r.category_id FROM round_dance rd
       JOIN round r ON r.id=rd.round_id JOIN category c ON c.id=r.category_id
       WHERE r.status='judging' AND c.competition_id=? LIMIT 1`
    ).get(comp.id);
    if (!activeRound) return res.json({ activeDanceId: null });

    const assigned = db.prepare('SELECT official_id FROM category_judge WHERE category_id=?').all(activeRound.category_id);
    if (assigned.length > 0 && !assigned.some(a => a.official_id === +req.params.oid))
      return res.json({ activeDanceId: null, notAssigned: true });

    res.json({ activeDanceId: activeRound.id });
  }));

  app.get('/api/judge/:oid/active-round', wrap((req, res) => {
    const oid  = +req.params.oid;
    const comp = getActiveCompetition(db);
    if (!comp) return res.json({ activeRoundId: null });

    const activeRound = db.prepare(
      `SELECT r.id, r.kind, r.active_judges_limit, r.category_id, c.name AS category_name
       FROM round r JOIN category c ON c.id=r.category_id
       WHERE r.status='judging' AND c.competition_id=? LIMIT 1`
    ).get(comp.id);
    if (!activeRound) return res.json({ activeRoundId: null });

    const assigned = db.prepare('SELECT official_id FROM category_judge WHERE category_id=?').all(activeRound.category_id);
    if (assigned.length > 0 && !assigned.some(a => a.official_id === oid))
      return res.json({ activeRoundId: null, notAssigned: true });

    const dances = db.prepare('SELECT id, dance_code, dance_order FROM round_dance WHERE round_id=? ORDER BY dance_order').all(activeRound.id);
    const checkStmt = db.prepare('SELECT id, signed_at FROM checksum WHERE round_dance_id=? AND official_id=?');
    for (const d of dances) {
      const chk = checkStmt.get(d.id, oid);
      d.confirmed = !!chk;
      d.signed = chk && chk.signed_at != null;
    }

    res.json({
      activeRoundId: activeRound.id,
      categoryName: activeRound.category_name,
      kind: roundLabel(activeRound.kind),
      isFinal: activeRound.kind === 'final',
      locked: security.isLocked(db),
      dances
    });
  }));

  app.get('/api/judge/:oid/dance/:rdid', wrap((req, res) => {
    const oid = +req.params.oid, rdid = +req.params.rdid;
    const rd = db.prepare('SELECT round_id FROM round_dance WHERE id=?').get(rdid);
    if (rd) {
      const round = db.prepare('SELECT active_judges_limit, category_id FROM round WHERE id=?').get(rd.round_id);
      if (round?.active_judges_limit) {
        let judges = db.prepare(
          `SELECT o.id FROM category_judge cj
           JOIN official o ON o.id=cj.official_id
           WHERE cj.category_id=? AND o.role='judge' ORDER BY o.judge_letter`
        ).all(round.category_id);
        if (!judges.length) {
          const cat = db.prepare('SELECT competition_id FROM category WHERE id=?').get(round.category_id);
          judges = db.prepare("SELECT id FROM official WHERE competition_id=? AND role='judge' ORDER BY judge_letter").all(cat.competition_id);
        }
        if (!judges.slice(0, round.active_judges_limit).some(j => j.id === oid))
          return res.status(403).json({ error: 'Not assigned to this round.' });
      }
    }
    res.json(J.getMarkingView(db, rdid, oid));
  }));

  app.post('/api/judge/:oid/dance/:rdid/place', wrap((req, res) => {
    if (security.isLocked(db)) return res.status(403).json({ error: 'Competition is locked.' });
    const r = J.setPlace(db, +req.params.rdid, +req.params.oid, req.body.entryId, req.body.place);
    if (r.ok) broadcast('mark:update', { roundDanceId: +req.params.rdid, officialId: +req.params.oid });
    res.json(r);
  }));

  app.post('/api/judge/:oid/dance/:rdid/components', wrap((req, res) => {
    if (security.isLocked(db)) return res.status(403).json({ error: 'Competition is locked.' });
    const r = J.setComponents(db, +req.params.rdid, +req.params.oid, req.body.entryId, req.body);
    if (r.ok) broadcast('mark:update', { roundDanceId: +req.params.rdid, officialId: +req.params.oid });
    res.json(r);
  }));

  app.post('/api/judge/:oid/dance/:rdid/cross', wrap((req, res) => {
    if (security.isLocked(db)) return res.status(403).json({ error: 'Competition is locked.' });
    const r = J.setCross(db, +req.params.rdid, +req.params.oid, req.body.entryId, req.body.value);
    if (r.ok) broadcast('mark:update', { roundDanceId: +req.params.rdid, officialId: +req.params.oid });
    res.json(r);
  }));

  app.post('/api/judge/:oid/dance/:rdid/score', wrap((req, res) => {
    if (security.isLocked(db)) return res.status(403).json({ error: 'Competition is locked.' });
    const r = J.setScore(db, +req.params.rdid, +req.params.oid, req.body.entryId, req.body.value);
    if (r.ok) broadcast('mark:update', { roundDanceId: +req.params.rdid, officialId: +req.params.oid });
    res.json(r);
  }));

  app.post('/api/judge/:oid/dance/:rdid/help', wrap((req, res) => {
    if (security.isLocked(db)) return res.status(403).json({ error: 'Competition is locked.' });
    res.json(J.setHelp(db, +req.params.rdid, +req.params.oid, req.body.entryId, req.body.value));
  }));

  app.post('/api/judge/:oid/dance/:rdid/confirm', wrap((req, res) => {
    if (security.isLocked(db)) return res.status(403).json({ error: 'Competition is locked.' });
    const r = J.confirmDance(db, +req.params.rdid, +req.params.oid);
    if (r.ok) broadcast('dance:confirmed', { roundDanceId: +req.params.rdid, officialId: +req.params.oid, checksum: r.checksum?.value });
    res.json(r);
  }));

  app.post('/api/judge/:oid/dance/:rdid/sign', wrap((req, res) => {
    if (security.isLocked(db)) return res.status(403).json({ error: 'Competition is locked.' });
    res.json(J.signChecksum(db, +req.params.rdid, +req.params.oid, req.body.signature));
  }));

  app.post('/api/judge/:oid/dance/:rdid/unconfirm', wrap((req, res) => {
    if (security.isLocked(db)) return res.status(403).json({ error: 'Competition is locked.' });
    
    // Check if it is already signed
    const chk = db.prepare('SELECT signed_at FROM checksum WHERE round_dance_id=? AND official_id=?').get(+req.params.rdid, +req.params.oid);
    if (chk && chk.signed_at) {
      return res.status(400).json({ error: 'Already signed. Cannot unconfirm.' });
    }
    
    db.prepare('DELETE FROM checksum WHERE round_dance_id=? AND official_id=?').run(+req.params.rdid, +req.params.oid);
    res.json({ ok: true });
  }));

  app.post('/api/scrutineer/dance/:rdid/open', wrap((req, res) => {
    const rd = db.prepare('SELECT id, dance_code, round_id FROM round_dance WHERE id=?').get(+req.params.rdid);
    if (!rd) return res.status(404).json({ error: 'round_dance not found' });
    db.prepare("UPDATE round SET status='judging' WHERE id=?").run(rd.round_id);
    broadcast('dance:open', { roundDanceId: rd.id, dance: rd.dance_code });
    res.json({ ok: true, dance: rd.dance_code });
  }));

  app.post('/api/scrutineer/dance/:rdid/reopen/:oid', wrap((req, res) => {
    if (!requireChairman(req, res)) return;
    const r = J.reopenDance(db, +req.params.rdid, +req.params.oid);
    broadcast('dance:reopened', { roundDanceId: +req.params.rdid, officialId: +req.params.oid });
    res.json(r);
  }));

  const close = () => new Promise((resolve) => {
    wss.close(() => {
      server.close(() => {
        resolve();
      });
    });
  });

  return { app, server, broadcast, close };
}

module.exports = { createServer };
