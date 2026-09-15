import test from 'node:test';
import assert from 'node:assert/strict';
import { COURT_PRESETS, courtSize, BASKET, COURT_WIDTH } from '../assets/js/court.js';

/**
 * The court is drawn in feet, so these are checks against the actual rulebook
 * rather than against pixels. A wrong constant here makes every diagram lie
 * about where the three-point line is.
 */

test('a half court is 50 by 47 feet and a full court is 50 by 94', () => {
  assert.deepEqual(courtSize('half'), { w: 50, h: 47 });
  assert.deepEqual(courtSize('full'), { w: 50, h: 94 });
  assert.deepEqual(courtSize(undefined), { w: 50, h: 47 }, 'defaults to half court');
});

test('the rim sits 5ft 3in from the baseline, centred', () => {
  assert.equal(BASKET.x, COURT_WIDTH / 2);
  assert.equal(BASKET.y, 5.25);
});

test('three-point distances match each level', () => {
  assert.equal(COURT_PRESETS.hs.three, 19.75); // 19'9"
  assert.equal(COURT_PRESETS.nba.three, 23.75); // 23'9"
  assert.ok(COURT_PRESETS.ncaa.three > COURT_PRESETS.hs.three);
  assert.ok(COURT_PRESETS.ncaa.three < COURT_PRESETS.nba.three);
});

test('lane widths match each level', () => {
  assert.equal(COURT_PRESETS.hs.lane, 12);
  assert.equal(COURT_PRESETS.ncaa.lane, 12);
  assert.equal(COURT_PRESETS.nba.lane, 16);
});

test('the high-school arc meets the baseline inside the sideline', () => {
  // With no straight corner segment the arc has to close before x=0, or the
  // three-point line would run off the floor.
  const R = COURT_PRESETS.hs.three;
  const x = BASKET.x - Math.sqrt(R * R - BASKET.y * BASKET.y);
  assert.ok(x > 0 && x < 10, `arc meets the baseline at x=${x.toFixed(2)}ft`);
  assert.equal(COURT_PRESETS.hs.cornerX, null);
});

test('the NBA corner three is 22ft and its arc takes over around 14ft out', () => {
  const { three: R, cornerX } = COURT_PRESETS.nba;
  assert.equal(cornerX, 3);
  // Distance from the rim to the corner line, along the baseline.
  const corner = Math.hypot(BASKET.x - cornerX, 0);
  assert.equal(corner, 22);
  // Where the straight segment hands off to the arc.
  const y = BASKET.y + Math.sqrt(R * R - (BASKET.x - cornerX) ** 2);
  assert.ok(Math.abs(y - 14) < 0.3, `handoff at y=${y.toFixed(2)}ft, spec says 14`);
});

test('every preset has a label for the picker', () => {
  for (const [key, p] of Object.entries(COURT_PRESETS)) {
    assert.ok(p.label, `${key} needs a label`);
    assert.ok(p.three > 0 && p.lane > 0);
  }
});
