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
    // find ALL team tokens mentioned in a free-text string (order of first appearance)
    function extractTokens(str) {
      const n = norm(str || '');
      const hits = [];
      teams.forEach(t => {
        let pos = -1;
        for (const sp of spell[t.token]) { if (sp.length >= 3) { const i = n.indexOf(sp); if (i >= 0 && (pos < 0 || i < pos)) pos = i; } }
        if (pos >= 0) hits.push({ token: t.token, pos });
      });
      hits.sort((a, b) => a.pos - b.pos);
      // de-dupe, drop tokens fully contained in an earlier-found longer token's span isn't needed; tokens are distinct teams
      const seen = new Set(); const out = [];
      hits.forEach(h => { if (!seen.has(h.token)) { seen.add(h.token); out.push(h.token); } });
      return out;
    }
    return { teams, tokenSet, tokenOf, extractTokens, byToken: Object.fromEntries(teams.map(t => [t.token, t])) };
  }

  function project(pred, res, T, opts) {
    opts = opts || {};
    const SIMS = opts.sims || 3000;
    const idx = buildIndex(res.standings || [], T);
    const { teams, tokenOf, extractTokens, byToken } = idx;
    const players = pred.players;
    const resultFor = i => (res.results || {})[String(i)] || null;

    // ---- remaining group matches (token pairs) + player guesses ----
    const remGroup = [];
    pred.matches.forEach(m => {
      const r = resultFor(m.idx);
      if (r && r.outcome) return; // already played
      const h = tokenOf(m.home), a = tokenOf(m.away);
      if (!h || !a) return;
      remGroup.push({ idx: m.idx, h, a, guesses: m.guesses });
    });

    // ---- current group points per player (already-played group games) ----
    const curPts = {}; players.forEach(p => curPts[p] = 0);
    pred.matches.forEach(m => {
      const r = resultFor(m.idx); if (!r || !r.outcome) return;
      players.forEach(p => { if (m.guesses[p] === r.outcome) curPts[p]++; });
    });

    // ---- bonus picks -> tokens, and the family-bet prior per team ----
    const bRow = k => (pred.bonus.find(b => b.key === k) || { picks: {} }).picks;
    const sfRow = bRow('semifinal'), fiRow = bRow('final'), chRow = bRow('champion'), tsRow = bRow('topscorer');
    const pick = {}; // player -> {sf:Set, fin:Set, champ:token, ts:name}
    const prior = {}; teams.forEach(t => prior[t.token] = 0);
    players.forEach(p => {
      const sf = extractTokens(sfRow[p]);
      const fin = extractTokens(fiRow[p]);
      const champArr = extractTokens(chRow[p]);
      const champ = champArr[0] || null;
      pick[p] = { sf: new Set(sf), fin: new Set(fin), champ, ts: (tsRow[p] || '').trim() };
      sf.forEach(t => prior[t] += 1);
      fin.forEach(t => prior[t] += 2);
      if (champ) prior[champ] += 3;
    });

    // ---- ratings: blend group performance with the family-bet prior ----
    const perf = {}; teams.forEach(t => {
      const pl = Math.max(1, t.played);
      perf[t.token] = (t.pts / pl) + 0.30 * ((t.gf - t.ga) / pl); // ~[-?, 4.2]
    });
    const pv = Object.values(perf), pmin = Math.min(...pv), pmax = Math.max(...pv);
    const prMax = Math.max(1, ...Object.values(prior));
    const rating = {};
    teams.forEach(t => {
      const pn = pmax > pmin ? (perf[t.token] - pmin) / (pmax - pmin) : 0.5;
      const rn = prior[t.token] / prMax;
      rating[t.token] = 0.55 * pn + 0.45 * rn; // 0..1
    });

    // ---- group membership ----
    const groups = {};
    teams.forEach(t => { (groups[t.group] = groups[t.group] || []).push(t.token); });

    // ---- top-scorer candidates ----
    const deburr = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const apiScorers = res.scorers || [];
    const candMap = {}; // key -> {name, teamTok, goals, rate}
    function addCand(name, teamName, goals, played) {
      if (!name) return;
      const key = deburr(name).split(/\s+/).pop();
      if (!candMap[key]) candMap[key] = { name, teamTok: tokenOf(teamName), goals: goals || 0, played: played || 2 };
    }
    apiScorers.forEach(s => addCand(s.name, s.team, s.goals, 2));
    // family-picked scorers: match to an API scorer if possible, else add as longshot
    players.forEach(p => {
      const raw = (tsRow[p] || '').trim(); if (!raw) return;
      const sur = deburr(raw).replace(/[^a-z ]/g, ' ').trim().split(/\s+/).pop();
      const found = apiScorers.find(s => deburr(s.name).includes(sur) && sur.length >= 3);
      if (found) return; // already a candidate
      addCand(raw, null, 0, 2);
    });
    const cands = Object.values(candMap);
    // map each player's top-scorer pick to a candidate key for scoring
    const playerTsKey = {};
    players.forEach(p => {
      const raw = (tsRow[p] || '').trim();
      const sur = deburr(raw).replace(/[^a-z ]/g, ' ').trim().split(/\s+/).pop();
      const c = cands.find(c => deburr(c.name).split(/\s+/).pop() === sur || deburr(c.name).includes(sur) && sur.length >= 3);
      playerTsKey[p] = c ? c.name : null;
    });

    // remaining group games per team (for top-scorer minutes)
    const remGamesTeam = {}; teams.forEach(t => remGamesTeam[t.token] = 0);
    remGroup.forEach(m => { remGamesTeam[m.h]++; remGamesTeam[m.a]++; });

    // ---- match model ----
    const BASE = 1.35, K = 1.0;
    function playScore(ra, rb) {
      const la = BASE * Math.exp(K * (ra - rb)), lb = BASE * Math.exp(K * (rb - ra));
      return [poisson(la), poisson(lb)];
    }

    // ---- accumulators ----
    const pSF = {}, pFin = {}, pCh = {}; teams.forEach(t => { pSF[t.token] = pFin[t.token] = pCh[t.token] = 0; });
    const tsWin = {}; cands.forEach(c => tsWin[c.name] = 0);
    const wins = {}, expTot = {}, expBon = {}; players.forEach(p => { wins[p] = 0; expTot[p] = 0; expBon[p] = 0; });

    const shuffle = arr => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };

    for (let s = 0; s < SIMS; s++) {
      // group tables start from current standings
      const tab = {}; teams.forEach(t => tab[t.token] = { pts: t.pts, gf: t.gf, ga: t.ga });
      const gOut = {}; players.forEach(p => gOut[p] = 0);
      const teamGames = {}; teams.forEach(t => teamGames[t.token] = t.played); // games played count this sim

      // simulate remaining group games
      for (const m of remGroup) {
        const [gh, ga] = playScore(rating[m.h], rating[m.a]);
        tab[m.h].pts += gh > ga ? 3 : gh === ga ? 1 : 0;
        tab[m.a].pts += ga > gh ? 3 : gh === ga ? 1 : 0;
        tab[m.h].gf += gh; tab[m.h].ga += ga; tab[m.a].gf += ga; tab[m.a].ga += gh;
        teamGames[m.h]++; teamGames[m.a]++;
        const out = gh > ga ? '1' : gh === ga ? 'X' : '2';
        for (const p of players) if (m.guesses[p] === out) gOut[p]++;
      }

      // rank groups -> qualifiers
      const cmp = (x, y) => tab[y].pts - tab[x].pts || (tab[y].gf - tab[y].ga) - (tab[x].gf - tab[x].ga) || tab[y].gf - tab[x].gf || (Math.random() - 0.5);
      const qualified = []; const thirds = [];
      for (const g of Object.keys(groups)) {
        const sorted = groups[g].slice().sort(cmp);
        qualified.push(sorted[0], sorted[1]);
        if (sorted[2]) thirds.push(sorted[2]);
      }
      thirds.sort(cmp);
      for (let i = 0; i < 8 && i < thirds.length; i++) qualified.push(thirds[i]);

      // knockout: random pairing each round
      let alive = shuffle(qualified.slice());
      let sfTeams = null, finTeams = null, champ = null;
      while (alive.length > 1) {
        const next = [];
        for (let i = 0; i + 1 < alive.length; i += 2) {
          const A = alive[i], B = alive[i + 1];
          let [ga, gb] = playScore(rating[A], rating[B]);
          teamGames[A]++; teamGames[B]++;
          let w;
          if (ga > gb) w = A; else if (gb > ga) w = B; else w = Math.random() < sigmoid(3 * (rating[A] - rating[B])) ? A : B;
          next.push(w);
        }
        if (next.length === 4) sfTeams = next.slice();
        if (next.length === 2) finTeams = next.slice();
        if (next.length === 1) champ = next[0];
        alive = next;
      }
      const sfSet = new Set(sfTeams || []), finSet = new Set(finTeams || []);
      sfSet.forEach(t => pSF[t]++); finSet.forEach(t => pFin[t]++); if (champ) pCh[champ]++;

      // top-scorer race
      let boot = null, bootGoals = -1;
      for (const c of cands) {
        const rg = (c.teamTok ? remGamesTeam[c.teamTok] : 1); // remaining group games
        const koG = c.teamTok ? Math.max(0, teamGames[c.teamTok] - (byToken[c.teamTok] ? byToken[c.teamTok].played + rg : 0)) : 0;
        const games = rg + koG;
        const rate = (c.goals / Math.max(2, c.played)) || 0.15;
        const total = c.goals + poisson(Math.max(0.05, rate * games));
        if (total > bootGoals) { bootGoals = total; boot = c.name; }
      }
      if (boot) tsWin[boot]++;

      // player totals this sim
      let best = -1, bestPlayers = [];
      for (const p of players) {
        const pk = pick[p];
        let bonus = 0;
        sfSet.forEach(t => { if (pk.sf.has(t)) bonus += 5; });
        finSet.forEach(t => { if (pk.fin.has(t)) bonus += 10; });
        if (pk.champ && pk.champ === champ) bonus += 10;
        if (playerTsKey[p] && playerTsKey[p] === boot) bonus += 10;
        const total = curPts[p] + gOut[p] + bonus;
        expTot[p] += total; expBon[p] += bonus;
        if (total > best) { best = total; bestPlayers = [p]; }
        else if (total === best) bestPlayers.push(p);
      }
      const share = 1 / bestPlayers.length;
      bestPlayers.forEach(p => wins[p] += share);
    }

    // ---- assemble output ----
    const teamProb = teams.map(t => ({
      name: t.name, group: t.group, rating: rating[t.token],
      sf: pSF[t.token] / SIMS, fin: pFin[t.token] / SIMS, champ: pCh[t.token] / SIMS,
    })).sort((a, b) => b.champ - a.champ || b.fin - a.fin);

    const topscorers = cands.map(c => ({ name: c.name, goals: c.goals, p: tsWin[c.name] / SIMS }))
      .sort((a, b) => b.p - a.p);

    const playerProj = players.map(p => ({
      name: p, curGroup: curPts[p], expTotal: expTot[p] / SIMS, expBonus: expBon[p] / SIMS, win: wins[p] / SIMS,
    })).sort((a, b) => b.win - a.win || b.expTotal - a.expTotal);

    // per-player annotated picks (with probabilities) for the bonus view
    const probOf = {}; teams.forEach(t => probOf[t.token] = { sf: pSF[t.token] / SIMS, fin: pFin[t.token] / SIMS, champ: pCh[t.token] / SIMS });
    const tsProb = {}; topscorers.forEach(t => tsProb[t.name] = t.p);
    const playerPicks = {};
    players.forEach(p => {
      const annot = tok => ({ name: (byToken[tok] || {}).name || tok, p: (probOf[tok] || {}) });
      playerPicks[p] = {
        sf: [...pick[p].sf].map(t => ({ ...annot(t), p: probOf[t] ? probOf[t].sf : 0 })),
        fin: [...pick[p].fin].map(t => ({ ...annot(t), p: probOf[t] ? probOf[t].fin : 0 })),
        champ: pick[p].champ ? { ...annot(pick[p].champ), p: probOf[pick[p].champ] ? probOf[pick[p].champ].champ : 0 } : null,
        ts: pick[p].ts ? { name: pick[p].ts, p: (playerTsKey[p] && tsProb[playerTsKey[p]]) || 0 } : null,
      };
    });

    return { sims: SIMS, teamProb, topscorers, playerProj, playerPicks };
  }

  const Sim = { project, buildIndex };
  if (typeof module !== 'undefined' && module.exports) module.exports = Sim;
  if (typeof root !== 'undefined') root.Sim = Sim;
})(typeof window !== 'undefined' ? window : this);
