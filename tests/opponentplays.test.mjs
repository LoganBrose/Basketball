/**
 * Opponent plays on the server: saved from the builder to an opponent through
 * a game, kept apart from every playbook of ours, and shown on that
 * opponent's reports with the same rules as the rest of scouting.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, tabFor } from './helpers/apps-script.mjs';

const NOW = Date.parse('2026-11-13T17:00:00Z');

function ctxWith(stage = 'everyone') {
  const ctx = loadCodeGs({
    VIEWER_PASSWORD: 'view-pw', RELEASE_SCOUTING: stage, VIEWER_HOURS: '1000', ADMIN_HOURS: '1000',
  }, { now: NOW });
  ctx.sheets.Games = tabFor([
    ['Game ID', 'Date', 'Opponent', 'Home/Away'],
    ['G01', '11/1/2026', 'North', 'Home'],
    ['G03', '2026-11-20', 'North', 'Away'],
    ['G04', '2026-11-21', 'South', 'Away'],
    ['G05', '12/5/2026', 'North', 'Home'],
  ]);
  ctx.coach = ctx.fns.handleSignIn({ name: 'Casey Jones', password: 'team-pw' }).token;
  ctx.admin = ctx.fns.handleSignIn({ name: 'Alex Admin', password: 'admin-pw' }).adminToken;
  ctx.viewer = ctx.fns.handleSignIn({ name: 'Parent', password: 'view-pw' }).token;
  return ctx;
}

const play = (id, over = {}) => ({
  id, name: `Their ${id}`, playbook: 'general', slug: 'x', courtType: 'half',
  frames: [{ label: 'Start', tokens: [{ id: 't1', kind: 'offense', label: '1', x: 25, y: 27 }], arrows: [], texts: [] }],
  ...over,
});
const HIDDEN = { ok: false, reason: 'unknown_action' };
const names = (r) => r.plays.map((p) => p.name);

test('a coach saves a play to an opponent and it appears on every game against them', () => {
  const ctx = ctxWith();
  const saved = ctx.fns.handleSaveOpponentPlay({ token: ctx.coach, gameId: 'G03', play: play('p1', { name: 'Box Set' }) });
  assert.equal(saved.ok, true);
  assert.equal(saved.opponent, 'North');
  assert.match(saved.id, /^opp-/);

  for (const gameId of ['G01', 'G03', 'G05']) {
    assert.deepEqual(names(ctx.fns.handleScoutReport({ token: ctx.admin, gameId })), ['Box Set'], gameId);
  }
  assert.deepEqual(names(ctx.fns.handleScoutReport({ token: ctx.admin, gameId: 'G04' })), [], 'not South');
});

test('the stored play has its own id and no playbook, so it cannot pass for one of ours', () => {
  const ctx = ctxWith();
  const { id } = ctx.fns.handleSaveOpponentPlay({ token: ctx.coach, gameId: 'G03', play: play('p1') });
  const p = ctx.fns.handleScoutReport({ token: ctx.coach, gameId: 'G03' }).plays[0];
  assert.equal(p.id, id);
  assert.equal(p.play.id, id);
  assert.equal(p.sourceId, 'p1');
  assert.equal('playbook' in p.play, false);
  assert.equal('slug' in p.play, false);
  assert.equal(p.play.frames[0].tokens[0].label, '1', 'the drawing itself is untouched');
});

test('opponent plays never show up in the team or admin playbooks', () => {
  const ctx = ctxWith();
  ctx.fns.handleSaveOpponentPlay({ token: ctx.admin, gameId: 'G03', play: play('p1') });
  assert.deepEqual(ctx.fns.handlePlays({ token: ctx.coach }).plays, []);
  assert.deepEqual(ctx.fns.handlePlays({ token: ctx.admin, book: 'admin' }).plays, []);
  assert.ok(ctx.sheets.OpponentPlays, 'they live in their own tab');
});

test('saving the same builder play to the same opponent again replaces it', () => {
  const ctx = ctxWith();
  const first = ctx.fns.handleSaveOpponentPlay({ token: ctx.coach, gameId: 'G03', play: play('p1', { name: 'v1' }) });
  const again = ctx.fns.handleSaveOpponentPlay({ token: ctx.admin, gameId: 'G05', play: play('p1', { name: 'v2' }) });
  assert.equal(again.replaced, true);
  assert.equal(again.id, first.id, 'same opponent play');
  const r = ctx.fns.handleScoutReport({ token: ctx.coach, gameId: 'G03' });
  assert.deepEqual(names(r), ['v2']);
  assert.equal(r.plays[0].updatedBy, 'Alex Admin', 'who saved last');
});

test('the same builder play saved to two opponents is two plays', () => {
  const ctx = ctxWith();
  const north = ctx.fns.handleSaveOpponentPlay({ token: ctx.coach, gameId: 'G03', play: play('p1') });
  const south = ctx.fns.handleSaveOpponentPlay({ token: ctx.coach, gameId: 'G04', play: play('p1') });
  assert.notEqual(north.id, south.id);
  assert.equal(south.replaced, false);
});

test('players see opponent plays inside their window, and nothing about who saved them', () => {
  const ctx = ctxWith();
  ctx.fns.handleSaveOpponentPlay({ token: ctx.coach, gameId: 'G03', play: play('p1', { name: 'Box Set' }) });
  const r = ctx.fns.handleScoutReport({ token: ctx.viewer, gameId: 'G03' });
  assert.deepEqual(names(r), ['Box Set']);
  assert.deepEqual(Object.keys(r.plays[0]).sort(), ['id', 'name', 'play']);
  assert.deepEqual(ctx.fns.handleScoutReport({ token: ctx.viewer, gameId: 'G05' }), { ok: false, reason: 'not_found' },
    'a later game against the same team stays closed');
});

test('viewers, unreleased logins and junk tokens cannot save or delete', () => {
  const ctx = ctxWith('coaches');
  const { id } = ctx.fns.handleSaveOpponentPlay({ token: ctx.coach, gameId: 'G03', play: play('p1') });
  for (const token of [ctx.viewer, 'junk', '']) {
    assert.deepEqual(ctx.fns.handleSaveOpponentPlay({ token, gameId: 'G03', play: play('x') }), HIDDEN);
    assert.deepEqual(ctx.fns.handleDeleteOpponentPlay({ token, gameId: 'G03', id }), HIDDEN);
  }
  ctx.props.RELEASE_SCOUTING = 'admin';
  assert.deepEqual(ctx.fns.handleSaveOpponentPlay({ token: ctx.coach, gameId: 'G03', play: play('y') }), HIDDEN);
  assert.equal(ctx.fns.handleScoutReport({ token: ctx.admin, gameId: 'G03' }).plays.length, 1);
});

test('a play is removed only through a game against its own opponent', () => {
  const ctx = ctxWith();
  const { id } = ctx.fns.handleSaveOpponentPlay({ token: ctx.coach, gameId: 'G03', play: play('p1') });
  ctx.fns.handleDeleteOpponentPlay({ token: ctx.coach, gameId: 'G04', id });
  assert.equal(ctx.fns.handleScoutReport({ token: ctx.coach, gameId: 'G03' }).plays.length, 1);
  assert.equal(ctx.fns.handleDeleteOpponentPlay({ token: ctx.coach, gameId: 'G01', id }).ok, true);
  assert.equal(ctx.fns.handleScoutReport({ token: ctx.coach, gameId: 'G03' }).plays.length, 0);
});

test('an unknown game, a play with no frames, or one too big for a cell is refused', () => {
  const ctx = ctxWith();
  assert.equal(ctx.fns.handleSaveOpponentPlay({ token: ctx.coach, gameId: 'G99', play: play('p1') }).reason, 'not_found');
  assert.equal(ctx.fns.handleSaveOpponentPlay({ token: ctx.coach, gameId: 'G03', play: { id: 'x' } }).reason, 'bad_request');
  assert.equal(ctx.fns.handleSaveOpponentPlay({ token: ctx.coach, gameId: 'G03', play: play('big', { notes: 'x'.repeat(46000) }) }).reason, 'too_big');
  assert.equal(ctx.fns.handleScoutReport({ token: ctx.coach, gameId: 'G03' }).plays.length, 0);
  assert.equal(ctx.locks.taken, ctx.locks.released);
});

test('a name that looks like a formula is stored as text, and an unreadable row is skipped', () => {
  const ctx = ctxWith();
  ctx.fns.handleSaveOpponentPlay({ token: ctx.coach, gameId: 'G03', play: play('p1', { name: '=HYPERLINK("x")' }) });
  assert.match(String(ctx.sheets.OpponentPlays.rows[1][5]), /^'=/);
  ctx.sheets.OpponentPlays.appendRow(['opp-bad', 'north', 'North', 's', 'G03', 'Bad', '', '', '{nope']);
  // (Sheets hides the apostrophe when the cell is read back; this test double does not.)
  const plays = ctx.fns.handleScoutReport({ token: ctx.coach, gameId: 'G03' }).plays;
  assert.equal(plays.length, 1, 'the unreadable row is skipped');
  assert.equal(plays[0].play.name, '=HYPERLINK("x")', 'the play itself keeps its name');
});

test('checkSetup creates the OpponentPlays tab with its header', () => {
  const ctx = ctxWith();
  ctx.fns.checkSetup();
  assert.deepEqual(ctx.sheets.OpponentPlays.rows[0],
    ['Id', 'OpponentKey', 'Opponent', 'SourceId', 'GameId', 'Name', 'Updated', 'UpdatedBy', 'JSON']);
});
