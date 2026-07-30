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

  // shared match model parameters (used by both the simulation and the luck index)
  const MODEL_BASE = 1.35, MODEL_K = 1.0;
  function poissonPMF(lambda, k) { let p = Math.exp(-lambda); for (let i = 1; i <= k; i++) p *= lambda / i; return p; }
  // closed-form 1/X/2 probabilities from two team ratings (Poisson goals)
  function match1X2(rH, rA) {
    const lH = MODEL_BASE * Math.exp(MODEL_K * (rH - rA)), lA = MODEL_BASE * Math.exp(MODEL_K * (rA - rH));
    const MAX = 10, ph = [], pa = [];
    for (let i = 0; i <= MAX; i++) { ph[i] = poissonPMF(lH, i); pa[i] = poissonPMF(lA, i); }
    let p1 = 0, px = 0, p2 = 0;
    for (let i = 0; i <= MAX; i++) for (let j = 0; j <= MAX; j++) { const pr = ph[i] * pa[j]; if (i > j) p1 += pr; else if (i === j) px += pr; else p2 += pr; }
    const s = p1 + px + p2 || 1;
    return { '1': p1 / s, 'X': px / s, '2': p2 / s };
  }

  const deburr = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  // ---- Pre-tournament priors ("based on past performances") ----
  // A rough team-strength seed (0..1), keyed by the normalized English team name.
  // It grounds champion/finalist odds in real-world pedigree BEFORE the group stage
  // has produced enough data — its influence is automatically weighted down as
  // actual results arrive (see `prepare`). Unlisted teams default to SEED_DEFAULT.
  // >>> NEXT TOURNAMENT: just refresh these numbers (e.g. from FIFA ranking). <<<
  const SEED_DEFAULT = 0.45;
  const SEED_STRENGTH = {
    spain: 0.95, france: 0.95, argentina: 0.92, brazil: 0.90, england: 0.88,
    portugal: 0.85, netherlands: 0.82, germany: 0.80, belgium: 0.75, croatia: 0.72,
    uruguay: 0.70, colombia: 0.68, morocco: 0.68, norway: 0.66, switzerland: 0.63,
    unitedstates: 0.62, usa: 0.62, mexico: 0.60, senegal: 0.62, japan: 0.60,
    denmark: 0.62, austria: 0.60, ecuador: 0.58, southkorea: 0.55, korearepublic: 0.55,
    australia: 0.52, canada: 0.55, egypt: 0.55, ghana: 0.52, ivorycoast: 0.55,
    qatar: 0.45, saudiarabia: 0.45, iran: 0.55, tunisia: 0.50, algeria: 0.55,
    scotland: 0.55, paraguay: 0.55, panama: 0.45, uzbekistan: 0.45, jordan: 0.42,
    haiti: 0.35, curacao: 0.35, capeverde: 0.35, newzealand: 0.42, kongo: 0.48, congo: 0.48,
  };
  // Elite finishers keep a scoring floor early on (reputation), decaying to nothing
  // as real goals accumulate. Keyed by deburred surname. Refresh per tournament.
  const SCORER_REP = new Set(['mbappe', 'haaland', 'kane', 'messi', 'martinez', 'lautaro',
    'yamal', 'vinicius', 'bellingham', 'osimhen', 'alvarez', 'griezmann', 'dembele', 'kolomuani']);

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

    // ratings: (group performance ⟵blended by data availability⟶ pre-tournament seed),
    // then blended with the family-bet prior.
    const perf = {}; teams.forEach(t => { const pl = Math.max(1, t.played); perf[t.token] = (t.pts / pl) + 0.30 * ((t.gf - t.ga) / pl); });
    const pv = Object.values(perf), pmin = Math.min(...pv), pmax = Math.max(...pv);
    const prMax = Math.max(1, ...Object.values(prior));
    // how much do we trust group results yet? 0 before kickoff, 1 once all 3 rounds are in.
    const avgPlayed = teams.length ? teams.reduce((s, t) => s + t.played, 0) / teams.length : 0;
    const dataW = Math.max(0, Math.min(1, avgPlayed / 3));
    const rating = {};
    teams.forEach(t => {
      const pn = pmax > pmin ? (perf[t.token] - pmin) / (pmax - pmin) : 0.5;
      const seed = SEED_STRENGTH[t.token] != null ? SEED_STRENGTH[t.token] : SEED_DEFAULT;
      const strength = dataW * pn + (1 - dataW) * seed;   // seed dominates early, perf takes over later
      rating[t.token] = 0.55 * strength + 0.45 * (prior[t.token] / prMax);
    });

    const groups = {}; teams.forEach(t => { (groups[t.group] = groups[t.group] || []).push(t.token); });

    // top-scorer candidates (all names canonicalised)
    const apiScorers = res.scorers || [];
    const candMap = {};
    const addCand = (name, teamName, goals, played) => {
      if (!name) return; const key = surnameOf(name);
      if (!candMap[key]) candMap[key] = { name, teamTok: tokenOf(teamName), goals: goals || 0, played: played || 2, rep: SCORER_REP.has(key) };
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

    const BASE = MODEL_BASE, K = MODEL_K;
    const playScore = (ra, rb) => [poisson(BASE * Math.exp(K * (ra - rb))), poisson(BASE * Math.exp(K * (rb - ra)))];

    // Locked bonus outcomes from the real bracket (null = still to be simulated).
    // A stage is "known" once the actual result determines it; the top scorer only
    // locks when the tournament is complete (the golden boot can still change).
    const oc = res.outcomes || {};
    const toTokSet = arr => new Set((arr || []).map(tokenOf).filter(Boolean));
    const known = {
      sf: (oc.semifinalists && oc.semifinalists.length === 4) ? toTokSet(oc.semifinalists) : null,
      fin: (oc.finalists && oc.finalists.length === 2) ? toTokSet(oc.finalists) : null,
      champ: oc.champion ? tokenOf(oc.champion) : null,
      boot: (oc.complete && oc.topScorer) ? oc.topScorer.name : null,
    };

    return { idx, teams, byToken, players, groupMatches, groupGamesByTeam, pick, prior, rating, groups, cands, playerTsKey, playScore, outFromScore, dataW, known, resolvedIdx: groupMatches.filter(m => m.actual).map(m => m.idx) };
  }

  // ---- core Monte Carlo: simulate the rest of the tournament N times.
  // `knownSet` = group-match idx whose ACTUAL result is used; all others are simulated.
  // `ko` = locked knockout outcomes {sf, fin, champ, boot} (any null => that stage is
  //        simulated instead of taken from reality). With everything locked the result
  //        is deterministic, so the true winner ends up at 100%. ----
  function runSims(M, knownSet, N, ko) {
    ko = ko || {};
    const { teams, byToken, players, groupMatches, groupGamesByTeam, pick, rating, groups, cands, playerTsKey, playScore, outFromScore, dataW } = M;
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

      const playKO = (A, B) => {
        const [ga, gb] = playScore(rating[A], rating[B]); koGames[A]++; koGames[B]++;
        return ga > gb ? A : gb > ga ? B : (Math.random() < sigmoid(3 * (rating[A] - rating[B])) ? A : B);
      };
      let sfTeams = null, finTeams = null, champ = null;
      if (ko.champ) {                             // fully known: champion (and everything before) locked
        champ = ko.champ; finTeams = ko.fin ? [...ko.fin] : null; sfTeams = ko.sf ? [...ko.sf] : null;
      } else if (ko.fin) {                        // finalists known, simulate the final only
        finTeams = [...ko.fin]; sfTeams = ko.sf ? [...ko.sf] : null;
        champ = playKO(finTeams[0], finTeams[1]);
      } else if (ko.sf) {                         // semifinalists known, simulate semis + final (pairing approximated)
        sfTeams = [...ko.sf];
        const s = shuffle(sfTeams.slice());
        finTeams = [playKO(s[0], s[1]), playKO(s[2], s[3])];
        champ = playKO(finTeams[0], finTeams[1]);
      } else {                                    // nothing known: simulate the whole bracket from the qualifiers
        let alive = shuffle(qualified.slice());
        while (alive.length > 1) {
          const next = [];
          for (let i = 0; i + 1 < alive.length; i += 2) next.push(playKO(alive[i], alive[i + 1]));
          if (next.length === 4) sfTeams = next.slice();
          if (next.length === 2) finTeams = next.slice();
          if (next.length === 1) champ = next[0];
          alive = next;
        }
      }
      const sfSet = new Set(sfTeams || []), finSet = new Set(finTeams || []);
      sfSet.forEach(t => pSF[t]++); finSet.forEach(t => pFin[t]++); if (champ) pCh[champ]++;

      let boot = ko.boot || null;
      if (!boot) {
        let bootGoals = -1;
        for (const c of cands) {
          const games = (c.teamTok ? futureGG[c.teamTok] + koGames[c.teamTok] : 1);
          const obs = (c.goals / Math.max(2, c.played)) || 0;
          // reputation floor (elite finishers) matters early, observed rate takes over as goals pile up
          const seedRate = c.rep ? 0.55 : 0.22;
          const rate = dataW * obs + (1 - dataW) * seedRate || 0.15;
          const total = c.goals + poisson(Math.max(0.05, rate * games));
          if (total > bootGoals) { bootGoals = total; boot = c.name; }
        }
      }
      if (boot) tsWin[boot] = (tsWin[boot] || 0) + 1;

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
    const r = runSims(M, knownSet, SIMS, M.known);   // lock in whatever the real bracket already decided

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

    const winAt = (knownSet, ko) => {
      const r = runSims(M, knownSet, N, ko);
      const win = {}; players.forEach((p, pi) => win[p] = r.wins[pi] / N);
      return win;
    };

    // group-stage checkpoints: results revealed match by match, knockouts still open
    const allGroup = new Set(chrono);
    const steps = counts.map(s => ({ played: s, win: winAt(new Set(chrono.slice(0, s)), {}), stage: 'group' }));

    // knockout milestones: each locks in the real bonus outcomes as they're decided,
    // so the win% line bends toward whoever actually banked the bonus points.
    const bracket = (res.outcomes && res.outcomes.bracket) || [];
    const cnt = st => bracket.filter(b => b.stage === st).length;
    const groupTotal = pred.matches.length;
    const afterQF = groupTotal + cnt('LAST_32') + cnt('LAST_16') + cnt('QUARTER_FINALS');
    const afterSF = afterQF + cnt('SEMI_FINALS');
    const afterFinal = afterSF + cnt('THIRD_PLACE') + cnt('FINAL');
    const K = M.known;
    if (K.sf) steps.push({ played: afterQF, win: winAt(allGroup, { sf: K.sf }), stage: 'sf', label: 'Välierät selvillä' });
    if (K.fin) steps.push({ played: afterSF, win: winAt(allGroup, { sf: K.sf, fin: K.fin }), stage: 'fin', label: 'Finalistit selvillä' });
    if (K.champ) steps.push({ played: afterFinal, win: winAt(allGroup, K), stage: 'champ', label: 'Mestari ratkennut' });

    return { players, steps, total: afterFinal, groupTotal };
  }

  // ---- luck index: actual points vs expected points (xP) on played group games ----
  function luckIndex(pred, res, T) {
    const M = prepare(pred, res, T);
    const { players, groupMatches, rating } = M;
    const NP = players.length;
    const xp = new Array(NP).fill(0), act = new Array(NP).fill(0);
    let best = null, worst = null; // single luckiest / unluckiest pick across everyone
    let resolved = 0;
    for (const m of groupMatches) {
      if (!m.actual) continue;
      resolved++;
      const P = match1X2(rating[m.h], rating[m.a]);
      for (const o of ['1', 'X', '2']) {
        const arr = m.byOut[o], p = P[o];
        const correct = o === m.actual.out;
        for (const pi of arr) {
          xp[pi] += p; if (correct) act[pi]++;
          if (correct && (!best || p < best.p)) best = { player: players[pi], m, p, out: o };
          if (!correct && (!worst || p > worst.p)) worst = { player: players[pi], m, p, out: o };
        }
      }
    }
    const rows = players.map((p, pi) => ({ name: p, actual: act[pi], xp: xp[pi], luck: act[pi] - xp[pi] }))
      .sort((a, b) => b.luck - a.luck);
    return { rows, resolved, best, worst };
  }

  const Sim = { project, winTimeline, luckIndex, prepare, runSims, buildIndex, canonScorer };
  if (typeof module !== 'undefined' && module.exports) module.exports = Sim;
  if (typeof root !== 'undefined') root.Sim = Sim;
})(typeof window !== 'undefined' ? window : this);
