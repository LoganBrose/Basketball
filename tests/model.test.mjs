import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toNumber, idMatches, parseSheetDate, normalizeHomeAway,
  isDNP, sanityCheck, buildDataset, gameSummaries, gamesForPlayers,
  summaryFor, selectedPoints, seasonRecord, scoreMismatches, compareGames,
  aggregate, pct, leaders, displayName, shortName, STAT_FIELDS,
} from '../assets/js/model.js';

const ROSTER = [
  { playerId: 'P1', fullName: 'John Smith', jersey: '12', position: 'PG', _sheetRow: 6 },
  { playerId: 'P2', fullName: 'Jane Doe', jersey: '7', position: 'SF', _sheetRow: 7 },
  { playerId: 'P3', fullName: 'Marcus Lee', jersey: '23', position: 'C', _sheetRow: 8 },
];

const SCHEDULE = [
  { gameId: 'G01', date: '9/15/2025', opponent: 'Central', homeAway: 'Home', _sheetRow: 6 },
  { gameId: 'G02', date: '2025-09-22', opponent: 'North', homeAway: 'Away', _sheetRow: 7 },
  { gameId: 'G03', date: '9/29/2025', opponent: 'South', homeAway: 'Home', _sheetRow: 8 },
];

/** A StatsLog row; omitted stats stay blank, which is how a DNP is expressed. */
function row(sheetRow, gameId, playerId, stats = {}) {
  const r = { _sheetRow: sheetRow, statId: 'S' + sheetRow, game: gameId, player: playerId, notes: '' };
  for (const f of STAT_FIELDS) r[f] = stats[f] == null ? '' : String(stats[f]);
  return r;
}

function build(stats, games = SCHEDULE, players = ROSTER) {
  const ds = buildDataset({ players, games, stats });
  return { ...ds, summaries: gameSummaries(ds.rows, [...ds.gameById.values()]) };
}

/* ---------------------------------------------------------------- */
/* Primitives                                                        */
/* ---------------------------------------------------------------- */

test('a blank stat cell is absent, not zero', () => {
  assert.equal(toNumber(''), null);
  assert.equal(toNumber('   '), null);
  assert.equal(toNumber('0'), 0);
  assert.equal(toNumber('14'), 14);
  assert.equal(toNumber('abc'), null);
});

test('IDs match case-insensitively and ignore leading zeros', () => {
  assert.equal(idMatches('P1', 'p1'), true);
  assert.equal(idMatches('07', '7'), true);
  assert.equal(idMatches('P1', 'P2'), false);
  assert.equal(idMatches('', 'P1'), false);
});

test('parses M/D/YYYY and YYYY-MM-DD', () => {
  assert.equal(parseSheetDate('9/15/2025').key, '2025-09-15');
  assert.equal(parseSheetDate('2025-09-22').key, '2025-09-22');
  assert.equal(parseSheetDate('09/05/2025').key, '2025-09-05');
});

test('the parsed day never shifts by a timezone', () => {
  // new Date("2025-09-15") is UTC midnight and renders as the 14th in the US.
  const local = new Date(parseSheetDate('2025-09-15').ms);
  assert.equal(local.getDate(), 15);
  assert.equal(local.getMonth(), 8);
});

test('rejects unparseable and impossible dates', () => {
  assert.equal(parseSheetDate(''), null);
  assert.equal(parseSheetDate('Sept 15'), null);
  assert.equal(parseSheetDate('13/01/2025'), null);
  assert.equal(parseSheetDate('2/30/2025'), null);
});

test('normalizes Home/Away spellings', () => {
  assert.equal(normalizeHomeAway('Home'), 'Home');
  assert.equal(normalizeHomeAway('away'), 'Away');
  assert.equal(normalizeHomeAway('H'), 'Home');
  assert.equal(normalizeHomeAway(''), '');
});

/* ---------------------------------------------------------------- */
/* Did not play                                                      */
/* ---------------------------------------------------------------- */

test('all stats blank means did not play', () => {
  const s = Object.fromEntries(STAT_FIELDS.map((f) => [f, null]));
  assert.equal(isDNP(s), true);
});

test('an explicit zero counts as having played', () => {
  const s = Object.fromEntries(STAT_FIELDS.map((f) => [f, null]));
  s.points = 0;
  assert.equal(isDNP(s), false);
});

/* ---------------------------------------------------------------- */
/* Sanity checks                                                     */
/* ---------------------------------------------------------------- */

const stats = (obj) => Object.fromEntries(STAT_FIELDS.map((f) => [f, obj[f] ?? null]));

