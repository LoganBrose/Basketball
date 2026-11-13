/**
 * The view-only password only works for a name on the Players tab.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, tabFor } from './helpers/apps-script.mjs';
import { messageFor } from '../assets/js/gate.js';
import { resultLabel, isFailure } from '../assets/js/admin.js';

const ROSTER = [
  ['Players', '', '', ''],
  ['Legend: yellow cells = type your data.', '', '', ''],
  ['Player ID', 'Full Name', 'Jersey Number', 'Position'],
  ['EX1', 'Example Player', '00', 'G'],
  ['P1', 'John Smith', '12', 'PG'],
  ['P2', 'Jane Doe', '7', 'SF'],
  ['', '', '', ''],
];

function ctxWith(rows = ROSTER) {
  const ctx = loadCodeGs({ VIEWER_PASSWORD: 'view-pw' });
  if (rows) ctx.sheets.Players = tabFor(rows.map((r) => r.slice()));
  else delete ctx.sheets.Players;
  return ctx;
}

const viewerSignIn = (fns, name) => fns.handleSignIn({ name, password: 'view-pw' });

test('a name on the Players tab signs in as view-only', () => {
  const { fns, rows } = ctxWith();
  const res = viewerSignIn(fns, 'John Smith');
  assert.equal(res.ok, true);
  assert.equal(res.role, 'viewer');
  assert.equal(rows.at(-1)[4], 'viewer');
});

test('capital letters and extra spaces do not matter, but the full name does', () => {
  const { fns } = ctxWith();
  assert.equal(viewerSignIn(fns, '  john   SMITH ').ok, true);
  assert.equal(viewerSignIn(fns, 'jane doe').ok, true);
  assert.equal(viewerSignIn(fns, 'John').reason, 'not_on_roster');
});

test('a name not on the tab is refused with its own reason and logged', () => {
  const { fns, rows } = ctxWith();
  const res = viewerSignIn(fns, 'Random Stranger');
  assert.deepEqual(res, { ok: false, reason: 'not_on_roster' });
  assert.equal(rows.at(-1)[4], 'failed:roster');
});

test('example rows, the legend and the header are not names', () => {
  const { fns } = ctxWith();
  for (const name of ['Example Player', 'Full Name', 'Players', 'Legend: yellow cells = type your data.']) {
    assert.equal(viewerSignIn(fns, name).ok, false, name);
  }
});

test('unlisted names count toward the lockout', () => {
  const { fns } = ctxWith();
  const reasons = [];
  for (let i = 0; i < 6; i++) reasons.push(viewerSignIn(fns, `Stranger ${i}`).reason);
  assert.deepEqual(reasons, Array(5).fill('not_on_roster').concat('slow'));
  assert.equal(viewerSignIn(fns, 'John Smith').reason, 'slow');
});

test('with no Players tab, nobody signs in as view-only', () => {
  const { fns } = ctxWith(null);
  assert.equal(viewerSignIn(fns, 'John Smith').reason, 'not_on_roster');
});

test('a Players tab with no name column lets nobody in', () => {
  const { fns } = ctxWith([['Player ID', 'Jersey Number'], ['P1', '12']]);
  assert.equal(viewerSignIn(fns, 'P1').reason, 'not_on_roster');
});

test('the team and admin passwords still work under any name', () => {
  const { fns } = ctxWith();
  assert.equal(fns.handleSignIn({ name: 'Assistant Coach', password: 'team-pw' }).role, 'site');
  assert.equal(fns.handleSignIn({ name: 'Alex Admin', password: 'admin-pw' }).role, 'admin');
});

test('a wrong password under a listed name is still just a wrong password', () => {
  const { fns } = ctxWith();
  assert.equal(fns.handleSignIn({ name: 'John Smith', password: 'nope' }).reason, 'password');
});

test('taking a player off the tab ends their sign-in once the cached list refreshes', () => {
  const ctx = ctxWith();
  const { fns, cache, sheets } = ctx;
  const { token } = viewerSignIn(fns, 'John Smith');
  assert.equal(fns.handlePlays({ token }).ok, true);
  assert.equal(fns.handleCheck({ token }).valid, true);

  sheets.Players.rows.splice(4, 1);    // remove John Smith
  cache.delete('roster');              // the five-minute cache running out

  assert.deepEqual(fns.handlePlays({ token }), { ok: false, reason: 'auth' });
  assert.equal(fns.handleCheck({ token }).valid, false);
});

test('the roster check does not touch coach tokens', () => {
  const { fns, sheets, cache } = ctxWith();
  const { token } = fns.handleSignIn({ name: 'Assistant Coach', password: 'team-pw' });
  sheets.Players.rows.length = 0;
  cache.delete('roster');
  assert.equal(fns.handlePlays({ token }).ok, true);
  assert.equal(fns.handleCheck({ token }).valid, true);
});

test('the roster is read once and then served from the cache', () => {
  const { fns, cache } = ctxWith();
  viewerSignIn(fns, 'John Smith');
  assert.deepEqual(JSON.parse(cache.get('roster')), ['john smith', 'jane doe']);
});

test('the popup tells the person to check their name', () => {
  const msg = messageFor({ ok: true, data: { ok: false, reason: 'not_on_roster' } });
  assert.equal(msg.kind, 'name');
  assert.equal(msg.text, "That name isn't on the team list. Use your full name as your coach entered it.");
});

test('the admin list labels the refusal and counts it as a failure', () => {
  const row = { name: 'Random Stranger', result: 'failed:roster' };
  assert.equal(resultLabel(row), 'Failed: name not on team list');
  assert.equal(isFailure(row), true);
});
