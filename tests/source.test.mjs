/**
 * The Apps Script data source, and the promise that it is not a second parser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTab, parseRows, SCHEMAS } from '../assets/js/sheets.js';
import { loadCodeGs, tabFor } from './helpers/apps-script.mjs';

/* ---------------------------------------------------------------- */
/* One parser, two sources                                           */
/* ---------------------------------------------------------------- */

/** A tab exactly as the sheet holds it: title, legend, blank, header, rows. */
const PLAYERS_ROWS = [
  ['Roster', '', ''],
  ['One row per player. IDs must be unique.', '', ''],
  ['', '', ''],
  ['Player ID', 'Full Name', 'Jersey Number'],
  ['EX1', 'Example Player', '00'],
  ['P1', 'John Smith', '12'],
  ['P2', 'Casey Jones', '4'],
  ['', '', ''],
];

const toCsv = (rows) => rows
  .map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','))
  .join('\n');

test('the Apps Script path and the CSV path produce identical records', () => {
  // This is the whole argument for parseRows existing. If these ever diverge,
  // the two sources have grown separate rules about what a header row is.
  const viaCsv = parseTab(toCsv(PLAYERS_ROWS), SCHEMAS.players);
  const viaScript = parseRows(PLAYERS_ROWS, SCHEMAS.players);

  assert.deepEqual(viaScript, viaCsv);
});

test('the shared parser still finds the header below the legend rows', () => {
  const parsed = parseRows(PLAYERS_ROWS, SCHEMAS.players);
  assert.equal(parsed.headerRow, 3);
  assert.deepEqual(parsed.records.map((r) => r.fullName), ['John Smith', 'Casey Jones']);
  assert.equal(parsed.skipped, 1, 'the EX row is skipped, the blank row is padding');
  assert.equal(parsed.error, null);
});

test('a moved header row is found by content, from either source', () => {
  // Editing a legend line shifts the offset; neither source may hardcode it.
  const shifted = [['Roster', '', ''], ['', '', ''], ...PLAYERS_ROWS.slice(3)];
  assert.equal(parseRows(shifted, SCHEMAS.players).headerRow, 2);
  assert.deepEqual(
    parseRows(shifted, SCHEMAS.players).records,
    parseTab(toCsv(shifted), SCHEMAS.players).records,
  );
});

test('a missing key column is reported the same way by both', () => {
  const broken = [['Player ID is misspelled below', ''], ['PlayerID', 'Full Name'], ['P1', 'X']];
  assert.deepEqual(parseRows(broken, SCHEMAS.players), parseTab(toCsv(broken), SCHEMAS.players));
  assert.match(parseRows(broken, SCHEMAS.players).error, /No header row found/);
});

/* ---------------------------------------------------------------- */
/* Which token opens which tab                                       */
/* ---------------------------------------------------------------- */

function withStats() {
  const ctx = loadCodeGs();
  ctx.sheets.StatsLog = tabFor([['Stat ID', 'Game ID', 'Player ID'], ['S1', 'G1', 'P1']]);
  ctx.sheets.Games = tabFor([['Game ID', 'Date'], ['G1', '9/15/2026']]);
  ctx.sheets.Players = tabFor(PLAYERS_ROWS);
  return ctx;
}

const siteToken = (ctx) => ctx.fns.handleSignIn({ name: 'Casey', password: 'team-pw' }).token;
const adminToken = (ctx) => ctx.fns.handleAdmin({ name: 'Logan Brose', password: 'admin-pw' }).token;

test('a site token opens Players but not StatsLog', () => {
  // The lineup selector needs names; the numbers are not its business.
  const ctx = withStats();
  const token = siteToken(ctx);

  assert.equal(ctx.fns.handleData({ token, tabs: ['Players'] }).ok, true);
  assert.deepEqual(ctx.fns.handleData({ token, tabs: ['StatsLog'] }), { ok: false, reason: 'auth' });
  assert.deepEqual(ctx.fns.handleData({ token, tabs: ['Games'] }), { ok: false, reason: 'auth' });
});

test('an admin token opens everything', () => {
  const ctx = withStats();
  const res = ctx.fns.handleData({ token: adminToken(ctx), tabs: ['StatsLog', 'Players', 'Games'] });

  assert.equal(res.ok, true);
  assert.deepEqual(Object.keys(res.tabs).sort(), ['Games', 'Players', 'StatsLog']);
  assert.deepEqual(res.tabs.Players, PLAYERS_ROWS);
});

