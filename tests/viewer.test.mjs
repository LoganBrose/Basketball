/**
 * The view-only login, video links on plays, and the 30-day sign-in list.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs } from './helpers/apps-script.mjs';
import { safeVideoUrl, youtubeId, youtubeEmbed, normalizePlay, newPlay, searchPlays } from '../assets/js/library.js';
import { resultLabel } from '../assets/js/admin.js';

const DAY = 24 * 60 * 60 * 1000;

const play = (id) => ({
  id, slug: `play-${id}`, playbook: 'general', name: `Play ${id}`,
  frames: [{ tokens: [], arrows: [], texts: [] }],
});

/* ---------------------------------------------------------------- */
/* Viewer sign-in on the server                                      */
/* ---------------------------------------------------------------- */

test('the viewer password signs in with a viewer token and nothing more', () => {
  const { fns, rows } = loadCodeGs({ VIEWER_PASSWORD: 'view-pw' });
  const res = fns.handleSignIn({ name: 'Parent', password: 'view-pw' });

  assert.equal(res.ok, true);
  assert.equal(res.role, 'viewer');
  assert.equal(res.adminToken, undefined);
  assert.equal(fns.verifyToken(res.token, 'viewer').ok, true);
  assert.equal(fns.verifyToken(res.token, 'site').ok, false, 'not a coach token');
  assert.equal(fns.verifyToken(res.token, 'admin').ok, false, 'not an admin token');
  assert.equal(rows.at(-1)[4], 'viewer');
});

test('the team and admin passwords say which role they got', () => {
  const { fns } = loadCodeGs({ VIEWER_PASSWORD: 'view-pw' });
  assert.equal(fns.handleSignIn({ name: 'Coach', password: 'team-pw' }).role, 'site');
  assert.equal(fns.handleSignIn({ name: 'Logan Brose', password: 'admin-pw' }).role, 'admin');
});

test('with VIEWER_PASSWORD unset there is no viewer login, even for an empty password', () => {
  const { fns } = loadCodeGs();
  assert.equal(fns.handleSignIn({ name: 'Someone', password: '' }).ok, false);
  assert.equal(fns.handleSignIn({ name: 'Someone', password: 'view-pw' }).ok, false);
});

test('if the viewer password matches the team password, the stronger role wins', () => {
  const { fns } = loadCodeGs({ VIEWER_PASSWORD: 'team-pw' });
  assert.equal(fns.handleSignIn({ name: 'Coach', password: 'team-pw' }).role, 'site');
});

test('a viewer token reads the team playbook and is refused everything else', () => {
  const ctx = loadCodeGs({ VIEWER_PASSWORD: 'view-pw' });
  const { fns } = ctx;
  const admin = fns.handleAdmin({ name: 'Logan Brose', password: 'admin-pw' }).token;
  fns.handleSavePlay({ token: admin, play: play('a') });

  const viewer = fns.handleSignIn({ name: 'Parent', password: 'view-pw' }).token;

  const read = fns.handlePlays({ token: viewer });
  assert.equal(read.ok, true);
  assert.deepEqual(read.plays.map((p) => p.id), ['a']);

  assert.deepEqual(fns.handleSavePlay({ token: viewer, play: play('b') }), { ok: false, reason: 'auth' });
  assert.deepEqual(fns.handleDeletePlay({ token: viewer, id: 'a' }), { ok: false, reason: 'auth' });
  assert.deepEqual(fns.handleData({ token: viewer, tabs: ['Players'] }), { ok: false, reason: 'auth' });
  assert.deepEqual(fns.handleSignIns({ token: viewer }), { ok: false, reason: 'auth' });
  assert.equal(fns.handlePlays({ token: admin }).plays.length, 1, 'nothing was deleted');
});

/* ---------------------------------------------------------------- */
/* Sign-in list: last 30 days                                        */
/* ---------------------------------------------------------------- */

test('the admin list shows only the last 30 days of sign-ins', () => {
  const ctx = loadCodeGs();
  ctx.rows.push([new Date(Date.now() - 40 * DAY), 'Old Timer', 'playbook.html', '', 'signin']);
  ctx.rows.push([new Date(Date.now() - 1 * DAY), 'Recent', 'playbook.html', '', 'signin']);

  const names = ctx.fns.readSignIns().map((r) => r.name);
  assert.deepEqual(names, ['Recent']);
  assert.equal(ctx.rows.length, 2, 'old rows stay in the sheet');
});

test('SIGNIN_DAYS widens the window, and the newest still come first', () => {
  const ctx = loadCodeGs({ SIGNIN_DAYS: '60' });
  ctx.rows.push([new Date(Date.now() - 40 * DAY), 'Old Timer', 'playbook.html', '', 'signin']);
  ctx.rows.push([new Date(Date.now() - 1 * DAY), 'Recent', 'playbook.html', '', 'signin']);
  assert.deepEqual(ctx.fns.readSignIns().map((r) => r.name), ['Recent', 'Old Timer']);
});

