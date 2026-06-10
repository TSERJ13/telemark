-- =====================================================================
-- Telemark.one — local scrutineering database (SQLite)
-- =====================================================================
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------
-- A) MIRROR LAYER
-- ---------------------------------------------------------------------

CREATE TABLE scrutineer_user (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  password_salt   TEXT NOT NULL,
  has_license     INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT DEFAULT (datetime('now'))
);

CREATE TABLE competition (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  src_id            TEXT UNIQUE,
  name              TEXT NOT NULL,
  event_date        TEXT,
  location          TEXT,
  organizer_names   TEXT,
  is_locked         INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT DEFAULT (datetime('now')),
  synced_at         TEXT
);

CREATE TABLE category (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  src_id              TEXT UNIQUE,
  competition_id      INTEGER NOT NULL REFERENCES competition(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  allowed_classes     TEXT,
  min_age             INTEGER DEFAULT 0,
  max_age             INTEGER DEFAULT 99,
  session_number      INTEGER DEFAULT 0,
  session_time        TEXT,
  category_order      INTEGER DEFAULT 0,
  entry_fee           REAL DEFAULT 0,
  discipline          TEXT,
  dances              TEXT,
  judging_system      TEXT DEFAULT 'skating',
  -- Chairman workflow
  chairman_confirmed  INTEGER DEFAULT 0,   -- 1 = chairman approved structure
  finals_count        INTEGER DEFAULT 6,   -- how many couples reach the final (1-6 places)
  -- Status
  status              TEXT DEFAULT 'pending',
  synced_at           TEXT
);

CREATE TABLE official (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  src_id          TEXT UNIQUE,
  competition_id  INTEGER NOT NULL REFERENCES competition(id) ON DELETE CASCADE,
  full_name       TEXT NOT NULL,
  role            TEXT DEFAULT 'judge',
  judge_letter    TEXT,
  wdsf_min        TEXT,
  studio_name     TEXT,
  pin_hash        TEXT,
  pin_salt        TEXT,
  synced_at       TEXT
);

CREATE TABLE entry (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  src_id            TEXT UNIQUE,
  competition_id    INTEGER NOT NULL REFERENCES competition(id) ON DELETE CASCADE,
  category_id       INTEGER NOT NULL REFERENCES category(id) ON DELETE CASCADE,
  start_number      INTEGER,
  athlete1_src_id   TEXT,
  name1             TEXT NOT NULL,
  name1_ka          TEXT,
  athlete2_src_id   TEXT,
  name2             TEXT,
  name2_ka          TEXT,
  studio_src_id     TEXT,
  studio_name       TEXT,
  is_present        INTEGER NOT NULL DEFAULT 1,
  status            TEXT DEFAULT 'active',
  is_seeded         INTEGER NOT NULL DEFAULT 0,
  added_manually    INTEGER NOT NULL DEFAULT 0,
  final_place       INTEGER,
  grade             TEXT,
  grade_average     REAL,
  disqualified      INTEGER NOT NULL DEFAULT 0,
  dq_reason         TEXT,
  synced_at         TEXT
);

-- ---------------------------------------------------------------------
-- B) SCRUTINY LAYER
-- ---------------------------------------------------------------------

CREATE TABLE round (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id           INTEGER NOT NULL REFERENCES category(id) ON DELETE CASCADE,
  ordinal               INTEGER NOT NULL,
  kind                  TEXT NOT NULL,
  -- kind values: final|semifinal|quarterfinal|r8|r16|r32|r64|r128|redance
  -- places:      1-6  | 7-12      | 13-24      |25-48|49-96|97-192|193-384|385+
  recall_count          INTEGER,
  draw_mode             TEXT DEFAULT 'random_per_dance',
  num_heats             INTEGER DEFAULT 1,
  status                TEXT DEFAULT 'pending',
  active_judges_limit   INTEGER,
  star_couples_enabled  INTEGER DEFAULT 0,
  created_at            TEXT DEFAULT (datetime('now')),
  UNIQUE(category_id, ordinal)
);

