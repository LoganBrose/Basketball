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

/** A Form responses tab: headers on row 1, no preamble at all. */
const RESPONSES_CSV = [
  'Timestamp,Game,Player,Points,Rebounds,Assists,Steals,Blocks,Turnovers,FGM,FGA,3PM,3PA,FTM,FTA,Fouls,Notes',
  '9/15/2025 19:04:11,G01 - vs Central,P1 - John Smith,14,6,3,2,1,2,6,11,1,3,1,2,3,',
].join('\n');

test('finds the header row beneath title, legend and blank rows', () => {
  const rows = parseCSV(PLAYERS_CSV);
  assert.equal(findHeaderRow(rows, 'player id'), 4);
});

test('finds a header row that is row 1', () => {
  const rows = parseCSV(RESPONSES_CSV);
  assert.equal(findHeaderRow(rows, 'player'), 0);
});

test('header detection survives a legend line being added or removed', () => {
  // The whole point of scanning: editing the legend shifts the offset.
  const shorter = PLAYERS_CSV.split('\n').filter((l) => !l.startsWith('"Example row')).join('\n');
  assert.equal(findHeaderRow(parseCSV(shorter), 'player id'), 3);
});

test('the key header is matched exactly, not as a substring', () => {
  // The Form tab's key is "Player". The Players tab has "Player ID" and
  // "Player Name" — neither may satisfy it, or the wrong tab would parse.
  const rows = parseCSV(PLAYERS_CSV);
  assert.equal(findHeaderRow(rows, 'player'), -1);
});

test('each tab declares its own key header', () => {
  assert.equal(SCHEMAS.players.key, 'player id');
  assert.equal(SCHEMAS.games.key, 'game id');
  assert.equal(SCHEMAS.responses.key, 'player');
  assert.equal(SCHEMAS.statslog.key, 'stat id');
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

test('the Form key does not match the StatsLog tab, and vice versa', () => {
  // Each source must only ever parse its own tab.
  assert.equal(findHeaderRow(parseCSV(STATSLOG_CSV), SCHEMAS.responses.key), -1);
  assert.equal(findHeaderRow(parseCSV(RESPONSES_CSV), SCHEMAS.statslog.key), -1);
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

test('parseTab maps Form response columns onto canonical stat fields', () => {
  const out = parseTab(RESPONSES_CSV, SCHEMAS.responses);
  assert.equal(out.error, null);
  const r = out.records[0];
  assert.equal(r.player, 'P1 - John Smith');
  assert.equal(r.game, 'G01 - vs Central');
  assert.equal(r.points, '14');
  assert.equal(r.tpm, '1');
  assert.equal(r.tpa, '3');
});

test('column aliases resolve alternate spellings', () => {
  const csv = [
    'Game ID,Date,Opponent,H/A',
    'G01,9/15/2025,Central,Home',
  ].join('\n');
  const out = parseTab(csv, SCHEMAS.games);
  assert.equal(out.records[0].homeAway, 'Home');

  const alt = ['Timestamp,Game,Player,3PTM,3PTA', 'x,G01,P1,2,5'].join('\n');
  const outAlt = parseTab(alt, SCHEMAS.responses);
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
  assert.match(gvizUrl('FILE', 'Form Responses 1'), /sheet=Form%20Responses%201/);
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