test('a row with an unreadable timestamp is left out rather than breaking the list', () => {
  const ctx = loadCodeGs();
  ctx.rows.push(['not a date', 'Mystery', 'playbook.html', '', 'signin']);
  ctx.rows.push([new Date(), 'Now', 'playbook.html', '', 'signin']);
  assert.deepEqual(ctx.fns.readSignIns().map((r) => r.name), ['Now']);
});

test('the admin list labels viewer and admin sign-ins', () => {
  assert.equal(resultLabel({ result: 'viewer' }), 'Signed in (view only)');
  assert.equal(resultLabel({ result: 'admin' }), 'Signed in (admin)');
  assert.equal(resultLabel({ result: 'signin' }), 'Signed in');
  assert.equal(resultLabel({ result: 'failed:site' }), 'Failed attempt');
});

/* ---------------------------------------------------------------- */
/* Video links                                                       */
/* ---------------------------------------------------------------- */

test('video links keep http(s), gain a missing scheme, and refuse anything else', () => {
  assert.equal(safeVideoUrl('https://www.youtube.com/watch?v=abc123'), 'https://www.youtube.com/watch?v=abc123');
  assert.equal(safeVideoUrl('  https://youtu.be/abc123 '), 'https://youtu.be/abc123');
  assert.equal(safeVideoUrl('youtu.be/abc123'), 'https://youtu.be/abc123');
  assert.equal(safeVideoUrl('javascript:alert(1)'), '');
  assert.equal(safeVideoUrl('data:text/html,hi'), '');
  assert.equal(safeVideoUrl('just some words'), '');
  assert.equal(safeVideoUrl(''), '');
  assert.equal(safeVideoUrl(null), '');
});

test('every common form of YouTube link yields its video ID', () => {
  const id = 'dQw4w9WgXcQ';
  for (const link of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&list=PL123`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}`,
    `youtu.be/${id}?si=abc`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube.com/live/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`,
  ]) assert.equal(youtubeId(link), id, link);
});

test('anything that is not a YouTube video has no ID', () => {
  assert.equal(youtubeId('https://vimeo.com/123456789'), '');
  assert.equal(youtubeId('https://www.youtube.com/'), '');
  assert.equal(youtubeId('https://www.youtube.com/watch?v=short'), '');
  assert.equal(youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ"><script>'), '');
  assert.equal(youtubeId('https://notyoutube.com/watch?v=dQw4w9WgXcQ'), '');
  assert.equal(youtubeId('javascript:alert(1)'), '');
  assert.equal(youtubeId(null), '');
});

test('a YouTube link plays from the privacy-enhanced embed, keeping its start time', () => {
  const base = 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&modestbranding=1&playsinline=1&autoplay=1';
  assert.equal(youtubeEmbed('https://youtu.be/dQw4w9WgXcQ'), base);
  assert.equal(youtubeEmbed('https://youtu.be/dQw4w9WgXcQ?t=90'), `${base}&start=90`);
  assert.equal(youtubeEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s'), `${base}&start=90`);
  assert.equal(youtubeEmbed('https://vimeo.com/123456789'), '');
});

test('a play keeps its video link through normalising, and drops a dangerous one', () => {
  const p = newPlay({ youtube: 'https://youtu.be/abc123' });
  assert.equal(normalizePlay(p).youtube, 'https://youtu.be/abc123');
  assert.equal(normalizePlay({ ...p, youtube: 'javascript:alert(1)' }).youtube, null);
  assert.equal(normalizePlay({ ...p, youtube: undefined }).youtube, null);
});

test('searching finds a play by its video link', () => {
  const p = newPlay({ name: 'Horns', youtube: 'https://youtu.be/hornsclip' });
  assert.equal(searchPlays([p], 'hornsclip').length, 1);
});

/* ---------------------------------------------------------------- */
/* Viewer sign-ins last one day                                      */
/* ---------------------------------------------------------------- */

test('a viewer sign-in lasts 24 hours by default; a team one still lasts 30 days', () => {
  const { fns } = loadCodeGs({ VIEWER_PASSWORD: 'view-pw' });
  const now = Date.now();
  const res = fns.handleSignIn({ name: 'Parent', password: 'view-pw' });

  assert.ok(Math.abs(res.expiresAt - (now + DAY)) < 5000, 'about a day from now');
  assert.equal(fns.verifyToken(res.token, 'viewer').ok, true);
  assert.equal(fns.verifyToken(fns.makeToken('viewer', 'Parent', now - 1), 'viewer').ok, false, 'expired');

  const team = fns.handleSignIn({ name: 'Coach', password: 'team-pw' });
  const expiry = Number(Buffer.from(team.token.split('.')[0], 'base64url').toString().split('|')[2]);
  assert.ok(expiry - now > 29 * DAY, 'team sign-in unchanged');
  assert.equal(team.expiresAt, undefined);
});

test('VIEWER_HOURS changes how long a viewer sign-in lasts', () => {
  const { fns } = loadCodeGs({ VIEWER_PASSWORD: 'view-pw', VIEWER_HOURS: '2' });
  const res = fns.handleSignIn({ name: 'Parent', password: 'view-pw' });
  assert.ok(Math.abs(res.expiresAt - (Date.now() + 2 * 60 * 60 * 1000)) < 5000);
});
