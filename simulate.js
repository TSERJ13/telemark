const fs = require('fs');
const http = require('http');
const express = require('express');
const { openDb } = require('./src/db');
const { createServer } = require('./src/server');

// Mock fetch
const originalFetch = global.fetch;
const mockData = fs.readFileSync('mock.json', 'utf8');

global.fetch = async (url, options) => {
  if (url.includes('dancesport.ge')) {
    return {
      ok: true,
      json: async () => JSON.parse(mockData)
    };
  }
  return originalFetch(url, options);
};

// Start a local server without serverless mode
const app = express();
// Force in-memory DB
const db = openDb(':memory:', { applySchema: true });
createServer(app, db, { isServerless: false });

const server = http.createServer(app);
server.listen(0, async () => {
  const port = server.address().port;
  console.log(`Test server running on port ${port}`);

  async function POST(path, body = {}) {
    const res = await originalFetch(`http://127.0.5.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-chairman-token': 'MOCK' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function GET(path) {
    const res = await originalFetch(`http://127.0.5.1:${port}${path}`, {
      headers: { 'x-chairman-token': 'MOCK' }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  let errors = [];

  for (let i = 0; i < 100; i++) {
    try {
      // 1. Pull
      await POST('/api/pull-competition', { srcId: '288' });
      
      const overview = await GET('/api/scrutineer/overview');
      const cat = overview.categories[0];
      if (!cat) throw new Error('No categories pulled');

      // 2. Generate numbers
      await POST(`/api/scrutineer/category/${cat.id}/generate-numbers`, {});

      // 3. Init round
      await POST(`/api/scrutineer/category/${cat.id}/init-round`, { judgesLimit: null, starCouplesEnabled: false });

      // Run rounds until final
      while (true) {
        const catInfo = await GET(`/api/scrutineer/category/${cat.id}`);
        const activeRound = catInfo.rounds.find(r => r.status === 'running');
        if (!activeRound) break;

        // Fetch judges
        const judges = await GET(`/api/competition`).then(c => c.judges || []);
        const letters = judges.filter(j => j.letter).map(j => j.letter);

        // Simulate marking
        const dances = activeRound.dances;
        for (const dance of dances) {
          for (const letter of letters) {
            // Give everyone a recall or rank
            const marks = catInfo.entries.map(e => ({
              entry_id: e.id,
              mark: activeRound.kind === 'final' ? Math.floor(Math.random() * catInfo.entries.length) + 1 : 1
            }));
            await POST('/api/judge/mark', {
              judgeLetter: letter,
              roundId: activeRound.id,
              dance: dance.code,
              marks
            });
          }
          // Scrutineer confirm dance
          await POST(`/api/scrutineer/round/${activeRound.id}/dance/${dance.code}/confirm`);
        }
        
        // Progress to next round
        if (activeRound.kind === 'final') {
          break; // Done
        } else {
          await POST(`/api/scrutineer/category/${cat.id}/init-round`, { judgesLimit: null, starCouplesEnabled: false });
        }
      }
    } catch (e) {
      errors.push(`Iteration ${i}: ` + e.message);
    }
  }

  console.log(`Completed 100 iterations. Errors found: ${errors.length}`);
  if (errors.length > 0) {
    console.log([...new Set(errors)].slice(0, 10).join('\n'));
  }
  
  process.exit(0);
});
