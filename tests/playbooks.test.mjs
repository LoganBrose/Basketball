import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  slugifyPlaybook, mergePlaybooks, playbookOf, flattenTeamPlays,
  findSlugConflict, playbookExistsOnSite, DEFAULT_PLAYBOOK,
} from '../assets/js/playbooks.js';
import { normalizePlay, exportPlay } from '../assets/js/library.js';

const run = promisify(execFile);

/* ---------------------------------------------------------------- */
/* Slugs and membership                                              */
/* ---------------------------------------------------------------- */

test('playbook names become folder-safe slugs', () => {
  assert.equal(slugifyPlaybook('Zone Offense'), 'zone-offense');
  assert.equal(slugifyPlaybook('BLOBs / SLOBs'), 'blobs-slobs');
  assert.equal(slugifyPlaybook('  '), 'playbook');
});

test('a play with no playbook belongs to General rather than nowhere', () => {
  assert.equal(playbookOf({ name: 'x' }), DEFAULT_PLAYBOOK);
  assert.equal(playbookOf({ playbook: 'press-break' }), 'press-break');
});

/* ---------------------------------------------------------------- */
/* Merging team and device                                           */
/* ---------------------------------------------------------------- */

test('a playbook on both the site and this device is one entry, not two', () => {
  // Two "Zone Offense" rows would mean checking both to find one play.
  const merged = mergePlaybooks(
    [{ slug: 'zone-offense', name: 'Zone Offense', order: 2, plays: [{ id: 't1' }] }],
    [{ slug: 'zone-offense', name: 'Zone Offense' }],
    [{ id: 'd1', playbook: 'zone-offense' }],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].teamCount, 1);
  assert.equal(merged[0].deviceCount, 1);
  assert.equal(merged[0].count, 2);
  assert.equal(merged[0].onSite, true);
});

test('a device-only playbook appears, marked as not on the site', () => {
  const merged = mergePlaybooks([], [{ slug: 'press-break', name: 'Press Break' }], []);
  assert.equal(merged[0].onSite, false);
  assert.equal(merged[0].count, 0);
});

test('a play referencing an undeclared playbook still has somewhere to live', () => {
  // Otherwise the play would vanish from every view.
  const merged = mergePlaybooks([], [], [{ id: 'd1', playbook: 'mystery' }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].slug, 'mystery');
  assert.equal(merged[0].deviceCount, 1);
});

test('playbooks sort by order, then by name', () => {
  const merged = mergePlaybooks([
    { slug: 'z', name: 'Zone', order: 2, plays: [] },
    { slug: 'm', name: 'Man', order: 1, plays: [] },
    { slug: 'a', name: 'Aardvark', order: 2, plays: [] },
  ], [], []);
  assert.deepEqual(merged.map((p) => p.slug), ['m', 'a', 'z']);
});

test('the site name wins when both sides name the same playbook', () => {
  const merged = mergePlaybooks(
    [{ slug: 'zone-offense', name: 'Zone Offense', plays: [] }],
    [{ slug: 'zone-offense', name: 'My Zone Stuff' }],
    [],
  );
  assert.equal(merged[0].name, 'Zone Offense', 'everyone else sees the site name');
});

test('flattening the index tags each play with its playbook', () => {
  const flat = flattenTeamPlays([
    { slug: 'general', plays: [{ id: 'a' }] },
    { slug: 'zone-offense', plays: [{ id: 'b' }] },
  ]);
  assert.deepEqual(flat.map((p) => `${p.id}:${p.playbook}`), ['a:general', 'b:zone-offense']);
});

/* ---------------------------------------------------------------- */
/* Publish conflicts                                                 */
/* ---------------------------------------------------------------- */

test('a different play at the same path in the same playbook is a conflict', () => {
  const team = [{ id: 'other', name: 'Horns Flare', path: 'plays/zone-offense/horns-flare.json' }];
  const hit = findSlugConflict(team, 'zone-offense', 'horns-flare', 'mine');
  assert.equal(hit.id, 'other');
});

test('the same play at that path is not a conflict — it is an update', () => {
  const team = [{ id: 'mine', name: 'Horns Flare', path: 'plays/zone-offense/horns-flare.json' }];
  assert.equal(findSlugConflict(team, 'zone-offense', 'horns-flare', 'mine'), null);
});

test('the same filename in a different playbook is not a conflict', () => {
  // Separate folders, separate files.
  const team = [{ id: 'other', name: 'Horns Flare', path: 'plays/man-offense/horns-flare.json' }];
  assert.equal(findSlugConflict(team, 'zone-offense', 'horns-flare', 'mine'), null);
});

test('playbookExistsOnSite decides whether a second commit is needed', () => {
  const books = [{ slug: 'general' }];
  assert.equal(playbookExistsOnSite(books, 'general'), true);
  assert.equal(playbookExistsOnSite(books, 'zone-offense'), false);
});

/* ---------------------------------------------------------------- */
/* Play data                                                         */
/* ---------------------------------------------------------------- */

