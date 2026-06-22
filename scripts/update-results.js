// Fetch World Cup 2026 results + top scorers from football-data.org and update data/results.json.
//
// Usage:  FOOTBALL_DATA_TOKEN=xxxxx node scripts/update-results.js
//
// Free token: https://www.football-data.org/client/register
// The World Cup competition code is "WC" and is included in the free tier.
//
// Only FINISHED (full-time) matches are scored. Live/in-progress matches are NOT
// counted and are actively removed if they were stored before. Existing results
// the API doesn't return (e.g. the seed) are preserved, so the site never regresses.

const fs = require('fs');
const path = require('path');
const { teamMatches } = require('./teams');

const TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const DATA_DIR = path.join(__dirname, '..', 'data');
const PRED_PATH = path.join(DATA_DIR, 'predictions.json');
const RESULTS_PATH = path.join(DATA_DIR, 'results.json');
const BASE = 'https://api.football-data.org/v4/competitions/WC';

const FINAL = new Set(['FINISHED', 'AWARDED']);

function outcome(h, a) {
  if (h == null || a == null) return null;
  if (h > a) return '1';
  if (h === a) return 'X';
  return '2';
}

async function api(pathname) {
  const res = await fetch(BASE + pathname, { headers: { 'X-Auth-Token': TOKEN } });
  if (!res.ok) throw new Error(`API ${pathname} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  if (!TOKEN) {
    console.error('ERROR: FOOTBALL_DATA_TOKEN env var not set.');
    console.error('Get a free token at https://www.football-data.org/client/register');
    process.exit(1);
  }

  const predictions = JSON.parse(fs.readFileSync(PRED_PATH, 'utf8'));
  const existing = fs.existsSync(RESULTS_PATH)
    ? JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'))
    : { results: {} };
  const results = { ...(existing.results || {}) };

  // --- Matches ---
  const data = await api('/matches');
  const apiMatches = data.matches || [];
  console.log(`API returned ${apiMatches.length} matches.`);

  let matched = 0, updated = 0, droppedLive = 0;
  const unmatched = [];

  for (const am of apiMatches) {
    const homeName = am.homeTeam && (am.homeTeam.name || am.homeTeam.shortName);
    const awayName = am.awayTeam && (am.awayTeam.name || am.awayTeam.shortName);
    if (!homeName || !awayName) continue; // knockout placeholders

    const pm = predictions.matches.find(m =>
      teamMatches(m.home, homeName) && teamMatches(m.away, awayName));
    if (!pm) {
      if (FINAL.has(am.status) || am.status === 'IN_PLAY' || am.status === 'PAUSED')
        unmatched.push(`${homeName} vs ${awayName} (${am.status})`);
      continue;
    }
    matched++;
    const key = String(pm.idx);

    if (!FINAL.has(am.status)) {
      // Live / scheduled — make sure no stale result lingers.
      if (results[key]) { delete results[key]; droppedLive++; }
      continue;
    }

    const ft = (am.score && am.score.fullTime) || {};
    const h = ft.home, a = ft.away;
    const out = outcome(h, a);
    if (out == null) continue;

    const prev = results[key];
    const next = { outcome: out, home: h, away: a, status: 'FINISHED' };
    if (!prev || prev.outcome !== out || prev.home !== h || prev.away !== a) {
      results[key] = next;
      updated++;
    }
  }

  // --- Top scorers (Golden Boot race) ---
  let scorers = [];
  try {
    const sd = await api('/scorers?limit=20');
    scorers = (sd.scorers || []).map(s => ({
      name: s.player && s.player.name,
      team: s.team && s.team.name,
      goals: s.goals || 0,
      assists: s.assists || 0,
    })).filter(s => s.name);
    console.log(`Top scorer: ${scorers[0] ? `${scorers[0].name} (${scorers[0].goals})` : 'n/a'}`);
  } catch (e) {
    console.warn('Could not fetch scorers:', e.message);
    scorers = (existing.scorers || []); // keep previous if fetch fails
  }

  // --- Group standings (for the tournament simulation) ---
  let standings = [];
  try {
    const sd = await api('/standings');
    (sd.standings || []).forEach(g => {
      (g.table || []).forEach(t => {
        standings.push({
          team: t.team && t.team.name,
          group: g.group,
          position: t.position,
          played: t.playedGames,
          points: t.points,
          gf: t.goalsFor,
          ga: t.goalsAgainst,
          gd: t.goalDifference,
        });
      });
    });
    console.log(`Standings: ${standings.length} teams across groups.`);
  } catch (e) {
    console.warn('Could not fetch standings:', e.message);
    standings = (existing.standings || []);
  }

  const out = {
    updatedAt: new Date().toISOString(),
    source: 'football-data.org/WC',
    results,
    scorers,
    standings,
  };
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(out, null, 2));

  console.log(`Matched ${matched} fixtures, updated ${updated} results, dropped ${droppedLive} live.`);
  console.log(`Total finished results: ${Object.keys(results).length}/72.`);
  if (unmatched.length) {
    console.log(`\nUnmatched API fixtures (add aliases in scripts/teams.js):`);
    unmatched.forEach(u => console.log('  - ' + u));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
