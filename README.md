# Coach Tools

Two static basketball coaching tools, deployable to GitHub Pages. No server, no build step, no
dependencies.

| Tool | What it does |
|---|---|
| **Stats Tracker** | Pick any players to see their combined numbers, split home vs away, and open a game for the full box score |
| **Play Diagram Builder** | Drag players on a court, draw movement across multiple steps, save plays as editable data |

---

## How the stats tracker works

```
you type rows  ─▶  StatsLog tab  ──published CSV──▶  index.html + stats.html
                        ▲
     Players + Games tabs supply names, dates, opponents
```

Stats are typed straight into the **StatsLog** tab. There is no Google Form. The site reads three
tabs, joins them by ID in your browser, and **never writes anything**.

---

## Setup

### 1. Sheet tabs

Three tabs matter. Each has title and legend rows above its header — that's fine, the site finds the
header by scanning for a key column, so you can edit those lines freely.

| Tab | Key column | Columns the site reads |
|---|---|---|
| `StatsLog` | `Stat ID` | `Game ID`, `Player ID`, `Points`, `Rebounds`, `Assists`, `Steals`, `Blocks`, `Turnovers`, `FGM`, `FGA`, `3PM`, `3PA`, `FTM`, `FTA`, `Fouls`, `Notes` |
| `Players` | `Player ID` | `Full Name`, `Jersey Number`, `Position` |
| `Games` | `Game ID` | `Date`, `Opponent`, `Home/Away`, and optionally `Team Score`, `Opponent Score` |

Notes:

- **`Stat ID` must not be blank**, but it does *not* have to be unique. The identity of a row is
  **(Game ID, Player ID)** — see "How stats are interpreted" below.
- The four `(auto)` lookup columns in `StatsLog` are ignored; the site joins `Players` and `Games`
  by ID itself. They're listed as unused in the Connection panel and do no harm.
- Example rows must use an ID starting with **`EX`** (`EX1`, `EX2`…). That's how a sample row is told
  from a real one — never by its contents, so a real player is never dropped for resembling it.
- `Date` may be `M/D/YYYY` or `YYYY-MM-DD`. `Home/Away` should be exactly `Home` or `Away`.
- **`Team Score` and `Opponent Score` are optional.** Fill in *both* for a game and the home page
  shows a win-loss record and average margin. Leave them blank and those tiles simply don't appear.
- `PlayerSummary` isn't read at all — the site reimplements it.

### 2. Publish the sheet

**File → Share → Publish to web.**

> **If you publish *selected tabs* rather than the entire document, you must include all three:
> `StatsLog`, `Players` and `Games`.** Miss `StatsLog` and the site shows a roster and a schedule
> with no stats; miss `Players` or `Games` and the stat rows have nothing to join against.

Publishing is where the delay comes from: **published CSVs can take up to about 5 minutes to reflect
an edit.** A stat you just typed may not appear on the next refresh. The Connection panel repeats
this next to the last refresh time, so a slow update is never mistaken for a broken site.

### 3. Point the site at your sheet — `assets/js/config.js`

Already filled in. Two routes are configured and tried in order, so one failing doesn't take the
site down:

```js
fileId: '1RRmiDGS5j4IWGc5B6BnC7aNXMzZLbtOTSLaIKkqIc8s'   // tabs addressed by name
pubKey: '2PACX-1vTIRdv…'                                  // tabs addressed by gid
```

| | Needs | Fix if it fails |
|---|---|---|
| `fileId` route | Sheet's General access set to **"Anyone with the link"** | Change the sharing setting, or clear `fileId` to force the gid route |
| `pubKey` route | The three tabs **published to web** (step 2) | Publish them, or correct the gids below |

**A gid is the number after `#gid=` in the URL while that tab is open.** The current values:

```js
tabs: {
  statslog: { name: 'StatsLog', gid: '2114409932' },
  players:  { name: 'Players',  gid: '335787751'  },
  games:    { name: 'Games',    gid: '761754105'  },
}
```