test('a play saved into a playbook still stores positions 1-5 only', () => {
  const play = normalizePlay({
    name: 'Horns Flare',
    playbook: 'zone-offense',
    frames: [{
      tokens: [
        { kind: 'offense', label: '1', x: 25, y: 27 },
        { kind: 'offense', label: '5', x: 16, y: 11 },
      ],
      arrows: [], texts: [],
    }],
  });

  assert.equal(play.playbook, 'zone-offense');
  const json = exportPlay(play);
  for (const needle of ['P1', 'John Smith', 'lineup', 'jersey']) {
    assert.ok(!json.includes(needle), `a play must not carry "${needle}"`);
  }
  assert.deepEqual(play.frames[0].tokens.map((t) => t.label), ['1', '5']);
});

/* ---------------------------------------------------------------- */
/* Index generation                                                  */
/* ---------------------------------------------------------------- */

async function buildIndexIn(tree) {
  // Run the real generator against a throwaway tree, never the repo's plays/.
  const dir = await mkdtemp(join(tmpdir(), 'plays-'));
  const playsDir = join(dir, 'plays');
  const toolsDir = join(dir, 'tools');
  await mkdir(playsDir, { recursive: true });
  await mkdir(toolsDir, { recursive: true });
  await writeFile(join(toolsDir, 'build-plays-index.mjs'),
    await readFile(new URL('../tools/build-plays-index.mjs', import.meta.url), 'utf8'));

  for (const [path, contents] of Object.entries(tree)) {
    const full = join(playsDir, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, typeof contents === 'string' ? contents : JSON.stringify(contents));
  }

  await run('node', [join(toolsDir, 'build-plays-index.mjs')]);
  const index = JSON.parse(await readFile(join(playsDir, 'index.json'), 'utf8'));
  await rm(dir, { recursive: true, force: true });
  return index;
}

const play = (name) => ({ id: `id-${name}`, name, frames: [{ tokens: [], arrows: [], texts: [] }] });

test('multiple playbook folders each become an index entry', async () => {
  const index = await buildIndexIn({
    'general/playbook.json': { name: 'General', order: 1 },
    'general/horns-flare.json': play('Horns Flare'),
    'zone-offense/playbook.json': { name: 'Zone Offense', description: 'vs 2-3', order: 2 },
    'zone-offense/overload.json': play('Overload'),
    'zone-offense/short-corner.json': play('Short Corner'),
  });

  assert.deepEqual(index.playbooks.map((p) => p.slug), ['general', 'zone-offense']);
  assert.equal(index.playbooks[1].name, 'Zone Offense');
  assert.equal(index.playbooks[1].description, 'vs 2-3');
  assert.equal(index.playbooks[1].plays.length, 2);
  assert.equal(index.playbooks[1].plays[0].path, 'plays/zone-offense/overload.json');
});

test('order in playbook.json decides the listing, not folder names', async () => {
  const index = await buildIndexIn({
    'aaa/playbook.json': { name: 'Aaa', order: 9 },
    'aaa/x.json': play('X'),
    'zzz/playbook.json': { name: 'Zzz', order: 1 },
    'zzz/y.json': play('Y'),
  });
  assert.deepEqual(index.playbooks.map((p) => p.slug), ['zzz', 'aaa']);
});

test('a loose play at the plays/ root is swept into General, not lost', async () => {
  // A file dropped in the wrong place must still publish.
  const index = await buildIndexIn({
    'general/playbook.json': { name: 'General', order: 1 },
    'general/a.json': play('A'),
    'stray.json': play('Stray'),
  });

  const general = index.playbooks.find((p) => p.slug === 'general');
  assert.equal(general.plays.length, 2);
  const stray = general.plays.find((p) => p.name === 'Stray');
  assert.equal(stray.path, 'plays/stray.json', 'it keeps the path it is actually served from');
});

test('a loose file with no General folder still gets one', async () => {
  const index = await buildIndexIn({ 'stray.json': play('Stray') });
  assert.equal(index.playbooks.length, 1);
  assert.equal(index.playbooks[0].slug, 'general');
  assert.equal(index.playbooks[0].plays.length, 1);
});

test('a folder without a playbook.json is still indexed', async () => {
  const index = await buildIndexIn({ 'press-break/a.json': play('A') });
  assert.equal(index.playbooks[0].slug, 'press-break');
  assert.equal(index.playbooks[0].plays.length, 1);
});

test('one malformed play does not take the deploy down with it', async () => {
  const index = await buildIndexIn({
    'general/playbook.json': { name: 'General', order: 1 },
    'general/good.json': play('Good'),
    'general/broken.json': '{ not json',
  });
  const general = index.playbooks.find((p) => p.slug === 'general');
  assert.deepEqual(general.plays.map((p) => p.name), ['Good']);
});

test('playbook.json is never indexed as a play', async () => {
  const index = await buildIndexIn({
    'general/playbook.json': { name: 'General', order: 1 },
    'general/a.json': play('A'),
  });
  assert.deepEqual(index.playbooks[0].plays.map((p) => p.file), ['a.json']);
});
