/* Tournament Monte Carlo for MM-veikkaus.
 *
 * Rates each team from (a) group-stage performance and (b) the family's own bets,
 * then simulates the rest of the tournament many times: remaining group games ->
 * qualifiers (top 2 + best 8 thirds) -> knockout rounds -> champion, plus a
 * top-scorer race. Produces per-team P(semifinal/final/champion), a golden-boot
 * race, and each player's expected bonus points + overall win probability
 * (group 1X2 points + bonus points combined).
 *
 * Pure JS, no DOM. Works in Node (require) and the browser (window.Sim).
 *
 * Knockout pairings are drawn randomly each round (the real bracket isn't published
 * by the data source while the group stage is live) — an explicit, documented
 * approximation; aggregate probabilities are driven mostly by team strength.
 */
(function (root) {
  'use strict';

  function poisson(lambda) {
    // Knuth's algorithm; lambda is small (~1-3) so this is cheap.
    const L = Math.exp(-lambda);
    let k = 0, p = 1;
    do { k++; p *= Math.random(); } while (p > L);
    return k - 1;
  }
  const sigmoid = x => 1 / (1 + Math.exp(-x));
  const deburr = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  // Canonical scorer name. Matches the raw pick to the live top-scorer list by
  // surname (so "Mbappe", "mbappe (sama vanha)" etc. all become the API spelling),
  // else falls back to a curated spelling.
  const SCORER_FALLBACK = {
    mbappe: 'Kylian Mbappé', haaland: 'Erling Haaland', dembele: 'Ousmane Dembélé',
    kane: 'Harry Kane', yamal: 'Lamine Yamal', lautaro: 'Lautaro Martínez',
    martinez: 'Lautaro Martínez', pele: 'Pelé',
  };
  function surnameOf(raw) {
    return deburr(String(raw || '').replace(/\(.*?\)/g, ' ')).replace(/[^a-z ]/g, ' ').trim().split(/\s+/).pop() || '';
  }
  function canonScorer(raw, apiScorers) {
    const sur = surnameOf(raw);
    if (sur.length >= 3) {
      const hit = (apiScorers || []).find(s => deburr(s.name).includes(sur));
      if (hit) return hit.name;
    }
    if (SCORER_FALLBACK[sur]) return SCORER_FALLBACK[sur];
    return String(raw || '').replace(/\(.*?\)/g, '').replace(/[!*?]/g, '').trim() || raw;
  }

  // ---- build a token index from the standings (canonical = English name) ----
  function buildIndex(standings, T) {
    const norm = T.norm;
    const teams = standings.filter(s => s.team).map(s => ({
      name: s.team, token: norm(s.team), group: s.group,
      played: s.played || 0, pts: s.points || 0, gf: s.gf || 0, ga: s.ga || 0,
    }));
    const tokenSet = new Set(teams.map(t => t.token));
    const spell = {}; teams.forEach(t => spell[t.token] = new Set([t.token]));
    for (const [fiKey, aliases] of Object.entries(T.FI_TO_EN)) {
      let match = null;
      for (const a of aliases) { const n = norm(a); if (tokenSet.has(n)) { match = n; break; } }
      if (!match) {
        for (const t of teams) {
          if (aliases.some(a => { const n = norm(a); return n === t.token || (n.length >= 4 && (t.token.includes(n) || n.includes(t.token))); })) { match = t.token; break; }
        }
      }
      if (match) { spell[match].add(norm(fiKey)); aliases.forEach(a => spell[match].add(norm(a))); }
    }
    const cache = {};
    function tokenOf(name) {
      if (!name) return null;
      const n = norm(name);
      if (cache[n] !== undefined) return cache[n];
      let res = null;
      if (tokenSet.has(n)) res = n;
      else for (const t of teams) {
        for (const sp of spell[t.token]) {
          if (sp.length >= 3 && (n === sp || n.includes(sp) || (sp.length >= 5 && sp.includes(n)))) { res = t.token; break; }
        }
        if (res) break;
      }
      cache[n] = res; return res;
    }
    // find ALL team tokens mentioned in a free-text string (order of first appearance).
    // Matches on WORD boundaries (not raw substrings) so that e.g. "Englanti Ranska"
    // does not spuriously yield "Iran" from the merged letters ...nti·ran·ska.
    function extractTokens(str) {
      const words = String(str || '').split(/[^A-Za-zÀ-ÿ0-9]+/).map(w => norm(w)).filter(Boolean);
      // every concatenation of up to 4 consecutive words -> earliest word index
      const concat = new Map();
      for (let i = 0; i < words.length; i++) {
        let s = '';
        for (let j = i; j < words.length && j < i + 4; j++) { s += words[j]; if (!concat.has(s)) concat.set(s, i); }
      }
      const hits = [];
      teams.forEach(t => {
        let pos = -1;
        for (const sp of spell[t.token]) {
          if (sp.length >= 2 && concat.has(sp)) { const p = concat.get(sp); if (pos < 0 || p < pos) pos = p; }
        }
        if (pos >= 0) hits.push({ token: t.token, pos });
      });
      hits.sort((a, b) => a.pos - b.pos);
      const seen = new Set(); const out = [];
      hits.forEach(h => { if (!seen.has(h.token)) { seen.add(h.token); out.push(h.token); } });
      return out;
    }
    return { teams, tokenSet, tokenOf, extractTokens, byToken: Object.fromEntries(teams.map(t => [t.token, t])) };
  }

  // ---- shared model: everything that doesn't depend on which results are "known" ----
  function prepare(pred, res, T) {
    const idx = buildIndex(res.standings || [], T);
    const { teams, tokenOf, extractTokens, byToken } = idx;
    const players = pred.players;
    const resultFor = i => (res.results || {})[String(i)] || null;
    const outFromScore = (h, a) => h > a ? '1' : h === a ? 'X' : '2';

    // all group matches, mapped to tokens, with actual score where known
    const groupMatches = [];
    const groupGamesByTeam = {}; teams.forEach(t => groupGamesByTeam[t.token] = []);
    pred.matches.forEach(m => {
      const h = tokenOf(m.home), a = tokenOf(m.away);
      if (!h || !a) return;
      const r = resultFor(m.idx);
      let actual = null;
      if (r && r.outcome) {
        let gh = r.home, ga = r.away;
        if (gh == null) { gh = r.outcome === '1' ? 1 : 0; ga = r.outcome === '2' ? 1 : 0; } // synth if no score
        actual = { out: r.outcome, gh, ga };
      }
      const byOut = { '1': [], 'X': [], '2': [] };
      players.forEach((p, pi) => { const g = m.guesses[p]; if (g === '1' || g === 'X' || g === '2') byOut[g].push(pi); });
      groupMatches.push({ idx: m.idx, h, a, actual, byOut });
      groupGamesByTeam[h].push(m.idx); groupGamesByTeam[a].push(m.idx);
    });

    // bonus picks -> tokens + family-bet prior
    const bRow = k => (pred.bonus.find(b => b.key === k) || { picks: {} }).picks;
    const sfRow = bRow('semifinal'), fiRow = bRow('final'), chRow = bRow('champion'), tsRow = bRow('topscorer');
    const pick = {};
    const prior = {}; teams.forEach(t => prior[t.token] = 0);
    players.forEach(p => {
      const sf = extractTokens(sfRow[p]), fin = extractTokens(fiRow[p]);
      const champ = extractTokens(chRow[p])[0] || null;
      pick[p] = { sf: new Set(sf), fin: new Set(fin), champ, ts: (tsRow[p] || '').trim() };
      sf.forEach(t => prior[t] += 1); fin.forEach(t => prior[t] += 2); if (champ) prior[champ] += 3;
    });

    // ratings: group performance blended with the family-bet prior
    const perf = {}; teams.forEach(t => { const pl = Math.max(1, t.played); perf[t.token] = (t.pts / pl) + 0.30 * ((t.gf - t.ga) / pl); });
    const pv = Object.values(perf), pmin = Math.min(...pv), pmax = Math.max(...pv);
    const prMax = Math.max(1, ...Object.values(prior));
    const rating = {};
    teams.forEach(t => {
      const pn = pmax > pmin ? (perf[t.token] - pmin) / (pmax - pmin) : 0.5;
      rating[t.token] = 0.55 * pn + 0.45 * (prior[t.token] / prMax);
    });

    const groups = {}; teams.forEach(t => { (groups[t.group] = groups[t.group] || []).push(t.token); });

    // top-scorer candidates (all names canonicalised)
    const apiScorers = res.scorers || [];
    const candMap = {};
    const addCand = (name, teamName, goals, played) => {
      if (!name) return; const key = surnameOf(name);
      if (!candMap[key]) candMap[key] = { name, teamTok: tokenOf(teamName), goals: goals || 0, played: played || 2 };
    };
    apiScorers.forEach(s => addCand(s.name, s.team, s.goals, 2));
    players.forEach(p => {
      const raw = (tsRow[p] || '').trim(); if (!raw) return;
      addCand(canonScorer(raw, apiScorers), null, 0, 2); // canonical; no-op if already a candidate
    });
    const cands = Object.values(candMap);
    const playerTsKey = {};
    players.forEach(p => {
      const raw = (tsRow[p] || '').trim();
      playerTsKey[p] = raw ? canonScorer(raw, apiScorers) : null;
    });

    const BASE = 1.35, K = 1.0;
    const playScore = (ra, rb) => [poisson(BASE * Math.exp(K * (ra - rb))), poisson(BASE * Math.exp(K * (rb - ra)))];

    return { idx, teams, byToken, players, groupMatches, groupGamesByTeam, pick, prior, rating, groups, cands, playerTsKey, playScore, outFromScore, resolvedIdx: groupMatches.filter(m => m.actual).map(m => m.idx) };
  }

  // ---- core Monte Carlo: simulate the rest of the tournament N times.
  // `knownSet` = group-match idx whose ACTUAL result is used; all others are simulated. ----
  function runSims(M, knownSet, N) {
    const { teams, byToken, players, groupMatches, groupGamesByTeam, pick, rating, groups, cands, playerTsKey, playScore, outFromScore } = M;
    const NP = players.length;
    const futureGG = {}; teams.forEach(t => futureGG[t.token] = groupGamesByTeam[t.token].filter(i => !knownSet.has(i)).length);

    const pSF = {}, pFin = {}, pCh = {}; teams.forEach(t => { pSF[t.token] = pFin[t.token] = pCh[t.token] = 0; });
    const tsWin = {}; cands.forEach(c => tsWin[c.name] = 0);
    const wins = new Array(NP).fill(0), expTot = new Array(NP).fill(0), expBon = new Array(NP).fill(0);
    const groupKeys = Object.keys(groups);
    const shuffle = arr => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };

    for (let s = 0; s < N; s++) {
      const tab = {}; teams.forEach(t => tab[t.token] = { pts: 0, gf: 0, ga: 0 });
      const gOut = new Array(NP).fill(0);
      const koGames = {}; teams.forEach(t => koGames[t.token] = 0);

      for (const m of groupMatches) {
        let gh, ga, out;
        if (knownSet.has(m.idx) && m.actual) { gh = m.actual.gh; ga = m.actual.ga; out = m.actual.out; }
        else { [gh, ga] = playScore(rating[m.h], rating[m.a]); out = outFromScore(gh, ga); }
        const th = tab[m.h], ta = tab[m.a];
        th.pts += gh > ga ? 3 : gh === ga ? 1 : 0; ta.pts += ga > gh ? 3 : gh === ga ? 1 : 0;
        th.gf += gh; th.ga += ga; ta.gf += ga; ta.ga += gh;
        const arr = m.byOut[out]; for (let k = 0; k < arr.length; k++) gOut[arr[k]]++;
      }

      const cmp = (x, y) => tab[y].pts - tab[x].pts || (tab[y].gf - tab[y].ga) - (tab[x].gf - tab[x].ga) || tab[y].gf - tab[x].gf || (Math.random() - 0.5);
      const qualified = [], thirds = [];
      for (const g of groupKeys) { const sorted = groups[g].slice().sort(cmp); qualified.push(sorted[0], sorted[1]); if (sorted[2]) thirds.push(sorted[2]); }
      thirds.sort(cmp);
      for (let i = 0; i < 8 && i < thirds.length; i++) qualified.push(thirds[i]);

      let alive = shuffle(qualified.slice()), sfTeams = null, finTeams = null, champ = null;
      while (alive.length > 1) {
        const next = [];
        for (let i = 0; i + 1 < alive.length; i += 2) {
          const A = alive[i], B = alive[i + 1];
          const [ga, gb] = playScore(rating[A], rating[B]); koGames[A]++; koGames[B]++;
          next.push(ga > gb ? A : gb > ga ? B : (Math.random() < sigmoid(3 * (rating[A] - rating[B])) ? A : B));
        }
        if (next.length === 4) sfTeams = next.slice();
        if (next.length === 2) finTeams = next.slice();
        if (next.length === 1) champ = next[0];
        alive = next;
      }
      const sfSet = new Set(sfTeams || []), finSet = new Set(finTeams || []);
      sfSet.forEach(t => pSF[t]++); finSet.forEach(t => pFin[t]++); if (champ) pCh[champ]++;

      let boot = null, bootGoals = -1;
      for (const c of cands) {
        const games = (c.teamTok ? futureGG[c.teamTok] + koGames[c.teamTok] : 1);
        const rate = (c.goals / Math.max(2, c.played)) || 0.15;
        const total = c.goals + poisson(Math.max(0.05, rate * games));
        if (total > bootGoals) { bootGoals = total; boot = c.name; }
      }
      if (boot) tsWin[boot]++;

      let best = -1, ties = [];
      for (let pi = 0; pi < NP; pi++) {
        const pk = pick[players[pi]];
        let bonus = 0;
        sfSet.forEach(t => { if (pk.sf.has(t)) bonus += 5; });
        finSet.forEach(t => { if (pk.fin.has(t)) bonus += 10; });
        if (pk.champ && pk.champ === champ) bonus += 10;
        if (playerTsKey[players[pi]] && playerTsKey[players[pi]] === boot) bonus += 10;
        const total = gOut[pi] + bonus;
        expTot[pi] += total; expBon[pi] += bonus;
        if (total > best) { best = total; ties = [pi]; } else if (total === best) ties.push(pi);
      }
      const share = 1 / ties.length;
      for (const pi of ties) wins[pi] += share;
    }
    return { wins, expTot, expBon, pSF, pFin, pCh, tsWin, N };
  }

  function project(pred, res, T, opts) {
    opts = opts || {};
    const SIMS = opts.sims || 3000;
    const M = prepare(pred, res, T);
    const { teams, byToken, players, pick, rating, cands, playerTsKey, groupMatches } = M;
    const knownSet = new Set(M.resolvedIdx);
    const r = runSims(M, knownSet, SIMS);

    // current (locked) group points per player
    const curGroup = {}; players.forEach(p => curGroup[p] = 0);
    groupMatches.forEach(m => { if (m.actual) m.byOut[m.actual.out].forEach(pi => curGroup[players[pi]]++); });

    const teamProb = teams.map(t => ({ name: t.name, group: t.group, rating: rating[t.token], sf: r.pSF[t.token] / SIMS, fin: r.pFin[t.token] / SIMS, champ: r.pCh[t.token] / SIMS }))
      .sort((a, b) => b.champ - a.champ || b.fin - a.fin);
    const topscorers = cands.map(c => ({ name: c.name, goals: c.goals, p: r.tsWin[c.name] / SIMS })).sort((a, b) => b.p - a.p);
    const playerProj = players.map((p, pi) => ({ name: p, curGroup: curGroup[p], expTotal: r.expTot[pi] / SIMS, expBonus: r.expBon[pi] / SIMS, win: r.wins[pi] / SIMS }))
      .sort((a, b) => b.win - a.win || b.expTotal - a.expTotal);

    const probOf = {}; teams.forEach(t => probOf[t.token] = { sf: r.pSF[t.token] / SIMS, fin: r.pFin[t.token] / SIMS, champ: r.pCh[t.token] / SIMS });
    const tsProb = {}; topscorers.forEach(t => tsProb[t.name] = t.p);
    const playerPicks = {};
    players.forEach(p => {
      const annot = tok => ({ name: (byToken[tok] || {}).name || tok });
      playerPicks[p] = {
        sf: [...pick[p].sf].map(t => ({ ...annot(t), p: probOf[t] ? probOf[t].sf : 0 })),
        fin: [...pick[p].fin].map(t => ({ ...annot(t), p: probOf[t] ? probOf[t].fin : 0 })),
        champ: pick[p].champ ? { ...annot(pick[p].champ), p: probOf[pick[p].champ] ? probOf[pick[p].champ].champ : 0 } : null,
        ts: pick[p].ts ? { name: playerTsKey[p] || pick[p].ts, p: (playerTsKey[p] && tsProb[playerTsKey[p]]) || 0 } : null,
      };
    });
    return { sims: SIMS, teamProb, topscorers, playerProj, playerPicks };
  }

  // ---- win-probability over time: recompute win% at each point in history,
  // treating later results as not-yet-known at that point. ----
  function winTimeline(pred, res, T, opts) {
    opts = opts || {};
    const N = opts.sims || 600;
    const maxPts = opts.maxPoints || 30;
    const M = prepare(pred, res, T);
    const { players } = M;
    const chrono = M.resolvedIdx.slice().sort((a, b) => a - b);
    const R = chrono.length;

    // checkpoints = matches-played counts 0..R, subsampled to <= maxPts (always include 0 and R)
    let counts;
    if (R + 1 <= maxPts) counts = Array.from({ length: R + 1 }, (_, i) => i);
    else {
      counts = [];
      for (let i = 0; i < maxPts - 1; i++) counts.push(Math.round(i * R / (maxPts - 1)));
      counts.push(R);
      counts = [...new Set(counts)];
    }

    const steps = counts.map(s => {
      const knownSet = new Set(chrono.slice(0, s));
      const r = runSims(M, knownSet, N);
      const win = {}; players.forEach((p, pi) => win[p] = r.wins[pi] / N);
      return { played: s, win };
    });
    return { players, steps, total: pred.matches.length };
  }

  const Sim = { project, winTimeline, prepare, runSims, buildIndex, canonScorer };
  if (typeof module !== 'undefined' && module.exports) module.exports = Sim;
  if (typeof root !== 'undefined') root.Sim = Sim;
})(typeof window !== 'undefined' ? window : this);
