import test from 'node:test';
import assert from 'node:assert/strict';
import { sheetProblems } from '../assets/js/data.js';

/** A load with nothing wrong: real sheet, every column found, no odd rows. */
function healthy(overrides = {}) {
  return {
    usingSample: false,
    stale: false,
    meta: {
      StatsLog: { error: null, missing: [] },
      Players: { error: null, missing: [] },
      Games: { error: null, missing: [] },
    },
    issues: {
      superseded: [], unmatchedGames: [], unmatchedPlayers: [],
      invalidDates: [], sanityFlags: [],
    },
    mismatches: [],
    ...overrides,
  };
}

test('a healthy load has nothing to report', () => {
  // This is what lets the Connection panel disappear entirely: no blocking
  // problems and no data-quality ones.
  const { blocking, quality } = sheetProblems(healthy());
  assert.deepEqual(blocking, []);
  assert.equal(quality, 0);
});

test('sample data and a cached copy both count as blocking', () => {
  // The numbers on screen aren't the sheet's, so the page has to say so.
  assert.deepEqual(sheetProblems(healthy({ usingSample: true })).blocking, ['showing sample data']);
  assert.deepEqual(sheetProblems(healthy({ stale: true })).blocking, ['showing a cached copy']);
});

test('a tab error blocks, and names the tab', () => {
  const data = healthy();
  data.meta.Games = { error: 'No header row found.', missing: [] };
  const { blocking } = sheetProblems(data);
  assert.equal(blocking.length, 1);
  assert.match(blocking[0], /^Games:/);
});

test('missing required columns block, and are counted', () => {
  const data = healthy();
  data.meta.StatsLog = { error: null, missing: ['fga', 'rebounds'] };
  const { blocking } = sheetProblems(data);
  assert.match(blocking[0], /StatsLog: missing 2 columns/);
});

test('an error takes precedence over the missing-column count for the same tab', () => {
  const data = healthy();
  data.meta.StatsLog = { error: 'Could not load this tab.', missing: ['fga'] };
  const { blocking } = sheetProblems(data);
  assert.equal(blocking.length, 1, 'one message per tab, not two');
  assert.match(blocking[0], /Could not load/);
});

test('data-quality issues are counted but do not block', () => {
  const data = healthy({
    issues: {
      superseded: [{}], unmatchedGames: [{}, {}], unmatchedPlayers: [],
      invalidDates: [{}], sanityFlags: [{}],
    },
    mismatches: [{}],
  });
  const { blocking, quality } = sheetProblems(data);
  assert.deepEqual(blocking, [], 'the numbers are still the sheet’s');
  assert.equal(quality, 6);
});

test('a missing or malformed payload degrades instead of throwing', () => {
  assert.deepEqual(sheetProblems(undefined).blocking, []);
  assert.equal(sheetProblems({}).quality, 0);
});
