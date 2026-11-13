/**
 * What a scouting report puts on paper. Only the model is tested here; the
 * page is built from it with the same helpers as the playbook PDF.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scoutPrintModel } from '../assets/js/printout.js';

const game = { gameId: 'G03', date: '2026-11-20', opponent: 'North', homeAway: 'Away', daysAway: 7 };
const note = (text, by = 'Casey') => ({ text, updated: '', updatedBy: by });
const players = [
  { id: 'a', number: '23', name: 'Jay Tall', position: 'C', blurb: 'Lefty.', statsUrl: 'https://www.maxpreps.com/jay' },
  { id: 'b', number: '4', name: 'Sam Quick', position: 'G', blurb: '', statsUrl: 'javascript:alert(1)' },
];
const plays = [{ id: 'opp-1', name: 'Box Set', play: { id: 'opp-1', name: 'Box Set', frames: [{ tokens: [], arrows: [], texts: [] }] } }];

const adminReport = {
  ok: true, role: 'admin', canEdit: true, game, players, plays,
  overview: note('Press after makes.'), privateNotes: note('Their coach ran our sets.', 'Alex'),
};

test('the heading names the opponent, the day and home or away', () => {
  const m = scoutPrintModel(adminReport);
  assert.equal(m.title, 'Scouting: at North');
  assert.equal(m.subtitle, 'Friday, November 20 · Away');
});

test('the admin\'s PDF carries every section, private notes last', () => {
  const m = scoutPrintModel(adminReport);
  assert.deepEqual(m.notes.map((n) => n.title), ['About North', 'Private notes']);
  assert.equal(m.notes[1].private, true);
});

test('there is no "This game" section on paper, even from an older script that still sends one', () => {
  const m = scoutPrintModel({ ...adminReport, gameNotes: note('Senior night.') });
  assert.doesNotMatch(JSON.stringify(m), /This game|Senior/);
});

test('a coach\'s PDF has no private notes, because a coach\'s report never had any', () => {
  const { privateNotes, ...coach } = adminReport;
  void privateNotes;
  const m = scoutPrintModel({ ...coach, role: 'coach' });
  assert.deepEqual(m.notes.map((n) => n.title), ['About North']);
  assert.doesNotMatch(JSON.stringify(m), /our sets/);
});

test('a player\'s PDF is key players and their plays, nothing else', () => {
  const m = scoutPrintModel({ ok: true, role: 'viewer', canEdit: false, game, players, plays });
  assert.deepEqual(m.notes, []);
  assert.equal(m.players.length, 2);
  assert.deepEqual(m.plays.map((p) => p.name), ['Box Set']);
});

test('empty notes stay off the paper', () => {
  const m = scoutPrintModel({ ...adminReport, overview: note('   ') });
  assert.deepEqual(m.notes.map((n) => n.title), ['Private notes']);
});

test('stats links print as text, and only web links print at all', () => {
  const m = scoutPrintModel(adminReport);
  assert.deepEqual(m.players.map((p) => [p.title, p.stats]), [
    ['#23 Jay Tall · C', 'https://www.maxpreps.com/jay'],
    ['#4 Sam Quick · G', ''],
  ]);
});

test('each opponent play keeps its drawing and its name', () => {
  const m = scoutPrintModel(adminReport);
  assert.equal(m.plays[0].name, 'Box Set');
  assert.ok(Array.isArray(m.plays[0].frames));
});

test('no players and no plays still makes a report, not a crash', () => {
  const m = scoutPrintModel({ ok: true, game });
  assert.deepEqual(m.players, []);
  assert.deepEqual(m.plays, []);
});

test('the scouting PDF is its own export, separate from the playbook\'s', () => {
  const src = readFileSync(new URL('../assets/js/printout.js', import.meta.url), 'utf8');
  assert.match(src, /export function printScoutReport\(/);
  assert.match(src, /export function printPlaybook\(/);
  const page = readFileSync(new URL('../assets/js/scouting.js', import.meta.url), 'utf8');
  assert.match(page, /Export scouting PDF/);
  assert.doesNotMatch(page, /printPlaybook/);
});