If neither route works the site falls back to the bundled sample data in `data/sample/` and says so.

### 4. Deploy

Push to the default branch. The workflow runs the unit tests, regenerates the team playbook index,
and deploys the repo root. If Pages is set to "Deploy from branch" instead of "GitHub Actions", that
works too — the repo is a plain static site.

---

## Reading the Connection panel

At the bottom of the stats page. This is how you confirm the site is reading your sheet, and it
names the fix for every failure.

Per tab it shows:

| Line | What to check |
|---|---|
| **Source** | `gviz (by tab name)` or `published CSV (by gid)` with an HTTP status. If it says **bundled sample data**, the sheet wasn't reachable |
| **URL** | Exactly what was fetched — paste it into a browser tab to see what Google returns |
| **Header row** | The sheet row the headers were found on. "not found" means the key column is missing or misspelled |
| **Matched** | The columns it recognised, using your sheet's own spelling |
| **Missing** | Shown **in red**. An expected column that isn't there — a missing `FGA` would otherwise read as a season of missed shots |
| **Data rows** | How many rows it kept, and how many blank/`EX` rows it skipped |

Below that, anything that didn't add up: duplicate rows replaced by a later row, rows whose Game or
Player ID matches nothing, unreadable dates, rows worth double-checking, and any game where
`Team Score` disagrees with the points logged in `StatsLog`.

---

## How stats are interpreted

These rules decide what your numbers mean:

- **To fix a mistake, add a corrected row below the original.** For a given (Game ID, Player ID) the
  **last row in the sheet wins**, and the replaced row is listed in the Connection panel so the
  correction is visible rather than silent. `Stat ID` plays no part in this — two rows with the same
  Stat ID but different players are two separate records, and two rows with different Stat IDs for
  the same player in the same game are still a duplicate.
- **Did not play: leave all 13 stat columns blank.** That row doesn't count toward games played and
  its stats count as 0. A row with any value — *including a `0`* — counts as a game played, so a
  scoreless appearance counts and a DNP doesn't.
- **Per-game averages divide by the number of distinct games shown**, never by the number of rows.
  Three players across nine games is 27 rows; dividing by 27 would understate every average.
- **Percentages come from summed makes over summed attempts**, never from averaging per-game
  percentages, and are blank — not `0.0%` — when nothing was attempted.

### Rows the site flags but always still counts

`FGM > FGA` · `3PM > 3PA` · `FTM > FTA` · `3PM > FGM` · `Points ≠ 2×FGM + 3PM + FTM`

The points check only runs when at least one of `FGM`, `3PM` or `FTM` was entered, so a points-only
row isn't flagged for missing shooting numbers nobody filled in.

---

## Using the stats page

- **Tap player chips** to select any combination. The selection is in the URL, so a filtered view is
  linkable and survives a reload.
- **All / Any** decides which games are shown: *All* = games where every selected player played,
  *Any* = games where at least one did. A DNP is not playing.
- The summary becomes **"Combined stats for selected players"** — their individual lines added
  together. Box scores don't record who was on the floor at the same time, so this is not a lineup
  rating, and the page says so.
- **Each game row shows `Team 58 · Selected 31`** when players are selected, so their contribution
  reads against the team total at a glance.
- **Click a game** to expand its full box score, with selected players highlighted.

---

## Play diagram builder

Open `playbook.html`. Everything autosaves as you work.

**Laying out a set.** The *Add* row drops a player at their usual spot, so a set takes seconds. Drag
anyone where you want them; positions snap to a half-foot. Double-click a player to relabel them;
arrow keys nudge the selection.

**Drawing movement.** Pick a tool and drag from where the action starts to where it ends:

| Tool | Looks like | Means |
|---|---|---|
| Cut | solid arrow | a player moving |
| Pass | dashed arrow | the ball moving |
| Dribble | squiggle | the ball-handler driving |
| Screen | line with a bar | where the screen is set, and which way the screener faces |

