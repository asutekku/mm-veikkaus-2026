# ⚽ MM-veikkaus 2026

A little website for our family's World Cup 2026 prediction game. Everyone guesses
**1 / X / 2** for every group-stage match; you get **1 point per correct guess**.
Match results (and top scorers) are fetched automatically and everything updates itself.

- **Etusivu** – the dashboard:
  - a stat ribbon (matches resolved, goals, leader, gap, consensus accuracy)
  - a **cumulative points chart** — one line per player; tap a name to spotlight it
  - a dense **standings table**: rank, movement, points, hit-rate, last-5 form, **win probability**, and how many points are still reachable (`OUT` / *pelistä* once a player is mathematically eliminated)
  - the **Golden Boot race** with everyone's top-scorer bet normalized to real player names + live goal counts
  - **tournament insights** (biggest upset, banker, biggest win, goals/match, draw rate)
- **Ottelut** – the full prediction grid (everyone's guess per match, green = correct, red = wrong, plus how many got each match right). Tap a name to highlight their column.
- **Bonukset** – the semifinal / final / champion / top-scorer predictions. During the
  tournament it shows live hit-probabilities; once the final is played it flips into a
  **results view** — the real outcomes plus who nailed what, scored automatically.

Once the tournament is over the dashboard shows a **champion banner** (family-league
winner + the real World Cup champion, final and Golden Boot) and a **final standings**
table where each player's total is group points **+ bonus points** (semifinalist 5,
finalist 10, champion +10, top scorer 10). Bonus team-picks are matched with the same
word-boundary tokenizer the simulation uses, so dash/comma/"ja"-separated picks all
resolve correctly.

**Win probability** is a full-tournament Monte Carlo simulation. Team strength blends
three things: **group-stage performance**, a **pre-tournament seed** (real-world
pedigree — see `SEED_STRENGTH` in `sim.js`), and the **family's own bets**. The seed
grounds champion/top-scorer odds from match 1 and is automatically weighted down as
real results arrive, so by the end of the group stage it's the actual results doing the
talking. The golden-boot race works the same way (elite finishers keep a scoring floor
early, observed goals take over).

## How it works

| File | What it is |
|------|------------|
| `data/predictions.json` | Everyone's guesses, parsed once from the Excel file. Static. |
| `data/results.json` | Actual match outcomes + top-scorer standings. **Updated automatically.** |
| `index.html` / `style.css` / `app.js` | The website. Plain static files, no build step. |
| `scripts/update-results.js` | Fetches results from football-data.org → `results.json`. |
| `scripts/teams.js` | Finnish → English team-name mapping for matching API fixtures. |
| `scripts/build-predictions.js` | Re-parses the `.xlsb` if the guesses ever change. |
| `.github/workflows/update-results.yml` | Runs the fetch every 3 hours. |

The scoring lives entirely in the browser (`app.js`), computed from
`predictions.json` + `results.json`. It already matches the totals in the original
spreadsheet exactly.

## One-time setup (≈5 minutes)

### 1. Get a free API token
Register at **https://www.football-data.org/client/register** — you'll get a token
by email instantly. The free tier covers the World Cup.

### 2. Put the code on GitHub
Create a new repository and push this folder to it.

### 3. Add the token as a secret
In the repo: **Settings → Secrets and variables → Actions → New repository secret**
- Name: `FOOTBALL_DATA_TOKEN`
- Value: your token

### 4. Turn on GitHub Pages
**Settings → Pages → Build and deployment → Source: “Deploy from a branch”**,
branch `main`, folder `/ (root)`. Your site will be at
`https://<your-username>.github.io/<repo-name>/`.

### 5. Run the updater once
**Actions → “Update results” → Run workflow.** It fetches the latest results,
commits `results.json`, and Pages redeploys. After that it runs automatically
every 3 hours.

## Running it locally

```bash
npm run serve        # then open http://localhost:8765
```

To refresh results from your own machine instead of the cloud:

```bash
FOOTBALL_DATA_TOKEN=your_token npm run update
```

If a result fails to match (e.g. a team name the API spells differently), the
updater prints it — add the alias to `scripts/teams.js`.

## Notes

- Until the first API fetch, the site uses the **36 results already in the
  spreadsheet** (seeded via `npm run seed`), so it works out of the box.
- The updater never deletes results — if the API is briefly missing a match,
  the previously stored result stays.
- Bonus predictions (semifinal four, final, champion, top scorer) are resolved and
  scored **automatically** once the final has been played: `update-results.js` reads
  the knockout bracket and records the actual semifinalists / finalists / champion /
  top scorer into `results.json` under `outcomes`.

## Reusing it for the next tournament

The whole thing is built to be re-run next time (Euros, next World Cup, …):

1. Drop in the new Excel of everyone's guesses and run `npm run build` to regenerate
   `data/predictions.json`.
2. Point `scripts/update-results.js` at the new competition code (`BASE`, currently
   `WC`) and check `scripts/teams.js` covers the new team names.
3. Refresh the two pre-tournament priors in `sim.js` — `SEED_STRENGTH` (team strengths,
   e.g. from the FIFA ranking) and `SCORER_REP` (elite finishers) — so the early-round
   probabilities are grounded in past performance before any games are played.
4. Everything else — scoring, charts, bonus resolution, champion banner — just works.

(For collecting next year's guesses we'll likely use a Google Form instead of the Excel.)
