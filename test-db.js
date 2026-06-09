const fs = require('fs');
const zlib = require('zlib');
const env = fs.readFileSync('.env', 'utf8');
const url = env.match(/SUPABASE_URL=(.*)/)[1].replace(/\/$/, '') + '/rest/v1';
const key = env.match(/SUPABASE_KEY=(.*)/)[1];

async function run() {
  const res = await fetch(`${url}/telemark_db_state?id=eq.1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  const rows = await res.json();
  if (!rows || rows.length === 0) { console.log('Empty DB'); return; }
  let buf = Buffer.from(rows[0].db_base64, 'base64');
  let isZipped = false;
  try {
    buf = zlib.gunzipSync(buf);
    isZipped = true;
  } catch (e) {
    console.log('Not zipped or corrupt');
  }
  console.log(`DB size: ${buf.length} bytes, zipped: ${isZipped}`);
  fs.writeFileSync('downloaded.db', buf);
}
run();
