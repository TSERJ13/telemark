'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs   = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA_PATH = path.join(__dirname, '..', 'db', 'schema.sql');

/**
 * Round kind helpers — single source of truth for the progression ladder.
 *
 * Ladder (min couples that need this round):
 *   final        ≤ 6  (or up to 8 if chairman chose finals_count=8)
 *   semifinal    7-12   places 7-12
 *   quarterfinal 13-24  places 13-24
 *   r8           25-48  places 25-48  (1/8 final)
 *   r16          49-96  places 49-96  (1/16 final)
 *   r32          97-192
 *   r64          193-384
 *   r128         385+
 */
const ROUND_LADDER = [
  { kind: 'r128',         minCouples: 385, recallTo: 192 },
  { kind: 'r64',          minCouples: 193, recallTo: 96  },
  { kind: 'r32',          minCouples: 97,  recallTo: 48  },
  { kind: 'r16',          minCouples: 49,  recallTo: 24  },
  { kind: 'r8',           minCouples: 25,  recallTo: 12  },
  { kind: 'quarterfinal', minCouples: 13,  recallTo: 6   },
  { kind: 'semifinal',    minCouples: 7,   recallTo: 6   },
  { kind: 'final',        minCouples: 1,   recallTo: null },
];

/** Given entry count and finals_count, return the first round kind + recallCount */
function firstRoundKind(entryCount, finalsCount = 6) {
  for (const step of ROUND_LADDER) {
    if (entryCount >= step.minCouples) {
      // recallTo is dynamic for the first two rounds based on finals_count
      let recall = step.recallTo;
      if (step.kind === 'semifinal') recall = finalsCount;
      if (step.kind === 'quarterfinal') recall = Math.min(12, finalsCount * 2);
      return { kind: step.kind, recallCount: recall };
    }
  }
  return { kind: 'final', recallCount: null };
}

/** Given the count of recalled couples, return the next round kind */
function nextRoundKind(recalledCount, finalsCount = 6) {
  return firstRoundKind(recalledCount, finalsCount);
}

/** Human-readable label for a round kind */
function roundLabel(kind) {
  const MAP = {
    final: 'Final', semifinal: 'Semifinal', quarterfinal: '1/4 Final',
    r8: '1/8 Final', r16: '1/16 Final', r32: '1/32 Final',
    r64: '1/64 Final', r128: '1/128 Final', redance: 'Redance',
  };
  return MAP[kind] || kind;
}

/** Place range for a round kind */
function placeRange(kind, finalsCount = 6) {
  const MAP = {
    final:        [1,  finalsCount],
    semifinal:    [finalsCount + 1, 12],
    quarterfinal: [13, 24],
    r8:           [25, 48],
    r16:          [49, 96],
    r32:          [97, 192],
    r64:          [193, 384],
    r128:         [385, 768],
  };
  return MAP[kind] || [null, null];
}

