import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV } from '../assets/js/csv.js';
import { findHeaderRow, isSkippableKey, parseTab, SCHEMAS, gvizUrl, pubCsvUrl, endpointsFor } from '../assets/js/sheets.js';

/** The Players tab as the sheet actually ships it: title, legend lines, blank row. */
const PLAYERS_CSV = [
  'Players,,,',
  '"Legend: yellow cells = type your data. Player ID must be unique (P1, P2, P3...).",,,',
  '"Example row shown in green below — replace/delete before entering your real roster.",,,',
  ',,,',
  'Player ID,Full Name,Jersey Number,Position',
  'EX1,Example Player,00,G',
  'P1,John Smith,12,PG',
  ',,,',
  'P2,Jane Doe,7,SF',
].join('\n');

test('finds the header row beneath title, legend and blank rows', () => {
  const rows = parseCSV(PLAYERS_CSV);
  assert.equal(findHeaderRow(rows, 'player id'), 4);
});

test('finds a header row that is row 1', () => {
  const rows = parseCSV('Stat ID,Game ID,Player ID,Points\nS01,G01,P1,15');
  assert.equal(findHeaderRow(rows, 'stat id'), 0);
});

test('header detection survives a legend line being added or removed', () => {
  // The whole point of scanning: editing the legend shifts the offset.
  const shorter = PLAYERS_CSV.split('\n').filter((l) => !l.startsWith('"Example row')).join('\n');
  assert.equal(findHeaderRow(parseCSV(shorter), 'player id'), 3);
});

test('the key header is matched exactly, not as a substring', () => {
  // "Player ID" and "Player Name" must not satisfy a key of "player", or a
  // schema could latch onto the wrong tab.
  const rows = parseCSV(PLAYERS_CSV);
  assert.equal(findHeaderRow(rows, 'player'), -1);
});

test('each tab declares its own key header', () => {
  assert.equal(SCHEMAS.players.key, 'player id');
  assert.equal(SCHEMAS.games.key, 'game id');
  assert.equal(SCHEMAS.statslog.key, 'stat id');
  assert.equal(SCHEMAS.responses, undefined, 'the Form schema is gone');
});

/** The StatsLog tab as the sheet ships it: preamble, then (auto) lookup columns. */
const STATSLOG_CSV = [
  'Stats Log — one row per player per game,,,,,,,',
  '"Legend: yellow cells = type your data.",,,,,,,',
  ',,,,,,,',
  'Stat ID,Game ID,Player ID,Player Name (auto),Home/Away (auto),Points,FGM,FGA',
  'EX1,G01,P1,Example Player,Home,10,4,8',
  'S01,G01,P1,John Smith,Home,15,6,11',
].join('\n');

test('StatsLog parses with Stat ID as its key and Player ID as the player', () => {
  const out = parseTab(STATSLOG_CSV, SCHEMAS.statslog);
  assert.equal(out.error, null);
  assert.equal(out.headerRow, 3);
  assert.equal(out.records.length, 1); // the EX row is skipped
  assert.equal(out.records[0].player, 'P1');
  assert.equal(out.records[0].game, 'G01');
  assert.equal(out.records[0].points, '15');
});

test('the (auto) lookup columns are reported as unused, not mistaken for data', () => {
  // The site joins Players and Games by ID itself, so these are surplus.
  const out = parseTab(STATSLOG_CSV, SCHEMAS.statslog);
  assert.ok(out.unknownColumns.includes('Player Name (auto)'));
  assert.ok(out.unknownColumns.includes('Home/Away (auto)'));
});

test('the StatsLog key is unique to StatsLog', () => {
  // `Stat ID` appears on no other tab, so the stats source can never latch onto
  // the roster or the schedule by mistake.
  assert.equal(findHeaderRow(parseCSV(PLAYERS_CSV), SCHEMAS.statslog.key), -1);
  assert.equal(findHeaderRow(parseCSV('Game ID,Date,Opponent\nG01,9/15/2025,Central'), SCHEMAS.statslog.key), -1);
  assert.notEqual(findHeaderRow(parseCSV(STATSLOG_CSV), SCHEMAS.statslog.key), -1);

  // The reverse isn't claimed: StatsLog legitimately carries a `Player ID`
  // column, so the Players key does appear there. Schemas are applied per tab.
  assert.notEqual(findHeaderRow(parseCSV(STATSLOG_CSV), SCHEMAS.players.key), -1);
});

test('skips blank keys and EX-prefixed example rows, structurally', () => {
  assert.equal(isSkippableKey(''), true);
  assert.equal(isSkippableKey('   '), true);
  assert.equal(isSkippableKey('EX1'), true);
  assert.equal(isSkippableKey('ex99'), true);
  assert.equal(isSkippableKey('P1'), false);
  // A real ID that merely begins with the letters of a word is untouched.
  assert.equal(isSkippableKey('P-EX1'), false);
});

test('parseTab returns canonical records and reports skipped example rows', () => {
  const out = parseTab(PLAYERS_CSV, SCHEMAS.players);
  assert.equal(out.error, null);
  assert.equal(out.headerRow, 4);
  assert.deepEqual(out.records.map((r) => r.playerId), ['P1', 'P2']);
  assert.equal(out.records[0].fullName, 'John Smith');
  assert.equal(out.records[0].jersey, '12');
  // The EX row is a skip; the all-blank padding row is not counted as one.
  assert.equal(out.skipped, 1);
});