test('a mixed request is refused whole rather than answered in part', () => {
  // Handing back only the roster would let a page render an empty season as
  // though it were a real one.
  const ctx = withStats();
  const res = ctx.fns.handleData({ token: siteToken(ctx), tabs: ['Players', 'StatsLog'] });

  assert.deepEqual(res, { ok: false, reason: 'auth' });
  assert.equal(res.tabs, undefined, 'no partial answer leaks out');
});

test('no token, a junk token or an expired one all read as auth', () => {
  const ctx = withStats();
  for (const token of ['', undefined, 'garbage', ctx.fns.makeToken('site', 'X', Date.now() - 1)]) {
    assert.deepEqual(ctx.fns.handleData({ token, tabs: ['Players'] }), { ok: false, reason: 'auth' });
  }
});

test('an unknown tab name is a bad request, not an auth failure', () => {
  // Otherwise a typo in the site would look like a permissions problem.
  const ctx = withStats();
  assert.deepEqual(
    ctx.fns.handleData({ token: adminToken(ctx), tabs: ['Secrets'] }),
    { ok: false, reason: 'bad_request' },
  );
  assert.deepEqual(
    ctx.fns.handleData({ token: adminToken(ctx), tabs: [] }),
    { ok: false, reason: 'bad_request' },
  );
});

test('a tab that is missing from the sheet comes back null, not an error', () => {
  const ctx = loadCodeGs();          // no tabs registered at all
  const res = ctx.fns.handleData({ token: adminToken(ctx), tabs: ['StatsLog'] });
  assert.equal(res.ok, true);
  assert.equal(res.tabs.StatsLog, null);
});

test('the tabs the site asks for are exactly the tabs the script allows', () => {
  // A name mismatch here would be an auth failure that looks like a bug.
  const ctx = withStats();
  const token = adminToken(ctx);
  for (const tab of ['StatsLog', 'Players', 'Games']) {
    assert.notDeepEqual(
      ctx.fns.handleData({ token, tabs: [tab] }),
      { ok: false, reason: 'bad_request' },
      `${tab} must be a name the script recognises`,
    );
  }
});

/* ---------------------------------------------------------------- */
/* What may be kept on the device                                    */
/* ---------------------------------------------------------------- */

/**
 * data.js reads CONFIG and localStorage at call time, so both are supplied
 * here rather than imported — the point of these tests is what the module does
 * to storage, which is a side effect, not a return value.
 */
async function withFakeStorage(run) {
  const store = new Map();
  const previous = globalThis.localStorage;

  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  try {
    await run(store);
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
}

test('signing out of admin takes the cached numbers with it', async () => {
  // A shared laptop keeping a box score after sign-out would undo the point of
  // asking for a password at all.
  await withFakeStorage(async (store) => {
    const { forgetSensitiveCache } = await import('../assets/js/data.js');

    store.set('bb.sheet.StatsLog', '{"text":"secret"}');
    store.set('bb.sheet.Games', '{"text":"secret"}');
    store.set('bb.sheet.Players', '{"text":"roster"}');
    store.set('bb.plays.v1', '[]');

    forgetSensitiveCache();

    assert.equal(store.has('bb.sheet.StatsLog'), false);
    assert.equal(store.has('bb.sheet.Games'), false);
    assert.equal(store.has('bb.sheet.Players'), true, 'the roster is names the team already knows');
    assert.equal(store.has('bb.plays.v1'), true, 'device plays are not the admin session\'s to delete');
  });
});

test('sheetProblems keeps a refused token apart from a broken sheet', async () => {
  // "You need the admin password" must not appear as a missing column, or you
  // go hunting through a spreadsheet that is perfectly fine.
  const { sheetProblems } = await import('../assets/js/data.js');

  const refused = sheetProblems({
    meta: { StatsLog: { auth: true, error: 'This needs the admin password.' } },
  });
  assert.deepEqual(refused.blocking, []);
  assert.deepEqual(refused.auth, ['StatsLog: This needs the admin password.']);

  const broken = sheetProblems({
    meta: { StatsLog: { error: 'No header row found.' } },
  });
  assert.deepEqual(broken.auth, []);
  assert.equal(broken.blocking.length, 1);
});

test('a tab that was never requested is not reported as a problem', async () => {
  // The playbook asks for Players alone; the other two are absent, not broken.
  const { sheetProblems } = await import('../assets/js/data.js');
  const result = sheetProblems({
    meta: {
      Players: { error: null, missing: [] },
      StatsLog: { skippedLoad: true, missing: ['statId'] },
    },
  });
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.auth, []);
});

test('a healthy load still reports nothing', async () => {
  const { sheetProblems } = await import('../assets/js/data.js');
  const result = sheetProblems({ meta: { Players: { error: null, missing: [] } }, issues: {} });
  assert.deepEqual(result, { blocking: [], auth: [], quality: 0 });
});
