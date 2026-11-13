/**
 * The admin playbook: a second sheet playbook that only the admin token can
 * read or change, and moves between it and the team playbook.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, post } from './helpers/apps-script.mjs';

const play = (id, over = {}) => ({
  id, slug: `play-${id}`, playbook: 'general', name: `Play ${id}`,
  frames: [{ tokens: [], arrows: [], texts: [] }],
  ...over,
});

function ctxWith(props = {}) {
  // Whatever the scouting stage, the admin playbook stays the admin's.
  const ctx = loadCodeGs({ VIEWER_PASSWORD: 'view-pw', RELEASE_SCOUTING: 'everyone', ...props });
  ctx.site = ctx.fns.handleSignIn({ name: 'Casey Jones', password: 'team-pw' }).token;
  const admin = ctx.fns.handleSignIn({ name: 'Alex Admin', password: 'admin-pw' });
  ctx.adminSite = admin.token;
  ctx.admin = admin.adminToken;
  ctx.viewer = ctx.fns.handleSignIn({ name: 'Parent', password: 'view-pw' }).token;
  return ctx;
}

const ids = (res) => res.plays.map((p) => p.id);
const HIDDEN = { ok: false, reason: 'unknown_action' };

/* ---------------------------------------------------------------- */
/* Only the admin                                                    */
/* ---------------------------------------------------------------- */

test('the admin saves to and reads from the admin playbook', () => {
  const ctx = ctxWith();
  const saved = ctx.fns.handleSavePlay({ token: ctx.admin, book: 'admin', play: play('a') });
  assert.equal(saved.ok, true);
  assert.equal(saved.updatedBy, 'Alex Admin');

  const res = ctx.fns.handlePlays({ token: ctx.admin, book: 'admin' });
  assert.deepEqual(ids(res), ['a']);
  assert.equal(res.plays[0].updatedBy, 'Alex Admin');
});

test('admin plays live in their own tab and never show up in the team playbook', () => {
  const ctx = ctxWith();
  ctx.fns.handleSavePlay({ token: ctx.admin, book: 'admin', play: play('secret') });
  ctx.fns.handleSavePlay({ token: ctx.admin, play: play('shared') });

  assert.ok(ctx.sheets.AdminPlays, 'AdminPlays tab created');
  assert.deepEqual(ids(ctx.fns.handlePlays({ token: ctx.site })), ['shared']);
  assert.deepEqual(ids(ctx.fns.handlePlays({ token: ctx.admin, book: 'admin' })), ['secret']);
});

test('coaches, viewers, the admin\'s own site token and junk are all refused, as if nothing were there', () => {
  const ctx = ctxWith();
  ctx.fns.handleSavePlay({ token: ctx.admin, book: 'admin', play: play('a') });

  for (const [token, who] of [[ctx.site, 'coach'], [ctx.viewer, 'viewer'], [ctx.adminSite, 'admin site token'], ['junk', 'junk'], ['', 'none']]) {
    assert.deepEqual(ctx.fns.handlePlays({ token, book: 'admin' }), HIDDEN, `read: ${who}`);
    assert.deepEqual(ctx.fns.handleSavePlay({ token, book: 'admin', play: play('x') }), HIDDEN, `save: ${who}`);
    assert.deepEqual(ctx.fns.handleDeletePlay({ token, book: 'admin', id: 'a' }), HIDDEN, `delete: ${who}`);
    assert.deepEqual(ctx.fns.handleMovePlay({ token, from: 'admin', to: 'team', id: 'a' }), HIDDEN, `move: ${who}`);
  }
  assert.deepEqual(ids(ctx.fns.handlePlays({ token: ctx.admin, book: 'admin' })), ['a'], 'nothing changed');
});

test('an unknown book is a bad request, not a quiet fallback to the team playbook', () => {
  const ctx = ctxWith();
  assert.deepEqual(ctx.fns.handlePlays({ token: ctx.admin, book: 'Plays' }), { ok: false, reason: 'bad_request' });
  assert.deepEqual(ctx.fns.handleSavePlay({ token: ctx.admin, book: 'stats', play: play('a') }), { ok: false, reason: 'bad_request' });
});

test('a request with no book is the team playbook, exactly as before', () => {
  // Browsers loaded before this change send no book. They must keep working.
  const ctx = ctxWith();
  ctx.fns.handleSavePlay({ token: ctx.site, play: play('a') });
  assert.deepEqual(ids(ctx.fns.handlePlays({ token: ctx.site })), ['a']);
  assert.deepEqual(ids(ctx.fns.handlePlays({ token: ctx.site, book: 'team' })), ['a']);
  assert.deepEqual(ctx.fns.handleSavePlay({ token: ctx.viewer, play: play('b') }), { ok: false, reason: 'auth' });
});

test('the admin removes a play from the admin playbook', () => {
  const ctx = ctxWith();
  ctx.fns.handleSavePlay({ token: ctx.admin, book: 'admin', play: play('a') });
  ctx.fns.handleSavePlay({ token: ctx.admin, book: 'admin', play: play('b') });
  assert.equal(ctx.fns.handleDeletePlay({ token: ctx.admin, book: 'admin', id: 'a' }).ok, true);
  assert.deepEqual(ids(ctx.fns.handlePlays({ token: ctx.admin, book: 'admin' })), ['b']);
});

/* ---------------------------------------------------------------- */
/* Moving between the two                                            */
/* ---------------------------------------------------------------- */

