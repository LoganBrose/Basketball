import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseImport, normalizePlay, searchPlays, allCategories, allTags,
  exportPlay, exportLibrary, slugify, emptyFrame,
} from '../assets/js/library.js';

/** A play as it lands on disk. */
function play(overrides = {}) {
  return {
    schema: 1,
    id: 'p1',
    name: 'Horns Flare',
    category: 'Set',
    tags: ['horns', 'ATO'],
    notes: '5 steps up, 4 flares',
    courtType: 'half',
    preset: 'hs',
    frames: [{
      label: 'Initial',
      tokens: [{ id: 't1', kind: 'offense', label: '1', x: 25, y: 27, hasBall: true }],
      arrows: [{ id: 'a1', kind: 'cut', from: { x: 25, y: 27 }, to: { x: 25, y: 9 }, ctrl: null }],
      texts: [],
    }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

/* ---------------------------------------------------------------- */
/* Round-tripping                                                    */
/* ---------------------------------------------------------------- */

test('a play survives export and re-import unchanged', () => {
  // This is the whole promise of storing plays as data: positions come back
  // as positions, not as a picture.
  const original = play();
  const { plays, errors } = parseImport(exportPlay(original));
  assert.deepEqual(errors, []);
  assert.equal(plays.length, 1);
  assert.equal(plays[0].name, 'Horns Flare');
  assert.deepEqual(plays[0].tags, ['horns', 'ATO']);
  assert.equal(plays[0].frames[0].tokens[0].x, 25);
  assert.equal(plays[0].frames[0].tokens[0].hasBall, true);
  assert.deepEqual(plays[0].frames[0].arrows[0].to, { x: 25, y: 9 });
});

test('a curved arrow keeps its control point through a round-trip', () => {
  const curved = play();
  curved.frames[0].arrows[0].ctrl = { x: 19, y: 16 };
  const { plays } = parseImport(exportPlay(curved));
  assert.deepEqual(plays[0].frames[0].arrows[0].ctrl, { x: 19, y: 16 });
});

test('a whole-library export re-imports as many plays', () => {
  const lib = exportLibrary([play(), play({ id: 'p2', name: 'Zipper' })]);
  const { plays, errors } = parseImport(lib);
  assert.deepEqual(errors, []);
  assert.deepEqual(plays.map((p) => p.name), ['Horns Flare', 'Zipper']);
});

test('a bare array of plays imports too', () => {
  const { plays } = parseImport(JSON.stringify([play()]));
  assert.equal(plays.length, 1);
});

/* ---------------------------------------------------------------- */
/* Bad input                                                         */
/* ---------------------------------------------------------------- */

test('invalid JSON reports the parse error rather than throwing', () => {
  const { plays, errors } = parseImport('{not json');
  assert.equal(plays.length, 0);
  assert.match(errors[0], /Not valid JSON/);
});

test('a file that is not a play is rejected with a readable reason', () => {
  const { plays, errors } = parseImport(JSON.stringify({ hello: 'world' }));
  assert.equal(plays.length, 0);
  assert.match(errors[0], /doesn't look like a play/);
});

test('one bad play in a library does not discard the good ones', () => {
  const { plays, errors } = parseImport(JSON.stringify({ plays: [play(), { name: 'broken' }] }));
  assert.equal(plays.length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Play 2/);
});

/* ---------------------------------------------------------------- */
/* Normalizing hand-edited files                                     */
/* ---------------------------------------------------------------- */

test('missing fields are filled in rather than left undefined', () => {
  const p = normalizePlay({ frames: [{ tokens: [{ kind: 'offense', x: 1, y: 2 }] }] });
  assert.equal(p.name, 'Untitled play');
  assert.equal(p.courtType, 'half');
  assert.equal(p.preset, 'hs');
  assert.deepEqual(p.tags, []);
  assert.ok(p.id);
  assert.ok(p.frames[0].tokens[0].id, 'tokens get ids so they can be selected');
  assert.deepEqual(p.frames[0].arrows, []);
  assert.equal(p.frames[0].label, 'Initial');
});

test('unnamed later frames are labelled in order', () => {
  const p = normalizePlay({ frames: [{}, {}, {}] });
  assert.deepEqual(p.frames.map((f) => f.label), ['Initial', 'Action 1', 'Action 2']);
});

test('a nonsense court type or preset falls back instead of breaking the render', () => {
  const p = normalizePlay({ frames: [emptyFrame()], courtType: 'oval', preset: 'fiba' });
  assert.equal(p.courtType, 'half');
  assert.equal(p.preset, 'hs');
});

test('numeric coordinates arriving as strings are coerced', () => {
  const p = normalizePlay({
    frames: [{ tokens: [{ kind: 'offense', x: '25', y: '27' }], arrows: [], texts: [] }],
  });
  assert.equal(p.frames[0].tokens[0].x, 25);
  assert.equal(typeof p.frames[0].tokens[0].y, 'number');
});

test('a play with no frames still opens', () => {
  const { plays, errors } = parseImport(JSON.stringify({ name: 'Empty', frames: [] }));
  assert.equal(plays.length, 0);
  assert.equal(errors.length, 1);
});

/* ---------------------------------------------------------------- */
/* Search                                                            */
/* ---------------------------------------------------------------- */

const LIBRARY = [
  play(),
  play({ id: 'p2', name: 'Zipper', category: 'Set', tags: ['motion'], notes: 'Down screen into a pin' }),
  play({ id: 'p3', name: 'Press Break', category: 'Press', tags: [], notes: '' }),
];

test('search matches name, category, tag and notes', () => {
  assert.deepEqual(searchPlays(LIBRARY, 'horns').map((p) => p.name), ['Horns Flare']);
  assert.deepEqual(searchPlays(LIBRARY, 'ato').map((p) => p.name), ['Horns Flare']);
  assert.deepEqual(searchPlays(LIBRARY, 'pin').map((p) => p.name), ['Zipper']);
  assert.deepEqual(searchPlays(LIBRARY, 'press').map((p) => p.name), ['Press Break']);
});

test('search reaches into token labels, so a play for the 5 is findable', () => {
  const forTheFive = play({
    id: 'p4',
    name: 'Nothing obvious',
    tags: [],
    notes: '',
    category: '',
    frames: [{
      label: 'Initial',
      tokens: [{ id: 't', kind: 'offense', label: 'post', x: 1, y: 1 }],
      arrows: [], texts: [],
    }],
  });
  assert.equal(searchPlays([forTheFive], 'post').length, 1);
});

test('search is case-insensitive and an empty query matches everything', () => {
  assert.equal(searchPlays(LIBRARY, 'HORNS').length, 1);
  assert.equal(searchPlays(LIBRARY, '').length, 3);
  assert.equal(searchPlays(LIBRARY, '   ').length, 3);
});

test('category and tag filters compose with the query', () => {
  assert.equal(searchPlays(LIBRARY, '', { category: 'Set' }).length, 2);
  assert.equal(searchPlays(LIBRARY, '', { tag: 'motion' }).length, 1);
  assert.equal(searchPlays(LIBRARY, 'zipper', { category: 'Press' }).length, 0);
});

test('category and tag lists are deduped and sorted', () => {
  assert.deepEqual(allCategories(LIBRARY), ['Press', 'Set']);
  assert.deepEqual(allTags(LIBRARY), ['ATO', 'horns', 'motion']);
});

/* ---------------------------------------------------------------- */
/* Filenames                                                         */
/* ---------------------------------------------------------------- */

test('play names become safe filenames', () => {
  assert.equal(slugify('Horns Flare'), 'horns-flare');
  assert.equal(slugify('5-Out / Motion (vs 2-3)'), '5-out-motion-vs-2-3');
  assert.equal(slugify('   '), 'play');
  assert.equal(slugify('!!!'), 'play');
});

test('pulling a play down from the team playbook is not an edit', () => {
  // savePlay stamps updatedAt by default. Doing that on a copy-down would make
  // an untouched play claim "edited since publishing" the moment it arrives.
  const original = play({ updatedAt: '2026-01-02T00:00:00.000Z' });
  const kept = { ...original, updatedAt: original.updatedAt };
  assert.equal(kept.updatedAt, '2026-01-02T00:00:00.000Z');
});
