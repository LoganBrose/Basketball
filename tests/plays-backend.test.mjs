/**
 * The team playbook in the sheet: who can read it, who can change it, and what
 * happens when two people save at once or a play grows too large.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs } from './helpers/apps-script.mjs';

const play = (id, over = {}) => ({
  id,
  slug: `play-${id}`,
  playbook: 'general',
  name: `Play ${id}`,
  frames: [{ tokens: [], arrows: [], texts: [] }],
  ...over,
});

function ctxWith() {
  const ctx = loadCodeGs();
  ctx.site = ctx.fns.handleSignIn({ name: 'Casey Jones', password: 'team-pw' }).token;
  ctx.admin = ctx.fns.handleAdmin({ name: 'Logan Brose', password: 'admin-pw' }).token;
  return ctx;
}

/* ---------------------------------------------------------------- */
/* Reading                                                           */
/* ---------------------------------------------------------------- */

test('any signed-in coach can read the team playbook', () => {
  // It has to work on a phone with the team password, or it is not a team
  // playbook.
  const ctx = ctxWith();
  ctx.fns.handleSavePlay({ token: ctx.admin, play: play('a') });

  const res = ctx.fns.handlePlays({ token: ctx.site });
  assert.equal(res.ok, true);
  assert.equal(res.plays.length, 1);
  assert.equal(res.plays[0].id, 'a');
  assert.equal(res.plays[0].play.name, 'Play a');
});

test('reading without a token is refused', () => {
  const ctx = ctxWith();
  assert.deepEqual(ctx.fns.handlePlays({ token: '' }), { ok: false, reason: 'auth' });
  assert.deepEqual(ctx.fns.handlePlays({ token: 'garbage' }), { ok: false, reason: 'auth' });
});

test('one unreadable row does not take the whole playbook down', () => {
  // A hand-edited cell must cost one play, not every play.
  const ctx = ctxWith();
  ctx.fns.handleSavePlay({ token: ctx.admin, play: play('good') });
  ctx.fns.playsSheet().appendRow(['broken', 's', 'general', 'Broken', '', '', '{ not json']);
  ctx.fns.handleSavePlay({ token: ctx.admin, play: play('alsogood') });

  const res = ctx.fns.handlePlays({ token: ctx.site });
  assert.deepEqual(res.plays.map((p) => p.id), ['good', 'alsogood']);
});

/* ---------------------------------------------------------------- */
/* Writing is admin-only                                             */
/* ---------------------------------------------------------------- */

test('a site token cannot change the team playbook', () => {
  // The shared password is shared. Everyone who knows it should not be able to
  // rewrite what the whole team sees.
  const ctx = ctxWith();
  assert.deepEqual(
    ctx.fns.handleSavePlay({ token: ctx.site, play: play('x') }),
    { ok: false, reason: 'auth' },
  );
  assert.deepEqual(
    ctx.fns.handleDeletePlay({ token: ctx.site, id: 'x' }),
    { ok: false, reason: 'auth' },
  );
});

test('a refused save changes nothing at all', () => {
  const ctx = ctxWith();
  ctx.fns.handleSavePlay({ token: ctx.admin, play: play('a', { name: 'Original' }) });
  ctx.fns.handleSavePlay({ token: ctx.site, play: play('a', { name: 'Vandalised' }) });

  const plays = ctx.fns.handlePlays({ token: ctx.admin }).plays;
  assert.equal(plays.length, 1);
  assert.equal(plays[0].play.name, 'Original');
});

test('an expired admin token cannot save', () => {
  const ctx = ctxWith();
  const stale = ctx.fns.makeToken('admin', 'Logan Brose', Date.now() - 1);
  assert.deepEqual(
    ctx.fns.handleSavePlay({ token: stale, play: play('x') }),
    { ok: false, reason: 'auth' },
  );
});

/* ---------------------------------------------------------------- */
/* Upsert                                                            */
/* ---------------------------------------------------------------- */

test('saving the same id twice replaces rather than duplicates', () => {
  // The migration button can be clicked twice; that must be harmless.
  const ctx = ctxWith();
  ctx.fns.handleSavePlay({ token: ctx.admin, play: play('a', { name: 'First' }) });
  ctx.fns.handleSavePlay({ token: ctx.admin, play: play('a', { name: 'Second' }) });

  const plays = ctx.fns.handlePlays({ token: ctx.admin }).plays;
  assert.equal(plays.length, 1);
  assert.equal(plays[0].play.name, 'Second');
});

test('different ids are different plays even with the same name', () => {
  const ctx = ctxWith();
  ctx.fns.handleSavePlay({ token: ctx.admin, play: play('a', { name: 'Horns' }) });
  ctx.fns.handleSavePlay({ token: ctx.admin, play: play('b', { name: 'Horns' }) });
  assert.equal(ctx.fns.handlePlays({ token: ctx.admin }).plays.length, 2);
});