function openDb(file = ':memory:', opts = {}) {
  if (file !== ':memory:') {
    const dir = path.dirname(file);
    if (dir && dir !== '.' && !fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`[DB] Created directory: ${dir}`);
      } catch (e) {
        console.error(`[DB] Failed to create directory ${dir}:`, e.message);
      }
    }
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');

  if (opts.applySchema !== false) {
    const alreadyHas = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='competition'")
      .get();

    if (!alreadyHas) {
      const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
      db.exec(sql);
      // Insert default scrutineer user
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.pbkdf2Sync('@Kjkszpj13', salt, 120000, 32, 'sha256').toString('hex');
      try {
        db.prepare("INSERT OR IGNORE INTO scrutineer_user (email, password_hash, password_salt, has_license) VALUES (?, ?, ?, ?)")
          .run('dancesportgeo@gmail.com', hash, salt, 1);
      } catch (_) {}
    } else {
      // ── migrations ──────────────────────────────────────────────────
      const colNames = (tbl) => db.prepare(`PRAGMA table_info(${tbl})`).all().map(c => c.name);

      const roundCols = colNames('round');
      if (!roundCols.includes('active_judges_limit'))
        db.exec('ALTER TABLE round ADD COLUMN active_judges_limit INTEGER;');
      if (!roundCols.includes('star_couples_enabled'))
        db.exec('ALTER TABLE round ADD COLUMN star_couples_enabled INTEGER DEFAULT 0;');

      const markCols = colNames('mark');
      if (!markCols.includes('score_tq')) {
        db.exec('ALTER TABLE mark ADD COLUMN score_tq REAL;');
        db.exec('ALTER TABLE mark ADD COLUMN score_mm REAL;');
        db.exec('ALTER TABLE mark ADD COLUMN score_ps REAL;');
        db.exec('ALTER TABLE mark ADD COLUMN score_cp REAL;');
      }

      const heCols = colNames('heat_entry');
      if (!heCols.includes('order_index'))
        db.exec('ALTER TABLE heat_entry ADD COLUMN order_index INTEGER DEFAULT 0;');

      const catCols = colNames('category');
      if (!catCols.includes('chairman_confirmed'))
        db.exec('ALTER TABLE category ADD COLUMN chairman_confirmed INTEGER DEFAULT 0;');
      if (!catCols.includes('finals_count'))
        db.exec('ALTER TABLE category ADD COLUMN finals_count INTEGER DEFAULT 6;');
      if (!catCols.includes('first_round_kind'))
        db.exec('ALTER TABLE category ADD COLUMN first_round_kind TEXT;');

      const entryCols = colNames('entry');
      if (!entryCols.includes('disqualified'))
        db.exec('ALTER TABLE entry ADD COLUMN disqualified INTEGER NOT NULL DEFAULT 0;');
      if (!entryCols.includes('dq_reason'))
        db.exec('ALTER TABLE entry ADD COLUMN dq_reason TEXT;');

      // category_judge
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='category_judge'").get())
        db.exec(`CREATE TABLE category_judge (
          category_id INTEGER NOT NULL REFERENCES category(id) ON DELETE CASCADE,
          official_id INTEGER NOT NULL REFERENCES official(id) ON DELETE CASCADE,
          PRIMARY KEY (category_id, official_id)
        )`);

      // auth_session
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='auth_session'").get())
        db.exec(`CREATE TABLE auth_session (
          token TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL
        )`);

      // scrutineer_user
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scrutineer_user'").get()) {
        db.exec(`CREATE TABLE scrutineer_user (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          email         TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          password_salt TEXT NOT NULL,
          has_license   INTEGER NOT NULL DEFAULT 0,
          created_at    TEXT DEFAULT (datetime('now'))
        )`);
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.pbkdf2Sync('@Kjkszpj13', salt, 120000, 32, 'sha256').toString('hex');
        db.prepare("INSERT OR IGNORE INTO scrutineer_user (email,password_hash,password_salt,has_license) VALUES(?,?,?,?)")
          .run('dancesportgeo@gmail.com', hash, salt, 1);
      }

      // sync_state columns
      const ssCols = colNames('sync_state');
      if (!ssCols.includes('chairman_pin_hash'))
        db.exec('ALTER TABLE sync_state ADD COLUMN chairman_pin_hash TEXT;');
      if (!ssCols.includes('chairman_pin_salt'))
        db.exec('ALTER TABLE sync_state ADD COLUMN chairman_pin_salt TEXT;');
      if (!ssCols.includes('active_competition_id'))
        db.exec('ALTER TABLE sync_state ADD COLUMN active_competition_id INTEGER REFERENCES competition(id) ON DELETE SET NULL;');

      // official.studio_name
      if (!colNames('official').includes('studio_name'))
        db.exec('ALTER TABLE official ADD COLUMN studio_name TEXT;');
    }

    // ── Criteria feature (additive; FlyMark-style artistic judging) ───
    // A flexible catalogue of scoring criteria (e.g. Technique, Musicality),
    // each scored on its own range (default 1-20). Used by criteria-based
    // categories instead of the fixed skating/WDSF components. Fully removable:
    // dropping this table + its routes + criteria.html leaves the app intact.
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='criteria'").get()) {
      db.exec(`CREATE TABLE criteria (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        competition_id INTEGER REFERENCES competition(id) ON DELETE CASCADE,
        name           TEXT NOT NULL,
        name_en        TEXT,
        range_min      INTEGER NOT NULL DEFAULT 1,
        range_max      INTEGER NOT NULL DEFAULT 20,
        sort_order     INTEGER NOT NULL DEFAULT 0,
        allow_double   INTEGER NOT NULL DEFAULT 0,
        active         INTEGER NOT NULL DEFAULT 1,
        created_at     TEXT DEFAULT (datetime('now'))
      )`);
    }

    // Per-judge, per-entry, per-criterion scores (criteria-based categories).
    // Category-level (no round/dance needed) so it never interferes with the
    // existing skating/placement flow. Fully removable with the criteria feature.
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='criteria_mark'").get()) {
      db.exec(`CREATE TABLE criteria_mark (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id  INTEGER NOT NULL REFERENCES category(id) ON DELETE CASCADE,
        official_id  INTEGER NOT NULL REFERENCES official(id) ON DELETE CASCADE,
        entry_id     INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
        criterion_id INTEGER NOT NULL REFERENCES criteria(id) ON DELETE CASCADE,
        score        REAL,
        updated_at   TEXT DEFAULT (datetime('now')),
        UNIQUE(category_id, official_id, entry_id, criterion_id)
      )`);
    }

    // ── Guarantee sync_state id=1 always exists ──────────────────────
    const hasSyncRow = db.prepare('SELECT id FROM sync_state WHERE id=1').get();
    if (!hasSyncRow) {
      db.prepare('INSERT INTO sync_state (id) VALUES (1)').run();
    }

    // ── Auto-assign PINs to judges missing them ───────────────────────
    try {
      const noPinJudges = db.prepare("SELECT id FROM official WHERE role='judge' AND pin_hash IS NULL").all();
      if (noPinJudges.length) {
        const existingPins = new Set(
          db.prepare("SELECT pin_hash FROM official WHERE role='judge' AND pin_hash IS NOT NULL").all().map(r => r.pin_hash)
        );
        for (const j of noPinJudges) {
          let pin;
          do { pin = String(1000 + Math.floor(Math.random() * 9000)); } while (existingPins.has(pin));
          db.prepare('UPDATE official SET pin_hash=? WHERE id=?').run(pin, j.id);
          existingPins.add(pin);
        }
      }
    } catch (_) {}
  }

  return db;
}

