// Seed data/results.json from the results already entered in the spreadsheet (column B result, C 1X2).
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const wb = XLSX.readFile(path.join(__dirname, '..', 'MM-veikkaus 2026.xlsb'));
const rows = XLSX.utils.sheet_to_json(wb.Sheets['Ottelut'], { header: 1, raw: true, defval: null });

const norm = v => (v === null || v === undefined) ? '' : String(v).trim().toUpperCase();
const results = {};
for (let r = 1; r <= 72; r++) {
  const row = rows[r] || [];
  const outcome = norm(row[2]);
  if (outcome !== '1' && outcome !== 'X' && outcome !== '2') continue;
  let home = null, away = null;
  const m = String(row[1] ?? '').match(/(\d+)\s*-\s*(\d+)/);
  if (m) { home = +m[1]; away = +m[2]; }
  results[String(r)] = { outcome, home, away, status: 'FINISHED' };
}
const out = {
  updatedAt: '2026-06-21T00:00:00Z',
  source: 'seed:spreadsheet',
  results
};
fs.writeFileSync(path.join(__dirname, '..', 'data', 'results.json'), JSON.stringify(out, null, 2));
console.log(`Seeded ${Object.keys(results).length} results`);
