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
- **Bonukset** – the semifinal / final / champion / top-scorer predictions, with a popularity tally (scored by hand at the end).

**Win probability** is a Monte Carlo simulation (8000 runs): everyone's guesses for
the remaining matches are locked in, and each unplayed match is resolved using the
*family's own consensus* (how the 18 of us split 1/X/2) as its odds. Only group-stage
1X2 points count toward it — bonus rounds are excluded.

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
- Bonus predictions (semifinal four, final, champion, top scorer) resolve only at
  the end of the tournament and are scored manually.
