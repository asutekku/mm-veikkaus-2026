// Dev tool: parse the source .xlsb into data/predictions.json (run once / when guesses change).
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'MM-veikkaus 2026.xlsb');
const OUT = path.join(__dirname, '..', 'data', 'predictions.json');

const wb = XLSX.readFile(SRC);
const ws = wb.Sheets['Ottelut'];
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });

const header = rows[0];
const players = [];
for (let c = 3; c < header.length; c++) {
  const v = header[c];
  if (v && String(v).trim() !== '') players.push({ col: c, name: String(v).trim() });
}
// Tidy display names
const NAME_FIX = { 'Karo': 'Karoliina', 'Elina ': 'Elina', 'Kalle ': 'Kalle', 'Lauri L': 'Lauri L' };
players.forEach(p => { p.name = NAME_FIX[p.name] || p.name.trim(); });

const norm12X = v => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toUpperCase();
  return (s === '1' || s === 'X' || s === '2') ? s : null;
};

const splitTeams = name => {
  const parts = String(name).split(/\s*–\s*/); // en dash
  return { home: (parts[0] || '').trim(), away: (parts[1] || '').trim() };
};

// Group-stage matches: rows 1..72
const matches = [];
for (let r = 1; r <= 72; r++) {
  const row = rows[r] || [];
  const name = row[0];
  if (!name || String(name).trim() === '') continue;
  const { home, away } = splitTeams(name);
  const guesses = {};
  players.forEach(p => { guesses[p.name] = norm12X(row[p.col]); });
  matches.push({
    idx: r,            // 1-based row index in sheet = match number
    home, away,
    name: String(name).trim(),
    guesses
  });
}

// Bonus rows (free text, manually scored)
const BONUS_ROWS = [
  { row: 76, key: 'semifinal', label: 'Välieräjoukkueet (neljä parasta)' },
  { row: 77, key: 'final',     label: 'Finaali' },
  { row: 78, key: 'champion',  label: 'Maailmanmestari' },
  { row: 79, key: 'topscorer', label: 'Maalikuningas' },
];
const bonus = BONUS_ROWS.map(b => {
  const row = rows[b.row] || [];
  const picks = {};
  players.forEach(p => {
    const v = row[p.col];
    picks[p.name] = (v === null || v === undefined) ? '' : String(v).trim();
  });
  return { key: b.key, label: b.label, picks };
});

const out = {
  title: 'MM-veikkaus 2026',
  generatedFrom: 'MM-veikkaus 2026.xlsb',
  players: players.map(p => p.name),
  matches,
  bonus
};

fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`Wrote ${OUT}: ${players.length} players, ${matches.length} matches, ${bonus.length} bonus rows`);
