'use strict';

const crypto = require('crypto');
const { audit } = require('../db');

function hashPin(pin, salt) {
  return crypto.pbkdf2Sync(String(pin), salt, 120000, 32, 'sha256').toString('hex');
}

function isPinSet(db) {
  const s = db.prepare('SELECT chairman_pin_hash FROM sync_state WHERE id=1').get();
  return !!(s && s.chairman_pin_hash);
}

function setChairmanPin(db, pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPin(pin, salt);
  // INSERT OR REPLACE guarantees id=1 row exists
  db.prepare(
    `INSERT INTO sync_state (id, chairman_pin_hash, chairman_pin_salt)
     VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET chairman_pin_hash=excluded.chairman_pin_hash,
                                    chairman_pin_salt=excluded.chairman_pin_salt`
  ).run(hash, salt);
  audit(db, 'chairman', 'chairman.pin_set', null);
  return true;
}

function verifyPin(db, pin) {
  const s = db.prepare('SELECT chairman_pin_hash, chairman_pin_salt FROM sync_state WHERE id=1').get();
  if (!s || !s.chairman_pin_hash) return false;
  const got  = Buffer.from(hashPin(pin, s.chairman_pin_salt), 'hex');
  const want = Buffer.from(s.chairman_pin_hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function resetPin(db) {
  db.prepare('UPDATE sync_state SET chairman_pin_hash=NULL, chairman_pin_salt=NULL WHERE id=1').run();
  audit(db, 'system', 'chairman.pin_reset', null);
}

function setLocked(db, locked) {
  const { getActiveCompetition } = require('../db');
  const c = getActiveCompetition(db);
  if (!c) return;
  db.prepare('UPDATE competition SET is_locked=? WHERE id=?').run(locked ? 1 : 0, c.id);
  audit(db, 'chairman', locked ? 'comp.lock' : 'comp.unlock', null);
}

function isLocked(db) {
  const { getActiveCompetition } = require('../db');
  const c = getActiveCompetition(db);
  return !c || c.is_locked === 1;
}

function createSessionStore(db, ttlMs = 8 * 60 * 60 * 1000) {
  return {
    issue() {
      const t = crypto.randomBytes(24).toString('hex');
      db.prepare('INSERT INTO auth_session (token, expires_at) VALUES (?, ?)').run(t, Date.now() + ttlMs);
      return t;
    },
    valid(t) {
      if (!t) return false;
      const s = db.prepare('SELECT expires_at FROM auth_session WHERE token=?').get(t);
      if (!s) return false;
      if (Date.now() > s.expires_at) {
        db.prepare('DELETE FROM auth_session WHERE token=?').run(t);
        return false;
      }
      return true;
    },
    revoke(t) {
      if (t) db.prepare('DELETE FROM auth_session WHERE token=?').run(t);
    },
    cleanup() {
      db.prepare('DELETE FROM auth_session WHERE expires_at < ?').run(Date.now());
    },
  };
}

module.exports = { hashPin, isPinSet, setChairmanPin, verifyPin, resetPin, setLocked, isLocked, createSessionStore };
