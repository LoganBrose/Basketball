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
Google Form  ──submit from your phone──▶  Form responses tab  ──published CSV──▶  stats.html
                                                 ▲
                              Players + Games tabs supply names, dates, opponents
```

The Form's responses tab **is** the stats source. There is exactly one way stats get in — the Form —
so there is never a question of which copy is right. The site reads three tabs and does the joins
itself in your browser; it never writes anything.

---

## Setup

### 1. Sheet tabs

Three tabs matter. The site finds the header row by scanning for a key column, so title and legend
rows above the headers are fine and can be edited freely.

| Tab | Key column | Columns the site reads |
|---|---|---|
| `Players` | `Player ID` | `Player ID`, `Full Name`, `Jersey Number`, `Position` |
| `Games` | `Game ID` | `Game ID`, `Date`, `Opponent`, `Home/Away` |
| Form responses | `Player` | `Game`, `Player`, `Points`, `Rebounds`, `Assists`, `Steals`, `Blocks`, `Turnovers`, `FGM`, `FGA`, `3PM`, `3PA`, `FTM`, `FTA`, `Fouls`, `Notes` |

Notes:

- **Example rows must use an ID starting with `EX`** (`EX1`, `EX2`, …). That's how the site tells a
  sample row from a real one — it never guesses from the contents, so a real player is never
  dropped for resembling the example.
- `Date` may be `M/D/YYYY` or `YYYY-MM-DD`.
- `Home/Away` should be exactly `Home` or `Away`.
- The `(auto)` lookup columns in your `StatsLog` tab aren't needed — the site joins `Players` and
  `Games` by ID itself. `StatsLog` and `PlayerSummary` stay in the sheet for your own use; the site
  doesn't read them.

### 2. Publish the sheet

**File → Share → Publish to web.**

> **If you publish *selected tabs* rather than the entire document, you must add the Form responses
> tab to the published list.** It's the only stats source — if it isn't published, the site loads
> your roster and schedule and shows no stats at all.

Publishing is also how the propagation delay gets introduced: **published CSVs can take up to about
5 minutes to reflect a new Form submission.** A stat you just entered may not appear on the next
refresh. The site repeats this note next to the last-refresh time in the Connection panel, so a
slow update is never mistaken for a broken site.

### 3. Point the site at your sheet — `assets/js/config.js`

Two ways to address tabs. Either works; you only need one.

**Preferred — by file ID (no gids to look up):**

```js
fileId: '1AbC...'   // from docs.google.com/spreadsheets/d/<fileId>/edit
```

Also set the sheet's General access to **"Anyone with the link"**. Tabs are then addressed by name,
so nothing breaks when a tab is moved or re-created. Check that `tabs.*.name` matches your tab names
exactly — the Form's tab is usually `Form Responses 1`.

**Alternative — by publish key + gids:**

`pubKey` is already filled in from your published URL. Add each tab's gid, which you read from the
tab's own URL after `#gid=`:

```js
tabs: {
  players:   { name: 'Players',          gid: '0' },
  games:     { name: 'Games',            gid: '123456789' },
  responses: { name: 'Form Responses 1', gid: '987654321' },
}
```

Leave both unset and the site runs on the bundled sample data in `data/sample/` and says so.

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