test('parseTab records the originating sheet row for each record', () => {
  const out = parseTab(PLAYERS_CSV, SCHEMAS.players);
  assert.equal(out.records[0]._sheetRow, 7); // 1-based, matching the sheet UI
  assert.equal(out.records[1]._sheetRow, 9);
});

test('column aliases resolve alternate spellings', () => {
  const csv = [
    'Game ID,Date,Opponent,H/A',
    'G01,9/15/2025,Central,Home',
  ].join('\n');
  const out = parseTab(csv, SCHEMAS.games);
  assert.equal(out.records[0].homeAway, 'Home');

  const alt = ['Stat ID,Game ID,Player ID,3PTM,3PTA', 'S1,G01,P1,2,5'].join('\n');
  const outAlt = parseTab(alt, SCHEMAS.statslog);
  assert.equal(outAlt.records[0].tpm, '2');
  assert.equal(outAlt.records[0].tpa, '5');
});

test('unrecognized columns are reported, not silently ignored', () => {
  const csv = ['Player ID,Full Name,Height', 'P1,John Smith,6-2'].join('\n');
  const out = parseTab(csv, SCHEMAS.players);
  assert.deepEqual(out.unknownColumns, ['Height']);
});

test('a missing header row is an explicit, actionable error', () => {
  const out = parseTab('nothing,useful\n1,2', SCHEMAS.players);
  assert.equal(out.records.length, 0);
  assert.match(out.error, /player id/i);
});

test('gviz URLs disable Google header folding', () => {
  // Without headers=0 Google merges the title rows into a header of its own.
  assert.match(gvizUrl('FILE', 'Players'), /headers=0/);
  assert.match(gvizUrl('FILE', 'Stats Log'), /sheet=Stats%20Log/);
});

test('published CSV URLs address a single tab by gid', () => {
  const url = pubCsvUrl('KEY', '123');
  assert.match(url, /\/d\/e\/KEY\/pub\?gid=123&single=true&output=csv/);
});

test('gviz is preferred over gid, and unconfigured strategies are omitted', () => {
  const both = endpointsFor({ fileId: 'F', pubKey: 'K' }, 'Players', '0');
  assert.equal(both.length, 2);
  assert.match(both[0].strategy, /gviz/);

  const pubOnly = endpointsFor({ fileId: '', pubKey: 'K' }, 'Players', '0');
  assert.equal(pubOnly.length, 1);
  assert.match(pubOnly[0].strategy, /published/);

  const noGid = endpointsFor({ fileId: '', pubKey: 'K' }, 'Players', '');
  assert.equal(noGid.length, 0);
});

/* ---------------------------------------------------------------- */
/* Required headers                                                  */
/* ---------------------------------------------------------------- */

test('a missing required column is reported by name', () => {
  // A silently absent FGA column would read as a season of missed shots, so
  // this has to surface rather than default to blank.
  const csv = [
    'Stat ID,Game ID,Player ID,Points,FGM',
    'S01,G01,P1,15,6',
  ].join('\n');
  const out = parseTab(csv, SCHEMAS.statslog);
  assert.ok(out.missing.includes('fga'), 'FGA is flagged as missing');
  assert.ok(out.missing.includes('rebounds'));
  assert.equal(out.error, null, 'the tab still parses — missing columns are a warning, not a failure');
  assert.equal(out.records.length, 1);
});

test('nothing is reported missing when every required column is present', () => {
  const header = 'Stat ID,Game ID,Player ID,Points,Rebounds,Assists,Steals,Blocks,Turnovers,FGM,FGA,3PM,3PA,FTM,FTA,Fouls,Notes';
  const out = parseTab(header + '\nS01,G01,P1,15,6,3,2,1,2,6,11,1,3,2,2,3,', SCHEMAS.statslog);
  assert.deepEqual(out.missing, []);
});

test('matched headers are reported with the spelling the sheet actually uses', () => {
  const out = parseTab('Game ID,Date,Opponent,H/A\nG01,9/15/2025,Central,Home', SCHEMAS.games);
  assert.equal(out.matched.homeAway, 'H/A');
  assert.equal(out.matched.gameId, 'Game ID');
});

test('optional score columns are absent without being reported missing', () => {
  const out = parseTab('Game ID,Date,Opponent,Home/Away\nG01,9/15/2025,Central,Home', SCHEMAS.games);
  assert.deepEqual(out.missing, []);
  assert.equal(out.matched.teamScore, undefined);
});

test('score columns are read when present', () => {
  const out = parseTab(
    'Game ID,Date,Opponent,Home/Away,Team Score,Opponent Score\nG01,9/15/2025,Central,Home,50,44',
    SCHEMAS.games,
  );
  assert.equal(out.records[0].teamScore, '50');
  assert.equal(out.records[0].oppScore, '44');
});

test('a header row that cannot be found reports every required column as missing', () => {
  const out = parseTab('nothing,useful\n1,2', SCHEMAS.statslog);
  assert.ok(out.missing.length > 10);
  assert.match(out.error, /stat id/i);
});