function getActiveCompetition(db) {
  try {
    const state = db.prepare('SELECT active_competition_id FROM sync_state WHERE id=1').get();
    if (state && state.active_competition_id) {
      const comp = db.prepare('SELECT * FROM competition WHERE id=?').get(state.active_competition_id);
      if (comp) return comp;
    }
  } catch (_) {}
  return db.prepare('SELECT * FROM competition LIMIT 1').get();
}

function audit(db, actor, action, detail) {
  db.prepare('INSERT INTO audit_log (actor, action, detail) VALUES (?,?,?)').run(
    String(actor ?? 'system'),
    String(action),
    detail == null ? null : JSON.stringify(detail)
  );
}

function suggestedFirstRound(entryCount, finalsCount = 6) {
  if (entryCount >= 7 && entryCount <= 8) {
    return 'Final / 1/2 Final';
  }
  if (entryCount >= 13 && entryCount <= 15) {
    return '1/2 Final / 1/4 Final';
  }
  if (entryCount >= 25 && entryCount <= 27) {
    return '1/4 Final / 1/8 Final';
  }
  if (entryCount >= 49 && entryCount <= 51) {
    return '1/8 Final / 1/16 Final';
  }
  
  const { kind } = firstRoundKind(entryCount, finalsCount);
  return roundLabel(kind);
}

function getStartingRoundOptions(entryCount) {
  if (entryCount >= 7 && entryCount <= 8) {
    return [
      { kind: 'final', label: 'Final' },
      { kind: 'semifinal', label: 'Semifinal' }
    ];
  }
  if (entryCount >= 13 && entryCount <= 15) {
    return [
      { kind: 'semifinal', label: 'Semifinal' },
      { kind: 'quarterfinal', label: '1/4 Final' }
    ];
  }
  if (entryCount >= 25 && entryCount <= 27) {
    return [
      { kind: 'quarterfinal', label: '1/4 Final' },
      { kind: 'r8', label: '1/8 Final' }
    ];
  }
  if (entryCount >= 49 && entryCount <= 51) {
    return [
      { kind: 'r8', label: '1/8 Final' },
      { kind: 'r16', label: '1/16 Final' }
    ];
  }
  
  // Default: only one natural option
  const { kind } = firstRoundKind(entryCount);
  return [
    { kind, label: roundLabel(kind) }
  ];
}

module.exports = {
  openDb, getActiveCompetition, audit, SCHEMA_PATH,
  firstRoundKind, nextRoundKind, roundLabel, placeRange, ROUND_LADDER,
  suggestedFirstRound, getStartingRoundOptions,
};
