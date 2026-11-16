/**
 * Scouting on the server: who sees which games, which fields each login gets,
 * the 7-day window for players, and who may write what.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, tabFor, post } from './helpers/apps-script.mjs';

/** Noon in New York on Friday 13 November 2026. */
const NOW = Date.parse('2026-11-13T17:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

/** The Games tab, laid out as the real one is: legend, blank, header, rows. */
function gamesTab() {
  return tabFor([
    ['Games', '', '', '', '', ''],
    ['Legend: yellow cells = type your data.', '', '', '', '', ''],
    ['', '', '', '', '', ''],
    ['Game ID', 'Date', 'Opponent', 'Home/Away', 'Team Score', 'Opponent Score'],
    ['EX1', '11/14/2026', 'Example Opponent', 'Home', '', ''],
    ['G01', '11/1/2026', 'North', 'Home', '987', '654'],
    ['G02', '11/13/2026', 'Central', 'Home', '', ''],
    ['G03', '2026-11-20', '  north ', 'Away', '', ''],
    ['G04', '2026-11-21', 'South', 'away', '', ''],
    ['G05', '12/5/2026', 'East', 'Home', '', ''],
    // A real date cell: Sheets hands it over as a Date, whatever it shows.
    ['G06', new Date('2026-11-16T05:00:00Z'), 'West', 'Away', '', ''],
    ['G07', 'next tuesday', 'Nowhere', 'Home', '', ''],
  ]);
}

function ctxWith(stage = 'everyone', props = {}) {
  // Sign-ins that outlast the days these tests move the clock through.
  const ctx = loadCodeGs({
    VIEWER_PASSWORD: 'view-pw', RELEASE_SCOUTING: stage, VIEWER_HOURS: '1000', ADMIN_HOURS: '1000', ...props,
  }, { now: NOW });
  ctx.sheets.Games = gamesTab();
  ctx.coach = ctx.fns.handleSignIn({ name: 'Casey Jones', password: 'team-pw' }).token;
  const admin = ctx.fns.handleSignIn({ name: 'Alex Admin', password: 'admin-pw' });
  ctx.adminSite = admin.token;
  ctx.admin = admin.adminToken;
  ctx.viewer = ctx.fns.handleSignIn({ name: 'Parent', password: 'view-pw' }).token;
  return ctx;
}

const HIDDEN = { ok: false, reason: 'unknown_action' };
const ids = (games) => games.map((g) => g.gameId);

/** Fill one opponent's report with every kind of content. */
function seed(ctx, gameId = 'G03') {
  ctx.fns.handleSaveScoutPlayer({ token: ctx.coach, gameId, player: { number: '23', name: 'Jay Tall', position: 'C', blurb: 'Lefty. Rolls hard.', statsUrl: 'https://www.maxpreps.com/x' } });
  ctx.fns.handleSaveScoutNotes({ token: ctx.coach, gameId, kind: 'overview', text: 'Full-court press after makes.' });
  ctx.fns.handleSaveScoutNotes({ token: ctx.admin, gameId, kind: 'private', text: 'Their coach ran our old sets.' });
}

/* ---------------------------------------------------------------- */
/* Release stages                                                    */
/* ---------------------------------------------------------------- */

test('at stage admin only the admin gets anything; everyone else is told the action does not exist', () => {
  const ctx = ctxWith('admin');
  assert.equal(ctx.fns.handleScoutGames({ token: ctx.admin }).ok, true);
  for (const token of [ctx.coach, ctx.viewer, ctx.adminSite, 'junk', '']) {
    assert.deepEqual(ctx.fns.handleScoutGames({ token }), HIDDEN);
    assert.deepEqual(ctx.fns.handleScoutReport({ token, gameId: 'G02' }), HIDDEN);
    assert.deepEqual(ctx.fns.handleSaveScoutNotes({ token, gameId: 'G02', kind: 'overview', text: 'x' }), HIDDEN);
    assert.deepEqual(ctx.fns.handleSaveScoutPlayer({ token, gameId: 'G02', player: { name: 'x' } }), HIDDEN);
  }
  assert.deepEqual(post(ctx.fns, { action: 'scoutGames', token: ctx.coach }), post(ctx.fns, { action: 'nope', token: ctx.coach }));
});

test('at stage coaches the coach is in and the viewer is still out', () => {
  const ctx = ctxWith('coaches');
  assert.equal(ctx.fns.handleScoutGames({ token: ctx.coach }).ok, true);
  assert.deepEqual(ctx.fns.handleScoutGames({ token: ctx.viewer }), HIDDEN);
});

test('rolling a stage back closes the door on the next request', () => {
  const ctx = ctxWith('everyone');
  assert.equal(ctx.fns.handleScoutGames({ token: ctx.viewer }).ok, true);
  ctx.props.RELEASE_SCOUTING = 'admin';
  assert.deepEqual(ctx.fns.handleScoutGames({ token: ctx.viewer }), HIDDEN);
});

/* ---------------------------------------------------------------- */
/* The schedule                                                      */
/* ---------------------------------------------------------------- */

test('admin and coaches get every upcoming game in date order, today included', () => {
  const ctx = ctxWith();
  const res = ctx.fns.handleScoutGames({ token: ctx.coach });
  assert.deepEqual(ids(res.upcoming), ['G02', 'G06', 'G03', 'G04', 'G05']);
  assert.deepEqual(res.upcoming.map((g) => g.daysAway), [0, 3, 7, 8, 22]);
  assert.equal(res.role, 'coach');
  assert.equal(res.canEdit, true);
});

test('finished games leave the list and go to the archive, newest first, for admin and coaches', () => {
  const ctx = ctxWith();
  assert.deepEqual(ids(ctx.fns.handleScoutGames({ token: ctx.admin }).past), ['G01']);
  assert.deepEqual(ids(ctx.fns.handleScoutGames({ token: ctx.coach }).past), ['G01']);
  assert.equal(ctx.fns.handleScoutGames({ token: ctx.viewer }).past, undefined, 'never for viewers');
});

test('a viewer sees only the games within 7 days, and cannot edit', () => {
  const ctx = ctxWith();
  const res = ctx.fns.handleScoutGames({ token: ctx.viewer });
  assert.deepEqual(ids(res.upcoming), ['G02', 'G06', 'G03']);
  assert.equal(res.role, 'viewer');
  assert.equal(res.canEdit, false);
});

test('the window edges: 8 days out is closed, 7 days out and game day are open, the day after is gone', () => {
  const ctx = ctxWith();
  const at = (iso) => { ctx.clock.now = Date.parse(iso); ctx.cache.delete('games'); };
  const canSee = (gameId) => ctx.fns.handleScoutReport({ token: ctx.viewer, gameId }).ok === true;

  at('2026-11-12T17:00:00Z'); // G03 (Nov 20) is 8 days away
  assert.equal(canSee('G03'), false, 'D-8');
  at('2026-11-13T05:00:01Z'); // just after midnight in New York: 7 days
  assert.equal(canSee('G03'), true, 'D-7');
  at('2026-11-20T23:00:00Z'); // game day, evening
  assert.equal(canSee('G03'), true, 'D');
  at('2026-11-21T06:00:00Z'); // the next morning in New York
  assert.equal(canSee('G03'), false, 'D+1');
});

test('"today" is the team\'s day, not the server\'s', () => {
  // 9pm on Nov 13 in Chicago is already Nov 14 in UTC. The Nov 13 game is
  // still today there, so it is still on the list.
  const ctx = ctxWith('everyone', { TIME_ZONE: 'America/Chicago' });
  ctx.clock.now = Date.parse('2026-11-14T03:00:00Z');
  assert.equal(ctx.fns.todayKey(), '2026-11-13');
  assert.equal(ctx.fns.handleScoutGames({ token: ctx.coach }).upcoming[0].gameId, 'G02');
});

test('dates are read from real date cells and from typed text; unreadable ones are skipped', () => {
  const ctx = ctxWith();
  const games = ctx.fns.readGames();
  assert.equal(games.find((g) => g.gameId === 'G06').date, '2026-11-16');
  assert.equal(games.find((g) => g.gameId === 'G05').date, '2026-12-05');
  assert.equal(games.some((g) => g.gameId === 'G07'), false);
  assert.equal(games.some((g) => g.gameId === 'EX1'), false, 'example rows are not games');
});

test('a date cell keeps its day whatever zone "today" is judged in', () => {
  // G06 is midnight on Nov 16 in New York, the spreadsheet's zone. Read in
  // Chicago (or a deployment still on an older project zone) it used to come
  // out as 11pm on Nov 15.
  for (const props of [{ TIME_ZONE: 'America/Chicago' }, { TIME_ZONE: 'America/Los_Angeles' }, {}]) {
    const ctx = ctxWith('everyone', props);
    assert.equal(ctx.fns.readGames().find((g) => g.gameId === 'G06').date, '2026-11-16', JSON.stringify(props));
  }
});

test('with no TIME_ZONE, "today" follows the spreadsheet\'s zone, not the project\'s', () => {
  const ctx = ctxWith();
  ctx.spreadsheet.timeZone = 'Pacific/Auckland';   // the project zone in the harness is New York
  ctx.clock.now = Date.parse('2026-11-13T12:00:00Z');   // 1am on Nov 14 in Auckland
  assert.equal(ctx.fns.todayKey(), '2026-11-14');
});

test('the day is what the cell shows, even when the stored moment is the evening before', () => {
  // The live sheet: getSpreadsheetTimeZone() came back empty and a cell shown
  // as 11/16 held midnight UTC, which is 7pm on Nov 15 in New York.
  const ctx = ctxWith();
  ctx.spreadsheet.timeZone = '';
  ctx.sheets.Games.rows.push(
    ['G10', { value: new Date('2026-11-16T00:00:00Z'), shown: '11/16' }, 'Taylor', 'Home', '', ''],
    ['G11', { value: new Date('2027-01-01T00:00:00Z'), shown: '12/31' }, 'Year End', 'Home', '', ''],
    ['G12', { value: new Date('2026-11-17T00:00:00Z'), shown: 'Tue, Nov 17' }, 'Words', 'Home', '', ''],
    ['G13', { value: new Date('2026-11-18T00:00:00Z'), shown: 'Wednesday, November 18, 2026' }, 'Long', 'Home', '', ''],
    ['G14', { value: new Date('2026-11-19T05:00:00Z'), shown: '' }, 'Unreadable display', 'Home', '', ''],
    ['G15', '11/22', 'Typed no year', 'Home', '', ''],
    ['G16', '2/30/2026', 'Not a day', 'Home', '', ''],
  );
  const date = (id) => ctx.fns.readGames().find((g) => g.gameId === id)?.date;
  assert.equal(date('G10'), '2026-11-16');
  assert.equal(date('G11'), '2026-12-31', 'the year is the one nearest the stored moment');
  assert.equal(date('G12'), '2026-11-17');
  assert.equal(date('G13'), '2026-11-18');
  assert.equal(date('G14'), '2026-11-19', 'a display it cannot read falls back to the stored moment');
  assert.equal(date('G15'), '2026-11-22', 'typed text with no year takes the nearest year to today');
  assert.equal(date('G16'), undefined);
  const taylor = ctx.fns.handleScoutGames({ token: ctx.coach }).upcoming.find((g) => g.gameId === 'G10');
  assert.equal(taylor.daysAway, 3, 'Nov 16 is three days from Friday Nov 13');
});

test('no score ever leaves the script for anyone but through the admin stats route', () => {
  const ctx = ctxWith();
  seed(ctx, 'G03');
  for (const token of [ctx.admin, ctx.coach, ctx.viewer]) {
    const text = JSON.stringify([
      ctx.fns.handleScoutGames({ token }),
      ctx.fns.handleScoutReport({ token, gameId: 'G01' }),
      ctx.fns.handleScoutReport({ token, gameId: 'G03' }),
    ]);
    assert.doesNotMatch(text, /987|654|Score/i);
  }
});

/* ---------------------------------------------------------------- */
/* What each login gets in a report                                  */
/* ---------------------------------------------------------------- */

test('the admin gets everything, private notes included', () => {
  const ctx = ctxWith();
  seed(ctx);
  const r = ctx.fns.handleScoutReport({ token: ctx.admin, gameId: 'G03' });
  assert.equal(r.overview.text, 'Full-court press after makes.');
  assert.equal(r.privateNotes.text, 'Their coach ran our old sets.');
  assert.equal(r.privateNotes.updatedBy, 'Alex Admin');
  assert.equal(r.players[0].updatedBy, 'Casey Jones');
});

test('a coach gets everything except the private notes', () => {
  const ctx = ctxWith();
  seed(ctx);
  const r = ctx.fns.handleScoutReport({ token: ctx.coach, gameId: 'G03' });
  assert.equal(r.overview.text, 'Full-court press after makes.');
  assert.equal('privateNotes' in r, false);
  assert.doesNotMatch(JSON.stringify(r), /old sets/);
});

test('a viewer gets the game, the overview text and the key players, and no private notes', () => {
  const ctx = ctxWith();
  seed(ctx);
  const r = ctx.fns.handleScoutReport({ token: ctx.viewer, gameId: 'G03' });
  assert.deepEqual(Object.keys(r).sort(), ['canEdit', 'game', 'ok', 'overview', 'players', 'plays', 'role']);
  assert.deepEqual(r.overview, { text: 'Full-court press after makes.' }, 'the text only, not who saved it');
  assert.deepEqual(Object.keys(r.players[0]).sort(),
    ['blurb', 'height', 'id', 'matchup', 'name', 'number', 'position', 'stats', 'statsUrl']);
  assert.equal(r.players[0].statsUrl, 'https://www.maxpreps.com/x');
  assert.doesNotMatch(JSON.stringify(r), /old sets|Casey/);
});

test('a viewer with no overview saved gets an empty one', () => {
  const ctx = ctxWith();
  const r = ctx.fns.handleScoutReport({ token: ctx.viewer, gameId: 'G03' });
  assert.deepEqual(r.overview, { text: '' });
});

test('a viewer asking for a game outside the window is told it does not exist', () => {
  const ctx = ctxWith();
  assert.deepEqual(ctx.fns.handleScoutReport({ token: ctx.viewer, gameId: 'G05' }), { ok: false, reason: 'not_found' });
  assert.deepEqual(ctx.fns.handleScoutReport({ token: ctx.viewer, gameId: 'G01' }), { ok: false, reason: 'not_found' });
  assert.deepEqual(ctx.fns.handleScoutReport({ token: ctx.viewer, gameId: 'G99' }), { ok: false, reason: 'not_found' });
  assert.equal(ctx.fns.handleScoutReport({ token: ctx.coach, gameId: 'G05' }).ok, true, 'coaches can prepare early');
  assert.equal(ctx.fns.handleScoutReport({ token: ctx.coach, gameId: 'G01' }).ok, true, 'and look back');
});

/* ---------------------------------------------------------------- */
/* Belongs to the opponent                                           */
/* ---------------------------------------------------------------- */

test('scouting carries over to every game against the same opponent', () => {
  const ctx = ctxWith();
  seed(ctx, 'G01');   // saved against North on Nov 1
  const r = ctx.fns.handleScoutReport({ token: ctx.admin, gameId: 'G03' });   // "  north " on Nov 20
  assert.equal(r.game.opponentKey, 'north');
  assert.equal(r.players[0].name, 'Jay Tall');
  assert.equal(r.overview.text, 'Full-court press after makes.');
  assert.equal(r.privateNotes.text, 'Their coach ran our old sets.');
});

test('there are no per-game notes any more, for anyone', () => {
  const ctx = ctxWith();
  seed(ctx);
  for (const token of [ctx.admin, ctx.coach, ctx.viewer]) {
    assert.equal('gameNotes' in ctx.fns.handleScoutReport({ token, gameId: 'G03' }), false);
  }
  assert.deepEqual(ctx.fns.handleSaveScoutNotes({ token: ctx.admin, gameId: 'G03', kind: 'game', text: 'x' }),
    { ok: false, reason: 'bad_request' });
  assert.equal(ctx.sheets.ScoutGameNotes, undefined, 'and no tab is created for them');
});

test('an old ScoutGameNotes tab is left exactly as it is', () => {
  const ctx = ctxWith();
  ctx.sheets.ScoutGameNotes = tabFor([
    ['GameId', 'OpponentKey', 'Notes', 'Updated', 'UpdatedBy'],
    ['G03', 'north', 'Senior night.', '', 'Casey Jones'],
  ]);
  const before = JSON.stringify(ctx.sheets.ScoutGameNotes.rows);
  seed(ctx);
  ctx.fns.checkSetup();
  assert.equal(JSON.stringify(ctx.sheets.ScoutGameNotes.rows), before);
  assert.doesNotMatch(JSON.stringify(ctx.fns.handleScoutReport({ token: ctx.admin, gameId: 'G03' })), /Senior/);
});

/* ---------------------------------------------------------------- */
/* Writing                                                           */
/* ---------------------------------------------------------------- */

test('viewers write nothing; coaches write everything but private notes', () => {
  const ctx = ctxWith();
  assert.deepEqual(ctx.fns.handleSaveScoutPlayer({ token: ctx.viewer, gameId: 'G02', player: { name: 'x' } }), HIDDEN);
  assert.deepEqual(ctx.fns.handleSaveScoutNotes({ token: ctx.viewer, gameId: 'G02', kind: 'overview', text: 'x' }), HIDDEN);
  assert.deepEqual(ctx.fns.handleDeleteScoutPlayer({ token: ctx.viewer, gameId: 'G02', id: 'x' }), HIDDEN);
  assert.deepEqual(ctx.fns.handleSaveScoutNotes({ token: ctx.coach, gameId: 'G02', kind: 'private', text: 'x' }), HIDDEN);
  assert.equal(ctx.fns.handleSaveScoutNotes({ token: ctx.coach, gameId: 'G02', kind: 'overview', text: 'x' }).ok, true);
  assert.equal(ctx.fns.handleSaveScoutNotes({ token: ctx.coach, gameId: 'G02', kind: 'weird', text: 'x' }).reason, 'bad_request');
  assert.equal(ctx.fns.handleSaveScoutNotes({ token: ctx.coach, gameId: 'G02', kind: 'game', text: 'x' }).reason, 'bad_request');
});

test('a write names a game, and the script decides which opponent that is', () => {
  const ctx = ctxWith();
  ctx.fns.handleSaveScoutPlayer({ token: ctx.coach, gameId: 'G04', opponentKey: 'north', player: { name: 'Sneaky', opponentKey: 'north' } });
  const south = ctx.fns.handleScoutReport({ token: ctx.coach, gameId: 'G04' });
  const north = ctx.fns.handleScoutReport({ token: ctx.coach, gameId: 'G03' });
  assert.deepEqual(south.players.map((p) => p.name), ['Sneaky']);
  assert.deepEqual(north.players, []);
  assert.equal(ctx.fns.handleSaveScoutPlayer({ token: ctx.coach, gameId: 'G99', player: { name: 'x' } }).reason, 'not_found');
});

test('a player can be edited and removed only through their own opponent', () => {
  const ctx = ctxWith();
  const { id } = ctx.fns.handleSaveScoutPlayer({ token: ctx.coach, gameId: 'G03', player: { name: 'Jay', number: '23' } });

  assert.equal(ctx.fns.handleSaveScoutPlayer({ token: ctx.coach, gameId: 'G04', player: { id, name: 'Hijack' } }).reason, 'not_found');
  ctx.fns.handleDeleteScoutPlayer({ token: ctx.coach, gameId: 'G04', id });
  assert.equal(ctx.fns.handleScoutReport({ token: ctx.coach, gameId: 'G03' }).players[0].name, 'Jay');

  const saved = ctx.fns.handleSaveScoutPlayer({ token: ctx.admin, gameId: 'G01', player: { id, name: 'Jay Tall', number: '23' } });
  assert.equal(saved.ok, true, 'any game against the same opponent will do');
  const r = ctx.fns.handleScoutReport({ token: ctx.coach, gameId: 'G03' });
  assert.equal(r.players.length, 1);
  assert.equal(r.players[0].name, 'Jay Tall');
  assert.equal(r.players[0].updatedBy, 'Alex Admin', 'who saved last is recorded');

  ctx.fns.handleDeleteScoutPlayer({ token: ctx.coach, gameId: 'G03', id });
  assert.deepEqual(ctx.fns.handleScoutReport({ token: ctx.coach, gameId: 'G03' }).players, []);
});

test('only http and https stats links are kept', () => {
  const ctx = ctxWith();
  const links = ['javascript:alert(1)', 'data:text/html,hi', 'ftp://x', 'www.maxpreps.com', 'https://ok.example/p?id=1', 'http://league.example'];
  for (const statsUrl of links) {
    ctx.fns.handleSaveScoutPlayer({ token: ctx.coach, gameId: 'G03', player: { name: statsUrl, statsUrl } });
  }
  const kept = ctx.fns.handleScoutReport({ token: ctx.coach, gameId: 'G03' }).players
    .filter((p) => p.statsUrl).map((p) => p.statsUrl).sort();
  assert.deepEqual(kept, ['http://league.example', 'https://ok.example/p?id=1']);
});

test('a link hand-typed into the sheet is checked on the way out too', () => {
  const ctx = ctxWith();
  ctx.fns.handleScoutReport({ token: ctx.coach, gameId: 'G03' });   // creates the tab
  ctx.sheets.ScoutPlayers.appendRow(['sp-x', 'north', '1', 'Typed', '', '', 'javascript:alert(1)', 0, '', '']);
  assert.equal(ctx.fns.handleScoutReport({ token: ctx.viewer, gameId: 'G03' }).players[0].statsUrl, '');
});

test('fields are trimmed and capped, and a player needs a name or a number', () => {
  const ctx = ctxWith();
  assert.equal(ctx.fns.handleSaveScoutPlayer({ token: ctx.coach, gameId: 'G03', player: { name: '  ', number: '' } }).reason, 'bad_request');
  ctx.fns.handleSaveScoutPlayer({ token: ctx.coach, gameId: 'G03', player: { number: '123456', name: 'x'.repeat(200), blurb: 'b'.repeat(2000) } });
  const p = ctx.fns.handleScoutReport({ token: ctx.coach, gameId: 'G03' }).players[0];
  assert.equal(p.number, '1234');
  assert.equal(p.name.length, 60);
  assert.equal(p.blurb.length, 500);
});

test('an opponent holds at most 30 key players', () => {
  const ctx = ctxWith();
  for (let i = 0; i < 30; i++) {
    assert.equal(ctx.fns.handleSaveScoutPlayer({ token: ctx.coach, gameId: 'G03', player: { number: String(i) } }).ok, true);
  }
  assert.equal(ctx.fns.handleSaveScoutPlayer({ token: ctx.coach, gameId: 'G03', player: { number: '99' } }).reason, 'too_many');
});

test('notes that look like formulas are stored as text', () => {
  const ctx = ctxWith();
  ctx.fns.handleSaveScoutNotes({ token: ctx.coach, gameId: 'G03', kind: 'overview', text: '=IMPORTXML("http://evil","//a")' });
  ctx.fns.handleSaveScoutPlayer({ token: ctx.coach, gameId: 'G03', player: { name: '+cmd', blurb: '@x' } });
  assert.match(String(ctx.sheets.Opponents.rows[1][2]), /^'=/);
  assert.match(String(ctx.sheets.ScoutPlayers.rows[1][3]), /^'\+/);
  assert.match(String(ctx.sheets.ScoutPlayers.rows[1][5]), /^'@/);
});

test('saving notes again replaces them, and records who saved last', () => {
  const ctx = ctxWith();
  ctx.fns.handleSaveScoutNotes({ token: ctx.coach, gameId: 'G03', kind: 'overview', text: 'one' });
  ctx.fns.handleSaveScoutNotes({ token: ctx.admin, gameId: 'G01', kind: 'overview', text: 'two' });
  assert.equal(ctx.sheets.Opponents.rows.length, 2, 'one row per opponent');
  const r = ctx.fns.handleScoutReport({ token: ctx.coach, gameId: 'G03' });
  assert.equal(r.overview.text, 'two');
  assert.equal(r.overview.updatedBy, 'Alex Admin');
});

test('every write releases its lock', () => {
  const ctx = ctxWith();
  seed(ctx);
  ctx.fns.handleDeleteScoutPlayer({ token: ctx.coach, gameId: 'G03', id: 'nope' });
  assert.ok(ctx.locks.taken > 0);
  assert.equal(ctx.locks.taken, ctx.locks.released);
});

/* ---------------------------------------------------------------- */
/* Tabs                                                              */
/* ---------------------------------------------------------------- */

test('checkSetup creates the scouting tabs with headers and never touches existing ones', () => {
  const ctx = ctxWith();
  ctx.fns.checkSetup();
  assert.deepEqual(ctx.sheets.Opponents.rows[0], ['OpponentKey', 'Opponent', 'Overview', 'Updated', 'UpdatedBy']);
  assert.deepEqual(ctx.sheets.ScoutPlayers.rows[0], ['Id', 'OpponentKey', 'Number', 'Name', 'Position', 'Blurb', 'StatsUrl', 'Order', 'Updated', 'UpdatedBy', 'Height', 'Stats', 'GuardId', 'HelpId', 'MatchupNote']);
  assert.deepEqual(ctx.sheets.ScoutPrivate.rows[0], ['OpponentKey', 'Notes', 'Updated', 'UpdatedBy']);

  seed(ctx);
  const before = JSON.stringify(ctx.sheets.ScoutPlayers.rows);
  ctx.fns.checkSetup();
  assert.equal(JSON.stringify(ctx.sheets.ScoutPlayers.rows), before);
});

test('the stats spreadsheet is never written to', () => {
  const ctx = ctxWith();
  const before = JSON.stringify(ctx.sheets.Games.rows);
  seed(ctx);
  ctx.fns.checkSetup();
  assert.equal(JSON.stringify(ctx.sheets.Games.rows), before);
});

test('the schedule is cached briefly, and checkSetup clears it', () => {
  const ctx = ctxWith();
  ctx.fns.handleScoutGames({ token: ctx.coach });
  ctx.sheets.Games.rows.push(['G08', '11/14/2026', 'Late Add', 'Home', '', '']);
  assert.equal(ids(ctx.fns.handleScoutGames({ token: ctx.coach }).upcoming).includes('G08'), false);
  ctx.fns.checkSetup();
  assert.equal(ids(ctx.fns.handleScoutGames({ token: ctx.coach }).upcoming).includes('G08'), true);
});

test('admin tokens also see the schedule a day at a time as it passes', () => {
  const ctx = ctxWith();
  ctx.clock.now = NOW + DAY;
  ctx.cache.delete('games');
  assert.equal(ctx.fns.handleScoutGames({ token: ctx.admin }).upcoming[0].gameId, 'G06');
});

/* ---------------------------------------------------------------- */
/* Stats, height and the defensive matchup                           */
/* ---------------------------------------------------------------- */

/** Our roster, out of jersey order on the sheet, with the viewer login 'Parent' still on it. */
function rosterTab(ctx) {
  ctx.sheets.Players = tabFor([
    ['Players', '', '', ''],
    ['Player ID', 'Full Name', 'Jersey Number', 'Position'],
    ['EX1', 'Example Player', '00', 'G'],
    ['P1', 'Parent', '23', 'G'],
    ['P2', 'John Smith', '12', 'PG'],
    ['P3', 'Jane Doe', '4', 'SF'],
    ['P4', 'No Number', '', 'C'],
  ]);
  ctx.cache.delete('rosterPlayers');
  ctx.cache.delete('roster');
}

const FULL = {
  number: '23', name: 'Jay Tall', position: 'C', height: `6'5"`,
  stats: { gp: '12', ppg: '18.4', rpg: '6.10', fg: '.512', '3p': '38%', ft: '0.7', bogus: '9' },
  guardId: 'P2', helpId: 'P3', matchupNote: 'Deny the catch, force left.',
};

test('stats, height and the matchup are saved and come back for every role', () => {
  const ctx = ctxWith();
  rosterTab(ctx);
  assert.equal(ctx.fns.handleSaveScoutPlayer({ token: ctx.coach, gameId: 'G03', player: FULL }).ok, true);

  for (const token of [ctx.admin, ctx.coach, ctx.viewer]) {
    const p = ctx.fns.handleScoutReport({ token, gameId: 'G03' }).players[0];
    assert.equal(p.height, `6'5"`);
    assert.deepEqual(p.stats, { gp: '12', ppg: '18.4', rpg: '6.1', fg: '51.2', '3p': '38', ft: '70' });
    assert.deepEqual(p.matchup, {
      guard: { id: 'P2', name: 'John Smith', number: '12' },
      help: { id: 'P3', name: 'Jane Doe', number: '4' },
      note: 'Deny the catch, force left.',
    });
  }
});

test('a percentage typed as a decimal under 1 is saved as a whole percentage', () => {
  const ctx = ctxWith();
  assert.deepEqual(ctx.fns.cleanStats({ fg: '.38', '3p': '0.385', ft: '1', ppg: '.5', rpg: '0' }),
    { fg: '38', '3p': '38.5', ft: '1', ppg: '0.5', rpg: '0' });
  assert.deepEqual(ctx.fns.cleanStats({ fg: '150', ppg: 'abc', apg: '-2', spg: '1e3', gp: '' }), {});
  assert.deepEqual(ctx.fns.cleanStats(null), {});
});

test('a defender must be on our roster; anything else is stored as nobody', () => {
  const ctx = ctxWith();
  rosterTab(ctx);
  ctx.fns.handleSaveScoutPlayer({ token: ctx.coach, gameId: 'G03', player: { name: 'A', guardId: 'EX1', helpId: 'P99' } });
  const row = ctx.sheets.ScoutPlayers.rows[1];
  assert.equal(row[12], '');
  assert.equal(row[13], '');
  const p = ctx.fns.handleScoutReport({ token: ctx.coach, gameId: 'G03' }).players[0];
  assert.deepEqual(p.matchup, { guard: null, help: null, note: '' });
});

test('a defender taken off the roster drops out of the matchup without breaking the report', () => {
  const ctx = ctxWith();
  rosterTab(ctx);
  ctx.fns.handleSaveScoutPlayer({ token: ctx.coach, gameId: 'G03', player: FULL });
  ctx.sheets.Players.rows.splice(4, 1);   // John Smith, P2
  ctx.cache.delete('rosterPlayers');
  const p = ctx.fns.handleScoutReport({ token: ctx.viewer, gameId: 'G03' }).players[0];
  assert.equal(p.matchup.guard, null);
  assert.equal(p.matchup.help.name, 'Jane Doe');
});

test('the roster for the dropdowns goes to admin and coaches only, sorted by jersey number', () => {
  const ctx = ctxWith();
  rosterTab(ctx);
  for (const token of [ctx.admin, ctx.coach]) {
    const r = ctx.fns.handleScoutReport({ token, gameId: 'G03' });
    assert.deepEqual(r.roster.map((x) => x.number), ['4', '12', '23', ''], 'numeric order, blanks last, no EX rows');
  }
  const v = ctx.fns.handleScoutReport({ token: ctx.viewer, gameId: 'G03' });
  assert.equal('roster' in v, false);
  assert.doesNotMatch(JSON.stringify(v), /No Number/);
});

test('a broken Stats cell, or a row from before these columns, reads as empty', () => {
  const ctx = ctxWith();
  ctx.fns.handleScoutReport({ token: ctx.coach, gameId: 'G03' });   // creates the tab
  ctx.sheets.ScoutPlayers.appendRow(['sp-a', 'north', '1', 'Old Row', '', '', '', 0, '', '']);
  ctx.sheets.ScoutPlayers.appendRow(['sp-b', 'north', '2', 'Bad Cell', '', '', '', 0, '', '', '', '{not json', '', '', '']);
  const players = ctx.fns.handleScoutReport({ token: ctx.viewer, gameId: 'G03' }).players;
  for (const p of players) {
    assert.deepEqual(p.stats, {});
    assert.equal(p.height, '');
    assert.deepEqual(p.matchup, { guard: null, help: null, note: '' });
  }
});

test('a tab made before the new columns gets their headers filled in, and nothing else changes', () => {
  const ctx = ctxWith();
  const old = ['Id', 'OpponentKey', 'Number', 'Name', 'Position', 'Blurb', 'StatsUrl', 'Order', 'Updated', 'UpdatedBy'];
  ctx.sheets.ScoutPlayers = tabFor([old.slice(), ['sp-a', 'north', '1', 'Old Row', 'G', '', '', 0, '', '']]);
  ctx.fns.handleSaveScoutPlayer({ token: ctx.coach, gameId: 'G03', player: { name: 'New', height: '6-1' } });
  assert.deepEqual(ctx.sheets.ScoutPlayers.rows[0], [...old, 'Height', 'Stats', 'GuardId', 'HelpId', 'MatchupNote']);
  assert.deepEqual(ctx.sheets.ScoutPlayers.rows[1], ['sp-a', 'north', '1', 'Old Row', 'G', '', '', 0, '', '']);
  assert.equal(ctx.fns.handleScoutReport({ token: ctx.coach, gameId: 'G03' }).players.find((p) => p.name === 'New').height, '6-1');
});

test('height and the matchup note that look like formulas are stored as text, and are capped', () => {
  const ctx = ctxWith();
  ctx.fns.handleSaveScoutPlayer({ token: ctx.coach, gameId: 'G03', player: { name: 'A', height: '=1+1', matchupNote: '+x'.repeat(300) } });
  const row = ctx.sheets.ScoutPlayers.rows[1];
  assert.match(String(row[10]), /^'=/);
  assert.match(String(row[14]), /^'\+/);
  assert.equal(String(row[14]).length, 201);
});

/* ---------------------------------------------------------------- */
/* Players are read-only; private notes stay with the admin           */
/* ---------------------------------------------------------------- */

test('a viewer cannot save or delete anything in scouting, and no row changes', () => {
  const ctx = ctxWith();
  rosterTab(ctx);
  seed(ctx);
  ctx.fns.handleSaveOpponentPlay({ token: ctx.coach, gameId: 'G03', play: { id: 'p1', name: 'Box', frames: [{}] } });
  const id = ctx.sheets.ScoutPlayers.rows[1][0];
  const playId = ctx.sheets.OpponentPlays.rows[1][0];
  const snap = () => JSON.stringify(['ScoutPlayers', 'Opponents', 'ScoutPrivate', 'OpponentPlays'].map((t) => ctx.sheets[t].rows));
  const before = snap();

  const tries = [
    ctx.fns.handleSaveScoutPlayer({ token: ctx.viewer, gameId: 'G03', player: { ...FULL, id, name: 'Hacked' } }),
    ctx.fns.handleSaveScoutPlayer({ token: ctx.viewer, gameId: 'G03', player: { name: 'New one' } }),
    ctx.fns.handleDeleteScoutPlayer({ token: ctx.viewer, gameId: 'G03', id }),
    ctx.fns.handleSaveScoutNotes({ token: ctx.viewer, gameId: 'G03', kind: 'overview', text: 'x' }),
    ctx.fns.handleSaveScoutNotes({ token: ctx.viewer, gameId: 'G03', kind: 'private', text: 'x' }),
    ctx.fns.handleSaveOpponentPlay({ token: ctx.viewer, gameId: 'G03', play: { id: 'p1', name: 'x', frames: [] } }),
    ctx.fns.handleDeleteOpponentPlay({ token: ctx.viewer, gameId: 'G03', id: playId }),
    post(ctx.fns, { action: 'saveScoutPlayer', token: ctx.viewer, gameId: 'G03', player: { id, name: 'Hacked' } }),
  ];
  for (const r of tries) assert.deepEqual(r, HIDDEN);
  assert.equal(snap(), before);
  assert.equal(ctx.fns.handleScoutReport({ token: ctx.viewer, gameId: 'G03' }).canEdit, false);
});

test('private notes are never sent to a coach or a viewer, by any scouting reply', () => {
  const ctx = ctxWith();
  rosterTab(ctx);
  seed(ctx);
  const secret = /old sets/;
  for (const token of [ctx.coach, ctx.viewer]) {
    const replies = [
      ctx.fns.handleScoutGames({ token }),
      ctx.fns.handleScoutReport({ token, gameId: 'G03' }),
      post(ctx.fns, { action: 'scoutGames', token }),
      post(ctx.fns, { action: 'scoutReport', token, gameId: 'G03' }),
    ];
    for (const r of replies) {
      assert.equal(r.ok, true);
      assert.equal('privateNotes' in r, false);
      assert.doesNotMatch(JSON.stringify(r), secret);
    }
  }
  assert.match(JSON.stringify(post(ctx.fns, { action: 'scoutReport', token: ctx.admin, gameId: 'G03' })), secret);
});
