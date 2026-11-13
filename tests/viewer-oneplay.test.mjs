/**
 * Players load one play at a time: their list has no diagrams, and each play
 * is fetched when it is opened, so a cancelled sign-in stops the next tap.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, post, tabFor } from './helpers/apps-script.mjs';
import { rowsToTeam, summaryStub, teamPlayResult } from '../assets/js/teamplays.js';
import { watchSession } from '../assets/js/gate.js';

const play = (id, over = {}) => ({
  id, slug: `play-${id}`, playbook: 'general', name: `Play ${id}`, category: 'Set', tags: ['horns'],
  notes: 'Secret coaching point', courtType: 'half',
  frames: [{ tokens: [{ id: 't', kind: 'offense', label: '1', x: 25, y: 27 }], arrows: [], texts: [] }, { tokens: [], arrows: [], texts: [] }],
  ...over,
});

function ctxWith() {
  const ctx = loadCodeGs({ VIEWER_PASSWORD: 'view-pw' });
  ctx.coach = ctx.fns.handleSignIn({ name: 'Casey Jones', password: 'team-pw' }).token;
  const admin = ctx.fns.handleSignIn({ name: 'Alex Admin', password: 'admin-pw' });
  ctx.admin = admin.adminToken;
  ctx.viewer = ctx.fns.handleSignIn({ name: 'Parent', password: 'view-pw' }).token;
  ctx.fns.handleSavePlay({ token: ctx.coach, play: play('a') });
  ctx.fns.handleSavePlay({ token: ctx.coach, play: play('b', { playbook: 'press', courtType: 'full' }) });
  return ctx;
}

/* ---------------------------------------------------------------- */
/* The script                                                        */
/* ---------------------------------------------------------------- */

test('a player\'s list has names and facts, and nothing of the plays themselves', () => {
  const ctx = ctxWith();
  const res = ctx.fns.handlePlays({ token: ctx.viewer });
  assert.equal(res.ok, true);
  assert.deepEqual(Object.keys(res.plays[0]).sort(),
    ['category', 'courtType', 'id', 'name', 'playbook', 'slug', 'steps', 'tags', 'updated']);
  assert.equal(res.plays[0].steps, 2);
  assert.equal(res.plays[1].courtType, 'full');
  const text = JSON.stringify(res);
  assert.doesNotMatch(text, /frames|tokens|Secret coaching point|"play"/);
});

test('coaches and the admin still get every play in full', () => {
  const ctx = ctxWith();
  for (const token of [ctx.coach, ctx.admin]) {
    const res = ctx.fns.handlePlays({ token });
    assert.equal(res.plays[0].play.frames.length, 2);
    assert.equal(res.plays[0].play.notes, 'Secret coaching point');
  }
});

test('anyone who may read the team playbook can open one play', () => {
  const ctx = ctxWith();
  for (const token of [ctx.viewer, ctx.coach, ctx.admin]) {
    const res = ctx.fns.handlePlay({ token, id: 'b' });
    assert.equal(res.ok, true);
    assert.equal(res.play.id, 'b');
    assert.equal(res.play.play.frames.length, 2);
  }
  assert.deepEqual(ctx.fns.handlePlay({ token: ctx.viewer, id: 'nope' }), { ok: false, reason: 'not_found' });
  assert.deepEqual(ctx.fns.handlePlay({ token: ctx.viewer }), { ok: false, reason: 'bad_request' });
});

test('a cancelled or bad sign-in gets no play', () => {
  const ctx = ctxWith();
  const AUTH = { ok: false, reason: 'auth' };
  for (const token of ['', 'junk', ctx.fns.makeToken('viewer', 'Parent', Date.now() - 1)]) {
    assert.deepEqual(ctx.fns.handlePlay({ token, id: 'a' }), AUTH);
  }

  // Sign everyone out: the player's very next request is refused.
  ctx.fns.handleSignOutAll({ token: ctx.admin });
  assert.deepEqual(ctx.fns.handlePlay({ token: ctx.viewer, id: 'a' }), AUTH);
  assert.deepEqual(post(ctx.fns, { action: 'play', token: ctx.viewer, id: 'a' }), AUTH);
});

test('a player taken off the roster gets no play', () => {
  const ctx = ctxWith();
  ctx.sheets.Players.rows.splice(ctx.sheets.Players.rows.findIndex((r) => r[1] === 'Parent'), 1);
  ctx.cache.delete('roster');
  assert.deepEqual(ctx.fns.handlePlay({ token: ctx.viewer, id: 'a' }), { ok: false, reason: 'auth' });
});

