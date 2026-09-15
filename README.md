# Coach Tools

Two static basketball coaching tools, deployable to GitHub Pages. No server, no build step, no
dependencies.

| Tool | Status |
|---|---|
| **Stats Tracker** — per-player season stats from a published Google Sheet, filterable by player and home/away | Ready |
| **Play Diagram Builder** — drag players on a court, draw movement, save plays as editable data | Next phase |

---

## How the stats tracker works

```
you type rows      ─▶  StatsLog tab        ─┐
   — or —                                   ├─ published CSV ─▶  stats.html
Google Form  ─▶  Form responses tab        ─┘
                                            ▲
                    Players + Games tabs supply names, dates, opponents
```

The site reads three tabs and does the joins itself in your browser. It never writes anything.

**One config line picks the stats source**, and only one is ever read — so there's never a question
of which copy is right:

```js
statsSource: 'statslog'    // the StatsLog tab you type into      ← current setting
statsSource: 'responses'   // the Google Form's responses tab
```

It currently reads **`StatsLog`**, because the Form doesn't exist yet. Build the Form (step 4),
then flip that one line. Every rule below — dedupe, DNP, sanity checks — works identically either
way.

---

## Setup

### 1. Sheet tabs

Three tabs matter. The site finds the header row by scanning for a key column, so title and legend
rows above the headers are fine and can be edited freely.

| Tab | Key column | Columns the site reads |
|---|---|---|
| `Players` | `Player ID` | `Player ID`, `Full Name`, `Jersey Number`, `Position` |
| `Games` | `Game ID` | `Game ID`, `Date`, `Opponent`, `Home/Away` |
| `StatsLog` | `Stat ID` | `Game ID`, `Player ID`, `Points`, `Rebounds`, `Assists`, `Steals`, `Blocks`, `Turnovers`, `FGM`, `FGA`, `3PM`, `3PA`, `FTM`, `FTA`, `Fouls`, `Notes` |
| Form responses | `Player` | the same stat columns, plus `Game` and `Player` dropdown labels |

`PlayerSummary` isn't read at all — the site reimplements it, so you get the same totals without
touching the sheet.

Notes:

- **Example rows must use an ID starting with `EX`** (`EX1`, `EX2`, …). That's how the site tells a
  sample row from a real one — it never guesses from the contents, so a real player is never
  dropped for resembling the example.
- `Date` may be `M/D/YYYY` or `YYYY-MM-DD`.
- `Home/Away` should be exactly `Home` or `Away`.
- The `(auto)` lookup columns in `StatsLog` aren't needed — the site joins `Players` and `Games` by
  ID itself and lists those columns as unused in the Connection panel. They do no harm; keep them if
  you like reading the sheet directly.

### 2. Publish the sheet

**File → Share → Publish to web.**

> **If you publish *selected tabs* rather than the entire document, publish `Players`, `Games` and
> whichever tab `statsSource` points at** — today `StatsLog`, later the Form responses tab. Miss the
> stats tab and the site loads your roster and schedule and shows no stats at all.

This matters only for the `pubKey` route; the `fileId` route uses link-sharing instead. Publishing
is also where the propagation delay comes from: **published CSVs can take up to about 5 minutes to
reflect a new row.** A stat you just entered may not appear on the next
refresh. The site repeats this note next to the last-refresh time in the Connection panel, so a
slow update is never mistaken for a broken site.

### 3. Point the site at your sheet — `assets/js/config.js`

**This is already filled in** with your file ID and the three tab gids, so there is nothing to do
here unless you swap sheets. Two routes are configured and tried in order, so one failing doesn't
take the site down:

```js
fileId: '1RRmiDGS5j4IWGc5B6BnC7aNXMzZLbtOTSLaIKkqIc8s'   // tabs addressed by name
pubKey: '2PACX-1vTIRdv…'                                  // tabs addressed by gid
```

The `fileId` route needs the sheet's General access set to **"Anyone with the link"**. The `pubKey`
route needs the tabs published (step 2). If neither works, the site falls back to the bundled sample
data and the Connection panel names the exact failure — a fix is a config edit, never a code change.

A gid is the number in a tab's own URL after `#gid=`. If you swap sheets and don't want to look them
up, clear `fileId` and all three gids but leave `pubKey` set: the site will then read the tab list
off the published page and work the gids out itself.

