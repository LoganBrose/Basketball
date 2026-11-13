/**
 * The browser half of the sheet-backed team playbook: the shape the editor
 * depends on and what each failure should say.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rowsToTeam, titleFromSlug, saveMessage,
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
/* What a failure should say                                         */
/* ---------------------------------------------------------------- */

test('each way a save can fail gets its own sentence', () => {
  assert.equal(saveMessage({ ok: true, data: { ok: true } }), '');

  assert.match(
    saveMessage({ ok: true, data: { ok: false, reason: 'auth' } }),
    /Sign in again/,
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

/* ---------------------------------------------------------------- */
/* Who may change the team playbook                                  */
/* ---------------------------------------------------------------- */

test('a coach and the admin can publish; a viewer and a signed-out browser cannot', async () => {
  const { canPublish } = await import('../assets/js/teamplays.js');
  const now = Date.now();
  const coach = { name: 'Casey Jones', token: 'tok', role: 'site', at: now };
  const viewer = { name: 'Pat', token: 'tok', role: 'viewer', at: now, until: now + 60_000 };
  const admin = { name: 'Logan Brose', token: 'tok', at: now, until: now + 60_000 };

  const cases = [
    // [site session, admin session, canPublish, why]
    [coach, null, true, 'a coach publishes'],
    [viewer, null, false, 'a viewer only reads'],
    [coach, admin, true, 'the admin publishes'],
    [null, null, false, 'nobody signed in'],
  ];

  const previous = globalThis.localStorage;
  try {
    for (const [site, adm, publish, why] of cases) {
      const store = new Map();
      globalThis.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
      };
      if (site) store.set('bb.gate.v1', JSON.stringify(site));
      if (adm) store.set('bb.admin.v1', JSON.stringify(adm));
      assert.equal(canPublish(), publish, `canPublish: ${why}`);
    }
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});

/* ---------------------------------------------------------------- */
/* The admin playbook, from the page's side                          */
/* ---------------------------------------------------------------- */

test('save messages name the book they are about', () => {
  assert.match(saveMessage({ ok: false, error: 'x' }, 'admin'), /admin playbook/);
  assert.match(saveMessage({ ok: true, data: { ok: false, reason: 'too_big' } }, 'admin'), /admin playbook/);
  // The admin playbook answers a lapsed admin session like a missing action.
  assert.match(saveMessage({ ok: true, data: { ok: false, reason: 'unknown_action' } }, 'admin'), /Sign in again/);
  assert.match(saveMessage({ ok: true, data: { ok: false, reason: 'not_found' } }, 'admin'), /no longer/);
});

test('the admin playbook is offered only to an admin session the script has confirmed', async () => {
  const { canUseAdminBook } = await import('../assets/js/teamplays.js');
  const now = Date.now();
  const coach = { name: 'Casey Jones', token: 'tok', role: 'site', at: now };
  const admin = { name: 'Logan Brose', token: 'tok', at: now, until: now + 60_000 };
  const told = JSON.stringify({ list: ['adminPlaybook'], at: now });

  const cases = [
    // [site, admin, features, expected, why]
    [coach, null, told, false, 'a coach, even with a forged feature entry'],
    [coach, admin, null, false, 'an admin before the script has said so (site deployed before script)'],
    [coach, admin, told, true, 'an admin the script confirmed'],
    [coach, { ...admin, until: now - 1 }, told, false, 'an admin session that lapsed'],
  ];

  const previous = globalThis.localStorage;
  try {
    for (const [site, adm, features, expected, why] of cases) {
      const store = new Map();
      globalThis.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
      };
      if (site) store.set('bb.gate.v1', JSON.stringify(site));
      if (adm) store.set('bb.admin.v1', JSON.stringify(adm));
      if (features) store.set('bb.features.v1', features);
      assert.equal(canUseAdminBook(), expected, why);
    }
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});
