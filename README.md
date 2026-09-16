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
you type rows  ─▶  StatsLog tab  ──Apps Script──▶  index.html + stats.html
                        ▲              (admin token required)
     Players + Games tabs supply names, dates, opponents
```

Stats are typed straight into the **StatsLog** tab. There is no Google Form. The site reads three
tabs, joins them by ID in your browser, and **never writes anything**.

With sign-in configured, the sheet is **not published** and the Apps Script is the only route to it.
With `gate.url` empty, the site reads the published CSV exactly as it always did — the two paths end
in the same parser, so the numbers cannot differ between them.

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

### 2. Publish the sheet — *only if you are not using sign-in*

**Skip this section entirely if you have set up [Sign-in](#sign-in).** With `gate.url` configured the
sheet must **not** be published; the Apps Script reads it directly, and that is the whole point.

**File → Share → Publish to web.**

> **If you publish *selected tabs* rather than the entire document, you must include all three:
> `StatsLog`, `Players` and `Games`.** Miss `StatsLog` and the site shows a roster and a schedule
> with no stats; miss `Players` or `Games` and the stat rows have nothing to join against.

Publishing is where the delay comes from: **published CSVs can take up to about 5 minutes to reflect
an edit.** A stat you just typed may not appear on the next refresh. The Connection panel repeats
this next to the last refresh time, so a slow update is never mistaken for a broken site.

The Apps Script route has no such lag — it reads the live sheet, so an edit shows on the next
refresh. That is a real reason to prefer it beyond the privacy.

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

#### Cloudflare Pages

GitHub Pages is primary and none of this changes it. To also serve from Cloudflare:

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Build output directory | `dist` |
| Production branch | `Main` — **capital M**, the field is case-sensitive |

`npm run build` regenerates the playbook index and then copies the servable files into `dist/`.
Both halves matter:

- **The index rebuild** is not optional. The GitHub Action does not run on Cloudflare, so without it
  a play published as a file would land in `plays/` and never appear under Team playbook.
- **`dist/` is the actual fix** for the build error Cloudflare reports:

  > `Asset too large. […] /opt/buildhome/repo/node_modules/workerd/bin/workerd with a size of
  > 125 MiB`

  Cloudflare treats the repo root as its assets directory and walks everything under it, including
  the `node_modules` its own build container installs — where a 125 MiB binary blows past a 25 MiB
  per-asset limit. Publishing from `dist/` puts `node_modules` outside the assets directory
  entirely. It isn't excluded; it simply isn't there.

`tools/build-site.mjs` copies a **whitelist**, so a new top-level folder stays unpublished unless
someone adds it. That also stops `tests/`, `tools/`, `apps-script/` and `package.json` being served,
which they currently are on GitHub Pages and never should have been. The script fails the build if
any file in `dist/` exceeds 25 MiB, rather than letting Cloudflare discover it.

---

## Reading the Connection panel

At the bottom of the stats page. This is how you confirm the site is reading your sheet, and it
names the fix for every failure.

Per tab it shows:

| Line | What to check |
|---|---|
| **Source** | `Apps Script` when sign-in is configured, otherwise `gviz (by tab name)` or `published CSV (by gid)` with an HTTP status. If it says **bundled sample data**, the sheet wasn't reachable |
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

**To get a play onto your phone:** open it and press **Publish to team playbook**. With sign-in
configured that saves straight into the team sheet and everyone sees it on their next refresh — no
commit, no wait. Re-publishing an edited play says **Update on team playbook** and replaces the same
entry, because a play is matched by its id.

**Remove from team playbook** takes it back off, after a confirm. Your copy on the device is kept, so
a misclick costs nothing.

Both of those need the **admin password**. Without it the button reads **Admin only**.

A play that minifies to more than 45,000 characters is refused — that is the limit of a single sheet
cell, and writing past it would corrupt the play rather than fail honestly. Split it into two plays
or remove frames.

> **Without sign-in configured**, publishing still works the old way: GitHub opens with the file
> filled in and you press Commit. Everything below about `plays/` folders applies to that mode.

A device play that's already published is badged **Published**, or **Edited since publishing** when
your copy is newer, and offers **Remove local copy**.

### Moving the playbook into the sheet

While both exist, the editor shows an admin a one-click **Move team plays into the sheet**. It copies
everything still in `plays/` across, matched by id, so clicking it twice is harmless.

**`plays/` is deliberately still there.** Nothing is deleted until you have confirmed the move —
open `playbook.html` in a private window or on a device that has never seen the plays and check the
team playbook is complete. A browser that already has them cached will look fine either way, which
is why the private window matters. Once you have confirmed, say so and `plays/` comes out.

### Multiple playbooks

*These apply when sign-in is not configured.* Each playbook is a folder on the site:

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

## Sign-in

The site can sit behind a **name and a shared password**, with every sign-in recorded where you can
see it, and an **admin view** behind a second password.

**Read this first, because it decides whether the rest is worth doing.** The popup is written in
JavaScript and runs in the visitor's browser, so it can be bypassed with developer tools. It keeps
casual visitors out of the pages. It is not what protects the numbers — that is the Apps Script,
which refuses to hand over anything without a token it signed, and which never sees a password it
did not check itself.

| | Protected by | Real? |
|---|---|---|
| The pages | the popup | No — bypassable |
| Stats data | the admin password, checked in Apps Script | **Yes**, once the sheet is unpublished |
| Player names | the site password, checked in Apps Script | **Yes**, same |
| Team playbook | the site password to read, the **admin password** to change | **Yes**, once `plays/` is deleted |
| Plays still in `plays/` | nothing | **No** — files in a public repo, until they are removed |

**The plays are in both places right now.** The sheet is the live one; `plays/` is still there as a
safety net until you have confirmed the move, and while it exists those files stay public.

Two more things worth knowing:

- **Names are self-reported.** Apps Script cannot read request headers, so the name and the browser
  string are sent by the page. The log is a roster of who says they used the site — useful, but not
  an audit trail.
- **Nothing is stored that shouldn't be.** The admin password is never written to the browser, and
  neither is the sign-in list.

### Setup

**1. Make a new, separate spreadsheet for the log.** Not the stats sheet — a fresh one. Copy its ID
from the URL: `docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`.

**2. Extensions → Apps Script**, delete whatever is in the editor, and paste all of
[`apps-script/Code.gs`](apps-script/Code.gs).

**3. Project Settings → Script Properties**, and add these:

| Property | Value |
|---|---|
| `SITE_PASSWORD` | what the team types |
| `ADMIN_PASSWORD` | what only you type |
| `ADMIN_NAME` | your name — **the admin password only works alongside it** |
| `LOG_SHEET_ID` | the ID from step 1 |
| `STATS_SHEET_ID` | your existing stats spreadsheet's ID — the one with `StatsLog`, `Players` and `Games` |
| `TOKEN_SECRET` | any long random string; nobody types this |

Optional: `SITE_DAYS` (default 30) and `ADMIN_HOURS` (default 24) set how long a sign-in lasts.

**4. Run → `checkSetup`** from the editor. This is also what triggers Google's authorization prompt.
It names any property you have missed instead of leaving you to work it out from a broken page.

**5. Deploy → New deployment → Web app**, with **Execute as: Me** and **Who has access: Anyone**.
"Anyone" is about the *endpoint*, not your data — the script still refuses every request that
doesn't carry a password or a token it signed. Copy the web app URL.

**6. Paste that URL** into `gate.url` in `assets/js/config.js`. Leave it empty and the whole gate
stays off and the site behaves exactly as before.

**7. Stop publishing the stats sheet.** In the stats spreadsheet: **File → Share → Publish to web →
Stop publishing**. Do this *last*, and only once step 6 is live and you have confirmed the stats page
loads behind the admin password — until then the site is still reading the published CSV, and
unpublishing early just makes it fall back to sample data.

Once unpublished, **the numbers are only reachable with the admin password.** There is no public URL
left to hand them over; the script is the only route, and it checks a token it signed itself.

### Changing something later

> **To update the script: Deploy → Manage deployments → Edit (the pencil) → Version: New version →
> Deploy.** That keeps the same URL.
>
> **"New deployment" makes a *different* URL**, which `config.js` is not pointing at — so the site
> keeps talking to the old code and your change looks like it did nothing.

To change a password, edit the Script Property. People stay signed in until their token expires, so
if you need everyone out now, change `TOKEN_SECRET` too — that invalidates every token immediately.
Changing `ADMIN_NAME` invalidates outstanding admin sessions on its own.

### Which password opens what

| | Site password | Admin password |
|---|---|---|
| Open the pages | yes | yes |
| Playbook, including the lineup names | yes | yes |
| **Read** the team playbook | yes | yes |
| **Publish to or remove from** the team playbook | **no** | **yes** |
| **Stats page, box scores, season tiles** | **no** | **yes** |
| The sign-in log at `admin.html` | no | yes |

**You can enter the admin password at the main sign-in popup** and be signed straight in as admin —
one step, no second prompt. The separate admin prompt on Stats and `admin.html` is for upgrading a
session that started with the team password, and for getting admin back after the 24 hours are up.

Knowing the admin *name* is not a credential: the admin password only works alongside it, and the
team password under that name still gets you a coach's session and nothing more.

Reading the team playbook takes only the site password, because it has to work on a phone with the
password everyone has. **Changing it takes the admin password** — the shared password is shared, and
the team playbook is not something everyone who knows it should be able to rewrite. A coach without
it still saves as many plays as they like on their own device; the Publish button simply reads
**Admin only**.

A site sign-in lasts 30 days; an admin session lasts 24 hours, and both limits are enforced inside
the token's signature rather than by the browser. **Signing out of admin clears the numbers from the
page and from the browser's storage**, so a shared laptop does not keep a box score after you walk
away. The stats are never written to storage under this setup at all; only the roster is.

### The admin view

`admin.html`, linked at the foot of every page. Your name is prefilled from your site sign-in; you
type the admin password. It shows:

- **People** — each name, how many times they signed in, how many attempts failed, and when they
  were last seen.
- **Every sign-in** — the full log, searchable, with failed attempts marked.

**Failed attempts are logged too**, with whatever name was typed. After ten failures in a minute,
further *failed* attempts are told to wait 30 seconds — but a correct password always works, even
mid-slowdown, so nobody can shut the team out by guessing badly at the endpoint.

A wrong admin name and a wrong admin password come back identically. There is no way to confirm the
name without also having the password.

---

## Privacy

**Anything the site can reach without a token, anyone can reach.** A published Google Sheet has no
login, and neither does a GitHub Pages site.

`nameDisplay` in `config.js` keeps names off the page whatever else is set up:

```js
nameDisplay: 'full'      // John Smith
nameDisplay: 'jersey'    // #12
nameDisplay: 'initials'  // J.S.
```

This changes what the site renders. A published sheet still contains full names.

---

## Development

```sh
npm test          # unit tests — no dependencies, uses node --test
npm run serve     # http://localhost:8000
npm run build     # regenerate the plays index, then fill dist/
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
| `assets/js/gate.js` | the sign-in popup and session — pure parts tested |
| `assets/js/admin.js` | the admin prompt and the sign-in log |
| `assets/js/teamplays.js` | the team playbook in the sheet, and the migration out of `plays/` |
| `assets/js/sheets.js` | `parseRows` is shared by both sources, so they cannot disagree |
| `apps-script/Code.gs` | the sign-in backend you paste into Google |

Sheet data is cached in `localStorage` after each successful load, so pages render instantly on a
slow connection and still show the last known numbers if the sheet can't be reached.