test('one-play reads only the team playbook: never an admin play or an opponent play', () => {
  const ctx = ctxWith();
  ctx.fns.handleSavePlay({ token: ctx.admin, book: 'admin', play: play('secret') });
  ctx.sheets.OpponentPlays = tabFor([
    ['Id', 'OpponentKey', 'Opponent', 'SourceId', 'GameId', 'Name', 'Updated', 'UpdatedBy', 'JSON'],
    ['opp-1', 'north', 'North', 'a', 'G1', 'Their Set', '', '', JSON.stringify(play('opp-1'))],
  ]);
  for (const token of [ctx.viewer, ctx.coach, ctx.admin]) {
    assert.deepEqual(ctx.fns.handlePlay({ token, id: 'secret' }), { ok: false, reason: 'not_found' });
    assert.deepEqual(ctx.fns.handlePlay({ token, id: 'opp-1' }), { ok: false, reason: 'not_found' });
  }
});

/* ---------------------------------------------------------------- */
/* The page                                                          */
/* ---------------------------------------------------------------- */

test('a player\'s list rows become stubs that know their step count', () => {
  const { plays, playbooks } = rowsToTeam([
    { id: 'a', name: 'Horns', playbook: 'general', steps: 3, category: 'Set', tags: ['x'], courtType: 'half' },
    { id: 'b', name: 'Press', playbook: 'press', steps: 1, courtType: 'full' },
  ]);
  assert.deepEqual(plays.map((p) => [p.id, p.summary, p.stepCount, p.frames.length]), [['a', true, 3, 0], ['b', true, 1, 0]]);
  assert.equal(plays[1].courtType, 'full');
  assert.deepEqual(playbooks.map((pb) => pb.slug), ['general', 'press']);
});

test('full rows from an older script still work exactly as before', () => {
  const { plays } = rowsToTeam([{ id: 'a', playbook: 'general', play: play('a') }]);
  assert.equal(plays[0].summary, undefined);
  assert.equal(plays[0].frames.length, 2);
});

test('a stub never claims to have steps it does not hold', () => {
  const stub = summaryStub({ id: 'x', name: '', steps: 'many' });
  assert.equal(stub.name, 'Untitled play');
  assert.equal(stub.stepCount, 0);
  assert.deepEqual(stub.frames, []);
});

test('each one-play reply tells the page what to do', () => {
  const ok = teamPlayResult({ ok: true, data: { ok: true, play: { id: 'a', playbook: 'general', play: play('a') } } });
  assert.equal(ok.ok, true);
  assert.equal(ok.play.frames.length, 2);
  assert.equal(teamPlayResult({ ok: true, data: { ok: false, reason: 'auth' } }).reason, 'auth');
  assert.equal(teamPlayResult({ ok: true, data: { ok: false, reason: 'not_found' } }).reason, 'not_found');
  assert.equal(teamPlayResult({ ok: false, error: 'offline' }).reason, 'network');
  assert.equal(teamPlayResult({ ok: true, data: { ok: false, reason: 'unknown_action' } }).reason, 'error',
    'an older script without this action is not mistaken for a sign-out');
});

test('the re-check runs on a timer and on returning to the tab, at most once a minute', () => {
  let t = 0;
  let checks = 0;
  const listeners = {};
  let interval = null;
  const doc = { visibilityState: 'visible', addEventListener: (e, fn) => { listeners[e] = fn; }, removeEventListener: (e) => { delete listeners[e]; } };
  const win = { setInterval: (fn, ms) => { interval = { fn, ms }; return 1; }, clearInterval: () => { interval = null; } };
  const watch = watchSession({ now: () => t, verify: () => { checks++; }, win, doc });

  assert.equal(interval.ms, 5 * 60 * 1000);
  t = 30 * 1000;
  listeners.visibilitychange();
  assert.equal(checks, 0, 'not within a minute of the last check');
  t = 90 * 1000;
  listeners.visibilitychange();
  assert.equal(checks, 1, 'coming back to the tab checks');
  doc.visibilityState = 'hidden';
  t = 10 * 60 * 1000;
  listeners.visibilitychange();
  assert.equal(checks, 1, 'leaving the tab does not');
  interval.fn();
  assert.equal(checks, 2, 'the timer checks');

  watch.stop();
  assert.equal(interval, null);
  assert.equal(listeners.visibilitychange, undefined);
});