test('flags makes exceeding attempts', () => {
  assert.ok(sanityCheck(stats({ fgm: 6, fga: 5, points: 12 })).includes('FGM > FGA'));
  assert.ok(sanityCheck(stats({ tpm: 3, tpa: 2, fgm: 3, points: 9 })).includes('3PM > 3PA'));
  assert.ok(sanityCheck(stats({ ftm: 3, fta: 2, points: 3 })).includes('FTM > FTA'));
  assert.ok(sanityCheck(stats({ tpm: 4, tpa: 6, fgm: 2, fga: 8, points: 8 })).includes('3PM > FGM'));
});

test('flags points that do not reconcile with shooting', () => {
  const flags = sanityCheck(stats({ points: 20, fgm: 5, fga: 9, tpm: 1, tpa: 3, ftm: 2, fta: 2 }));
  assert.ok(flags.some((f) => f.startsWith('PTS')));
});

test('accepts points that reconcile (FGM includes the three)', () => {
  assert.deepEqual(sanityCheck(stats({ points: 15, fgm: 6, fga: 11, tpm: 1, tpa: 3, ftm: 2, fta: 2 })), []);
});

test('the points check stays silent when no shooting was entered', () => {
  assert.deepEqual(sanityCheck(stats({ points: 14, rebounds: 6 })), []);
});

test('the points check fires when any one shooting column is entered', () => {
  for (const field of ['fgm', 'tpm', 'ftm']) {
    const flags = sanityCheck(stats({ points: 14, [field]: 1 }));
    assert.ok(flags.some((f) => f.startsWith('PTS')), `expected a PTS flag when ${field} is present`);
  }
});

/* ---------------------------------------------------------------- */
/* Dataset + dedupe                                                  */
/* ---------------------------------------------------------------- */

test('joins opponent, home/away and date by ID', () => {
  const { rows } = build([row(10, 'G02', 'P2', { points: 8 })]);
  assert.equal(rows[0].opponent, 'North');
  assert.equal(rows[0].homeAway, 'Away');
  assert.equal(rows[0].date.key, '2025-09-22');
});

