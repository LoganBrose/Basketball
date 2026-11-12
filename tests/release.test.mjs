/**
 * Feature releases: who each feature is open to, decided by a Script Property
 * the script reads on every request, and refused in the script — not just
 * hidden by the page.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, post } from './helpers/apps-script.mjs';

function ctxWith(props = {}) {
  const ctx = loadCodeGs({ VIEWER_PASSWORD: 'view-pw', ...props });
  ctx.site = ctx.fns.handleSignIn({ name: 'Casey Jones', password: 'team-pw' }).token;
  const admin = ctx.fns.handleSignIn({ name: 'Logan Brose', password: 'admin-pw' });
  ctx.adminSite = admin.token;
  ctx.admin = admin.adminToken;
  ctx.viewer = ctx.fns.handleSignIn({ name: 'Parent', password: 'view-pw' }).token;
  return ctx;
}

const who = (role) => ({ ok: true, role, name: 'Someone' });

/* ---------------------------------------------------------------- */
/* The stage                                                         */
/* ---------------------------------------------------------------- */

test('scouting starts at admin only when the property is unset', () => {
  const { fns } = loadCodeGs();
  assert.equal(fns.stageOf('scouting'), 'admin');
});

test('each stage is read from RELEASE_SCOUTING, case and spaces ignored', () => {
  for (const [value, stage] of [['admin', 'admin'], ['coaches', 'coaches'], [' Everyone ', 'everyone'], ['COACHES', 'coaches']]) {
    const { fns } = loadCodeGs({ RELEASE_SCOUTING: value });
    assert.equal(fns.stageOf('scouting'), stage, value);
  }
});

test('a typo closes the feature rather than opening it', () => {
  for (const value of ['coach', 'all', 'yes', 'true', '']) {
    const { fns } = loadCodeGs({ RELEASE_SCOUTING: value });
    assert.equal(fns.stageOf('scouting'), 'admin', JSON.stringify(value));
    assert.equal(fns.released('scouting', who('site')), false);
  }
});

test('the property is read on every request, so a change needs no redeploy', () => {
  const ctx = loadCodeGs();
  assert.equal(ctx.fns.released('scouting', who('site')), false);
  ctx.props.RELEASE_SCOUTING = 'coaches';
  assert.equal(ctx.fns.released('scouting', who('site')), true);
  ctx.props.RELEASE_SCOUTING = 'admin';
  assert.equal(ctx.fns.released('scouting', who('site')), false, 'and rolling back is just as quick');
});

/* ---------------------------------------------------------------- */
/* Who each stage admits                                             */
/* ---------------------------------------------------------------- */

test('the role matrix for scouting', () => {
  const cases = [
    // stage, admin, coach, viewer
    ['admin', true, false, false],
    ['coaches', true, true, false],
    ['everyone', true, true, true],
  ];
  for (const [stage, a, c, v] of cases) {
    const { fns } = loadCodeGs({ RELEASE_SCOUTING: stage });
    assert.equal(fns.released('scouting', who('admin')), a, `${stage}: admin`);
    assert.equal(fns.released('scouting', who('site')), c, `${stage}: coach`);
    assert.equal(fns.released('scouting', who('viewer')), v, `${stage}: viewer`);
  }
});

test('the admin playbook is the admin\'s at every stage, and has no property', () => {
  for (const stage of ['admin', 'coaches', 'everyone']) {
    const { fns } = loadCodeGs({ RELEASE_SCOUTING: stage, RELEASE_ADMINPLAYBOOK: 'everyone', RELEASE_ADMIN_PLAYBOOK: 'everyone' });
    assert.equal(fns.released('adminPlaybook', who('admin')), true);
    assert.equal(fns.released('adminPlaybook', who('site')), false);
    assert.equal(fns.released('adminPlaybook', who('viewer')), false);
  }
});

test('a failed token and an unknown feature are never released', () => {
  const { fns } = loadCodeGs({ RELEASE_SCOUTING: 'everyone' });
  assert.equal(fns.released('scouting', { ok: false, role: '', name: '' }), false);
  assert.equal(fns.released('scouting', null), false);
  assert.equal(fns.released('somethingElse', who('admin')), false);
});

/* ---------------------------------------------------------------- */
/* What the page is told                                             */
/* ---------------------------------------------------------------- */

test('sign-in tells each login which features it has', () => {
  const ctx = loadCodeGs({ VIEWER_PASSWORD: 'view-pw' });
  assert.deepEqual(ctx.fns.handleSignIn({ name: 'Logan Brose', password: 'admin-pw' }).features,
    ['adminPlaybook', 'scouting']);
  assert.deepEqual(ctx.fns.handleSignIn({ name: 'Casey Jones', password: 'team-pw' }).features, []);
  assert.deepEqual(ctx.fns.handleSignIn({ name: 'Parent', password: 'view-pw' }).features, []);
});

test('check reports the features of the strongest token that still works', () => {
  const ctx = ctxWith({ RELEASE_SCOUTING: 'coaches' });
  assert.deepEqual(ctx.fns.handleCheck({ token: ctx.site }).features, ['scouting']);
  assert.deepEqual(ctx.fns.handleCheck({ token: ctx.viewer }).features, []);
  assert.deepEqual(ctx.fns.handleCheck({ token: ctx.adminSite, adminToken: ctx.admin }).features,
    ['adminPlaybook', 'scouting']);
  // An admin whose admin part lapsed is a coach again.
  assert.deepEqual(ctx.fns.handleCheck({ token: ctx.adminSite, adminToken: 'junk' }).features, ['scouting']);
});

test('check carries no features for a token that no longer works', () => {
  const ctx = ctxWith({ RELEASE_SCOUTING: 'everyone' });
  assert.equal(ctx.fns.handleCheck({ token: 'junk' }).features, undefined);
});

test('a stage change reaches the next check without anyone signing in again', () => {
  const ctx = ctxWith();
  assert.deepEqual(ctx.fns.handleCheck({ token: ctx.viewer }).features, []);
  ctx.props.RELEASE_SCOUTING = 'everyone';
  assert.deepEqual(ctx.fns.handleCheck({ token: ctx.viewer }).features, ['scouting']);
});

test('the admin page is told each feature\'s stage', () => {
  const ctx = ctxWith({ RELEASE_SCOUTING: 'coaches' });
  const res = ctx.fns.handleSignIns({ token: ctx.admin });
  assert.deepEqual(res.releases, { scouting: 'coaches' });
});

test('checkSetup warns about a release value it does not understand', () => {
  const ctx = loadCodeGs({ RELEASE_SCOUTING: 'coach' });
  ctx.fns.checkSetup();
  const text = ctx.logged.map((args) => args.join(' ')).join('\n');
  assert.match(text, /RELEASE_SCOUTING/);
  assert.match(text, /WARNING/);
});

/* ---------------------------------------------------------------- */
/* Through doPost                                                    */
/* ---------------------------------------------------------------- */

test('a refusal for an unreleased feature reads exactly like an action that does not exist', () => {
  const ctx = ctxWith();
  const missing = post(ctx.fns, { action: 'noSuchThing', token: ctx.site });
  const admin = post(ctx.fns, { action: 'plays', book: 'admin', token: ctx.site });
  assert.deepEqual(admin, missing);
});
