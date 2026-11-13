/**
 * The drawing code shared by the builder, the printout and the Scouting page,
 * and the read-only viewer that steps through an opponent's play.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  pathD, tangentAt, unitNormal, arrowLength, dribbleD, screenBarD, midpoint, TOKEN_R,
} from '../assets/js/draw.js';
import { stepTo, stepLabel, STEP_MS, STEP_STILL_MS } from '../assets/js/playviewer.js';

const straight = { from: { x: 0, y: 0 }, to: { x: 10, y: 0 } };
const curved = { from: { x: 0, y: 0 }, ctrl: { x: 5, y: 5 }, to: { x: 10, y: 0 } };
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('a straight arrow is a line, a curved one a quadratic', () => {
  assert.equal(pathD(straight), 'M 0 0 L 10 0');
  assert.equal(pathD(curved), 'M 0 0 Q 5 5 10 0');
});

test('the length of a straight arrow is its length', () => {
  assert.ok(close(arrowLength(straight), 10, 1e-6));
  assert.ok(arrowLength(curved) > 10, 'a curve is longer than its chord');
});

test('the normal is perpendicular to the direction of travel', () => {
  const n = unitNormal(straight, 0.5);
  assert.ok(close(Math.hypot(n.x, n.y), 1));
  const t = tangentAt(curved, 0.3);
  const m = unitNormal(curved, 0.3);
  assert.ok(close(t.x * m.x + t.y * m.y, 0, 1e-9));
});

test('a dribble starts and ends on the arrow, so it meets the player cleanly', () => {
  const d = dribbleD(straight);
  assert.match(d, /^M 0\.000 0\.000 L /);
  assert.match(d, /10\.000 -?0\.000$/);
});

test('a screen bar sits across the end of the arrow', () => {
  assert.equal(screenBarD(straight), 'M 10 -1.15 L 10 1.15');
});

test('the middle handle is the curve point, or the middle of a straight arrow', () => {
  assert.deepEqual(midpoint(curved), { x: 5, y: 5 });
  const m = midpoint(straight);
  assert.ok(close(m.x, 5) && close(m.y, 0));
  assert.equal(TOKEN_R, 1.25);
});

test('the builder draws with the shared code rather than a copy of it', () => {
  // Two copies would drift, and a play would look different on the Scouting
  // page from how it was drawn.
  const src = readFileSync(new URL('../assets/js/playbook.js', import.meta.url), 'utf8');
  for (const fn of ['renderToken', 'renderArrow', 'renderText', 'dribbleD', 'pathD']) {
    assert.doesNotMatch(src, new RegExp(`function ${fn}\\(`), fn);
  }
  assert.match(src, /from '\.\/draw\.js'/);
});

/* ---------------------------------------------------------------- */
/* The viewer                                                        */
/* ---------------------------------------------------------------- */

test('Previous and Next stay inside the play', () => {
  assert.equal(stepTo(0, -1, 3), 0);
  assert.equal(stepTo(0, 1, 3), 1);
  assert.equal(stepTo(2, 1, 3), 2);
  assert.equal(stepTo(1, -1, 3), 0);
});

test('the step label names the step when it has a name', () => {
  assert.equal(stepLabel({ label: 'Swing' }, 1, 4), 'Step 2 of 4 · Swing');
  assert.equal(stepLabel({ label: '' }, 0, 1), 'Step 1 of 1');
});

test('an opponent play moves at the builder\'s speed', () => {
  const src = readFileSync(new URL('../assets/js/playbook.js', import.meta.url), 'utf8');
  assert.match(src, new RegExp(`const STEP_MS = ${STEP_MS};`));
  assert.match(src, new RegExp(`const STEP_STILL_MS = ${STEP_STILL_MS};`));
});