test('a later sheet row supersedes an earlier one for the same game and player', () => {
  const { rows, issues } = build([
    row(10, 'G01', 'P1', { points: 10 }),
    row(20, 'G01', 'P1', { points: 14 }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stats.points, 14);
  assert.equal(issues.superseded[0].sheetRow, 10);
  assert.equal(issues.superseded[0].supersededBy, 20);
});

test('row order decides regardless of the order rows arrive in', () => {
  const { rows } = build([
    row(20, 'G01', 'P1', { points: 14 }),
    row(10, 'G01', 'P1', { points: 10 }),
  ]);
  assert.equal(rows[0].stats.points, 14);
});

test('the same Stat ID on different players is not a duplicate', () => {
  // Stat ID is a label, not an identity — (Game, Player) is the identity.
  const a = { ...row(10, 'G01', 'P1', { points: 10 }), statId: 'S1' };
  const b = { ...row(11, 'G01', 'P2', { points: 8 }), statId: 'S1' };
  const { rows, issues } = build([a, b]);
  assert.equal(rows.length, 2);
  assert.equal(issues.superseded.length, 0);
});

test('unresolvable rows are reported rather than dropped silently', () => {
  const { rows, issues } = build([
    row(10, 'G99', 'P1', { points: 5 }),
    row(11, 'G01', 'P99', { points: 5 }),
  ]);
  assert.equal(rows.length, 0);
  assert.equal(issues.unmatchedGames.length, 1);
  assert.equal(issues.unmatchedPlayers.length, 1);
});

/* ---------------------------------------------------------------- */
/* Game ordering                                                     */
/* ---------------------------------------------------------------- */

test('games sort newest first, ties by later sheet row, undated last', () => {
  const a = { date: { ms: 100 }, sheetRow: 1 };
  const b = { date: { ms: 200 }, sheetRow: 2 };
  const undated = { date: null, sheetRow: 3 };
  const tieEarly = { date: { ms: 200 }, sheetRow: 5 };

  assert.deepEqual([a, b, undated].sort(compareGames), [b, a, undated]);
  // Same date: the later sheet row comes first.
  assert.deepEqual([b, tieEarly].sort(compareGames), [tieEarly, b]);
  // Undated sinks rather than sorting as epoch zero.
  assert.deepEqual([undated, a].sort(compareGames), [a, undated]);
});

test('gameSummaries excludes games with no stat rows and records who played', () => {
  const { summaries } = build([
    row(10, 'G01', 'P1', { points: 10 }),
    row(11, 'G01', 'P2'),            // dressed, did not play
  ]);
  assert.deepEqual(summaries.map((s) => s.gameId), ['G01']);
  assert.deepEqual([...summaries[0].played], ['P1']);
  assert.equal(summaries[0].teamPoints, 10);
});

/* ---------------------------------------------------------------- */
/* Any / All                                                         */
/* ---------------------------------------------------------------- */

const THREE_GAMES = [
  row(10, 'G01', 'P1', { points: 10 }),
  row(11, 'G01', 'P2', { points: 8 }),
  row(12, 'G02', 'P1', { points: 12 }),
  row(13, 'G02', 'P2'),               // DNP
  row(14, 'G03', 'P2', { points: 6 }),
];

test('All means every selected player played; Any means at least one did', () => {
  const { summaries } = build(THREE_GAMES);

  assert.deepEqual(gamesForPlayers(summaries, ['P1', 'P2'], 'all').map((s) => s.gameId), ['G01']);
  assert.deepEqual(gamesForPlayers(summaries, ['P1', 'P2'], 'any').map((s) => s.gameId), ['G03', 'G02', 'G01']);
});

test('a DNP does not count as playing for either mode', () => {
  const { summaries } = build(THREE_GAMES);
  // P2 has a row in G02 but did not play, so G02 is out under All.
  assert.ok(!gamesForPlayers(summaries, ['P1', 'P2'], 'all').some((s) => s.gameId === 'G02'));
  assert.deepEqual(gamesForPlayers(summaries, ['P2'], 'all').map((s) => s.gameId), ['G03', 'G01']);
});

test('no selection means no narrowing', () => {
  const { summaries } = build(THREE_GAMES);
  assert.equal(gamesForPlayers(summaries, [], 'all').length, summaries.length);
  assert.equal(gamesForPlayers(summaries, null, 'any').length, summaries.length);
});

/* ---------------------------------------------------------------- */
/* Summary                                                           */
/* ---------------------------------------------------------------- */

test('averages divide by distinct games shown, not by player rows', () => {
  // Two players across two games is four rows. Dividing by four would halve
  // every average.
  const { summaries } = build([
    row(10, 'G01', 'P1', { points: 10 }),
    row(11, 'G01', 'P2', { points: 8 }),
    row(12, 'G02', 'P1', { points: 12 }),
    row(13, 'G02', 'P2', { points: 6 }),
  ]);
  const s = summaryFor(summaries, ['P1', 'P2']);
  assert.equal(s.rowCount, 4);
  assert.equal(s.gp, 2);
  assert.equal(s.totals.points, 36);
  assert.equal(s.averages.points, 18);
});

test('an empty selection summarises the whole team', () => {
  const { summaries } = build(THREE_GAMES);
  const team = summaryFor(summaries, []);
  assert.equal(team.totals.points, 36);
  assert.equal(team.gp, 3);
});

test('a filtered summary counts only the selected players rows', () => {
  const { summaries } = build(THREE_GAMES);
  const justP1 = summaryFor(gamesForPlayers(summaries, ['P1'], 'all'), ['P1']);
  assert.equal(justP1.totals.points, 22);
  assert.equal(justP1.gp, 2);
  assert.equal(justP1.averages.points, 11);
});

test('a game whose only rows are DNPs is listed but is not a game played', () => {
  const { summaries } = build([
    row(10, 'G01', 'P1', { points: 10 }),
    row(11, 'G02', 'P1'),
    row(12, 'G02', 'P2'),
  ]);
  assert.equal(summaries.length, 2, 'the DNP-only game still appears');
  const s = summaryFor(summaries, []);
  assert.equal(s.games, 2);
  assert.equal(s.gp, 1, 'but it does not count toward games played');
  assert.equal(s.averages.points, 10, 'and it does not dilute the average');
});

test('percentages come from summed makes over summed attempts', () => {
  // Averaging per-game percentages would give (100% + 25%) / 2 = 62.5%.
  // The honest number is 3/6 = 50%.
  const { summaries } = build([
    row(10, 'G01', 'P1', { points: 4, fgm: 2, fga: 2 }),
    row(11, 'G02', 'P1', { points: 2, fgm: 1, fga: 4 }),
  ]);
  const s = summaryFor(summaries, ['P1']);
  assert.equal(s.fgPct, 0.5);
});

test('percentages are blank rather than zero when nothing was attempted', () => {
  const { summaries } = build([row(10, 'G01', 'P1', { points: 0 })]);
  const s = summaryFor(summaries, ['P1']);
  assert.equal(s.fgPct, null);
  assert.equal(s.tpPct, null);
  assert.equal(s.ftPct, null);
  assert.equal(pct(0, 0), null);
  assert.equal(pct(6, 11), 6 / 11);
});

test('selectedPoints is null with no selection and sums the chosen players otherwise', () => {
  const { summaries } = build(THREE_GAMES);
  const g01 = summaries.find((s) => s.gameId === 'G01');
  assert.equal(selectedPoints(g01, []), null);
  assert.equal(selectedPoints(g01, ['P1']), 10);
  assert.equal(selectedPoints(g01, ['P1', 'P2']), 18);
});

/* ---------------------------------------------------------------- */
/* Season record                                                     */
/* ---------------------------------------------------------------- */

test('record counts only games where both scores are filled in', () => {
  const record = seasonRecord([
    { gameId: 'G01', teamScore: '50', oppScore: '44' },
    { gameId: 'G02', teamScore: '40', oppScore: '48' },
    { gameId: 'G03', teamScore: '61', oppScore: '' },   // half-entered: ignored
    { gameId: 'G04', teamScore: '', oppScore: '' },     // unscored
  ]);
  assert.equal(record.wins, 1);
  assert.equal(record.losses, 1);
  assert.equal(record.scored, 2);
  assert.equal(record.unscored, 2);
  assert.equal(record.margin, (6 + -8) / 2);
});

test('record includes scored games that have no stat rows at all', () => {
  // A result is a result whether or not anyone logged a box score.
  const record = seasonRecord([{ gameId: 'G09', teamScore: '55', oppScore: '50' }]);
  assert.equal(record.wins, 1);
  assert.equal(record.scored, 1);
});

test('record is null when no game has both scores', () => {
  assert.equal(seasonRecord([{ gameId: 'G01', teamScore: '', oppScore: '' }]), null);
  assert.equal(seasonRecord([]), null);
});

test('a tie is counted separately rather than as a loss', () => {
  const record = seasonRecord([{ gameId: 'G01', teamScore: '50', oppScore: '50' }]);
  assert.equal(record.ties, 1);
  assert.equal(record.wins, 0);
  assert.equal(record.losses, 0);
});

/* ---------------------------------------------------------------- */
/* Score mismatches                                                  */
/* ---------------------------------------------------------------- */

test('a Team Score that disagrees with the logged points is reported, not corrected', () => {
  const games = [{ gameId: 'G01', date: '9/15/2025', opponent: 'Central', homeAway: 'Home', teamScore: '55', _sheetRow: 6 }];
  const { summaries } = build([row(10, 'G01', 'P1', { points: 10 })], games);

  const out = scoreMismatches(summaries);
  assert.equal(out.length, 1);
  assert.equal(out[0].recorded, 55);
  assert.equal(out[0].logged, 10);
  // Neither number is altered.
  assert.equal(summaries[0].teamPoints, 10);
});

test('no mismatch is reported when Team Score is blank or agrees', () => {
  const agree = [{ gameId: 'G01', date: '9/15/2025', opponent: 'C', homeAway: 'Home', teamScore: '10', _sheetRow: 6 }];
  assert.deepEqual(scoreMismatches(build([row(10, 'G01', 'P1', { points: 10 })], agree).summaries), []);

  const blank = [{ gameId: 'G01', date: '9/15/2025', opponent: 'C', homeAway: 'Home', teamScore: '', _sheetRow: 6 }];
  assert.deepEqual(scoreMismatches(build([row(10, 'G01', 'P1', { points: 10 })], blank).summaries), []);
});

/* ---------------------------------------------------------------- */
/* Misc                                                              */
/* ---------------------------------------------------------------- */

test('aggregate counts games played as non-DNP rows', () => {
  const { rows } = build([
    row(10, 'G01', 'P1', { points: 20 }),
    row(11, 'G02', 'P1'),
  ]);
  const agg = aggregate(rows);
  assert.equal(agg.games, 2);
  assert.equal(agg.gp, 1);
  assert.equal(agg.averages.points, 20);
});

test('leaders rank by total', () => {
  const { rows } = build([
    row(10, 'G01', 'P1', { points: 10 }),
    row(11, 'G01', 'P2', { points: 22 }),
  ]);
  const top = leaders(rows, ROSTER, 'points');
  assert.equal(top[0].playerId, 'P2');
  assert.equal(top[0].total, 22);
});

test('nameDisplay controls what reaches a public page', () => {
  const p = ROSTER[0];
  assert.equal(displayName(p, 'full'), 'John Smith');
  assert.equal(displayName(p, 'jersey'), '#12');
  assert.equal(displayName(p, 'initials'), 'J.S.');
  assert.equal(displayName(null, 'full'), '—');
});

test('shortName keeps a name compact without losing who it is', () => {
  assert.equal(shortName(ROSTER[0], 'full'), 'John S.');
  assert.equal(shortName(ROSTER[0], 'jersey'), '#12');
  assert.equal(shortName({ playerId: 'P9', fullName: 'Cher' }, 'full'), 'Cher');
});
