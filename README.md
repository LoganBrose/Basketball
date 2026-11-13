# Coach Tools

Two static basketball coaching tools, deployable to GitHub Pages. No server, nothing to compile, no
dependencies — deploying only copies the site's files into `dist/`.

| Tool | What it does |
|---|---|
| **Stats Tracker** | Pick any players to see their combined numbers, split home vs away, and open a game for the full box score |
| **Play Diagram Builder** | Drag players on a court, draw movement across multiple steps, save plays as editable data |
| **Scouting** | A report on each upcoming opponent: key players, stats links, notes. Staged — see [Releasing a feature](#releasing-a-feature) |

---

## How the stats tracker works

```
you type rows  ─▶  StatsLog tab  ──Apps Script──▶  index.html + stats.html
                        ▲              (admin token required)
     Players + Games tabs supply names, dates, opponents
```

Stats are typed straight into the **StatsLog** tab. There is no Google Form. The site reads three
tabs, joins them by ID in your browser, and **never writes anything**.

Sign-in is configured and the stats sheet is **no longer published**: the Apps Script is the only
route to it. The published-CSV route described below is only a fallback for a copy of the site with
`gate.url` left empty. Both paths end in the same parser, so the numbers cannot differ between them.

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

**This site uses sign-in, and the stats sheet is already unpublished, so skip this section.** It is
kept for a copy of the site with `gate.url` empty. With sign-in configured the sheet must **not** be
published; the Apps Script reads it directly, and that is the whole point.

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

**With sign-in on (as it is now) these values are not used**: every read goes through the Apps
Script. They only matter if `gate.url` is emptied. In that case two routes are tried in order, so one
failing doesn't take the site down:

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

Push to the default branch. The workflow runs the unit tests, then `npm run build` (regenerates the
team playbook index and copies the servable files into `dist/`), and deploys `dist/`.

In the repo's **Settings → Pages**, set **Source** to **GitHub Actions**. "Deploy from branch" would
skip the workflow and serve the whole repo — `tests/`, `tools/`, `apps-script/`, this README — to
anyone with the link.

#### Cloudflare Pages

GitHub Pages is primary. To also serve from Cloudflare, using the same build:

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
someone adds it. That also keeps `tests/`, `tools/`, `apps-script/` and `package.json` off the public
site, on both hosts. The script fails the build if
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

**Steps.** A play is a sequence. **+ Step** adds a step with everyone where the last one left them:
a player with a cut, dribble or screen arrow starts at its end, and a pass hands the ball to the
receiver. Undo if you wanted it different. The previous step shows through faded. Double-click a
step chip to rename it.

**▶ Play** animates the play from the current step to the end: players run along their arrows,
curves included, and then the ball flies along each pass. It moves exactly as **+ Step** carries
players over, so where the animation ends one step is where the next one starts. Press **■ Stop**, or
tap anything else, to stop on the step as drawn. The space bar starts and stops it. Viewers get it too.
With *reduce motion* turned on in your device settings, it shows each step in turn without the
movement.

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

Any coach signed in with the **site password** can do both, as can the admin. A view-only sign-in
cannot — it never sees the buttons. The sheet's `Updated By` column records who published each play.

A play that minifies to more than 45,000 characters is refused — that is the limit of a single sheet
cell, and writing past it would corrupt the play rather than fail honestly. Split it into two plays
or remove frames.

> **Without sign-in configured**, publishing still works the old way: GitHub opens with the file
> filled in and you press Commit. Everything below about `plays/` folders applies to that mode.

A device play that's already published is badged **Published**, or **Edited since publishing** when
your copy is newer, and offers **Remove local copy**.

### The admin playbook

An admin sees a third list, **Admin playbook**, under *Team playbook*. It is for plays you are not
ready to share: it is saved in the sheet (the `AdminPlays` tab of the log spreadsheet), so it is the
same on every device you sign in on as admin, and nobody else can read it.

| From → to | How |
|---|---|
| This device → admin playbook | **Save to admin playbook** on the play's card. The copy on this device is kept; the card then says *In admin playbook*, or *Edited since saving* once you change it. Press it again to update. |
| Admin playbook → this device | Tap the play, or **Copy to this device**. |
| Admin playbook → team playbook | **Move to team playbook**. Everyone sees it on their next refresh, and it comes out of the admin playbook. |
| Team playbook → admin playbook | **Move to admin playbook**, after a confirm. It comes **off** the team playbook for everyone. |
| Remove | **Remove from admin playbook**. A copy on this device is kept. |

A move is one request that copies and then deletes inside the script, under a lock. If anything
fails, the play is left where it was. A play keeps its id everywhere, so moving it onto a play
already there replaces that play rather than duplicating it.

The admin playbook has **no release setting**: it is the admin's alone. Coaches and viewers never
get the card (it is built by JavaScript for an admin only, like the Stats link), and the script
answers their tokens exactly as if the admin playbook did not exist.

### The old `plays/` folder

The team playbook used to be JSON files under `plays/`. That folder has been deleted, so with
sign-in configured the sheet is the only team playbook and no play is readable without signing in. The files are still in the git history if one is ever needed.

### Multiple playbooks

*These apply only when sign-in is not configured*, in which case team plays are files committed under
`plays/` (the folder doesn't exist at the moment; publishing creates it). Each playbook is a folder:

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

## Scouting

The **Scouting** tab is built for a login only once Scouting is released to it (see [Releasing a
feature](#releasing-a-feature)). It starts at **admin only**.

### The page

- **Upcoming games in date order**, from the `Games` tab. The **next game** is at the top, with its
  report fully open.
- **The rest of this week** (the next 7 days) are cards showing the day, date and opponent. Tap one
  to open its report.
- **Admin and coaches** also get **Later games** and **Past games** (the last 30), collapsed at the
  bottom. A finished game drops off the upcoming list the day after it is played. The archive is
  there for looking back; players never see it.

### A report

| Section | What it is | Admin | Coaches | Players |
|---|---|---|---|---|
| **About *opponent*** | Notes on the team: kept for **every** game against them | read + edit | read + edit | — |
| **This game** | Notes for this game only | read + edit | read + edit | — |
| **Key players** | Number, name, position, a short blurb, and a **View stats** button | read + edit | read + edit | **read** |
| **Private notes** | Your own notes on the opponent | read + edit | — | — |

**Scouting belongs to the opponent, not the game.** Play North twice and the second report already
has North's key players, overview and private notes. Only *This game* starts empty. Opponents are
matched by their name on the Games tab, ignoring capital letters and extra spaces, so `North` and
`north ` are the same team. **Renaming an opponent on the Games tab** (say `North` → `North HS`)
starts it with an empty report; rename it back and the old one returns. Two different schools typed
with exactly the same name would share one report.

**Players (view-only login) see a report from 7 days before the game through game day**, and only
the key players and stats buttons. Days are counted in your time zone: the script project's own (Apps
Script → Project Settings → Time zone), or the `TIME_ZONE` Script Property if you set one (for example
`America/Chicago`). The script enforces this. A player asking for any other game is told it doesn't
exist.

**Stats links are only stored, never fetched.** Paste any page — MaxPreps, a league site — and the
button opens it in a new tab. Only `http`/`https` links are kept; `maxpreps.com/...` typed without the
`https://` is fixed up for you.

**Everything is edited on the site**, not in the spreadsheet. Coaches don't need sheet access. Every
save records who made it, shown as *Saved by …* under each section and in the `UpdatedBy` column.

> **Last save wins.** If two coaches edit the same section or the same player at once, the second
> save replaces the first without warning. Separate sections and separate players don't collide.
> The *Saved by* line shows who saved last, so a lost edit can at least be traced.

### The sheet tabs

The script creates these in the **log spreadsheet** (the one with `SignIns` and `Plays`) when
`checkSetup` runs, or the first time they are needed. **The stats spreadsheet is only read**: the
`Games` tab supplies the schedule, and nothing is ever written to it. Coaches and players are only
ever sent a game's ID, date, opponent and home/away — never a score.

| Tab | Columns | One row per |
|---|---|---|
| `Opponents` | `OpponentKey`, `Opponent`, `Overview`, `Updated`, `UpdatedBy` | opponent |
| `ScoutPlayers` | `Id`, `OpponentKey`, `Number`, `Name`, `Position`, `Blurb`, `StatsUrl`, `Order`, `Updated`, `UpdatedBy` | key player |
| `ScoutGameNotes` | `GameId`, `OpponentKey`, `Notes`, `Updated`, `UpdatedBy` | game |
| `ScoutPrivate` | `OpponentKey`, `Notes`, `Updated`, `UpdatedBy` | opponent — **admin only** |

`OpponentKey` is the opponent's name in lowercase with spaces tidied. Private notes have a tab of
their own that only an admin request ever opens, so they can't leak through another tab's reply. A
key player's `Order` sorts the list (lower first; ties go by number). It isn't on the page yet, but
you can set it in the sheet. Each opponent holds up to 30 key players.

You can read and tidy these tabs by hand. Keep the header row and the `OpponentKey` values as they
are, or rows will stop matching their opponent.

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
| Stats data | the admin password, checked in Apps Script | **Yes** — the sheet is unpublished |
| Player names | the site password, checked in Apps Script | **Yes**, same |
| Team playbook | the site password to read **and** to change; the viewer password to read only | **Yes** |
| Admin playbook | the admin password only, to read and to change | **Yes** |
| Staged features (Scouting) | the release stage in `RELEASE_SCOUTING`, checked in Apps Script | **Yes** |

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

Optional:

| Property | Value |
|---|---|
| `VIEWER_PASSWORD` | a **view-only** password — the team playbook and nothing else, and only for names on the **Players** tab (see below). Leave it unset and there is no viewer login. |
| `SITE_DAYS` | how long a team sign-in lasts, in days (default 30) |
| `VIEWER_HOURS` | how long a view-only sign-in lasts, in hours (default 24) |
| `ADMIN_HOURS` | how long an admin session lasts, in hours (default 24) |
| `SIGNIN_DAYS` | how many days back the admin sign-in list goes (default 30) |
| `RELEASE_SCOUTING` | who Scouting is open to: `admin`, `coaches` or `everyone` (default `admin`). See [Releasing a feature](#releasing-a-feature). |
| `TIME_ZONE` | the time zone scouting dates are counted in, e.g. `America/Chicago` (default: the script project's time zone) |

**4. Run → `checkSetup`** from the editor. This is also what triggers Google's authorization prompt.
It names any property you have missed instead of leaving you to work it out from a broken page.
It also creates any tab the script writes to that is missing (`SignIns`, `Plays`, `AdminPlays` and
the scouting tabs) with its header row, and logs the time zone and today's date that scouting uses. **It never clears or rewrites a tab that already exists**; if one's header row
has drifted, it logs a warning and leaves it alone.

**5. Deploy → New deployment → Web app**, with **Execute as: Me** and **Who has access: Anyone**.
"Anyone" is about the *endpoint*, not your data — the script still refuses every request that
doesn't carry a password or a token it signed. Copy the web app URL.

**6. Paste that URL** into `gate.url` in `assets/js/config.js`. Leave it empty and the whole gate
stays off and the site behaves exactly as before.

**7. Stop publishing the stats sheet** (already done for this site). In the stats spreadsheet: **File → Share → Publish to web →
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
if you need everyone out now, press **Sign everyone out** on `admin.html` (see below). Changing
`TOKEN_SECRET` does the same thing by hand. Changing `ADMIN_NAME` invalidates outstanding admin
sessions on its own.

### Releasing a feature

New features launch **for the admin login only**, so you can try them first. Each one has a
release setting with three stages:

| Value | Who sees it |
|---|---|
| `admin` | you only (the default) |
| `coaches` | you and everyone signed in with the site password |
| `everyone` | you, coaches, and players signed in with the view-only password |

**To move a feature to the next stage:** Apps Script editor → **Project Settings → Script
Properties** → set the property (for Scouting, `RELEASE_SCOUTING`) to the new value → **Save**.

- **No new deployment and no code change.** The script reads the property on every request.
- Each person sees the change on their **next page load**: every page checks its sign-in with the
  script in the background, and that check now also says which features the login has.
- **To roll back**, set it back to `admin`. It goes away just as quickly.
- **A blank, missing or misspelled value means `admin`.** A typo closes a feature; it never opens
  one. Run `checkSetup` to confirm: it logs each feature's stage and warns about a value it doesn't
  understand.
- The admin page has a **Feature releases** card showing each stage. It is read-only on purpose, so
  a stolen admin session can't open a feature to everyone.

The script enforces this, not the page. A login a feature isn't released to gets the same reply as
an action that doesn't exist, and the page doesn't build the feature's link or sections, the same way
the Stats pages are hidden from coaches.

### Which password opens what

| | Viewer password | Site password | Admin password |
|---|---|---|---|
| **Look through** the team playbook, step through plays, open video links | yes | yes | yes |
| Draw and edit plays on this device, the lineup names | **no** | yes | yes |
| **Publish to or remove from** the team playbook | **no** | **yes** | **yes** |
| The **admin playbook**: see it, save to it, move plays in and out | **no** | **not shown to exist** | **yes** |
| **Scouting** | only at stage `everyone` | from stage `coaches` | yes |
| **Stats page, box scores, season tiles** | **no** | **not shown to exist** | **yes** |
| The sign-in log at `admin.html`, who is signed in now | **no** | **not shown to exist** | yes |
| **Sign everyone out** | **no** | **no** | **yes** |

### The view-only login

Set `VIEWER_PASSWORD` in Script Properties and redeploy the script (Manage deployments → Edit → New
version). The password only works for a **name on the Players tab** of the stats spreadsheet (see
*Who can use the view-only password* below). Anyone signed in with it sees **only the team playbook**:
the playbook picker, the list of team plays, and the play itself. They can click through plays, step
through them, and open a play's video link. The drawing tools, the "On this device" list, Publish
and every edit button are gone, and the play's fields can't be typed in.

The hiding is done by the page, but the limit is real: the script gives a viewer a `viewer` token,
and the only thing that token can do is read the team playbook. It cannot read the roster or stats,
and it cannot save or delete anything.

A view-only sign-in lasts **1 day**, after which the sign-in popup appears again. Set
`VIEWER_HOURS` to change that.

Viewer sign-ins show up in the admin list as *Signed in (view only)*.

#### Who can use the view-only password

Only the people in the **Full Name** column of the **Players** tab: the roster the stats page and
the lineup selector already use. There is no separate list to keep up.

- **The full name, as it is on the tab.** Capital letters and extra spaces don't matter, so
  `john smith` works for *John Smith*; `John` on its own doesn't.
- **Example rows are ignored.** A row whose Player ID starts with `EX` can't be used to sign in, the
  same as everywhere else on the site.
- **A name that isn't on the list** gets *"That name isn't on the team list. Use your full name as
  your coach entered it."* That tells the person the password was right, so these attempts count
  toward the 5-a-minute lockout exactly like a wrong password. The admin list shows them as
  *Failed: name not on team list*.
- **Taking someone off the tab ends their sign-in** within 5 minutes. The script keeps the list
  for 5 minutes rather than opening the spreadsheet on every sign-in, so additions also take up
  to 5 minutes to work.
- **If the Players tab is missing or has no Full Name column, nobody can sign in as view-only.**
  Run `checkSetup` in the script editor: it says how many names the view-only password will accept.

The team and admin passwords are not affected and still work under any name.

### The sign-in list only goes back 30 days

`admin.html` lists the last 30 days of sign-ins. Older rows are **not deleted** from the log sheet;
they just stop being listed. Set `SIGNIN_DAYS` to change the window; the page headings follow it.

### Video links on plays

Each play has a **Video link** field in *This play*. Paste a YouTube link and a **▶ Watch video**
button appears under it. A YouTube video **plays in a player on the page**, so nobody leaves the
playbook; close it with ✕ or Escape. Any other `http`/`https` link still opens in a new tab. The link
is saved with the play, travels with it when it is published to the team playbook, and is printed
under the notes in PDF exports. Anything that is not an `http`/`https` link is ignored.

**The sign-in popup is the only way to become admin.** Enter the admin name and the admin password
there and you are signed straight in — one step. There is no second prompt anywhere, because a
prompt would give the game away (see below).

Knowing the admin *name* is not a credential: the admin password only works alongside it, and the
team password under that name still gets you a coach's session and nothing more.

### What a coach sees: a playbook, and nothing else

Without an admin session the site is a playbook site. Not a locked-down one — a playbook one.

- **The nav has one entry: Playbook.** The Stats and Admin links are created by JavaScript for an
  admin only, so for everyone else they are not hidden or disabled, they are never built. `View
  source` on a coach's browser shows a playbook site because that is all there is.
- **`index.html`, `stats.html` and `admin.html` redirect to the playbook**, from a script at the top
  of `<head>` — before the title commits and before the markup parses.
- **Nothing says "admin".** No lock icons, no "needs the admin password". A coach publishes to the
  team playbook with the team password, so Publish is there for them too.
- **When the admin session expires** after 24 hours, the site drops back to this view without
  comment. The team sign-in keeps working for its full 30 days.

This is about not advertising. It is not a second security boundary: the numbers are protected
because the Apps Script refuses to hand them over without an admin token, and that check is on
Google's side where a browser cannot reach it. The redirects would not stop someone determined —
they stop the site from telling anyone there is something to be determined about.

One edge worth knowing: on a browser's **very first** visit, if the first URL opened is `stats.html`
itself, the head script has no way to know yet whether sign-in is even configured, so the redirect
happens a moment later in JavaScript instead. The page stays blank throughout and no stats are ever
requested. Every visit after that is caught in the `<head>`.

Reading **and changing** the team playbook take only the site password, so any coach can publish
or remove a play from a phone with the password everyone has. Anyone who knows the team password can
therefore rewrite the team playbook — if that ever becomes a problem, change `SITE_PASSWORD`. A
view-only sign-in can still only read: the script refuses a `viewer` token for saving and removing.

A site sign-in lasts 30 days; an admin session lasts 24 hours, and both limits are enforced inside
the token's signature rather than by the browser. **Signing out of admin clears the numbers from the
page and from the browser's storage**, so a shared laptop does not keep a box score after you walk
away. The stats are never written to storage under this setup at all; only the roster is.

### The admin view

`admin.html`, linked at the foot of every page. Your name is prefilled from your site sign-in; you
type the admin password. It shows:

- **People** — each name, how many times they signed in, how many attempts failed, and when they
  were last seen.
- **Signed in now** — everyone whose sign-in is still valid: name, access (Admin, Coach or View
  only), when they signed in, when it runs out, and how many devices. See the caveat below.
- **Sign everyone out** — ends every session on every device after a confirm. You stay signed in.
- **Every sign-in** — the full log, searchable, with failed attempts and "Signed everyone out" marked.

#### Signed in now

Sign-ins are tokens held by each browser; the script doesn't keep a list of them. So this list is
**worked out from the log**: every successful sign-in since the last *Sign everyone out*, whose
lifetime (`SITE_DAYS`, `VIEWER_HOURS`, `ADMIN_HOURS`) hasn't run out. That means:

- Pressing **Sign out** in someone's browser only forgets the token on that device. They stay
  listed until their sign-in would have expired, or until you sign everyone out.
- It shows who **could** use the site right now, not who has it open.
- An admin whose 24-hour admin part has run out is listed as a Coach, because that's what they still are.

#### Sign everyone out

Pressing it writes a new `SESSION_EPOCH` Script Property. That value is part of the key every token is
signed with, so every token issued before the press stops working at once: coaches, viewers and any
other admin session. Every page checks its stored sign-in with the script in the background when it
opens, so the next page anyone loads shows them the sign-in popup. A page already open stays usable
until it next talks to the script. You are handed fresh tokens and stay signed in. The press is
recorded in the log.

`SESSION_EPOCH` is managed by the script; don't set it yourself. Deleting it only re-validates
tokens signed before the very first press.

> **This needs the updated `Code.gs` deployed** (Manage deployments → Edit → New version). Until then
> the button says so and nobody is signed out, and *Signed in now* doesn't appear.

**Failed attempts are logged too**, with whatever name was typed.

**Five wrong passwords within a minute lock sign-in for 10 minutes — for everyone, even with the
correct password.** The popup says how long is left. Apps Script can't see IP addresses, so it can't
tell one guesser from another; the lock has to cover everybody, and that is what stops someone
trying passwords until one works. The trade-off: anyone hammering the endpoint can keep *new*
sign-ins paused. **People already signed in are not affected** — their sign-in keeps working the
whole time.

The lock is logged as a single *Sign-in locked* row. Attempts made while it is on are refused
without being checked or logged, so a flood of guesses cannot bloat the log sheet.

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
npm run build     # regenerate the plays index, then fill dist/ (what both hosts deploy)
npm run build:plays
```

`package.json` exists only to mark the modules as ESM for Node's test runner and to hold these
scripts. There are no dependencies and nothing is bundled — the site's files ship exactly as they are in the repo.

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
| `assets/js/teamplays.js` | the team playbook and the admin playbook in the sheet |
| `assets/js/features.js` | which staged features this login may see — pure and tested |
| `assets/js/scout.js` | scouting: grouping the schedule, dates, messages — pure and tested |
| `assets/js/scouting.js` | the Scouting page |
| `assets/js/sheets.js` | `parseRows` is shared by both sources, so they cannot disagree |
| `apps-script/Code.gs` | the sign-in backend you paste into Google |

Sheet data is cached in `localStorage` after each successful load, so pages render instantly on a
slow connection and still show the last known numbers if the sheet can't be reached.