Click an arrow to select it, then drag either end — or the **middle handle to curve it**, which is
how you draw a flare or a curl.

Keyboard: `V` select, `C` cut, `P` pass, `D` dribble, `S` screen, `T` text, `Ctrl+Z` /
`Ctrl+Shift+Z` undo and redo, `Delete` removes the selection.

**Steps.** A play is a sequence. **Continue** adds a step with everyone still where they finished;
**+ Step** starts an empty one. The previous step shows through faded. Double-click a step chip to
rename it.

**Court.** Half or full court per play, with High School (19'9"), College or NBA three-point lines,
drawn to scale in feet.

### On this device vs the team playbook

The library has two sections, and the difference is the whole answer to "why is my play on my
computer but not my phone":

- **On this device** — saved in *this browser only*. Another device will never see it.
- **Team playbook** — published to the site, identical on every device.

**To get a play onto your phone:** open it, press **Publish to team playbook**, and GitHub opens
with the file already filled in — press Commit. A minute or two later it's under Team playbook
everywhere. Re-publishing an edited play says **Update on team playbook** and edits the same file,
because a play is matched by its id, not its filename. If a *different* play already owns that
filename, you're asked to rename rather than silently overwriting it.

A device play that's already published is badged **Published**, or **Edited since publishing** when
your copy is newer, and offers **Remove local copy**.

### Multiple playbooks

Each playbook is a folder on the site:

```
plays/
  general/        playbook.json  {"name":"General","description":"","order":1}
                  horns-flare.json
  zone-offense/   playbook.json
                  overload.json
  index.json      generated by the deploy — never hand-edited
```

The picker at the top of the library shows every playbook — team and device merged by slug, so
"Zone Offense" is one entry holding both — with play counts and an **All plays** option. The
selection lives in the URL (`?playbook=zone-offense`), so you can send a link straight to one.

- **New playbook** creates one on this device immediately. Its plays stay device-only until
  published.
- **Move / Copy to playbook** on any play card. A copy into a different playbook gets its own id,
  because it will publish to a different file.
- Publishing into a playbook that isn't on the site yet is **two commits**: the button first offers
  to create `plays/<slug>/playbook.json`, then publishes the play.
- A play file dropped loose in `plays/` still publishes — the generator sweeps it into **General**
  rather than letting it disappear.

### PDF

**Export PDF** prints one play: name, category and tags at the top, every frame with its step name,
notes at the bottom, and the lineup names currently on the tokens. **Export playbook as PDF** adds a
cover page with a numbered contents list, then each play on its own page. Use your browser's
"Save as PDF" (computer) or the share sheet (phone). The court prints white with dark lines even if
you're in dark mode.

**Download backup (.json)**, under *More*, is for re-importing into the builder — not a viewable
document.

---

## Privacy

**A published Google Sheet and a GitHub Pages site are both readable by anyone with the link.**
Neither has a login. If this will be shared beyond your staff, set `nameDisplay` in `config.js`:

```js
nameDisplay: 'full'      // John Smith
nameDisplay: 'jersey'    // #12
nameDisplay: 'initials'  // J.S.
```

This changes what the site renders. The published sheet still contains full names.

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
| `assets/js/sheets.js` | schemas, header detection, endpoints, caching |
| `assets/js/model.js` | dedupe, DNP, Any/All, summaries, record — pure and tested |
| `assets/js/data.js` | loads all three tabs once, shared by every page |
| `assets/js/home.js` | the season dashboard |
| `assets/js/stats.js` | the stats page |
| `assets/js/court.js` | court geometry in feet |
| `assets/js/library.js` | play storage, search, import/export — pure and tested |
| `assets/js/playbook.js` | the diagram editor |

Sheet data is cached in `localStorage` after each successful load, so pages render instantly on a
slow connection and still show the last known numbers if the sheet can't be reached.
