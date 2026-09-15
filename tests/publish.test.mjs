import test from 'node:test';
import assert from 'node:assert/strict';
import {
  publishPlan, markPublished, mergeById, playPath, playbookPath,
  newFileUrl, editFileUrl, fileUrl, URL_LIMIT,
} from '../assets/js/publish.js';

function play(overrides = {}) {
  return {
    schema: 1,
    id: 'abc-123',
    name: 'Horns Flare',
    category: 'Set',
    tags: ['horns'],
    notes: '',
    courtType: 'half',
    preset: 'hs',
    frames: [{ label: 'Initial', tokens: [], arrows: [], texts: [] }],
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

/* ---------------------------------------------------------------- */
/* Paths                                                             */
/* ---------------------------------------------------------------- */

test('a play with no playbook lives at the plays/ root', () => {
  assert.equal(playPath(play()), 'plays/horns-flare.json');
});

test('a play in a playbook lives in that folder', () => {
  assert.equal(playPath(play(), 'zone-offense'), 'plays/zone-offense/horns-flare.json');
  assert.equal(playbookPath('zone-offense'), 'plays/zone-offense/playbook.json');
});

test('URLs point at the Main branch, which is what Pages deploys', () => {
  assert.match(newFileUrl('plays/a.json', '{}'), /\/new\/Main\?/);
  assert.equal(editFileUrl('plays/a.json'), 'https://github.com/loganbrose/basketball/edit/Main/plays/a.json');
  assert.equal(fileUrl('plays/a.json'), 'https://github.com/loganbrose/basketball/blob/Main/plays/a.json');
});

/* ---------------------------------------------------------------- */
/* The three branches                                                */
/* ---------------------------------------------------------------- */

test('a play not on the site gets a prefilled new-file URL', () => {
  const plan = publishPlan(play(), []);
  assert.equal(plan.action, 'create');
  assert.equal(plan.path, 'plays/horns-flare.json');
  assert.match(plan.url, /\/new\/Main\?/);
  assert.match(plan.url, /filename=plays%2Fhorns-flare\.json/);
  assert.match(plan.url, /value=/, 'content is prefilled');
  assert.equal(plan.clipboardOnly, false);
});

test('the same id already on the site is an update, not a second file', () => {
  // Re-publishing an edited play must change the file it came from. Creating a
  // second one would fork the play and neither copy would be authoritative.
  const team = [{ id: 'abc-123', name: 'Horns Flare', path: 'plays/general/horns-flare.json' }];
  const plan = publishPlan(play(), team);

  assert.equal(plan.action, 'update');
  assert.equal(plan.path, 'plays/general/horns-flare.json', 'edits where it actually lives');
  assert.equal(plan.url, 'https://github.com/loganbrose/basketball/edit/Main/plays/general/horns-flare.json');
  assert.ok(plan.clipboard, 'content goes via the clipboard');
  assert.equal(plan.clipboardOnly, true);
  assert.match(plan.message, /paste/i);
});

test('an update follows the play even when it was renamed locally', () => {
  const team = [{ id: 'abc-123', name: 'Horns Flare', path: 'plays/general/horns-flare.json' }];
  const plan = publishPlan(play({ name: 'Horns Flare v2' }), team);
  assert.equal(plan.action, 'update');
  assert.equal(plan.path, 'plays/general/horns-flare.json', 'the id decides, not the new name');
});

test('the same filename owned by a different play is a conflict', () => {
  // Publishing here would overwrite someone else's play, so nothing is handed
  // back until it's renamed.
  const team = [{ id: 'someone-else', name: 'Horns Flare', path: 'plays/horns-flare.json' }];
  const plan = publishPlan(play(), team);

  assert.equal(plan.action, 'conflict');
  assert.equal(plan.url, null, 'no URL until it is renamed');
  assert.equal(plan.clipboard, null);
  assert.match(plan.message, /already uses this filename/i);
  assert.equal(plan.conflictWith.id, 'someone-else');
});

test('renaming clears the conflict', () => {
  const team = [{ id: 'someone-else', name: 'Horns Flare', path: 'plays/horns-flare.json' }];
  const plan = publishPlan(play({ name: 'Horns Flare Left' }), team);
  assert.equal(plan.action, 'create');
  assert.equal(plan.path, 'plays/horns-flare-left.json');
});

/* ---------------------------------------------------------------- */
/* Over-length fallback                                              */
/* ---------------------------------------------------------------- */

test('a play too big to prefill falls back to the clipboard', () => {
  // The clipboard works on a phone. Downloading a file and dragging it into a
  // browser does not, which is why that is not the fallback.
  const huge = play({ notes: 'x'.repeat(URL_LIMIT) });
  const plan = publishPlan(huge, []);

  assert.equal(plan.action, 'create');
  assert.equal(plan.clipboardOnly, true);
  assert.ok(plan.clipboard.length > 1000);
  assert.match(plan.url, /filename=/);
  assert.ok(!plan.url.includes('value='), 'no content in the URL');
  assert.ok(plan.url.length < URL_LIMIT, 'the fallback URL is itself short');
  assert.match(plan.message, /Copied/);
});

test('a normal play stays under the URL limit', () => {
  assert.ok(publishPlan(play(), []).url.length <= URL_LIMIT);
});

/* ---------------------------------------------------------------- */
/* New playbook                                                      */
/* ---------------------------------------------------------------- */

test('a playbook that does not exist yet needs its own commit first', () => {
  const plan = publishPlan(play(), [], {
    playbook: 'zone-offense',
    playbookExists: false,
    playbookName: 'Zone Offense',
  });
  assert.equal(plan.path, 'plays/zone-offense/horns-flare.json');
  assert.match(plan.playbookUrl, /filename=plays%2Fzone-offense%2Fplaybook\.json/);
  assert.match(decodeURIComponent(plan.playbookUrl), /"name":"Zone Offense"/);
  assert.match(plan.message, /two commits/i);
});

test('an existing playbook needs no extra commit', () => {
  const plan = publishPlan(play(), [], { playbook: 'zone-offense', playbookExists: true });
  assert.equal(plan.playbookUrl, null);
});

/* ---------------------------------------------------------------- */
/* Published badging                                                 */
/* ---------------------------------------------------------------- */

test('a device play whose id is on the site is marked published', () => {
  const team = [{ id: 'abc-123', updatedAt: '2026-01-02T00:00:00.000Z', path: 'plays/a.json' }];
  const [marked] = markPublished([play()], team);
  assert.equal(marked.published, true);
  assert.equal(marked.newerThanTeam, false);
  assert.equal(marked.teamPath, 'plays/a.json');
});

test('a device copy edited since publishing is flagged, not treated as a stale duplicate', () => {
  const team = [{ id: 'abc-123', updatedAt: '2026-01-01T00:00:00.000Z' }];
  const [marked] = markPublished([play({ updatedAt: '2026-06-01T00:00:00.000Z' })], team);
  assert.equal(marked.published, true);
  assert.equal(marked.newerThanTeam, true, 'unpublished work must be visible');
});

test('an unpublished play is not marked', () => {
  const [marked] = markPublished([play()], []);
  assert.equal(marked.published, false);
});

/* ---------------------------------------------------------------- */
/* Merged view                                                       */
/* ---------------------------------------------------------------- */

test('a play on both sides appears once, as the team version', () => {
  const team = [{ id: 'abc-123', name: 'Horns Flare', updatedAt: '2026-01-02T00:00:00.000Z' }];
  const merged = mergeById([play()], team);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, 'team');
  assert.equal(merged[0].hasDeviceCopy, true);
  assert.equal(merged[0].deviceNewer, false);
});

test('a newer device copy is flagged on the merged card', () => {
  const team = [{ id: 'abc-123', name: 'Horns Flare', updatedAt: '2026-01-01T00:00:00.000Z' }];
  const merged = mergeById([play({ updatedAt: '2026-09-01T00:00:00.000Z' })], team);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].deviceNewer, true);
});

test('device-only plays survive the merge', () => {
  const merged = mergeById([play({ id: 'local-only', name: 'Zipper' })], []);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, 'device');
});

test('an empty library on either side is not an error', () => {
  assert.deepEqual(mergeById([], []), []);
  assert.equal(mergeById([], [{ id: 't1', name: 'T' }]).length, 1);
});