test('admin -> team moves the play: it is in the team playbook and gone from the admin one', () => {
  const ctx = ctxWith();
  ctx.fns.handleSavePlay({ token: ctx.admin, book: 'admin', play: play('a', { name: 'Horns' }) });

  const res = ctx.fns.handleMovePlay({ token: ctx.admin, from: 'admin', to: 'team', id: 'a' });
  assert.equal(res.ok, true);
  assert.deepEqual(ids(ctx.fns.handlePlays({ token: ctx.admin, book: 'admin' })), []);
  const team = ctx.fns.handlePlays({ token: ctx.site });
  assert.deepEqual(ids(team), ['a']);
  assert.equal(team.plays[0].play.name, 'Horns', 'the play itself survives the move');
  assert.equal(team.plays[0].updatedBy, 'Alex Admin');
});

test('team -> admin takes it off the team playbook', () => {
  const ctx = ctxWith();
  ctx.fns.handleSavePlay({ token: ctx.site, play: play('a') });
  assert.equal(ctx.fns.handleMovePlay({ token: ctx.admin, from: 'team', to: 'admin', id: 'a' }).ok, true);
  assert.deepEqual(ids(ctx.fns.handlePlays({ token: ctx.site })), []);
  assert.deepEqual(ids(ctx.fns.handlePlays({ token: ctx.admin, book: 'admin' })), ['a']);
});

test('moving onto a play that is already there replaces it rather than duplicating it', () => {
  const ctx = ctxWith();
  ctx.fns.handleSavePlay({ token: ctx.site, play: play('a', { name: 'Old' }) });
  ctx.fns.handleSavePlay({ token: ctx.admin, book: 'admin', play: play('a', { name: 'New' }) });
  ctx.fns.handleMovePlay({ token: ctx.admin, from: 'admin', to: 'team', id: 'a' });

  const team = ctx.fns.handlePlays({ token: ctx.site });
  assert.deepEqual(ids(team), ['a']);
  assert.equal(team.plays[0].play.name, 'New');
});

test('a move with a missing play, the same book twice, or no id changes nothing', () => {
  const ctx = ctxWith();
  ctx.fns.handleSavePlay({ token: ctx.admin, book: 'admin', play: play('a') });

  assert.deepEqual(ctx.fns.handleMovePlay({ token: ctx.admin, from: 'admin', to: 'team', id: 'nope' }), { ok: false, reason: 'not_found' });
  assert.equal(ctx.fns.handleMovePlay({ token: ctx.admin, from: 'admin', to: 'admin', id: 'a' }).reason, 'bad_request');
  assert.equal(ctx.fns.handleMovePlay({ token: ctx.admin, from: 'admin', to: 'team' }).reason, 'bad_request');
  assert.equal(ctx.fns.handleMovePlay({ token: ctx.admin, from: 'admin', to: 'stats', id: 'a' }).reason, 'bad_request');
  assert.deepEqual(ids(ctx.fns.handlePlays({ token: ctx.admin, book: 'admin' })), ['a']);
});

test('if writing the destination fails, the play stays where it was', () => {
  // Copy first, delete second: a failure can leave the play in both places,
  // never in neither.
  const ctx = ctxWith();
  ctx.fns.handleSavePlay({ token: ctx.admin, book: 'admin', play: play('a') });
  ctx.fns.handlePlays({ token: ctx.site });   // creates the Plays tab
  ctx.sheets.Plays.appendRow = () => { throw new Error('quota'); };

  const res = post(ctx.fns, { action: 'movePlay', token: ctx.admin, from: 'admin', to: 'team', id: 'a' });
  assert.deepEqual(res, { ok: false, reason: 'error' });
  assert.deepEqual(ids(ctx.fns.handlePlays({ token: ctx.admin, book: 'admin' })), ['a']);
  assert.equal(ctx.locks.taken, ctx.locks.released, 'the lock is released even on failure');
});

/* ---------------------------------------------------------------- */
/* Cells                                                             */
/* ---------------------------------------------------------------- */

test('a play name that looks like a formula is stored as text', () => {
  // Otherwise it would run in the admin's spreadsheet when it is opened.
  const ctx = ctxWith();
  ctx.fns.handleSavePlay({ token: ctx.site, play: play('a', { name: '=IMPORTXML("http://x","//a")' }) });
  const stored = ctx.sheets.Plays.rows[1];
  assert.equal(stored[3], '\'=IMPORTXML("http://x","//a")');
  assert.equal(stored[0], 'a', 'ordinary text is left alone');
});

test('cellText guards = + - @ and nothing else', () => {
  const { fns } = loadCodeGs();
  for (const bad of ['=1+1', '+1', '-1', '@x']) assert.equal(fns.cellText(bad), `'${bad}`);
  for (const ok of ['Horns', '1-4 high', '', 'a=b']) assert.equal(fns.cellText(ok), ok);
  assert.equal(fns.cellText(null), '');
});

test('checkSetup creates the admin playbook tab and never touches an existing one', () => {
  const ctx = loadCodeGs();
  ctx.fns.checkSetup();
  assert.deepEqual(ctx.sheets.AdminPlays.rows[0], ['Id', 'Slug', 'Playbook', 'Name', 'Updated', 'UpdatedBy', 'JSON']);

  ctx.sheets.AdminPlays.rows.push(['a', 's', 'general', 'Kept', '', '', '{}']);
  ctx.fns.checkSetup();
  assert.equal(ctx.sheets.AdminPlays.rows.length, 2, 'no second header row, nothing cleared');
  assert.equal(ctx.sheets.AdminPlays.rows[1][3], 'Kept');
});

test('checkSetup reports a drifted header and leaves it alone', () => {
  const ctx = loadCodeGs();
  ctx.fns.checkSetup();
  ctx.sheets.AdminPlays.rows[0] = ['Something', 'Else'];
  ctx.fns.checkSetup();
  assert.deepEqual(ctx.sheets.AdminPlays.rows[0], ['Something', 'Else']);
  assert.match(ctx.logged.map((a) => a.join(' ')).join('\n'), /WARNING.*AdminPlays/);
});
