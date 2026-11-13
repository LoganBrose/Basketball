/**
 * The page's copy of which staged features this login may see, and the admin
 * page's view of each release stage.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEATURES_KEY, parseFeatures, readFeatures, writeFeatures, clearFeatures, hasFeature, featuresFrom,
} from '../assets/js/features.js';
import { releaseRows } from '../assets/js/admin.js';

function withStorage(fn) {
  const previous = globalThis.localStorage;
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  try {
    return fn(store);
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
}

test('only known feature names survive, once each', () => {
  assert.deepEqual(parseFeatures(['scouting', 'stats', 'scouting', 7, null, 'adminPlaybook']),
    ['scouting', 'adminPlaybook']);
  assert.deepEqual(parseFeatures('scouting'), []);
  assert.deepEqual(parseFeatures(undefined), []);
});

test('nothing stored, or something unreadable, means no features', () => withStorage((store) => {
  assert.deepEqual(readFeatures(), []);
  store.set(FEATURES_KEY, '{not json');
  assert.deepEqual(readFeatures(), []);
  assert.equal(hasFeature('scouting'), false);
}));

test('writing reports whether anything changed, so the page re-renders only then', () => withStorage(() => {
  assert.equal(writeFeatures(['scouting']), true);
  assert.equal(hasFeature('scouting'), true);
  assert.equal(writeFeatures(['scouting']), false, 'same list: nothing to do');
  assert.equal(writeFeatures([]), true, 'a rollback is a change too');
  assert.equal(hasFeature('scouting'), false);
}));

test('clearing takes everything away', () => withStorage(() => {
  writeFeatures(['scouting', 'adminPlaybook']);
  clearFeatures();
  assert.deepEqual(readFeatures(), []);
}));

test('a reply without features leaves what is stored alone', () => {
  // A network failure, or a script deployed before features existed, must not
  // take a feature away from someone who has it.
  assert.equal(featuresFrom({ ok: false, error: 'offline' }), null);
  assert.equal(featuresFrom({ ok: true, data: { ok: true, valid: true } }), null);
  assert.equal(featuresFrom({ ok: true, data: { ok: false } }), null);
  assert.deepEqual(featuresFrom({ ok: true, data: { ok: true, valid: true, features: [] } }), []);
  assert.deepEqual(featuresFrom({ ok: true, data: { ok: true, features: ['scouting', 'x'] } }), ['scouting']);
});

test('the admin page lists each stage the script reported, and nothing it did not', () => {
  assert.deepEqual(releaseRows({ scouting: 'coaches' }).map((r) => [r.label, r.property, r.text]),
    [['Scouting', 'RELEASE_SCOUTING', 'Admin + coaches']]);
  assert.deepEqual(releaseRows(undefined), [], 'an older script has no stages');
  assert.deepEqual(releaseRows({}), []);
});
