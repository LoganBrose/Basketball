import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SLOTS, pruneLineup, availableFor, playerInSlot, assignSlot, tokenGlyph,
} from '../assets/js/lineup.js';
import { normalizePlay, exportPlay, emptyFrame } from '../assets/js/library.js';

const ROSTER = [
  { playerId: 'P1', fullName: 'John Smith', jersey: '12' },
  { playerId: 'P2', fullName: 'Jane Doe', jersey: '7' },
  { playerId: 'P3', fullName: 'Marcus Lee', jersey: '' },
];

test('there are five offensive slots, matching the labels a play stores', () => {
  assert.deepEqual(SLOTS, ['1', '2', '3', '4', '5']);
});

/* ---------------------------------------------------------------- */
/* The core guarantee: a lineup never reaches the play               */
/* ---------------------------------------------------------------- */

test('a saved play carries no player names or IDs', () => {
  // This is the whole constraint. Bake a name into a play and that play stops
  // being reusable next season, or with a different group.
  const play = normalizePlay({
    name: 'Horns Flare',
    frames: [{
      tokens: [
        { kind: 'offense', label: '1', x: 25, y: 27 },
        { kind: 'offense', label: '5', x: 16, y: 11 },
      ],
      arrows: [], texts: [],
    }],
  });

  const json = exportPlay(play);
  for (const p of ROSTER) {
    assert.ok(!json.includes(p.playerId), `${p.playerId} must not appear in the play`);
    assert.ok(!json.includes(p.fullName), `${p.fullName} must not appear in the play`);
  }
  assert.deepEqual(play.frames[0].tokens.map((t) => t.label), ['1', '5']);
});

test('a lineup smuggled into a play file is dropped on load', () => {
  // Hand-edited or exported by some future version — either way the play only
  // keeps fields it knows about.
  const play = normalizePlay({
    name: 'Zipper',
    lineup: { 1: 'P1', 2: 'P2' },
    frames: [{ tokens: [{ kind: 'offense', label: '1', x: 1, y: 2 }], arrows: [], texts: [] }],
  });
  assert.equal(play.lineup, undefined);
  assert.ok(!exportPlay(play).includes('P1'));
});

/* ---------------------------------------------------------------- */
/* Pruning                                                           */
/* ---------------------------------------------------------------- */

test('a stored lineup referencing a player who left clears that slot', () => {
  const stored = { 1: 'P1', 2: 'P9', 3: 'P3' };
  assert.deepEqual(pruneLineup(stored, ROSTER), { 1: 'P1', 3: 'P3' });
});

test('an empty roster clears the whole lineup rather than showing stale names', () => {
  assert.deepEqual(pruneLineup({ 1: 'P1', 2: 'P2' }, []), {});
  assert.deepEqual(pruneLineup({ 1: 'P1' }, undefined), {});
});

test('junk in storage degrades to an empty lineup', () => {
  assert.deepEqual(pruneLineup(null, ROSTER), {});
  assert.deepEqual(pruneLineup({ 9: 'P1' }, ROSTER), {}, 'slots outside 1-5 are ignored');
});

/* ---------------------------------------------------------------- */
/* Assignment                                                        */
/* ---------------------------------------------------------------- */

test('a player assigned elsewhere is not offered in another slot', () => {
  const lineup = { 1: 'P1' };
  const forTwo = availableFor('2', lineup, ROSTER).map((p) => p.playerId);
  assert.deepEqual(forTwo, ['P2', 'P3'], 'P1 is already standing in slot 1');

  // Their own slot still offers them, so the dropdown can show its own value.
  assert.ok(availableFor('1', lineup, ROSTER).some((p) => p.playerId === 'P1'));
});

test('assigning a player moves them out of their previous slot', () => {
  // A player can't be in two places at once.
  const moved = assignSlot({ 1: 'P1', 3: 'P3' }, '4', 'P1');
  assert.deepEqual(moved, { 3: 'P3', 4: 'P1' });
});

test('assigning an empty value clears the slot', () => {
  assert.deepEqual(assignSlot({ 1: 'P1', 2: 'P2' }, '1', ''), { 2: 'P2' });
});

test('playerInSlot resolves the player or null', () => {
  assert.equal(playerInSlot('1', { 1: 'P2' }, ROSTER).fullName, 'Jane Doe');
  assert.equal(playerInSlot('4', { 1: 'P2' }, ROSTER), null);
  assert.equal(playerInSlot('1', { 1: 'GONE' }, ROSTER), null);
});

/* ---------------------------------------------------------------- */
/* Token glyph                                                       */
/* ---------------------------------------------------------------- */

test('the token shows the jersey when there is one', () => {
  assert.equal(tokenGlyph(ROSTER[0], '1'), '12');
});

test('a player with no jersey falls back to initials, not a blank token', () => {
  assert.equal(tokenGlyph(ROSTER[2], '5'), 'ML');
});

test('an empty slot keeps the position number', () => {
  assert.equal(tokenGlyph(null, '3'), '3');
  assert.equal(tokenGlyph({ playerId: 'P9', fullName: '', jersey: '' }, '3'), '3');
});
