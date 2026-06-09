# Telemark.one

WDSF scrutineering software, synced with dancesport.ge. Runs on a venue
laptop; judge tablets connect over WiFi/LAN. Works fully offline.

## Run (local — for real events)

```bash
npm install
npm start                 # http://localhost:4000
npm test                  # 31 tests
```

- Scrutineer:  `http://localhost:4000/scrutineer.html`
- Judges:      `http://<server-ip>:4000/judge.html`

Config via env: `PORT`, `DB`, `BACKUP_DIR`, `SEED`, `SUPABASE_URL`,
`SUPABASE_KEY`, `WDSF_URL`, `WDSF_KEY`.

## Deploy (online demo)

Telemark needs a persistent host with WebSocket support — **Railway** or
**Render**, NOT Vercel (serverless can't hold WebSocket/SQLite).

Railway: New Project → Deploy from GitHub repo → pick `telemark`. It reads
`.nvmrc` (Node 22) and runs `npm start`. Add env `SEED=1` for demo data.
Add a Volume mounted at `/data` and set `DB=/data/telemark.db` to persist.

Render: New → Blueprint → select the repo (`render.yaml` configures Node 22,
seed, and a 1 GB disk at `/data` automatically).

Demo chairman PIN is `1234`. Root `/` redirects to the scrutineer screen.

## Lifecycle

dancesport.ge → pull → numbering → draw → judge tablets (WiFi) → skating
→ scrutineer/chairman → print-outs → push result_place + WDSF export.

## Layout

```
src/
  core/
    skating.js     rules 1-11 (final, multi-dance, recall)
    numbering.js   continuous start numbers by category_order
    draw.js        heats: random_per_dance | random_all_same | fixed_heats + seeding
    judging.js     marking, checksum, helpmarks, confirm/lock/sign
    results.js     marks -> skating engine -> placings
    security.js    chairman PIN (PBKDF2), sessions, lock
    backup.js      VACUUM INTO snapshots
    printouts.js   print-ready A4 HTML (Latin)
  sync/
    supabaseClient.js  dancesport.ge REST (pull + pushResult)
    pull.js            pull competition + numbering source
    push.js            results -> result_place
    wdsfExport.js      WDSF payload / HTML / send
  server.js        Express REST + WebSocket
  db.js            SQLite (node:sqlite) + audit
db/schema.sql      15 tables (mirror + scrutiny)
public/            judge.html, scrutineer.html
index.js           entry point
```

## WDSF certification coverage

- Section 1 (security): chairman PIN, protected reopen, lock, backup.
- Section 2 (calculation): skating rules 1-11, multi-dance, recall, redance flag.
- Section 3 (print-outs): couples, draw by heats, judging sheets,
  checksum report (3 signed copies), results + skating table, officials,
  missing/excused — all in Latin.
- Section 4 (export): WDSF payload + send, missing couples, HTML export,
  dancesport.ge result push.
- Section 5 (general): draw modes, recall count, seeding, missing/excused.
- Section 7 (tablets): heat-by-heat marking, confirm per dance, on-device
  checksum, helpmarks, judge signature, lock after confirm.

## Remaining for live certification

1. WDSF MIN: confirm the athletes table field and attach min1/min2 at sync
   (payload already carries the slot).
2. Real credentials: dancesport.ge service key + WDSF API endpoint/key.
3. Run the official WDSF test cases against `placeFinal` /
   `placeMultiDanceFinal` to certify rule output.
4. Confirm the full `tournaments` table columns (the export looked truncated).
```
