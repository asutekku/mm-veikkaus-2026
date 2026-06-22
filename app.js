'use strict';

const state = { pred: null, res: null, sel: new Set() };

async function loadJSON(p) {
  const r = await fetch(p + '?t=' + Date.now());
  if (!r.ok) throw new Error('load ' + p);
  return r.json();
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const R = () => state.res.results || {};
const resultFor = i => R()[String(i)] || null;

/* ============================ COMPUTE ============================ */

function resolvedMatches() {
  return state.pred.matches
    .filter(m => { const r = resultFor(m.idx); return r && r.outcome; })
    .sort((a, b) => a.idx - b.idx);
}

// points counting only matches with idx <= cap (cap=Infinity for all)
function pointsAt(cap) {
  const { players } = state.pred;
  const pts = {}; players.forEach(p => pts[p] = 0);
  state.pred.matches.forEach(m => {
    if (m.idx > cap) return;
    const r = resultFor(m.idx); if (!r || !r.outcome) return;
    players.forEach(p => { if (m.guesses[p] === r.outcome) pts[p]++; });
  });
  return pts;
}

function rankMap(pts) {
  const players = state.pred.players.slice()
    .sort((a, b) => pts[b] - pts[a] || a.localeCompare(b, 'fi'));
  const rank = {}; let lp = null, lr = 0;
  players.forEach((p, i) => { if (pts[p] !== lp) { lr = i + 1; lp = pts[p]; } rank[p] = lr; });
  return rank;
}

function cumulativeSeries() {
  const { players } = state.pred;
  const res = resolvedMatches();
  const series = {}; players.forEach(p => series[p] = [0]);
  res.forEach(m => {
    const r = resultFor(m.idx);
    players.forEach(p => {
      const prev = series[p][series[p].length - 1];
      series[p].push(prev + (m.guesses[p] === r.outcome ? 1 : 0));
    });
  });
  return { series, steps: res.length, matches: res };
}

function standings() {
  const { players, matches } = state.pred;
  const res = resolvedMatches();
  const total = matches.length;
  const resolved = res.length;
  const remaining = total - resolved;

  const pts = pointsAt(Infinity);
  const played = {}; players.forEach(p => played[p] = resolved); // everyone guessed every match

  // form: last 5 resolved
  const last5 = res.slice(-5);
  const form = {};
  players.forEach(p => form[p] = last5.map(m => m.guesses[p] === resultFor(m.idx).outcome ? 'h' : 'm'));

  // delta vs last fully-completed matchday boundary
  const boundaries = [24, 48, 72];
  let cap = 0;
  for (const b of boundaries) {
    const allDone = matches.filter(m => m.idx <= b).every(m => { const r = resultFor(m.idx); return r && r.outcome; });
    if (allDone) cap = b;
  }
  const nowRank = rankMap(pts);
  const prevRank = cap ? rankMap(pointsAt(cap)) : null;

  const leaderPts = Math.max(...players.map(p => pts[p]));

  // win % and projected final total come from the full-tournament simulation
  // (group 1X2 points + bonus points). Falls back to a group-only estimate if
  // the sim hasn't loaded.
  const proj = state.proj;
  const projBy = {};
  if (proj) proj.playerProj.forEach(p => projBy[p.name] = p);
  const fallbackWin = proj ? null : winProbabilities(remaining, pts);

  const rows = players.map(p => {
    const pr = projBy[p];
    return {
      name: p,
      pts: pts[p],
      played: played[p],
      hit: played[p] ? pts[p] / played[p] : 0,
      form: form[p],
      rank: nowRank[p],
      delta: prevRank ? prevRank[p] - nowRank[p] : null,
      projTotal: pr ? pr.expTotal : null,
      expBonus: pr ? pr.expBonus : null,
      win: pr ? pr.win : (fallbackWin ? fallbackWin[p] : 0),
    };
  }).sort((a, b) => a.rank - b.rank || b.pts - a.pts || a.name.localeCompare(b.name, 'fi'));

  return { rows, resolved, remaining, total, leaderPts, leader: rows[0] };
}

// Monte Carlo: remaining matches resolved by crowd-consensus probabilities.
function winProbabilities(remaining, basePts) {
  const { players } = state.pred;
  const wins = {}; players.forEach(p => wins[p] = 0);
  if (remaining === 0) {
    const lead = Math.max(...players.map(p => basePts[p]));
    const top = players.filter(p => basePts[p] === lead);
    top.forEach(p => wins[p] = 1 / top.length);
    return wins;
  }
  const open = state.pred.matches.filter(m => { const r = resultFor(m.idx); return !(r && r.outcome); });
  // For each open match: probability of each outcome from the family's guesses (+smoothing),
  // and the index lists of players backing each outcome.
  const model = open.map(m => {
    const backers = { '1': [], 'X': [], '2': [] };
    let c1 = 0.5, cx = 0.5, c2 = 0.5;
    players.forEach((p, i) => {
      const g = m.guesses[p];
      if (g === '1') { c1++; backers['1'].push(i); }
      else if (g === 'X') { cx++; backers['X'].push(i); }
      else if (g === '2') { c2++; backers['2'].push(i); }
    });
    const tot = c1 + cx + c2;
    return { p1: c1 / tot, px: cx / tot, backers };
  });

  const N = 8000;
  const base = players.map(p => basePts[p]);
  const score = new Array(players.length);
  for (let s = 0; s < N; s++) {
    for (let i = 0; i < score.length; i++) score[i] = base[i];
    for (const mm of model) {
      const r = Math.random();
      const out = r < mm.p1 ? '1' : (r < mm.p1 + mm.px ? 'X' : '2');
      const b = mm.backers[out];
      for (let k = 0; k < b.length; k++) score[b[k]]++;
    }
    let mx = -1; for (let i = 0; i < score.length; i++) if (score[i] > mx) mx = score[i];
    let cnt = 0; for (let i = 0; i < score.length; i++) if (score[i] === mx) cnt++;
    const share = 1 / cnt;
    for (let i = 0; i < score.length; i++) if (score[i] === mx) wins[players[i]] += share;
  }
  players.forEach(p => wins[p] /= N);
  return wins;
}

function tournamentStats() {
  const { players } = state.pred;
  const res = resolvedMatches();
  let goals = 0, withScore = 0, draws = 0, hw = 0, aw = 0, consensusHit = 0, bigWin = null;
  const diff = [];
  res.forEach(m => {
    const r = resultFor(m.idx);
    if (r.home != null) { goals += r.home + r.away; withScore++; if (bigWin == null || Math.abs(r.home - r.away) > Math.abs(bigWin.r.home - bigWin.r.away)) bigWin = { m, r }; }
    if (r.outcome === 'X') draws++; else if (r.outcome === '1') hw++; else aw++;
    // crowd majority
    const cnt = { '1': 0, 'X': 0, '2': 0 };
    let nCorrect = 0, nGuess = 0;
    players.forEach(p => { const g = m.guesses[p]; if (g) { cnt[g]++; nGuess++; if (g === r.outcome) nCorrect++; } });
    const maj = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
    if (maj === r.outcome) consensusHit++;
    diff.push({ m, r, frac: nGuess ? nCorrect / nGuess : 0, nCorrect, nGuess });
  });
  const sorted = diff.slice().sort((a, b) => a.frac - b.frac);
  return {
    goals, withScore, avg: withScore ? goals / withScore : 0,
    draws, hw, aw, n: res.length,
    consensus: res.length ? consensusHit / res.length : 0,
    hardest: sorted[0], easiest: sorted[sorted.length - 1],
    bigWin,
  };
}

/* ----- betting (odds implied by the family's own picks) ----- */
const STAKE = 10;          // € per match
const BOOK_MARGIN = 0.94;  // ~6% house edge
const ODDS_MIN = 1.05, ODDS_MAX = 12;

function matchOdds(m) {
  const players = state.pred.players;
  const n = { '1': 0, 'X': 0, '2': 0 };
  let N = 0;
  players.forEach(p => { const g = m.guesses[p]; if (g) { n[g]++; N++; } });
  const odds = {};
  ['1', 'X', '2'].forEach(o => {
    const prob = (n[o] + 0.5) / (N + 1.5);          // Laplace-smoothed consensus probability
    const d = (1 / prob) * BOOK_MARGIN;             // fair odds, shortened by the margin
    odds[o] = Math.max(ODDS_MIN, Math.min(ODDS_MAX, d));
  });
  return { odds, n, N };
}

function bettingStats() {
  const players = state.pred.players;
  const res = resolvedMatches();
  const stats = {}; players.forEach(p => stats[p] = { net: 0, staked: 0, wins: 0, best: null });
  const perMatch = [];
  res.forEach(m => {
    const r = resultFor(m.idx);
    const { odds, n, N } = matchOdds(m);
    perMatch.push({ m, r, odds, n, N });
    players.forEach(p => {
      const g = m.guesses[p]; if (!g) return;
      stats[p].staked += STAKE;
      if (g === r.outcome) {
        const profit = STAKE * (odds[g] - 1);
        stats[p].net += profit; stats[p].wins++;
        if (!stats[p].best || profit > stats[p].best.profit) stats[p].best = { m, profit, odds: odds[g] };
      } else {
        stats[p].net -= STAKE;
      }
    });
  });
  const rows = players.map(p => ({ name: p, ...stats[p], roi: stats[p].staked ? stats[p].net / stats[p].staked : 0 }))
    .sort((a, b) => b.net - a.net || a.name.localeCompare(b.name, 'fi'));
  // biggest longshot that actually hit, across everyone
  let bigShot = null;
  perMatch.forEach(pm => {
    const o = pm.odds[pm.r.outcome];
    const backers = players.filter(p => pm.m.guesses[p] === pm.r.outcome);
    if (backers.length && (!bigShot || o > bigShot.odds)) bigShot = { m: pm.m, odds: o, backers };
  });
  return { rows, perMatch, resolved: res.length, bigShot };
}

/* ----- top scorer normalization ----- */
const SCORER_CANON = [
  { keys: ['mbappe'], name: 'Kylian Mbappé', sur: 'mbappe' },
  { keys: ['haaland'], name: 'Erling Haaland', sur: 'haaland' },
  { keys: ['dembele'], name: 'Ousmane Dembélé', sur: 'dembele' },
  { keys: ['kane'], name: 'Harry Kane', sur: 'kane' },
  { keys: ['yamal'], name: 'Lamine Yamal', sur: 'yamal' },
  { keys: ['lautaro', 'martinez'], name: 'Lautaro Martínez', sur: 'martinez' },
  { keys: ['pele'], name: 'Pelé', sur: 'pele' },
];
const deburr = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function canonScorer(raw) {
  const d = deburr(raw).replace(/[^a-z ]/g, ' ');
  for (const c of SCORER_CANON) if (c.keys.some(k => d.includes(k))) return c;
  const last = d.trim().split(/\s+/).pop() || raw;
  return { name: raw.replace(/[!*].*$/, '').replace(/\(.*\)/, '').trim(), sur: last };
}
function goalsFor(sur) {
  const list = state.res.scorers || [];
  const hit = list.find(s => deburr(s.name).includes(sur) && sur.length >= 3);
  return hit ? hit.goals : null;
}

/* ============================ RENDER ============================ */

function playerColors() {
  const ps = state.pred.players; const map = {};
  ps.forEach((p, i) => {
    const h = Math.round((i * 360 / ps.length + 18) % 360);
    map[p] = `hsl(${h} ${i % 2 ? 65 : 85}% ${i % 3 ? 62 : 70}%)`;
  });
  return map;
}

function renderRibbon(st, ts) {
  const cells = [
    { lab: 'Ratkaistu', val: `<b>${st.resolved}</b><span class="sm">/${st.total}</span>` },
    { lab: 'Jäljellä', val: `${st.remaining}` },
    { lab: 'Kärjessä', val: `<b>${esc(st.leader.name)}</b> <span class="sm">${st.leader.pts}p</span>` },
    { lab: 'Kärkiero', val: `${st.rows[1] ? '+' + (st.leader.pts - st.rows[1].pts) : '—'}` },
    { lab: 'Maaleja', val: `${ts.goals} <span class="sm">${ts.avg.toFixed(2)}/ott</span>` },
    { lab: '1 / X / 2', val: `<span class="sm">${ts.hw}·${ts.draws}·${ts.aw}</span>` },
    { lab: 'Konsensus', val: `${Math.round(ts.consensus * 100)}<span class="sm">%</span>` },
  ];
  document.getElementById('ribbon').innerHTML = cells.map(c =>
    `<div class="cell"><div class="lab">${c.lab}</div><div class="val num">${c.val}</div></div>`).join('');
}

function renderChart(colors) {
  const { series, steps, matches } = cumulativeSeries();
  const { players } = state.pred;
  const _p = pointsAt(Infinity);
  const lead = players.slice().sort((a, b) => _p[b] - _p[a] || a.localeCompare(b, 'fi'))[0];
  if (steps === 0) return '<div class="chart-body muted" style="padding:24px 16px">Ei vielä tuloksia.</div>';

  const W = 760, H = 300, padL = 26, padR = 12, padT = 12, padB = 18;
  const yMax = Math.max(3, ...players.map(p => series[p][steps]));
  const x = i => padL + (i / steps) * (W - padL - padR);
  const y = v => padT + (1 - v / yMax) * (H - padT - padB);

  // gridlines
  let grid = '';
  const yStep = yMax <= 8 ? 2 : yMax <= 20 ? 5 : 10;
  for (let v = 0; v <= yMax; v += yStep) {
    grid += `<line class="grid-line" x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W - padR}" y2="${y(v).toFixed(1)}"/>`;
    grid += `<text x="${padL - 5}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${v}</text>`;
  }
  // matchday markers on x
  let xlab = '';
  [0, 24, 48, 72].forEach(b => {
    const i = matches.filter(m => m.idx <= b).length;
    if (i > 0 && i <= steps) {
      xlab += `<line class="grid-line" x1="${x(i).toFixed(1)}" y1="${padT}" x2="${x(i).toFixed(1)}" y2="${H - padB}" stroke-dasharray="2 3"/>`;
      xlab += `<text x="${x(i).toFixed(1)}" y="${H - 5}" text-anchor="middle">K${Math.min(3, b / 24)}</text>`;
    }
  });

  const lines = players.map(p => {
    const pts = series[p].map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const cls = 'pline' + (p === lead ? ' lead' : '') + (state.sel.has(p) ? ' sel' : '');
    return `<polyline class="${cls}" data-p="${esc(p)}" points="${pts}" stroke="${colors[p]}"/>`;
  }).join('');

  const legend = players
    .map(p => ({ p, end: series[p][steps] }))
    .sort((a, b) => b.end - a.end)
    .map(({ p, end }) => {
      const cls = 'lg-chip' + (state.sel.has(p) ? ' sel' : (state.sel.size ? ' dim' : ''));
      return `<span class="${cls}" data-chip="${esc(p)}"><span class="sw" style="background:${colors[p]}"></span><span class="lp">${esc(p)}</span> ${end}</span>`;
    }).join('');

  return `
    <div class="chart-body chart ${state.sel.size ? 'has-sel' : ''}">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" class="axis">
        ${grid}${xlab}${lines}
      </svg>
    </div>
    <div class="legend">${legend}</div>`;
}

function renderStandingsTable(st, colors) {
  const head = `<thead><tr>
    <th class="l">#</th><th></th><th class="l">Pelaaja</th>
    <th>Pist</th><th class="l barcell hide-sm">Eteneminen</th>
    <th class="hide-sm">Osuma</th><th class="hide-sm">Viim. 5</th>
    <th>Voitto-%</th><th>Ennuste</th></tr></thead>`;
  const max = st.leaderPts || 1;
  const body = st.rows.map(r => {
    const d = r.delta;
    const dCell = d == null ? '<span class="delta flat">·</span>'
      : d > 0 ? `<span class="delta up">▲${d}</span>`
      : d < 0 ? `<span class="delta down">▼${-d}</span>`
      : '<span class="delta flat">–</span>';
    const form = r.form.map(f => `<i class="${f}"></i>`).join('') || '<i class="x"></i>';
    const winPct = r.win >= 0.001 ? (r.win * 100).toFixed(r.win >= 0.1 ? 0 : 1) + '%' : '<0.1%';
    const status = r.projTotal != null
      ? `<span class="num" title="projisoitu lopputulos (alkulohko + bonukset)">~${Math.round(r.projTotal)} p</span>`
      : (r.rank === 1 ? '<span class="badge live">KÄRJESSÄ</span>' : '<span class="muted">—</span>');
    return `<tr class="tr-${r.rank}">
      <td class="l st-rank">${r.rank}</td>
      <td>${dCell}</td>
      <td class="l"><span class="st-name" style="border-left:3px solid ${colors[r.name]};padding-left:7px">${esc(r.name)}</span></td>
      <td class="st-pts">${r.pts}</td>
      <td class="l barcell hide-sm"><div class="minibar"><span style="width:${(r.pts / max) * 100}%"></span></div></td>
      <td class="hide-sm num">${Math.round(r.hit * 100)}%</td>
      <td class="hide-sm"><span class="form">${form}</span></td>
      <td class="winp ${r.win >= 0.15 ? 'hot' : ''}">${winPct}</td>
      <td>${status}</td>
    </tr>`;
  }).join('');
  return `<div class="tbl-scroll"><table class="stand">${head}<tbody>${body}</tbody></table></div>`;
}

function renderScorer() {
  const { players } = state.pred;
  const bonus = state.pred.bonus.find(b => b.key === 'topscorer');
  const scorers = state.res.scorers || [];
  const gb = scorers[0];

  // family bets grouped by canonical scorer
  const groups = {};
  players.forEach(p => {
    const raw = bonus.picks[p]; if (!raw) return;
    const c = canonScorer(raw);
    const key = c.name.toLowerCase();
    if (!groups[key]) groups[key] = { name: c.name, sur: c.sur, backers: [] };
    groups[key].backers.push(p);
  });
  const leadSur = gb ? deburr(gb.name).split(/\s+/).pop() : '';
  const rows = Object.values(groups)
    .map(g => ({ ...g, goals: goalsFor(g.sur) }))
    .sort((a, b) => (b.goals ?? -1) - (a.goals ?? -1) || b.backers.length - a.backers.length)
    .map(g => {
      const isLead = gb && g.sur && deburr(gb.name).includes(g.sur);
      return `<tr class="${isLead ? 'leadrow' : ''}">
        <td class="pl">${esc(g.name)}${isLead ? ' 👑' : ''}</td>
        <td class="g">${g.goals == null ? '<span class="muted">–</span>' : g.goals}</td>
        <td class="who">${g.backers.length}× · ${g.backers.map(esc).join(', ')}</td>
      </tr>`;
    }).join('');

  return `<div class="panel">
    <div class="panel-h"><h2>Maalikuningas-kisa</h2><span class="sub">Golden Boot</span></div>
    ${gb ? `<div class="boot-lead"><div class="gb"><span class="g num">${gb.goals}</span>
      <span><span class="n">${esc(gb.name)}</span> <span class="t">${esc(gb.team || '')}</span><br>
      <span class="chip-mini">KÄRJESSÄ NYT</span></span></div></div>` : ''}
    <table class="boot-list"><tbody>${rows || '<tr><td class="muted" style="padding:14px 16px">Ei veikkauksia.</td></tr>'}</tbody></table>
  </div>`;
}

function renderInsights(ts, st) {
  const matchName = d => d ? `${esc(d.m.home)}–${esc(d.m.away)}` : '—';
  const rows = [
    { k: 'Kärkitaisto', sub: `1. vs 2.`, v: st.rows[1] ? `+${st.leader.pts - st.rows[1].pts}` : '—', vs: `${esc(st.leader.name)} johtaa` },
    { k: 'Yllätys', sub: 'harvin osuma', v: ts.hardest ? `${ts.hardest.nCorrect}/${ts.hardest.nGuess}` : '—', vs: matchName(ts.hardest) },
    { k: 'Varma veto', sub: 'lähes kaikki oikein', v: ts.easiest ? `${ts.easiest.nCorrect}/${ts.easiest.nGuess}` : '—', vs: matchName(ts.easiest) },
    { k: 'Suurin voitto', sub: 'maaliero', v: ts.bigWin ? `${ts.bigWin.r.home}–${ts.bigWin.r.away}` : '—', vs: ts.bigWin ? matchName(ts.bigWin) : '—' },
    { k: 'Maalia / ottelu', sub: `${ts.goals} maalia`, v: ts.avg.toFixed(2), vs: `${ts.withScore} ottelua` },
    { k: 'Konsensus osui', sub: 'enemmistö oikeassa', v: `${Math.round(ts.consensus * 100)}%`, vs: `${ts.n} ottelua` },
    { k: 'Tasapelit', sub: 'kaikista', v: `${ts.draws}`, vs: `${Math.round(ts.draws / Math.max(1, ts.n) * 100)}%` },
  ];
  return `<div class="panel">
    <div class="panel-h"><h2>Turnausdata</h2><span class="sub">insights</span></div>
    <div class="stat-rows">${rows.map(r => `<div class="row">
      <div class="k">${r.k}<small>${r.sub}</small></div>
      <div class="v">${r.v}<small>${r.vs}</small></div></div>`).join('')}</div>
  </div>`;
}

function chartCardHTML(colors) {
  return `<div class="panel-h"><h2>Pisteet kierroksittain</h2><span class="sub">kumulatiivinen · klikkaa nimeä</span></div>${renderChart(colors)}`;
}
function bindChart(colors) {
  document.querySelectorAll('#chart-card [data-chip], #chart-card [data-p]').forEach(el =>
    el.addEventListener('click', () => {
      const p = el.getAttribute('data-chip') || el.getAttribute('data-p');
      if (state.sel.has(p)) state.sel.delete(p); else state.sel.add(p);
      const card = document.getElementById('chart-card');
      card.innerHTML = chartCardHTML(colors);
      bindChart(colors);
    }));
}

function renderDash() {
  const colors = playerColors();
  const st = standings();
  const ts = tournamentStats();
  renderRibbon(st, ts);

  document.getElementById('view-dash').innerHTML = `
    <div class="panel chart-card mb" id="chart-card">${chartCardHTML(colors)}</div>
    <div class="panel mb">
      <div class="panel-h"><h2>Sarjataulukko</h2><span class="sub">${st.resolved}/${st.total} ottelua · voitto-% = monte carlo</span></div>
      ${renderStandingsTable(st, colors)}
    </div>
    <div class="grid grid-2">
      ${renderScorer()}
      ${renderInsights(ts, st)}
    </div>`;

  bindChart(colors);
}

/* ----- matches matrix ----- */
function renderMatches() {
  const { players, matches } = state.pred;
  let selPlayer = state._matrixHl || null;
  const mdLabel = i => i <= 24 ? 'Kierros 1' : i <= 48 ? 'Kierros 2' : 'Kierros 3';

  const head = `<thead><tr>
    <th class="col-match">Ottelu</th><th class="col-res">Tulos</th><th class="col-diff" title="oikein / veikkausta">%</th>
    ${players.map(p => `<th class="col-player" data-player="${esc(p)}">${esc(p)}</th>`).join('')}
  </tr></thead>`;

  let lastMd = null;
  const body = matches.map(m => {
    const r = resultFor(m.idx);
    const md = mdLabel(m.idx);
    let div = '';
    if (md !== lastMd) { lastMd = md; div = `<tr class="md-divider"><td colspan="${players.length + 3}">${md}</td></tr>`; }

    let nCorrect = 0, nGuess = 0;
    players.forEach(p => { if (m.guesses[p]) { nGuess++; if (r && r.outcome && m.guesses[p] === r.outcome) nCorrect++; } });
    const diff = r && r.outcome ? `${nCorrect}/${nGuess}` : '';

    const score = r && r.home != null ? `${r.home}–${r.away}` : '';
    const resCell = r && r.outcome
      ? `<span class="outcome-pill">${r.outcome}</span> <span class="score">${score}</span>`
      : `<span class="score pending">–</span>`;

    const cells = players.map(p => {
      const g = m.guesses[p] ?? '·';
      let cls = 'col-player cell-pending';
      if (r && r.outcome && m.guesses[p]) cls = 'col-player ' + (m.guesses[p] === r.outcome ? 'cell-correct' : 'cell-wrong');
      return `<td class="${cls}${selPlayer === p ? ' hl' : ''}" data-player="${esc(p)}">${esc(g)}</td>`;
    }).join('');

    return `${div}<tr>
      <td class="col-match"><span class="teams">${esc(m.home)}</span> – ${esc(m.away)}</td>
      <td class="col-res">${resCell}</td><td class="col-diff num">${diff}</td>${cells}</tr>`;
  }).join('');

  document.getElementById('view-matches').innerHTML =
    `<div class="matrix-scroll"><table class="matrix">${head}<tbody>${body}</tbody></table></div>`;
  document.querySelectorAll('#view-matches [data-player]').forEach(el =>
    el.addEventListener('click', () => {
      const p = el.getAttribute('data-player');
      state._matrixHl = state._matrixHl === p ? null : p;
      renderMatches();
    }));
}

/* ----- betting view ----- */
const eur = v => (v >= 0 ? '+' : '−') + '€' + Math.abs(v).toFixed(2);

function renderBetting() {
  const colors = playerColors();
  const { rows, perMatch, resolved, bigShot } = bettingStats();

  const lead = rows[0], worst = rows[rows.length - 1];
  const ribbon = `<div class="ribbon" style="border:1px solid var(--line);border-radius:12px;margin-bottom:14px">
    <div class="cell"><div class="lab">Panos / ottelu</div><div class="val num">€${STAKE}</div></div>
    <div class="cell"><div class="lab">Otteluita</div><div class="val num">${resolved}</div></div>
    <div class="cell"><div class="lab">Paras tuotto</div><div class="val num"><b>${esc(lead.name)}</b> <span class="sm">${eur(lead.net)}</span></div></div>
    <div class="cell"><div class="lab">Suurin tappio</div><div class="val num">${esc(worst.name)} <span class="sm">${eur(worst.net)}</span></div></div>
    <div class="cell"><div class="lab">Pisin kerroin osui</div><div class="val num">${bigShot ? bigShot.odds.toFixed(2) : '—'} <span class="sm">${bigShot ? esc(bigShot.backers.join(', ')) : ''}</span></div></div>
  </div>`;

  const lbRows = rows.map((r, i) => {
    const best = r.best
      ? `<span class="num">${eur(r.best.profit)}</span> <span class="muted">@${r.best.odds.toFixed(2)} · ${esc(r.best.m.home)}–${esc(r.best.m.away)}</span>`
      : '<span class="muted">—</span>';
    return `<tr class="tr-${i + 1}">
      <td class="l st-rank">${i + 1}</td>
      <td class="l"><span class="st-name" style="border-left:3px solid ${colors[r.name]};padding-left:7px">${esc(r.name)}</span></td>
      <td class="st-pts ${r.net >= 0 ? 'pl-pos' : 'pl-neg'}">${eur(r.net)}</td>
      <td class="num ${r.roi >= 0 ? 'pl-pos' : 'pl-neg'}">${(r.roi * 100).toFixed(1)}%</td>
      <td class="num muted">€${r.staked}</td>
      <td class="num muted">${r.wins}/${resolved}</td>
      <td class="l hide-sm">${best}</td>
    </tr>`;
  }).join('');

  const lb = `<div class="panel mb">
    <div class="panel-h"><h2>Vedonlyönti­liiga</h2><span class="sub">€${STAKE}/ottelu · netto­voitto</span></div>
    <div class="tbl-scroll"><table class="stand">
      <thead><tr><th class="l">#</th><th class="l">Pelaaja</th><th>Netto</th><th>ROI</th><th>Panostettu</th><th>Osumat</th><th class="l hide-sm">Paras veto</th></tr></thead>
      <tbody>${lbRows}</tbody></table></div></div>`;

  // per-match odds table
  const oddsRows = perMatch.map(pm => {
    const cell = o => {
      const win = pm.r.outcome === o;
      return `<td class="num ${win ? 'odds-win' : ''}">${pm.odds[o].toFixed(2)}<span class="odds-n">${pm.n[o]}</span></td>`;
    };
    return `<tr>
      <td class="l col-match"><span class="teams">${esc(pm.m.home)}</span> – ${esc(pm.m.away)}</td>
      <td><span class="outcome-pill">${pm.r.outcome}</span> <span class="score">${pm.r.home != null ? pm.r.home + '–' + pm.r.away : ''}</span></td>
      ${cell('1')}${cell('X')}${cell('2')}
    </tr>`;
  }).join('');
  const oddsTable = `<div class="panel">
    <div class="panel-h"><h2>Kertoimet otteluittain</h2><span class="sub">1 / X / 2 · pieni luku = veikkaajien määrä</span></div>
    <div class="tbl-scroll"><table class="stand odds-table">
      <thead><tr><th class="l">Ottelu</th><th class="l">Tulos</th><th>1</th><th>X</th><th>2</th></tr></thead>
      <tbody>${oddsRows}</tbody></table></div></div>`;

  document.getElementById('view-betting').innerHTML =
    `<p class="muted" style="margin-top:0">Jokainen lyö <b>€${STAKE}</b> omalle 1/X/2-veikkaukselleen joka ottelussa. Kertoimet johdetaan <b>perheen omista veikkauksista</b> (mitä useampi veikkasi saman, sitä matalampi kerroin) ~6&nbsp;% marginaalilla — oikeita vedonlyöntikertoimia menneille otteluille ei saa ilmaiseksi. Rohkea oikea veikkaus maksaa eniten.</p>
     ${ribbon}${lb}${oddsTable}`;
}

/* ----- forecast ----- */
const pct = v => v == null ? '—' : v < 0.005 ? '<1%' : Math.round(v * 100) + '%';

function renderForecast() {
  const colors = playerColors();
  const proj = state.proj;
  if (!proj) { document.getElementById('view-forecast').innerHTML = '<p class="muted">Ennustetta ei voitu laskea (simulaatiodata puuttuu).</p>'; return; }

  const rules = `<div class="panel mb"><div class="panel-h"><h2>Pisteytys</h2><span class="sub">säännöt</span></div>
    <div class="stat-rows">
      <div class="row"><div class="k">Oikea merkki alkulohkossa</div><div class="v">1 p</div></div>
      <div class="row"><div class="k">Välieräjoukkue<small>per oikein veikattu joukkue (4 kpl)</small></div><div class="v">5 p</div></div>
      <div class="row"><div class="k">Finaalijoukkue<small>per oikein veikattu joukkue (2 kpl)</small></div><div class="v">10 p</div></div>
      <div class="row"><div class="k">Oikea mestari<small>finalistipisteiden lisäksi</small></div><div class="v">+10 p</div></div>
      <div class="row"><div class="k">Maalikuningas</div><div class="v">10 p</div></div>
    </div></div>`;

  const maxTot = Math.max(...proj.playerProj.map(p => p.expTotal)) || 1;
  const projRows = proj.playerProj.map((p, i) => `<tr class="tr-${i + 1}">
     <td class="l st-rank">${i + 1}</td>
     <td class="l"><span class="st-name" style="border-left:3px solid ${colors[p.name]};padding-left:7px">${esc(p.name)}</span></td>
     <td class="winp ${p.win >= 0.15 ? 'hot' : ''}">${pct(p.win)}</td>
     <td class="num muted">${p.curGroup}</td>
     <td class="num muted">+${p.expBonus.toFixed(1)}</td>
     <td class="st-pts">${p.expTotal.toFixed(1)}</td>
     <td class="l barcell hide-sm"><div class="minibar"><span style="width:${p.expTotal / maxTot * 100}%"></span></div></td>
   </tr>`).join('');
  const projPanel = `<div class="panel mb"><div class="panel-h"><h2>Projisoitu lopputulos</h2><span class="sub">${proj.sims} simulaatiota · voitto-% = mestaruus­todennäköisyys</span></div>
    <div class="tbl-scroll"><table class="stand"><thead><tr><th class="l">#</th><th class="l">Pelaaja</th><th>Voitto-%</th><th>Lohko nyt</th><th>Bonus odot.</th><th>Yht. odot.</th><th class="l barcell hide-sm"></th></tr></thead><tbody>${projRows}</tbody></table></div></div>`;

  const teams = proj.teamProb.filter(t => t.sf > 0.005).slice(0, 16);
  const tRows = teams.map(t => `<tr>
     <td class="l st-name">${esc(t.name)}</td>
     <td class="num">${pct(t.sf)}</td><td class="num">${pct(t.fin)}</td>
     <td class="num ${t.champ >= 0.1 ? 'pl-pos' : ''}">${pct(t.champ)}</td></tr>`).join('');
  const teamPanel = `<div class="panel"><div class="panel-h"><h2>Joukkueet</h2><span class="sub">välierä / finaali / mestari</span></div>
    <div class="tbl-scroll"><table class="stand"><thead><tr><th class="l">Joukkue</th><th>VE</th><th>Fin</th><th>Mestari</th></tr></thead><tbody>${tRows}</tbody></table></div></div>`;

  const ts = proj.topscorers.filter(t => t.p > 0.003).slice(0, 10);
  const tsRows = ts.map(t => `<tr><td class="l st-name">${esc(t.name)}</td><td class="num muted">${t.goals}</td><td class="num ${t.p >= 0.15 ? 'pl-pos' : ''}">${pct(t.p)}</td></tr>`).join('');
  const tsPanel = `<div class="panel"><div class="panel-h"><h2>Maalikuningas</h2><span class="sub">todennäköisyys</span></div>
    <div class="tbl-scroll"><table class="stand"><thead><tr><th class="l">Pelaaja</th><th>Maalit</th><th>Todennäk.</th></tr></thead><tbody>${tsRows}</tbody></table></div></div>`;

  document.getElementById('view-forecast').innerHTML =
    `<p class="muted" style="margin-top:0">Koko turnaus simuloidaan <b>${proj.sims}×</b> loppuun: jäljellä olevat alkulohko-ottelut, jatkopelit ja maalikuningaskisa. Joukkueiden vahvuus perustuu <b>alkulohkon tuloksiin</b> ja <b>perheen veikkauksiin</b>. Jatkopelien parit arvotaan joka kierroksella (virallista kaaviota ei vielä julkaistu).</p>
     ${rules}${projPanel}<div class="grid grid-2">${teamPanel}${tsPanel}</div>`;
}

/* ----- bonus ----- */
function renderBonus() {
  const { players } = state.pred;
  const pp = state.proj ? state.proj.playerPicks : null;
  const chip = (name, p) => `<span class="pchip ${p >= 0.4 ? 'hi' : p >= 0.15 ? 'mid' : ''}">${esc(name)}${p != null ? ` <b>${pct(p)}</b>` : ''}</span>`;

  const cats = [
    { key: 'semifinal', label: 'Välieräjoukkueet (4 parasta)', sub: '5 p / oikea joukkue', get: p => pp && pp[p] ? pp[p].sf : null },
    { key: 'final', label: 'Finaalijoukkueet', sub: '10 p / oikea joukkue', get: p => pp && pp[p] ? pp[p].fin : null },
    { key: 'champion', label: 'Maailmanmestari', sub: '+10 p', get: p => pp && pp[p] && pp[p].champ ? [pp[p].champ] : null },
    { key: 'topscorer', label: 'Maalikuningas', sub: '10 p', get: p => pp && pp[p] && pp[p].ts ? [pp[p].ts] : null },
  ];

  const blocks = cats.map(cat => {
    const raw = state.pred.bonus.find(b => b.key === cat.key) || { picks: {} };
    const rows = players.map(p => {
      const picks = cat.get(p);
      let cell;
      if (picks && picks.length) cell = `<div class="pchips">${picks.map(x => chip(x.name, x.p)).join('')}</div>`;
      else cell = `<span class="muted">${esc(raw.picks[p] || '—')}</span>`;
      return `<tr><td class="who">${esc(p)}</td><td>${cell}</td></tr>`;
    }).join('');
    return `<div class="panel bonus-block">
      <div class="panel-h"><h2>${esc(cat.label)}</h2><span class="sub">${cat.sub}</span></div>
      <table><tbody>${rows}</tbody></table></div>`;
  }).join('');

  document.getElementById('view-bonus').innerHTML =
    `<p class="muted" style="margin-top:0">Prosentti = nykyinen todennäköisyys, että veikkaus osuu (simulaatiosta). Tarkat pisteet ratkeavat turnauksen edetessä.</p>${blocks}`;
}

/* ----- tabs/boot ----- */
function setView(n) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('is-active', t.dataset.view === n));
  ['dash', 'matches', 'forecast', 'betting', 'bonus'].forEach(v => document.getElementById('view-' + v).hidden = v !== n);
}
function fmtUpdated(iso) {
  try { return new Date(iso).toLocaleString('fi-FI', { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return iso || '—'; }
}

function renderAll() {
  renderDash(); renderMatches(); renderForecast(); renderBetting(); renderBonus();
}

async function boot() {
  try {
    const [pred, res] = await Promise.all([loadJSON('data/predictions.json'), loadJSON('data/results.json')]);
    state.pred = pred; state.res = res;
    document.getElementById('updated').textContent = 'Päivitetty ' + fmtUpdated(res.updatedAt);
    document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => setView(t.dataset.view)));

    // First paint without the projection (instant), then run the tournament
    // simulation and re-render so the win % / forecast appear.
    renderAll();
    if (window.Sim && window.Teams && res.standings && res.standings.length) {
      setTimeout(() => {
        try {
          state.proj = window.Sim.project(state.pred, state.res, window.Teams, { sims: 3000 });
          renderAll();
        } catch (e) { console.error('sim failed', e); }
      }, 30);
    }
  } catch (e) {
    document.getElementById('updated').textContent = 'Virhe ladattaessa.';
    console.error(e);
  }
}
boot();
