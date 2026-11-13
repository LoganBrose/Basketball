/**
 * Opponent plays from the page's side: the game picker and its messages.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gameLabel, pickerGames, opponentSaveMessage } from '../assets/js/opponentplays.js';

const g = (gameId, daysAway, date, opponent, homeAway = 'Away') => ({ gameId, daysAway, date, opponent, homeAway });

test('a game in the picker reads by day, date and opponent', () => {
  assert.equal(gameLabel(g('G3', 7, '2026-11-20', 'North')), 'Fri Nov 20 · North (Away)');
  assert.equal(gameLabel(g('G3', 7, '2026-11-20', 'North', '')), 'Fri Nov 20 · North');
});

test('upcoming games first, soonest at the top, then past games, most recent first', () => {
  const list = pickerGames({
    upcoming: [g('G5', 22, '2026-12-05', 'East'), g('G2', 0, '2026-11-13', 'Central')],
    past: [g('G0', -20, '2026-10-24', 'West'), g('G1', -12, '2026-11-01', 'North')],
  });
  assert.deepEqual(list.map((x) => x.gameId), ['G2', 'G5', 'G1', 'G0']);
  assert.deepEqual(list.map((x) => x.group), ['Upcoming', 'Upcoming', 'Past', 'Past']);
});

test('an empty or missing schedule is an empty picker', () => {
  assert.deepEqual(pickerGames({}), []);
  assert.deepEqual(pickerGames(null), []);
});

test('each failed save says what to do', () => {
  assert.equal(opponentSaveMessage({ ok: true, data: { ok: true } }), '');
  assert.match(opponentSaveMessage({ ok: true, data: { ok: false, reason: 'too_big' } }), /Split it/);
  assert.match(opponentSaveMessage({ ok: true, data: { ok: false, reason: 'unknown_action' } }), /Sign in again/);
  assert.match(opponentSaveMessage({ ok: false, error: 'x' }), /Couldn't reach/);
});

test('the builder\'s button starts hidden, so it never shows before the script says so', () => {
  const html = readFileSync(new URL('../playbook.html', import.meta.url), 'utf8');
  assert.match(html, /<button[^>]*id="p-opponent"[^>]*hidden/);
  assert.match(html, /id="opp-picker"[^>]*hidden/);
  assert.match(html, /id="opp-remove"(?![^>]*checked)/, 'removing the device copy is opt-in');
});
