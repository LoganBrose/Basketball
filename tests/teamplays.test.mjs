/**
 * The browser half of the sheet-backed team playbook: the shape the editor
 * depends on, what each failure should say, and the migration being safe to
 * run twice.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rowsToTeam, titleFromSlug, playsToMigrate, saveMessage,
} from '../assets/js/teamplays.js';
import { mergePlaybooks } from '../assets/js/playbooks.js';

const row = (id, over = {}) => ({
  id,
  playbook: 'general',
  name: `Play ${id}`,
  updated: '9/16/2026 10:00:00',
  updatedBy: 'Logan Brose',
  play: {
    id, name: `Play ${id}`, playbook: 'general',
    frames: [{ tokens: [{ kind: 'offense', label: '1', x: 25, y: 27 }], arrows: [], texts: [] }],
  },
  ...over,
});

/* ---------------------------------------------------------------- */
/* Rows -> the shape the editor already speaks                       */
/* ---------------------------------------------------------------- */

test('sheet rows become the same structure the file index produced', () => {
  // The rest of the editor was written against that shape; this is what lets
  // the source swap without rewriting the library.
  const { plays, playbooks } = rowsToTeam([
    row('a'),
    row('b', { playbook: 'zone-offense' }),
    row('c', { playbook: 'zone-offense' }),
  ]);

  assert.deepEqual(plays.map((p) => p.id), ['a', 'b', 'c']);
  assert.deepEqual(playbooks.map((pb) => pb.slug), ['general', 'zone-offense']);
  assert.equal(playbooks.find((pb) => pb.slug === 'zone-offense').plays.length, 2);
});

test('every play carries the playbook it belongs to', () => {
  const { plays } = rowsToTeam([row('a', { playbook: 'press-break' })]);
  assert.equal(plays[0].playbook, 'press-break');
});

test('the result feeds mergePlaybooks unchanged', () => {
  // The picker merges team and device by slug. If the shapes disagreed, a
  // playbook would show up twice.
  const { playbooks } = rowsToTeam([row('a', { playbook: 'zone-offense' })]);
  const merged = mergePlaybooks(playbooks, [{ slug: 'zone-offense', name: 'My Zone Stuff' }], []);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].teamCount, 1);
  assert.equal(merged[0].onSite, true);
});

test('a play is normalized on the way in', () => {
  // A hand-edited cell must not be able to put a shape the editor cannot
  // render into the library.
  const { plays } = rowsToTeam([row('a', { play: { id: 'a', name: 'Bare' } })]);
  assert.ok(Array.isArray(plays[0].frames), 'frames exist even when the cell had none');
  assert.equal(plays[0].id, 'a');
});

test('a row with no play object is skipped rather than crashing the list', () => {
  const { plays } = rowsToTeam([row('a'), { id: 'b', playbook: 'general' }, null, row('c')]);
  assert.deepEqual(plays.map((p) => p.id), ['a', 'c']);
});

test('a play with no playbook lands in General', () => {
  const { plays } = rowsToTeam([row('a', { playbook: '' })]);
  assert.equal(plays[0].playbook, 'general');
});

test('who last changed a play is carried through', () => {
  const { plays } = rowsToTeam([row('a', { updatedBy: 'Casey Jones' })]);
  assert.equal(plays[0].updatedBy, 'Casey Jones');
});

test('a slug with no declared name gets a readable one', () => {
  assert.equal(titleFromSlug('zone-offense'), 'Zone Offense');
  assert.equal(titleFromSlug('general'), 'General');
  assert.equal(titleFromSlug('blobs-slobs'), 'Blobs Slobs');
  assert.equal(titleFromSlug(''), '');
});

/* ---------------------------------------------------------------- */
/* Migration                                                         */
/* ---------------------------------------------------------------- */

const filePlay = (id, name) => ({ id, name, frames: [] });

test('migration moves only what the sheet does not already have', () => {
  const pending = playsToMigrate(
    [filePlay('a', 'Horns Flare'), filePlay('b', 'Overload')],
    rowsToTeam([row('a')]).plays,
  );
  assert.deepEqual(pending.map((p) => p.id), ['b']);
});

test('clicking migrate twice is harmless', () => {
  // The second click finds nothing left to move rather than duplicating.
  const files = [filePlay('a', 'Horns Flare')];
  const afterFirstRun = rowsToTeam([row('a')]).plays;
  assert.deepEqual(playsToMigrate(files, afterFirstRun), []);
});

test('the offer disappears when there is nothing left in the files', () => {
  assert.deepEqual(playsToMigrate([], rowsToTeam([row('a')]).plays), []);
  assert.deepEqual(playsToMigrate([], []), []);
});

test('a file play with no id is not migrated', () => {
  // It would arrive in the sheet with no identity and could never be updated.
  assert.deepEqual(playsToMigrate([{ name: 'No id', frames: [] }], []), []);
});

/* ---------------------------------------------------------------- */
/* What a failure should say                                         */
/* ---------------------------------------------------------------- */

test('each way a save can fail gets its own sentence', () => {
  assert.equal(saveMessage({ ok: true, data: { ok: true } }), '');

  assert.match(
    saveMessage({ ok: true, data: { ok: false, reason: 'auth' } }),
    /admin password/,
  );

  const tooBig = saveMessage({ ok: true, data: { ok: false, reason: 'too_big' } });
  assert.match(tooBig, /too large/);
  assert.match(tooBig, /Split it into two plays|remove frames/,
    'it must say what to do, not just that it failed');

  assert.match(saveMessage({ ok: false, error: 'Failed to fetch' }), /Couldn't reach/);
});

test('an unexpected refusal still says something true', () => {
  assert.match(saveMessage({ ok: true, data: { ok: false, reason: 'weird' } }), /Couldn't save/);
});
