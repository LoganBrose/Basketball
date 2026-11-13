/**
 * The admin's "Sign everyone out" button, the background session check every
 * page makes, and the "Signed in now" list — all run against the real Code.gs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, post } from './helpers/apps-script.mjs';

function ctxWith() {
  const ctx = loadCodeGs({ VIEWER_PASSWORD: 'view-pw' });
  const { fns } = ctx;
  ctx.site = fns.handleSignIn({ name: 'Casey Jones', password: 'team-pw' }).token;
  ctx.viewer = fns.handleSignIn({ name: 'Pat Lee', password: 'view-pw' }).token;
  const admin = fns.handleSignIn({ name: 'Logan Brose', password: 'admin-pw' });
  ctx.adminSite = admin.token;
  ctx.admin = admin.adminToken;
  return ctx;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/* ---------------------------------------------------------------- */
/* Checking a stored session                                         */
/* ---------------------------------------------------------------- */

test('check accepts a token of any role and reports it', () => {
  const ctx = ctxWith();
  assert.deepEqual(ctx.fns.handleCheck({ token: ctx.site }), { ok: true, valid: true, role: 'site', features: [] });
  assert.equal(ctx.fns.handleCheck({ token: ctx.viewer }).role, 'viewer');
  assert.equal(ctx.fns.handleCheck({ token: 'junk' }).valid, false);
});

test('check reports the admin token separately', () => {
  const ctx = ctxWith();
  const out = ctx.fns.handleCheck({ token: ctx.adminSite, adminToken: ctx.admin });
  assert.equal(out.valid, true);
  assert.equal(out.adminValid, true);
  assert.equal(ctx.fns.handleCheck({ token: ctx.adminSite, adminToken: ctx.site }).adminValid, false);
});

test('check is not a sign-in and is not logged', () => {
  const ctx = ctxWith();
  const before = ctx.rows.length;
  ctx.fns.handleCheck({ token: ctx.site });
  assert.equal(ctx.rows.length, before);
});

/* ---------------------------------------------------------------- */
/* Sign everyone out                                                 */
/* ---------------------------------------------------------------- */

test('only an admin token can sign everyone out', () => {
  const ctx = ctxWith();
  for (const token of [ctx.site, ctx.viewer, ctx.adminSite, 'junk', '']) {
    assert.deepEqual(ctx.fns.handleSignOutAll({ token }), { ok: false, reason: 'auth' });
  }
  assert.equal(ctx.props.SESSION_EPOCH, undefined, 'a refused request changes nothing');
  assert.equal(ctx.fns.verifyToken(ctx.site).ok, true);
});

test('every outstanding token stops working, of every role', () => {
  const ctx = ctxWith();
  assert.equal(ctx.fns.handleSignOutAll({ token: ctx.admin }).ok, true);

  for (const token of [ctx.site, ctx.viewer, ctx.adminSite, ctx.admin]) {
    assert.equal(ctx.fns.verifyToken(token).ok, false);
  }
  assert.equal(ctx.fns.handlePlays({ token: ctx.site }).reason, 'auth');
  assert.equal(ctx.fns.handleCheck({ token: ctx.viewer }).valid, false);
});

test('the admin who pressed it is handed fresh tokens and stays in', () => {
  const ctx = ctxWith();
  const out = ctx.fns.handleSignOutAll({ token: ctx.admin });
  assert.equal(out.name, 'Logan Brose');
  assert.equal(ctx.fns.verifyToken(out.token, 'site').ok, true);
  assert.equal(ctx.fns.verifyToken(out.adminToken, 'admin').ok, true);
  assert.equal(ctx.fns.handleSignIns({ token: out.adminToken }).ok, true);
});

test('people can sign straight back in afterwards', () => {
  const ctx = ctxWith();
  ctx.fns.handleSignOutAll({ token: ctx.admin });
  const again = ctx.fns.handleSignIn({ name: 'Casey Jones', password: 'team-pw' });
  assert.equal(ctx.fns.handlePlays({ token: again.token }).ok, true);
});