### 4. Build the Google Form

One question per stat, plus two dropdowns. Title each question **exactly** as the column name so the
response headers line up: `Game`, `Player`, `Points`, `Rebounds`, `Assists`, `Steals`, `Blocks`,
`Turnovers`, `FGM`, `FGA`, `3PM`, `3PA`, `FTM`, `FTA`, `Fouls`, `Notes`.

**Set every stat question to response validation → Number → "Whole number" → "Greater than or equal
to" 0.** Catching a typo at entry is worth far more than flagging it afterwards.

The `Player` and `Game` questions are **dropdowns**, so you tap instead of typing an ID:

```
Player            Game
12 – John Smith   G01 – vs Central (9/15)
7 – Jane Doe      G02 – at North (9/22)
23 – Marcus Lee   G03 – vs South (9/29)
```

The site reads the token before the dash and resolves it against `Player ID` first, then
`Jersey Number` — so `12 – John Smith` and `P1 – John Smith` both work. En dash, em dash and plain
hyphen are all accepted.

> **Keep the dropdowns up to date by hand.** Google Forms can't read your roster, so adding a player
> or scheduling a game means editing the dropdown options too. The stats page has a **"Form dropdown
> options"** panel that generates both lists ready to paste — open it, copy, and replace the options
> in the Form.

Finally, put the Form's public link in `config.js` as `formUrl` to light up the **Log a stat** button.

### 5. Deploy

Push to `main`. Then, **once**, set **Settings → Pages → Source** to **"GitHub Actions"** — without
it the workflow builds and never publishes. The workflow runs the unit tests, regenerates the team
playbook index, and deploys the repo root.

---

## How stats are interpreted

Worth knowing, because these rules decide what your averages mean:

- **Fixing a mistake: just submit the Form again.** For a given (Game, Player), the **last row in
  the sheet wins**. Earlier entries are listed under "Corrected entries" in the Connection panel, so
  a correction is visible rather than silent. Timestamps are never used for ordering — row position
  already carries it.
- **Did not play: leave every stat blank.** That row doesn't count toward games played, and its
  stats count as 0. A row with any value — *including a `0`* — counts as a game played. So a
  scoreless appearance is a game played, and a DNP is not.
- **Averages divide by games played**, never by rows, so sitting out doesn't drag an average down.
- **Percentages are blank, not `0.0%`, when nothing was attempted.**

### Rows the site flags (but always still counts)

Listed in the Connection panel, never dropped:

- `FGM > FGA`, `3PM > 3PA`, `FTM > FTA`, `3PM > FGM`
- `Points ≠ 2×FGM + 3PM + FTM` — only checked when at least one of `FGM`, `3PM` or `FTM` was
  entered, so a points-only row isn't flagged for missing shooting numbers nobody filled in.
- Rows whose Game or Player doesn't match the roster or schedule
- A dropdown value that's ambiguous — for example a token that is one player's `Player ID` *and*
  another player's jersey number. The site reports that rather than picking one of two real people.

---

## Privacy

**A published Google Sheet and a GitHub Pages site are both readable by anyone with the link.**
Neither has a login. If this will be shared beyond your staff, set `nameDisplay` in `config.js`:

```js
nameDisplay: 'full'      // John Smith
nameDisplay: 'jersey'    // #12
nameDisplay: 'initials'  // J.S.
```

This changes what the site renders. The published sheet still contains full names, so for a roster
of minors consider keeping the sheet unpublished-by-tab or using initials in the sheet too.

---

## Development

```sh
npm test          # unit tests — no dependencies, uses node --test
npm run serve     # http://localhost:8000
npm run build:plays
```

`package.json` exists only to mark the modules as ESM for Node's test runner and to hold these
scripts. There are no dependencies and nothing is bundled — what's in the repo is what ships.

| File | Purpose |
|---|---|
| `assets/js/config.js` | the only file you normally edit |
| `assets/js/csv.js` | RFC 4180 CSV parsing |
| `assets/js/sheets.js` | endpoints, header detection, caching |
| `assets/js/model.js` | dedupe, DNP, sanity checks, aggregation — pure and tested |
| `assets/js/stats.js` | the stats page |

Stats are cached in `localStorage` after each successful load, so the page renders instantly on a
slow connection and still shows the last known numbers if the sheet can't be reached.