CREATE TABLE round_dance (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id    INTEGER NOT NULL REFERENCES round(id) ON DELETE CASCADE,
  dance_code  TEXT NOT NULL,
  dance_order INTEGER NOT NULL,
  UNIQUE(round_id, dance_code)
);

CREATE TABLE heat_entry (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  round_dance_id INTEGER NOT NULL REFERENCES round_dance(id) ON DELETE CASCADE,
  entry_id       INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  heat_number    INTEGER NOT NULL DEFAULT 1,
  order_index    INTEGER NOT NULL DEFAULT 0,
  UNIQUE(round_dance_id, entry_id)
);

CREATE TABLE mark (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  round_dance_id INTEGER NOT NULL REFERENCES round_dance(id) ON DELETE CASCADE,
  official_id    INTEGER NOT NULL REFERENCES official(id) ON DELETE CASCADE,
  entry_id       INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  place          INTEGER,
  cross_mark     INTEGER DEFAULT 0,
  is_helpmark    INTEGER DEFAULT 0,
  score_tq       REAL,
  score_mm       REAL,
  score_ps       REAL,
  score_cp       REAL,
  grade_score    REAL,
  confirmed_at   TEXT,
  UNIQUE(round_dance_id, official_id, entry_id)
);

CREATE TABLE checksum (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  round_dance_id INTEGER NOT NULL REFERENCES round_dance(id) ON DELETE CASCADE,
  official_id    INTEGER NOT NULL REFERENCES official(id) ON DELETE CASCADE,
  value          TEXT NOT NULL,
  signed_at      TEXT,
  signature_blob TEXT,
  UNIQUE(round_dance_id, official_id)
);

CREATE TABLE recall_result (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id        INTEGER NOT NULL REFERENCES round(id) ON DELETE CASCADE,
  entry_id        INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  crosses         INTEGER NOT NULL DEFAULT 0,
  recalled        INTEGER NOT NULL DEFAULT 0,
  borderline_tie  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(round_id, entry_id)
);

CREATE TABLE placing (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id   INTEGER NOT NULL REFERENCES category(id) ON DELETE CASCADE,
  entry_id      INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  place         INTEGER NOT NULL,
  tie           INTEGER NOT NULL DEFAULT 0,
  computed_at   TEXT DEFAULT (datetime('now')),
  pushed_at     TEXT,
  UNIQUE(category_id, entry_id)
);

CREATE TABLE category_judge (
  category_id INTEGER NOT NULL REFERENCES category(id) ON DELETE CASCADE,
  official_id INTEGER NOT NULL REFERENCES official(id) ON DELETE CASCADE,
  PRIMARY KEY (category_id, official_id)
);

CREATE TABLE auth_session (
  token       TEXT PRIMARY KEY,
  expires_at  INTEGER NOT NULL
);

-- ---------------------------------------------------------------------
-- Sync + audit
-- ---------------------------------------------------------------------
CREATE TABLE sync_state (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  last_pull_at          TEXT,
  last_push_at          TEXT,
  dancesport_url        TEXT,
  chairman_pin_hash     TEXT,
  chairman_pin_salt     TEXT,
  active_competition_id INTEGER REFERENCES competition(id) ON DELETE SET NULL
);
INSERT INTO sync_state (id) VALUES (1);

CREATE TABLE audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT DEFAULT (datetime('now')),
  actor   TEXT,
  action  TEXT,
  detail  TEXT
);

-- Indexes
CREATE INDEX idx_entry_category   ON entry(category_id);
CREATE INDEX idx_entry_comp       ON entry(competition_id);
CREATE INDEX idx_mark_rd          ON mark(round_dance_id);
CREATE INDEX idx_mark_entry       ON mark(entry_id);
CREATE INDEX idx_round_category   ON round(category_id);
CREATE INDEX idx_heat_rd          ON heat_entry(round_dance_id);