test('pressing it twice signs out the tokens from the first press too', () => {
  const ctx = ctxWith();
  const first = ctx.fns.handleSignOutAll({ token: ctx.admin });
  const coach = ctx.fns.handleSignIn({ name: 'Casey Jones', password: 'team-pw' }).token;
  const second = ctx.fns.handleSignOutAll({ token: first.adminToken });
  assert.equal(second.ok, true);
  assert.equal(ctx.fns.verifyToken(coach).ok, false);
  assert.equal(ctx.fns.verifyToken(first.adminToken).ok, false);
});

test('it is logged, takes the lock and releases it', () => {
  const ctx = ctxWith();
  ctx.fns.handleSignOutAll({ token: ctx.admin, page: 'admin' });
  const last = ctx.rows[ctx.rows.length - 1];
  assert.equal(last[1], 'Logan Brose');
  assert.equal(last[4], 'signout-all');
  assert.equal(ctx.locks.taken, ctx.locks.released);
  assert.ok(ctx.locks.taken >= 1);
});

test('it works through doPost', () => {
  const ctx = ctxWith();
  const out = post(ctx.fns, { action: 'signOutAll', token: ctx.admin });
  assert.equal(out.ok, true);
  assert.equal(post(ctx.fns, { action: 'check', token: ctx.site }).valid, false);
});

/* ---------------------------------------------------------------- */
/* Signed in now                                                     */
/* ---------------------------------------------------------------- */

const names = (list) => list.map((p) => p.name).sort();

test('everyone with a valid sign-in is listed, with their access', () => {
  const ctx = ctxWith();
  const active = ctx.fns.readActiveSessions();
  assert.deepEqual(names(active), ['Casey Jones', 'Logan Brose', 'Pat Lee']);
  const role = (n) => active.find((p) => p.name === n).role;
  assert.equal(role('Casey Jones'), 'coach');
  assert.equal(role('Pat Lee'), 'viewer');
  assert.equal(role('Logan Brose'), 'admin');
});

test('failed attempts are not listed', () => {
  const ctx = ctxWith();
  ctx.fns.handleSignIn({ name: 'Mallory', password: 'nope' });
  assert.ok(!names(ctx.fns.readActiveSessions()).includes('Mallory'));
});

test('two devices under one name are one person with two sessions', () => {
  const ctx = ctxWith();
  ctx.fns.handleSignIn({ name: 'casey  jones', password: 'team-pw' });
  const casey = ctx.fns.readActiveSessions().filter((p) => p.name.toLowerCase() === 'casey jones');
  assert.equal(casey.length, 1);
  assert.equal(casey[0].sessions, 2);
});

test('a sign-in drops off when its token would have expired', () => {
  const ctx = ctxWith();
  const now = Date.now();
  assert.ok(names(ctx.fns.readActiveSessions(now + 2 * DAY)).includes('Casey Jones'));
  assert.ok(!names(ctx.fns.readActiveSessions(now + 2 * DAY)).includes('Pat Lee'), 'a viewer lasts a day');
  assert.deepEqual(names(ctx.fns.readActiveSessions(now + 31 * DAY)), []);
});

test('an admin whose admin part has lapsed is still listed as a coach', () => {
  const ctx = ctxWith();
  const logan = ctx.fns.readActiveSessions(Date.now() + 2 * DAY).find((p) => p.name === 'Logan Brose');
  assert.equal(logan.role, 'coach');
});

test('after Sign everyone out only the admin who pressed it is listed', () => {
  const ctx = ctxWith();
  ctx.fns.handleSignOutAll({ token: ctx.admin });
  const active = ctx.fns.readActiveSessions();
  assert.deepEqual(names(active), ['Logan Brose']);
  assert.equal(active[0].role, 'admin');

  ctx.fns.handleSignIn({ name: 'Casey Jones', password: 'team-pw' });
  assert.deepEqual(names(ctx.fns.readActiveSessions()), ['Casey Jones', 'Logan Brose']);
});

test('the admin log includes who is signed in now', () => {
  const ctx = ctxWith();
  const out = ctx.fns.handleSignIns({ token: ctx.admin });
  assert.deepEqual(names(out.active), ['Casey Jones', 'Logan Brose', 'Pat Lee']);
});
