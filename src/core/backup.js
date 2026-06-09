'use strict';

/**
 * Backups (WDSF 1.4 / 7.1 crash recovery).
 * Each backup is a complete, consistent SQLite copy made with VACUUM INTO.
 * Auto-backup is triggered on key events (round computed) by the server.
 */

const fs = require('fs');
const path = require('path');
const { audit } = require('../db');

function backupNow(db, dir = 'backups') {
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `telemark-${ts}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  audit(db, 'system', 'backup.create', { file });
  return file;
}

/** keep only the newest `keep` backups */
function prune(dir = 'backups', keep = 30) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter((f) => f.startsWith('telemark-') && f.endsWith('.db'))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  const removed = [];
  for (const { f } of files.slice(keep)) {
    fs.unlinkSync(path.join(dir, f));
    removed.push(f);
  }
  return removed;
}

function listBackups(dir = 'backups') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.startsWith('telemark-') && f.endsWith('.db'))
    .sort()
    .reverse();
}

module.exports = { backupNow, prune, listBackups };
