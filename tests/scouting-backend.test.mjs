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
  const admin = ctx.fns.handleSignIn({ name: 'Logan Brose', password: 'admin-pw' });
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
  ctx.fns.handleSaveScoutNotes({ token: ctx.coach, gameId, kind: 'game', text: 'Senior night.' });
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
  assert.equal(r.gameNotes.text, 'Senior night.');
  assert.equal(r.privateNotes.text, 'Their coach ran our old sets.');
  assert.equal(r.privateNotes.updatedBy, 'Logan Brose');
  assert.equal(r.players[0].updatedBy, 'Casey Jones');
});

test('a coach gets everything except the private notes', () => {
  const ctx = ctxWith();
  seed(ctx);
  const r = ctx.fns.handleScoutReport({ token: ctx.coach, gameId: 'G03' });
  assert.equal(r.overview.text, 'Full-court press after makes.');
  assert.equal(r.gameNotes.text, 'Senior night.');
  assert.equal('privateNotes' in r, false);
  assert.doesNotMatch(JSON.stringify(r), /old sets/);
});

test('a viewer gets the game and the key players, and no notes of any kind', () => {
  const ctx = ctxWith();
  seed(ctx);
  const r = ctx.fns.handleScoutReport({ token: ctx.viewer, gameId: 'G03' });
  assert.deepEqual(Object.keys(r).sort(), ['canEdit', 'game', 'ok', 'players', 'role']);
  assert.deepEqual(Object.keys(r.players[0]).sort(), ['blurb', 'id', 'name', 'number', 'position', 'statsUrl']);
  assert.equal(r.players[0].statsUrl, 'https://www.maxpreps.com/x');
  assert.doesNotMatch(JSON.stringify(r), /press|Senior|old sets|Casey/);
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

test('scouting carries over to every game against the same opponent; game notes do not', () => {
  const ctx = ctxWith();
  seed(ctx, 'G01');   // saved against North on Nov 1
  const r = ctx.fns.handleScoutReport({ token: ctx.admin, gameId: 'G03' });   // "  north " on Nov 20
  assert.equal(r.game.opponentKey, 'north');
  assert.equal(r.players[0].name, 'Jay Tall');
  assert.equal(r.overview.text, 'Full-court press after makes.');
  assert.equal(r.privateNotes.text, 'Their coach ran our old sets.');
  assert.equal(r.gameNotes.text, '', 'game notes belong to G01');
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
  assert.equal(r.players[0].updatedBy, 'Logan Brose', 'who saved last is recorded');

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
  assert.equal(r.overview.updatedBy, 'Logan Brose');
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
  assert.deepEqual(ctx.sheets.ScoutPlayers.rows[0], ['Id', 'OpponentKey', 'Number', 'Name', 'Position', 'Blurb', 'StatsUrl', 'Order', 'Updated', 'UpdatedBy']);
  assert.deepEqual(ctx.sheets.ScoutGameNotes.rows[0], ['GameId', 'OpponentKey', 'Notes', 'Updated', 'UpdatedBy']);
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
