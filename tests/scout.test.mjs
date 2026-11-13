/**
 * The Scouting page's pure parts: grouping, how dates read, links and messages.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  groupGames, dateParts, whenText, matchup, playerTitle, statsLink, savedText, scoutMessage,
} from '../assets/js/scout.js';

const g = (gameId, daysAway, over = {}) => ({ gameId, daysAway, date: '2026-11-20', opponent: 'North', homeAway: 'Away', ...over });

test('the next game first, the rest of the week as cards, everything after that later', () => {
  const { next, week, later } = groupGames([g('G5', 22), g('G2', 0), g('G4', 8), g('G3', 7), g('G6', 3)]);
  assert.equal(next.gameId, 'G2');
  assert.deepEqual(week.map((x) => x.gameId), ['G6', 'G3']);
  assert.deepEqual(later.map((x) => x.gameId), ['G4', 'G5']);
});

test('the next game can be weeks away and is still the next game', () => {
  const { next, week, later } = groupGames([g('G9', 30), g('G10', 31)]);
  assert.equal(next.gameId, 'G9');
  assert.deepEqual(week, []);
  assert.deepEqual(later.map((x) => x.gameId), ['G10']);
});

test('no games is an empty schedule, not a crash', () => {
  assert.deepEqual(groupGames([]), { next: null, week: [], later: [] });
  assert.deepEqual(groupGames(), { next: null, week: [], later: [] });
});

test('a date reads the same in every browser time zone', () => {
  // Read in the browser's own zone, a date can move back a day west of UTC.
  const d = dateParts('2026-11-20');
  assert.equal(d.weekday, 'Fri');
  assert.equal(d.short, 'Nov 20');
  assert.equal(d.long, 'Friday, November 20');
  assert.equal(dateParts('garbage').short, 'garbage');
});

test('how far away a game is', () => {
  assert.equal(whenText(0), 'Today');
  assert.equal(whenText(1), 'Tomorrow');
  assert.equal(whenText(5), 'In 5 days');
  assert.equal(whenText(-1), 'Yesterday');
  assert.equal(whenText(-4), '4 days ago');
  assert.equal(whenText(undefined), '');
});

test('vs at home, at away', () => {
  assert.equal(matchup(g('x', 0, { homeAway: 'Home' })), 'vs North');
  assert.equal(matchup(g('x', 0, { homeAway: 'Away' })), 'at North');
  assert.equal(matchup(g('x', 0, { homeAway: '' })), 'North');
});

test('a player reads as number, name and position, skipping blanks', () => {
  assert.equal(playerTitle({ number: '23', name: 'Jay Tall', position: 'C' }), '#23 Jay Tall · C');
  assert.equal(playerTitle({ number: '', name: 'Jay Tall', position: '' }), 'Jay Tall');
  assert.equal(playerTitle({ number: '4', name: '', position: 'G' }), '#4 · G');
});

test('a stats button only ever points at a web page', () => {
  assert.equal(statsLink('https://www.maxpreps.com/a'), 'https://www.maxpreps.com/a');
  assert.equal(statsLink('maxpreps.com/a'), 'https://maxpreps.com/a', 'a bare address is fixed up');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', '', 'not a link']) {
    assert.equal(statsLink(bad), '', bad);
  }
});

test('who saved last is shown when known', () => {
  assert.equal(savedText({ updatedBy: 'Casey', updated: '11/13/2026' }), 'Saved by Casey · 11/13/2026');
  assert.equal(savedText({ updatedBy: '' }), '');
  assert.equal(savedText(null), '');
});

test('each failure says something a person can act on', () => {
  assert.equal(scoutMessage({ ok: true, data: { ok: true } }), '');
  assert.match(scoutMessage({ ok: false, error: 'x' }), /Couldn't reach/);
  assert.match(scoutMessage({ ok: true, data: { ok: false, reason: 'unknown_action' } }), /Sign in again/);
  assert.match(scoutMessage({ ok: true, data: { ok: false, reason: 'too_many' } }), /30/);
  assert.match(scoutMessage({ ok: true, data: { ok: false, reason: 'bad_request' } }), /name or a number/);
});

/* ---------------------------------------------------------------- */
/* The page is hidden from anyone it isn't released to               */
/* ---------------------------------------------------------------- */

const page = readFileSync(new URL('../scouting.html', import.meta.url), 'utf8');
const headScript = page.match(/<head>\s*<script>([\s\S]*?)<\/script>/)[1];

function redirectsFor(storage) {
  let to = null;
  const localStorage = { getItem: (k) => (k in storage ? storage[k] : null) };
  const location = { replace: (u) => { to = u; } };
  new Function('localStorage', 'location', headScript)(localStorage, location);
  return to;
}

test('the head script sends anyone without Scouting back to the playbook before the page renders', () => {
  const told = (list) => JSON.stringify({ list });
  assert.equal(redirectsFor({ 'bb.gate.on': '1', 'bb.features.v1': told(['scouting']) }), null);
  assert.equal(redirectsFor({ 'bb.gate.on': '1', 'bb.features.v1': told([]) }), 'playbook.html');
  assert.equal(redirectsFor({ 'bb.gate.on': '1', 'bb.features.v1': told(['adminPlaybook']) }), 'playbook.html');
  assert.equal(redirectsFor({ 'bb.gate.on': '1' }), 'playbook.html');
  assert.equal(redirectsFor({ 'bb.gate.on': '1', 'bb.features.v1': '{bad' }), 'playbook.html');
  assert.equal(redirectsFor({ 'bb.gate.on': '0', 'bb.features.v1': told(['scouting']) }), 'playbook.html',
    'with sign-in off there is no scouting');
  assert.equal(redirectsFor({}), null, 'first visit ever: the module decides');
});

test('the build publishes the Scouting page', () => {
  const build = readFileSync(new URL('../tools/build-site.mjs', import.meta.url), 'utf8');
  assert.match(build, /'scouting\.html'/);
});
