'use strict';

/**
 * Telemark.one — venue server entry point.
 *
 *   node index.js
 *   PORT=4000 DB_PATH=/data/telemark.db node index.js
 *
 * On Render.com: set DB_PATH=/data/telemark.db and mount a persistent disk at /data
 */

const os   = require('os');
const path = require('path');
const { openDb } = require('./src/db');
const { createServer } = require('./src/server');

const PORT    = process.env.PORT    || 4000;
const DB_PATH = process.env.DB_PATH || process.env.DB || 'telemark.db';

const db = openDb(DB_PATH);

const { server } = createServer(db, {
  backupDir: process.env.BACKUP_DIR || 'backups',
  supabase: {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_KEY,
  },
});

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  const ips = lanAddresses();
  console.log(`\n  Telemark.one  ·  DB: ${DB_PATH}`);
  console.log(`  ─────────────────────────────────────────────`);
  console.log(`  Scrutineer:  http://localhost:${PORT}/scrutineer.html`);
  console.log(`  Chairman:    http://localhost:${PORT}/chairman.html`);
  ips.forEach(ip => {
    console.log(`  Judges:      http://${ip}:${PORT}/judge.html`);
    console.log(`  Results:     http://${ip}:${PORT}/results.html`);
  });
  console.log(`  ─────────────────────────────────────────────\n`);
});