test('a save records who made it', () => {
  const ctx = ctxWith();
  const res = ctx.fns.handleSavePlay({ token: ctx.admin, play: play('a') });
  assert.equal(res.updatedBy, 'Logan Brose');
  assert.equal(ctx.fns.handlePlays({ token: ctx.admin }).plays[0].updatedBy, 'Logan Brose');
});

test('a play with no id is a bad request, not a new row', () => {
  const ctx = ctxWith();
  assert.deepEqual(
    ctx.fns.handleSavePlay({ token: ctx.admin, play: { name: 'No id' } }),
    { ok: false, reason: 'bad_request' },
  );
  assert.deepEqual(
    ctx.fns.handleSavePlay({ token: ctx.admin }),
    { ok: false, reason: 'bad_request' },
  );
  assert.equal(ctx.fns.handlePlays({ token: ctx.admin }).plays.length, 0);
});

/* ---------------------------------------------------------------- */
/* Size                                                              */
/* ---------------------------------------------------------------- */

test('a play too large for a sheet cell is refused with a reason', () => {
  // Writing it would truncate the cell and corrupt the play on the next read,
  // which surfaces much later and looks like data loss.
  const ctx = ctxWith();
  const huge = play('big', { notes: 'x'.repeat(46000) });

  assert.deepEqual(
    ctx.fns.handleSavePlay({ token: ctx.admin, play: huge }),
    { ok: false, reason: 'too_big' },
  );
  assert.equal(ctx.fns.handlePlays({ token: ctx.admin }).plays.length, 0, 'nothing was written');
});

test('a play just under the limit still saves', () => {
  const ctx = ctxWith();
  const big = play('ok', { notes: 'x'.repeat(44000) });
  assert.equal(ctx.fns.handleSavePlay({ token: ctx.admin, play: big }).ok, true);
  assert.equal(ctx.fns.handlePlays({ token: ctx.admin }).plays[0].play.notes.length, 44000);
});

/* ---------------------------------------------------------------- */
/* Deleting                                                          */
/* ---------------------------------------------------------------- */

test('deleting removes that play and leaves the others alone', () => {
  const ctx = ctxWith();
  for (const id of ['a', 'b', 'c']) ctx.fns.handleSavePlay({ token: ctx.admin, play: play(id) });

  assert.equal(ctx.fns.handleDeletePlay({ token: ctx.admin, id: 'b' }).ok, true);
  assert.deepEqual(
    ctx.fns.handlePlays({ token: ctx.admin }).plays.map((p) => p.id),
    ['a', 'c'],
  );
});

test('deleting something already gone is the outcome that was asked for', () => {
  const ctx = ctxWith();
  assert.equal(ctx.fns.handleDeletePlay({ token: ctx.admin, id: 'nope' }).ok, true);
});

test('deleting without an id is refused', () => {
  const ctx = ctxWith();
  assert.deepEqual(
    ctx.fns.handleDeletePlay({ token: ctx.admin }),
    { ok: false, reason: 'bad_request' },
  );
});

test('the row after a deletion is still addressable', () => {
  // Off-by-one here would edit the wrong play, silently.
  const ctx = ctxWith();
  for (const id of ['a', 'b', 'c']) ctx.fns.handleSavePlay({ token: ctx.admin, play: play(id) });
  ctx.fns.handleDeletePlay({ token: ctx.admin, id: 'a' });
  ctx.fns.handleSavePlay({ token: ctx.admin, play: play('c', { name: 'Edited' }) });

  const plays = ctx.fns.handlePlays({ token: ctx.admin }).plays;
  assert.deepEqual(plays.map((p) => p.id), ['b', 'c']);
  assert.equal(plays.find((p) => p.id === 'c').play.name, 'Edited');
  assert.equal(plays.find((p) => p.id === 'b').play.name, 'Play b', 'b was not disturbed');
});

/* ---------------------------------------------------------------- */
/* Locking                                                           */
/* ---------------------------------------------------------------- */

test('every write takes the script lock and releases it', () => {
  // Without the lock, two saves can interleave between finding the row and
  // writing it, and one disappears with no error anywhere.
  const ctx = loadCodeGs();
  const admin = ctx.fns.handleAdmin({ name: 'Logan Brose', password: 'admin-pw' }).token;

  assert.equal(ctx.locks.taken, 0);
  ctx.fns.handleSavePlay({ token: admin, play: play('a') });
  ctx.fns.handleDeletePlay({ token: admin, id: 'a' });

  assert.equal(ctx.locks.taken, 2, 'both writes locked');
  assert.equal(ctx.locks.released, 2, 'and both released');
});

test('the lock is released even when the write throws', () => {
  // A lock left held blocks every later save for its full timeout.
  const ctx = loadCodeGs();
  const admin = ctx.fns.handleAdmin({ name: 'Logan Brose', password: 'admin-pw' }).token;

  ctx.sheets.Plays = {
    getDataRange: () => ({ getDisplayValues: () => [[]] }),
    appendRow: () => { throw new Error('sheet exploded'); },
    setFrozenRows: () => {},
  };

  assert.throws(() => ctx.fns.handleSavePlay({ token: admin, play: play('a') }));
  assert.equal(ctx.locks.released, 1);
});
