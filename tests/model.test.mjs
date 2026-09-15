import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toNumber, parseIdToken, resolvePlayerToken, resolveGameToken, parseSheetDate,
  isDNP, sanityCheck, buildDataset, aggregate, pct, displayName, normalizeHomeAway,
  STAT_FIELDS,
} from '../assets/js/model.js';

const ROSTER = [
  { playerId: 'P1', fullName: 'John Smith', jersey: '12', position: 'PG' },
  { playerId: 'P2', fullName: 'Jane Doe', jersey: '7', position: 'SF' },
];

const SCHEDULE = [
  { gameId: 'G01', date: '9/15/2025', opponent: 'Central', homeAway: 'Home' },
  { gameId: 'G02', date: '2025-09-22', opponent: 'North', homeAway: 'Away' },
];

/** Build a Form response record; omitted stats stay blank. */
function response(sheetRow, game, player, stats = {}) {
  const r = { _sheetRow: sheetRow, game, player, notes: '' };
  for (const f of STAT_FIELDS) r[f] = stats[f] == null ? '' : String(stats[f]);
  return r;
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

/* ---------------------------------------------------------------- */
/* Dropdown token parsing                                            */
/* ---------------------------------------------------------------- */

test('parses the ID token across en dash, em dash and hyphen', () => {
  assert.equal(parseIdToken('12 – John Smith'), '12');
  assert.equal(parseIdToken('12 — John Smith'), '12');
  assert.equal(parseIdToken('12 - John Smith'), '12');
  assert.equal(parseIdToken('G05 – vs Central (9/15)'), 'G05');
});

test('a bare ID with no separator still parses', () => {
  assert.equal(parseIdToken('P1'), 'P1');
  assert.equal(parseIdToken('  G02  '), 'G02');
  assert.equal(parseIdToken(''), '');
});

test('a hyphenated surname does not split the token early', () => {
  // The separator needs surrounding spaces; "Mary-Jane" must not match.
  assert.equal(parseIdToken('P3 - Mary-Jane Smith'), 'P3');
});

/* ---------------------------------------------------------------- */
/* Token resolution                                                  */
/* ---------------------------------------------------------------- */

test('resolves by Player ID', () => {
  const r = resolvePlayerToken('P1', ROSTER);
  assert.equal(r.playerId, 'P1');
  assert.equal(r.matchedBy, 'id');
});

test('resolves by jersey number when the token is not a Player ID', () => {
  // The dropdown format the coach chose leads with the jersey: "12 - John Smith".
  const r = resolvePlayerToken('12', ROSTER);
  assert.equal(r.playerId, 'P1');
  assert.equal(r.matchedBy, 'jersey');
});

test('jersey matching ignores leading zeros', () => {
  assert.equal(resolvePlayerToken('07', ROSTER).playerId, 'P2');
});

test('a token matching one player ID and another player jersey is flagged, not resolved', () => {
  // P1's ID is literally "12" while P2 wears #12: precedence would silently
  // pick one of two real people, so the site refuses and reports instead.
  const roster = [
    { playerId: '12', fullName: 'John Smith', jersey: '4' },
    { playerId: 'P2', fullName: 'Jane Doe', jersey: '12' },
  ];
  const r = resolvePlayerToken('12', roster);
  assert.equal(r.playerId, null);
  assert.match(r.issue, /John Smith/);
  assert.match(r.issue, /Jane Doe/);
});

test('an ID match is not flagged when the same player also wears that number', () => {
  const roster = [{ playerId: '12', fullName: 'John Smith', jersey: '12' }];
  const r = resolvePlayerToken('12', roster);
  assert.equal(r.playerId, '12');
  assert.equal(r.issue, null);
});

test('a jersey worn by two players is flagged', () => {
  const roster = [
    { playerId: 'P1', fullName: 'John Smith', jersey: '12' },
    { playerId: 'P2', fullName: 'Jane Doe', jersey: '12' },
  ];
  const r = resolvePlayerToken('12', roster);
  assert.equal(r.playerId, null);
  assert.match(r.issue, /worn by/);
});

test('duplicate Player IDs are flagged', () => {
  const roster = [
    { playerId: 'P1', fullName: 'John Smith', jersey: '12' },
    { playerId: 'P1', fullName: 'Jim Brown', jersey: '5' },
  ];
  assert.match(resolvePlayerToken('P1', roster).issue, /must be unique/);
});

test('an unknown token reports which value failed', () => {
  assert.match(resolvePlayerToken('P99', ROSTER).issue, /P99/);
  assert.match(resolveGameToken('G99', SCHEDULE).issue, /G99/);
});

test('resolves a game by ID', () => {
  assert.equal(resolveGameToken('G02', SCHEDULE).gameId, 'G02');
});

/* ---------------------------------------------------------------- */
/* Dates                                                             */
/* ---------------------------------------------------------------- */

test('parses M/D/YYYY', () => {
  const d = parseSheetDate('9/15/2025');
  assert.equal(d.key, '2025-09-15');
  assert.equal(d.month, 9);
  assert.equal(d.day, 15);
});

test('parses YYYY-MM-DD', () => {
  const d = parseSheetDate('2025-09-22');
  assert.equal(d.key, '2025-09-22');
  assert.equal(d.day, 22);
});

test('parses zero-padded M/D/YYYY', () => {
  assert.equal(parseSheetDate('09/05/2025').key, '2025-09-05');
});

test('the parsed day never shifts by a timezone', () => {
  // new Date("2025-09-15") is UTC midnight and renders as the 14th in the US.
  const d = parseSheetDate('2025-09-15');
  const local = new Date(d.ms);
  assert.equal(local.getDate(), 15);
  assert.equal(local.getMonth(), 8);
});

test('rejects unparseable and impossible dates', () => {
  assert.equal(parseSheetDate(''), null);
  assert.equal(parseSheetDate('Sept 15'), null);
  assert.equal(parseSheetDate('13/01/2025'), null);
  assert.equal(parseSheetDate('2/30/2025'), null);
});

/* ---------------------------------------------------------------- */
/* Did not play                                                      */
/* ---------------------------------------------------------------- */

test('all stats blank means did not play', () => {
  const stats = {};
  for (const f of STAT_FIELDS) stats[f] = null;
  assert.equal(isDNP(stats), true);
});

test('an explicit zero counts as having played', () => {
  const stats = {};
  for (const f of STAT_FIELDS) stats[f] = null;
  stats.points = 0;
  assert.equal(isDNP(stats), false);
});

/* ---------------------------------------------------------------- */
/* Sanity checks                                                     */
/* ---------------------------------------------------------------- */

function stats(obj) {
  const s = {};
  for (const f of STAT_FIELDS) s[f] = obj[f] == null ? null : obj[f];
  return s;
}

test('flags makes exceeding attempts', () => {
  assert.ok(sanityCheck(stats({ fgm: 6, fga: 5, points: 12 })).includes('FGM > FGA'));
  assert.ok(sanityCheck(stats({ tpm: 3, tpa: 2, fgm: 3, points: 9 })).includes('3PM > 3PA'));
  assert.ok(sanityCheck(stats({ ftm: 3, fta: 2, points: 3 })).includes('FTM > FTA'));
});

test('flags more threes than field goals', () => {
  assert.ok(sanityCheck(stats({ tpm: 4, tpa: 6, fgm: 2, fga: 8, points: 8 })).includes('3PM > FGM'));
});

test('flags points that do not reconcile with shooting', () => {
  // 2x5 + 1 + 2 = 13, not 20.
  const flags = sanityCheck(stats({ points: 20, fgm: 5, fga: 9, tpm: 1, tpa: 3, ftm: 2, fta: 2 }));
  assert.ok(flags.some((f) => f.startsWith('PTS')));
});

test('accepts points that reconcile', () => {
  // FGM includes the three: 2x6 + 1 + 2 = 15.
  assert.deepEqual(sanityCheck(stats({ points: 15, fgm: 6, fga: 11, tpm: 1, tpa: 3, ftm: 2, fta: 2 })), []);
});

test('the points check stays silent when no shooting was entered', () => {
  // A points-only row has nothing to reconcile against and must not be flagged.
  assert.deepEqual(sanityCheck(stats({ points: 14, rebounds: 6 })), []);
});

test('the points check fires when any one shooting column is entered', () => {
  for (const field of ['fgm', 'tpm', 'ftm']) {
    const flags = sanityCheck(stats({ points: 14, [field]: 1 }));
    assert.ok(flags.some((f) => f.startsWith('PTS')), `expected a PTS flag when ${field} is present`);
  }
});

test('a zero in a shooting column still counts as entered', () => {
  const flags = sanityCheck(stats({ points: 14, fgm: 0 }));
  assert.ok(flags.some((f) => f.startsWith('PTS')));
});

/* ---------------------------------------------------------------- */
/* Dedupe                                                            */
/* ---------------------------------------------------------------- */

test('a resubmission wins because its sheet row is later', () => {
  const { rows, issues } = buildDataset({
    players: ROSTER,
    games: SCHEDULE,
    responses: [
      response(2, 'G01', 'P1', { points: 10, rebounds: 2 }),
      response(9, 'G01', 'P1', { points: 14, rebounds: 6 }),
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stats.points, 14);
  assert.equal(issues.superseded.length, 1);
  assert.equal(issues.superseded[0].sheetRow, 2);
  assert.equal(issues.superseded[0].supersededBy, 9);
});

test('row order wins regardless of the order rows arrive in', () => {
  const { rows } = buildDataset({
    players: ROSTER,
    games: SCHEDULE,
    responses: [
      response(9, 'G01', 'P1', { points: 14 }),
      response(2, 'G01', 'P1', { points: 10 }),
    ],
  });
  assert.equal(rows[0].stats.points, 14);
});

test('Timestamp is never consulted for ordering', () => {
  // Deliberately out of order: the earlier sheet row carries the later
  // timestamp. Row position must still decide.
  const early = { ...response(2, 'G01', 'P1', { points: 10 }), timestamp: '12/31/2025 23:59:59' };
  const later = { ...response(9, 'G01', 'P1', { points: 14 }), timestamp: '1/1/2025 00:00:01' };
  const { rows } = buildDataset({ players: ROSTER, games: SCHEDULE, responses: [early, later] });
  assert.equal(rows[0].stats.points, 14);
});

test('different players in the same game are not deduped together', () => {
  const { rows } = buildDataset({
    players: ROSTER,
    games: SCHEDULE,
    responses: [
      response(2, 'G01', 'P1', { points: 10 }),
      response(3, 'G01', 'P2', { points: 8 }),
    ],
  });
  assert.equal(rows.length, 2);
});

/* ---------------------------------------------------------------- */
/* Dataset joins and issue reporting                                 */
/* ---------------------------------------------------------------- */

test('joins home/away, opponent and date from the Games tab', () => {
  const { rows } = buildDataset({
    players: ROSTER,
    games: SCHEDULE,
    responses: [response(2, 'G02 - at North', '7 - Jane Doe', { points: 8 })],
  });
  assert.equal(rows[0].homeAway, 'Away');
  assert.equal(rows[0].opponent, 'North');
  assert.equal(rows[0].date.key, '2025-09-22');
  assert.equal(rows[0].playerId, 'P2');
});

test('unresolvable rows are reported rather than dropped silently', () => {
  const { rows, issues } = buildDataset({
    players: ROSTER,
    games: SCHEDULE,
    responses: [
      response(2, 'G99 - Unknown', 'P1 - John Smith', { points: 5 }),
      response(3, 'G01 - vs Central', 'P99 - Nobody', { points: 5 }),
    ],
  });
  assert.equal(rows.length, 0);
  assert.equal(issues.unmatchedGames.length, 1);
  assert.equal(issues.unmatchedPlayers.length, 1);
  assert.equal(issues.unmatchedGames[0].sheetRow, 2);
});

test('an unparseable game date is reported', () => {
  const { issues } = buildDataset({
    players: ROSTER,
    games: [{ gameId: 'G03', date: 'Sept 15', opponent: 'South', homeAway: 'Home' }],
    responses: [],
  });
  assert.equal(issues.invalidDates.length, 1);
  assert.equal(issues.invalidDates[0].gameId, 'G03');
});

test('sanity flags name the player and game but keep the row', () => {
  const { rows, issues } = buildDataset({
    players: ROSTER,
    games: SCHEDULE,
    responses: [response(2, 'G01', 'P1', { points: 20, fgm: 5, fga: 9 })],
  });
  assert.equal(rows.length, 1);
  assert.equal(issues.sanityFlags.length, 1);
  assert.equal(issues.sanityFlags[0].player, 'John Smith');
  assert.equal(issues.sanityFlags[0].game, 'G01');
});

test('a did-not-play row is never sanity-flagged', () => {
  const { rows, issues } = buildDataset({
    players: ROSTER, games: SCHEDULE, responses: [response(2, 'G01', 'P1')],
  });
  assert.equal(rows[0].dnp, true);
  assert.equal(issues.sanityFlags.length, 0);
});

/* ---------------------------------------------------------------- */
/* Aggregation                                                       */
/* ---------------------------------------------------------------- */

test('averages divide by games played, not by row count', () => {
  const { rows } = buildDataset({
    players: ROSTER,
    games: SCHEDULE,
    responses: [
      response(2, 'G01', 'P1', { points: 20 }),
      response(3, 'G02', 'P1'), // did not play
    ],
  });
  const agg = aggregate(rows);
  assert.equal(agg.games, 2);
  assert.equal(agg.gp, 1);
  assert.equal(agg.totals.points, 20);
  assert.equal(agg.averages.points, 20); // not 10
});

test('a scoreless appearance does count toward games played', () => {
  const { rows } = buildDataset({
    players: ROSTER,
    games: SCHEDULE,
    responses: [
      response(2, 'G01', 'P1', { points: 20 }),
      response(3, 'G02', 'P1', { points: 0 }),
    ],
  });
  const agg = aggregate(rows);
  assert.equal(agg.gp, 2);
  assert.equal(agg.averages.points, 10);
});

test('percentages are blank rather than zero when nothing was attempted', () => {
  assert.equal(pct(0, 0), null);
  assert.equal(pct(3, 0), null);
  assert.equal(pct(6, 11), 6 / 11);

  const agg = aggregate([{ dnp: false, stats: Object.fromEntries(STAT_FIELDS.map((f) => [f, 0])) }]);
  assert.equal(agg.fgPct, null);
  assert.equal(agg.tpPct, null);
  assert.equal(agg.ftPct, null);
});

test('aggregating no rows yields zero games played and no averages', () => {
  const agg = aggregate([]);
  assert.equal(agg.gp, 0);
  assert.equal(agg.averages.points, null);
});

/* ---------------------------------------------------------------- */
/* Display                                                           */
/* ---------------------------------------------------------------- */

test('normalizes Home/Away spellings', () => {
  assert.equal(normalizeHomeAway('Home'), 'Home');
  assert.equal(normalizeHomeAway('away'), 'Away');
  assert.equal(normalizeHomeAway('H'), 'Home');
  assert.equal(normalizeHomeAway(''), '');
});

test('nameDisplay controls what reaches a public page', () => {
  const p = ROSTER[0];
  assert.equal(displayName(p, 'full'), 'John Smith');
  assert.equal(displayName(p, 'jersey'), '#12');
  assert.equal(displayName(p, 'initials'), 'J.S.');
  assert.equal(displayName(null, 'full'), '—');
});

test('jersey mode falls back to initials when no number is on file', () => {
  assert.equal(displayName({ playerId: 'P9', fullName: 'Sam Lee', jersey: '' }, 'jersey'), 'S.L.');
});
