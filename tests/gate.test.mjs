/**
 * The browser half of sign-in: name rules, sessions, and how the three ways a
 * request can end are told apart.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanName, isEnabled, sessionValid, siteMaxAge, adminMaxAge,
  callScript, messageFor, pageName,
} from '../assets/js/gate.js';
import { peopleFrom, filterRows, isFailure } from '../assets/js/admin.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/* ---------------------------------------------------------------- */
/* Names                                                             */
/* ---------------------------------------------------------------- */

test('names are trimmed, collapsed and capped at 60', () => {
  assert.equal(cleanName('  Logan   Brose '), 'Logan Brose');
  assert.equal(cleanName('Casey\n\tJones'), 'Casey Jones');
  assert.equal(cleanName('x'.repeat(200)).length, 60);
});

test('a blank name is unusable rather than an empty record', () => {
  assert.equal(cleanName('   '), '');
  assert.equal(cleanName(''), '');
  assert.equal(cleanName(null), '');
  assert.equal(cleanName(undefined), '');
});

/* ---------------------------------------------------------------- */
/* Enabled                                                           */
/* ---------------------------------------------------------------- */

test('the gate is off until a script URL is configured', () => {
  // An unconfigured site must never lock its owner out.
  assert.equal(isEnabled({ url: '' }), false);
  assert.equal(isEnabled({ url: '   ' }), false);
  assert.equal(isEnabled({}), false);
  assert.equal(isEnabled(null), false);
  assert.equal(isEnabled({ url: 'https://script.google.com/macros/s/AKf/exec' }), true);
});

/* ---------------------------------------------------------------- */
/* Sessions                                                          */
/* ---------------------------------------------------------------- */

const session = (at) => ({ name: 'Casey', token: 'tok', at });

test('a session is offerable until its age passes the limit', () => {
  const now = 1_000_000_000_000;
  assert.equal(sessionValid(session(now - 29 * DAY), 30 * DAY, now), true);
  assert.equal(sessionValid(session(now - 31 * DAY), 30 * DAY, now), false);
  assert.equal(sessionValid(session(now), 30 * DAY, now), true);
});

test('site and admin sessions expire on different clocks', () => {
  // 24 hours for admin, 30 days for the team: the same stored shape, two limits.
  const now = 1_000_000_000_000;
  const gate = { days: 30, adminHours: 24 };
  const twoDaysOld = session(now - 2 * DAY);

  assert.equal(sessionValid(twoDaysOld, siteMaxAge(gate), now), true, 'still a valid site session');
  assert.equal(sessionValid(twoDaysOld, adminMaxAge(gate), now), false, 'but not an admin one');
});

test('the config falls back to 30 days and 24 hours', () => {
  assert.equal(siteMaxAge({}), 30 * DAY);
  assert.equal(adminMaxAge({}), 24 * HOUR);
  assert.equal(siteMaxAge({ days: 7 }), 7 * DAY);
  assert.equal(adminMaxAge({ adminHours: 2 }), 2 * HOUR);
});

test('a malformed or future-stamped session is refused', () => {
  const now = 1_000_000_000_000;
  assert.equal(sessionValid(null, DAY, now), false);
  assert.equal(sessionValid({ token: '', at: now }, DAY, now), false);
  assert.equal(sessionValid({ token: 'tok' }, DAY, now), false);
  assert.equal(sessionValid({ token: 'tok', at: 'yesterday' }, DAY, now), false);
  assert.equal(sessionValid(session(now + HOUR), DAY, now), false, 'a clock that moved backwards');
});

/* ---------------------------------------------------------------- */
/* Transport — the three outcomes                                    */
/* ---------------------------------------------------------------- */

const jsonResponse = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

test('a yes from the script comes back as a yes', async () => {
  const fetchImpl = async () => jsonResponse({ ok: true, token: 't', name: 'Casey' });
  const result = await callScript('https://example.test/exec', { action: 'signin' }, { fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.token, 't');
});

test('a wrong password is a refusal, not a failure to reach the script', async () => {
  const fetchImpl = async () => jsonResponse({ ok: false, reason: 'password' });
  const result = await callScript('https://example.test/exec', {}, { fetchImpl });

  assert.equal(result.ok, true, 'the call itself succeeded');
  assert.equal(result.data.ok, false, 'the answer was no');
  assert.equal(result.error, null);
});

test('a network error is a failure to reach the script, not a refusal', async () => {
  // Treating this as a wrong password would hide a broken setup behind a
  // message that sends people hunting for a password that was fine.
  const fetchImpl = async () => { throw new Error('Failed to fetch'); };
  const result = await callScript('https://example.test/exec', {}, { fetchImpl });

  assert.equal(result.ok, false);
  assert.equal(result.data, null);
  assert.match(result.error, /Failed to fetch/);
});

test('an HTTP error is reported with its status', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => '' });
  const result = await callScript('https://example.test/exec', {}, { fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'HTTP 500');
});

test('an HTML page instead of JSON names the actual misconfiguration', async () => {
  // This is what a deployment that is not shared with "Anyone" returns.
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '<!doctype html><html>' });
  const result = await callScript('https://example.test/exec', {}, { fetchImpl });

  assert.equal(result.ok, false);
  assert.match(result.error, /Who has access/);
});

test('the request is sent as text/plain to dodge the CORS preflight', async () => {
  // Any other content type triggers an OPTIONS request, which Apps Script does
  // not answer — so this is load-bearing, not cosmetic.
  let seen = null;
  const fetchImpl = async (url, init) => { seen = init; return jsonResponse({ ok: true }); };
  await callScript('https://example.test/exec', { action: 'signin' }, { fetchImpl });

  assert.equal(seen.method, 'POST');
  assert.match(seen.headers['Content-Type'], /^text\/plain/);
  assert.equal(JSON.parse(seen.body).action, 'signin');
});

/* ---------------------------------------------------------------- */
/* Messages                                                          */
/* ---------------------------------------------------------------- */

test('each outcome gets its own sentence', () => {
  assert.equal(messageFor({ ok: true, data: { ok: true } }).kind, 'ok');

  const wrong = messageFor({ ok: true, data: { ok: false, reason: 'password' } });
  assert.equal(wrong.kind, 'password');
  assert.match(wrong.text, /password/i);

  const slow = messageFor({ ok: true, data: { ok: false, reason: 'slow', retryAfter: 30 } });
  assert.equal(slow.kind, 'slow');
  assert.match(slow.text, /30s/);

  const down = messageFor({ ok: false, error: 'Failed to fetch' });
  assert.equal(down.kind, 'network');
  assert.match(down.text, /Try again/);
});

test('an unrecognised refusal points at the deployment rather than the password', () => {
  const m = messageFor({ ok: true, data: { ok: false, reason: 'error' } });
  assert.equal(m.kind, 'error');
  assert.match(m.text, /deployment/);
});

test('slow falls back to 30 seconds when the script sends no retryAfter', () => {
  assert.match(messageFor({ ok: true, data: { ok: false, reason: 'slow' } }).text, /30s/);
});

/* ---------------------------------------------------------------- */
/* Page names                                                        */
/* ---------------------------------------------------------------- */

test('the logged page is just the filename', () => {
  assert.equal(pageName('/Basketball/stats.html'), 'stats.html');
  assert.equal(pageName('/playbook.html'), 'playbook.html');
  assert.equal(pageName('/'), 'index.html');
  assert.equal(pageName(''), 'index.html');
});

/* ---------------------------------------------------------------- */
/* The admin log                                                     */
/* ---------------------------------------------------------------- */

const row = (name, result = 'signin', at = '9/15/2026 10:00:00') => ({ name, result, at, page: 'index.html' });

test('people are summarised with successes and failures kept apart', () => {
  // Ten failures and no sign-ins must not read as a regular visitor.
  const people = peopleFrom([
    row('Casey Jones'), row('Casey Jones'), row('Guesser', 'failed:site'),
    row('Guesser', 'failed:site'), row('Logan Brose', 'admin'),
  ]);

  const casey = people.find((p) => p.name === 'Casey Jones');
  const guesser = people.find((p) => p.name === 'Guesser');

  assert.equal(casey.signIns, 2);
  assert.equal(casey.failures, 0);
  assert.equal(guesser.signIns, 0);
  assert.equal(guesser.failures, 2);
});

test('a person is one entry however their name was typed', () => {
  const people = peopleFrom([row('  casey   jones '), row('casey jones')]);
  assert.equal(people.length, 1);
  assert.equal(people[0].signIns, 2);
});

test('last seen is the newest row, since rows arrive newest first', () => {
  const people = peopleFrom([row('Casey', 'signin', 'later'), row('Casey', 'signin', 'earlier')]);
  assert.equal(people[0].lastSeen, 'later');
});

test('a blank name is shown as such rather than dropped', () => {
  const people = peopleFrom([row('', 'failed:site')]);
  assert.equal(people[0].name, '(no name)');
  assert.equal(people[0].failures, 1);
});

test('failures are identified by what the script recorded', () => {
  assert.equal(isFailure(row('x', 'failed:site')), true);
  assert.equal(isFailure(row('x', 'failed:admin')), true);
  assert.equal(isFailure(row('x', 'signin')), false);
  assert.equal(isFailure(row('x', 'admin')), false);
});

test('search covers every column someone might look in', () => {
  const rows = [row('Casey Jones'), { name: 'Sam', result: 'signin', at: '3/4/2026', page: 'stats.html' }];
  assert.equal(filterRows(rows, 'casey').length, 1);
  assert.equal(filterRows(rows, 'stats').length, 1, 'by page');
  assert.equal(filterRows(rows, '3/4').length, 1, 'by date');
  assert.equal(filterRows(rows, '').length, 2);
  assert.equal(filterRows(rows, 'nobody').length, 0);
});

/* ---------------------------------------------------------------- */
/* The token delimiter                                               */
/* ---------------------------------------------------------------- */

test('the browser strips a pipe from a name, exactly as the script does', () => {
  // "|" separates the fields inside a token payload. If the two sides disagreed
  // about what a name is, the name sent would not be the name signed.
  assert.equal(cleanName('Logan|Brose'), 'LoganBrose');
  assert.equal(cleanName('a | b'), 'a b');
  assert.equal(cleanName('|'), '');
  assert.equal(cleanName('||  Casey  ||'), 'Casey');
});
