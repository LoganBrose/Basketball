/**
 * The sign-in backend, exercised against the real apps-script/Code.gs.
 *
 * See tests/helpers/apps-script.mjs for how the Google globals are supplied,
 * and for what this does and does not prove.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, post } from './helpers/apps-script.mjs';

/* ---------------------------------------------------------------- */
/* Names                                                             */
/* ---------------------------------------------------------------- */

test('names are trimmed, collapsed and capped', () => {
  const { fns } = loadCodeGs();
  assert.equal(fns.cleanName('  Logan   Brose '), 'Logan Brose');
  assert.equal(fns.cleanName('Casey\n\tJones'), 'Casey Jones');
  assert.equal(fns.cleanName('   '), '');
  assert.equal(fns.cleanName(null), '');
  assert.equal(fns.cleanName('x'.repeat(200)).length, 60);
});

test('an empty name is refused before the password is even considered', () => {
  // Otherwise the log fills with blank rows that name nobody.
  const { fns } = loadCodeGs();
  assert.deepEqual(fns.handleSignIn({ name: '   ', password: 'team-pw' }),
    { ok: false, reason: 'name' });
});

/* ---------------------------------------------------------------- */
/* Comparison                                                        */
/* ---------------------------------------------------------------- */

test('constant-time compare handles equal, different and mismatched lengths', () => {
  const { fns } = loadCodeGs();
  assert.equal(fns.constantTimeEquals('abc', 'abc'), true);
  assert.equal(fns.constantTimeEquals('abc', 'abd'), false);
  assert.equal(fns.constantTimeEquals('abc', 'abcd'), false);
  assert.equal(fns.constantTimeEquals('', ''), true);
  assert.equal(fns.constantTimeEquals(null, ''), true);
});

/* ---------------------------------------------------------------- */
/* Tokens                                                            */
/* ---------------------------------------------------------------- */

test('a valid token round-trips with its role and name', () => {
  const { fns } = loadCodeGs();
  const token = fns.makeToken('site', 'Casey Jones', Date.now() + 60_000);
  assert.deepEqual(fns.verifyToken(token, 'site'),
    { ok: true, role: 'site', name: 'Casey Jones' });
});

test('a site token cannot be replayed as an admin token', () => {
  // The role is inside the signature, so it cannot be edited in the browser.
  const { fns } = loadCodeGs();
  const token = fns.makeToken('site', 'Casey Jones', Date.now() + 60_000);
  assert.equal(fns.verifyToken(token, 'admin').ok, false);
});

test('an expired token is refused', () => {
  const { fns } = loadCodeGs();
  assert.equal(fns.verifyToken(fns.makeToken('site', 'X', Date.now() - 1), 'site').ok, false);
});

test('a tampered signature or payload is refused', () => {
  const { fns } = loadCodeGs();
  const token = fns.makeToken('admin', 'Logan Brose', Date.now() + 60_000);
  assert.equal(fns.verifyToken(token.slice(0, -2) + 'xx', 'admin').ok, false, 'signature');
  assert.equal(fns.verifyToken('Zm9v' + token.slice(token.indexOf('.')), 'admin').ok, false, 'payload');
  assert.equal(fns.verifyToken('garbage', 'admin').ok, false);
  assert.equal(fns.verifyToken('', 'admin').ok, false);
  assert.equal(fns.verifyToken(undefined, 'admin').ok, false);
});

test('changing ADMIN_NAME invalidates admin tokens immediately', () => {
  // Otherwise an outstanding token stays good for the rest of its 24 hours,
  // which is exactly the window you are trying to close.
  const ctx = loadCodeGs();
  const token = ctx.fns.makeToken('admin', 'Logan Brose', Date.now() + 60_000);
  assert.equal(ctx.fns.verifyToken(token, 'admin').ok, true);

  ctx.props.ADMIN_NAME = 'Someone Else';
  assert.equal(ctx.fns.verifyToken(token, 'admin').ok, false);
});

/* ---------------------------------------------------------------- */
/* Site sign-in                                                      */
/* ---------------------------------------------------------------- */

test('the site password signs you in and logs the cleaned name', () => {
  const { fns, rows } = loadCodeGs();
  const res = fns.handleSignIn({ name: ' Casey  Jones ', password: 'team-pw', page: 'stats' });

  assert.equal(res.ok, true);
  assert.equal(res.name, 'Casey Jones');
  assert.equal(fns.verifyToken(res.token, 'site').ok, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][1], 'Casey Jones');
  assert.equal(rows[0][2], 'stats');
  assert.equal(rows[0][4], 'signin');
});

test('a wrong site password unlocks nothing and is logged as a failure', () => {
  const { fns, rows } = loadCodeGs();
  assert.deepEqual(fns.handleSignIn({ name: 'Casey', password: 'nope' }),
    { ok: false, reason: 'password' });
  assert.equal(rows[0][4], 'failed:site');
});

/* ---------------------------------------------------------------- */
/* Admin sign-in — name AND password                                 */
/* ---------------------------------------------------------------- */

test('the admin password works with the admin name, whatever its case or spacing', () => {
  const { fns } = loadCodeGs();
  const res = fns.handleAdmin({ name: '  logan   BROSE ', password: 'admin-pw' });
  assert.equal(res.ok, true);
  assert.equal(fns.verifyToken(res.token, 'admin').ok, true);
  assert.ok(Array.isArray(res.signIns));
});

test('the right admin password under the wrong name fails', () => {
  const { fns } = loadCodeGs();
  assert.equal(fns.handleAdmin({ name: 'Someone Else', password: 'admin-pw' }).ok, false);
});

test('the admin name with the wrong password fails', () => {
  const { fns } = loadCodeGs();
  assert.equal(fns.handleAdmin({ name: 'Logan Brose', password: 'nope' }).ok, false);
});

test('a wrong admin name and a wrong admin password are indistinguishable', () => {
  // If these differed, an attacker could confirm the name before starting on
  // the password.
  const { fns } = loadCodeGs();
  const wrongName = fns.handleAdmin({ name: 'Someone Else', password: 'admin-pw' });
  const wrongPassword = fns.handleAdmin({ name: 'Logan Brose', password: 'nope' });

  assert.deepEqual(wrongName, wrongPassword);
  assert.deepEqual(wrongName, { ok: false, reason: 'password' });
});

test('a failed admin attempt records the name that was typed', () => {
  const { fns, rows } = loadCodeGs();
  fns.handleAdmin({ name: 'Someone Else', password: 'admin-pw' });
  assert.equal(rows[0][1], 'Someone Else');
  assert.equal(rows[0][4], 'failed:admin');
});

/* ---------------------------------------------------------------- */
/* Throttle                                                          */
/* ---------------------------------------------------------------- */

test('failures slow down after ten in a minute', () => {
  const { fns } = loadCodeGs();
  const reasons = [];
  for (let i = 0; i < 13; i++) {
    reasons.push(fns.handleSignIn({ name: 'Guesser', password: 'guess' + i }).reason);
  }

  assert.equal(reasons.filter((r) => r === 'password').length, 10);
  assert.equal(reasons[10], 'slow');
  assert.equal(fns.handleSignIn({ name: 'Guesser', password: 'x' }).retryAfter, 30);
});

test('a correct password still works during the slowdown', () => {
  // The whole point of a slowdown rather than a lockout: nobody can shut the
  // team out by guessing badly at the endpoint.
  const { fns } = loadCodeGs();
  for (let i = 0; i < 25; i++) fns.handleSignIn({ name: 'Guesser', password: 'guess' + i });

  assert.equal(fns.handleSignIn({ name: 'Coach', password: 'team-pw' }).ok, true);
  assert.equal(fns.handleAdmin({ name: 'Logan Brose', password: 'admin-pw' }).ok, true);
});

test('a successful sign-in never counts toward the throttle', () => {
  const { fns, cache } = loadCodeGs();
  for (let i = 0; i < 20; i++) fns.handleSignIn({ name: 'Coach', password: 'team-pw' });
  assert.equal(cache.get('fails'), undefined);
});

/* ---------------------------------------------------------------- */
/* Transport                                                         */
/* ---------------------------------------------------------------- */

test('doPost dispatches and refuses unknown or malformed requests', () => {
  const { fns } = loadCodeGs();
  assert.equal(post(fns, { action: 'signin', name: 'Coach', password: 'team-pw' }).ok, true);
  assert.deepEqual(post(fns, { action: 'nope' }), { ok: false, reason: 'unknown_action' });
  assert.deepEqual(
    JSON.parse(fns.doPost({ postData: { contents: '{not json' } }).body),
    { ok: false, reason: 'bad_request' },
  );
  assert.deepEqual(JSON.parse(fns.doGet().body), { ok: false, reason: 'post_only' });
});

test('an internal error never leaks a stack trace to the caller', () => {
  const { fns } = loadCodeGs({ TOKEN_SECRET: '' });   // prop() throws
  assert.deepEqual(post(fns, { action: 'signin', name: 'Coach', password: 'team-pw' }),
    { ok: false, reason: 'error' });
});

test('the sign-in list comes back newest first', () => {
  const { fns } = loadCodeGs();
  fns.handleSignIn({ name: 'First', password: 'team-pw' });
  fns.handleSignIn({ name: 'Second', password: 'team-pw' });

  const list = fns.handleAdmin({ name: 'Logan Brose', password: 'admin-pw' }).signIns;
  assert.equal(list[0].name, 'Logan Brose', 'the admin sign-in itself is the newest');
  assert.equal(list[1].name, 'Second');
  assert.equal(list[2].name, 'First');
});

/* ---------------------------------------------------------------- */
/* The token delimiter                                               */
/* ---------------------------------------------------------------- */

test('a pipe is stripped from a name, because it separates token fields', () => {
  // Not tidiness. makeToken builds "role|name|expiry" and verifyToken requires
  // exactly three fields, so a name carrying one would sign in, hand back a
  // token, and then fail every request made with it.
  const { fns } = loadCodeGs();
  assert.equal(fns.cleanName('Logan|Brose'), 'LoganBrose');
  assert.equal(fns.cleanName('a | b'), 'a b', 'the surrounding spaces still collapse');
  assert.equal(fns.cleanName('|'), '', 'a name that was only a pipe is unusable');
  assert.equal(fns.cleanName('  |Casey|  '), 'Casey');
});

test('a token issued for a name containing a pipe still verifies', () => {
  // The end the bug actually bit: sign-in succeeded and everything after it
  // failed, which reads as a broken site rather than a rejected name.
  const { fns } = loadCodeGs();
  const res = fns.handleSignIn({ name: 'Logan|Brose', password: 'team-pw' });

  assert.equal(res.ok, true);
  const check = fns.verifyToken(res.token, 'site');
  assert.equal(check.ok, true, 'the token must verify, not just be issued');
  assert.equal(check.name, res.name);
});

test('an admin whose typed name contains a pipe is handled consistently', () => {
  // Both sides run the same cleanName, so ADMIN_NAME and the typed name are
  // compared after the same stripping.
  const ctx = loadCodeGs({ ADMIN_NAME: 'Logan Brose' });
  assert.equal(ctx.fns.handleAdmin({ name: 'Logan|Brose', password: 'admin-pw' }).ok, false,
    'stripping does not turn a different name into a match');

  const piped = loadCodeGs({ ADMIN_NAME: 'Logan|Brose' });
  const res = piped.fns.handleAdmin({ name: 'LoganBrose', password: 'admin-pw' });
  assert.equal(res.ok, true, 'a pipe in the property is stripped the same way');
  assert.equal(piped.fns.verifyToken(res.token, 'admin').ok, true);
});

/* ---------------------------------------------------------------- */
/* Either password at the front door                                 */
/* ---------------------------------------------------------------- */

/**
 * These call handleSignIn end to end — real prop(), log(), makeToken(),
 * CacheService and the log sheet, all through the shims. That is deliberate:
 * an undefined variable inside the function (a dropped `var page`, say) throws
 * a ReferenceError at runtime and would sail past any test that only exercised
 * the comparison helpers.
 */

test('handleSignIn runs end to end on success, touching every helper it uses', () => {
  const { fns, rows } = loadCodeGs();
  const res = fns.handleSignIn({
    name: 'Casey Jones', password: 'team-pw', page: 'stats.html', ua: 'TestBrowser/1.0',
  });

  assert.equal(res.ok, true);
  assert.equal(res.name, 'Casey Jones');
  assert.equal(fns.verifyToken(res.token, 'site').ok, true);

  // The row proves page and ua reached log() rather than being undefined.
  assert.equal(rows.length, 1);
  assert.equal(rows[0][1], 'Casey Jones');
  assert.equal(rows[0][2], 'stats.html');
  assert.equal(rows[0][3], 'TestBrowser/1.0');
  assert.equal(rows[0][4], 'signin');
});

test('handleSignIn runs end to end on failure, touching every helper it uses', () => {
  // failed() takes page and ua too, so the failure path needs its own check.
  const { fns, rows, cache } = loadCodeGs();
  const res = fns.handleSignIn({
    name: 'Casey Jones', password: 'wrong', page: 'index.html', ua: 'TestBrowser/1.0',
  });

  assert.deepEqual(res, { ok: false, reason: 'password' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0][2], 'index.html');
  assert.equal(rows[0][3], 'TestBrowser/1.0');
  assert.equal(rows[0][4], 'failed:site');
  assert.equal(cache.get('fails'), '1', 'the throttle counted it');
});

test('a sign-in with no page or ua still works rather than throwing', () => {
  const { fns, rows } = loadCodeGs();
  assert.equal(fns.handleSignIn({ name: 'Casey', password: 'team-pw' }).ok, true);
  assert.equal(rows[0][2], '');
  assert.equal(rows[0][3], '');
});

test('the admin password at the front door signs you straight in as admin', () => {
  // The whole point: no second prompt for the person who owns the site.
  const { fns, rows } = loadCodeGs();
  const res = fns.handleSignIn({ name: 'Logan Brose', password: 'admin-pw', page: 'index.html' });

  assert.equal(res.ok, true);
  assert.equal(fns.verifyToken(res.token, 'site').ok, true, 'a site token as well');
  assert.equal(fns.verifyToken(res.adminToken, 'admin').ok, true, 'and an admin token');
  assert.equal(rows[0][4], 'admin', 'logged as an admin sign-in, not a plain one');
});

test('the admin name is matched the same way here as in handleAdmin', () => {
  const { fns } = loadCodeGs();
  const res = fns.handleSignIn({ name: '  logan   BROSE ', password: 'admin-pw' });
  assert.equal(res.ok, true);
  assert.equal(fns.verifyToken(res.adminToken, 'admin').ok, true);
});

test('the team password gets a site token and no admin token', () => {
  const { fns, rows } = loadCodeGs();
  const res = fns.handleSignIn({ name: 'Casey Jones', password: 'team-pw' });

  assert.equal(res.ok, true);
  assert.equal(res.adminToken, undefined, 'a coach must not be handed admin');
  assert.equal(rows[0][4], 'signin');
});

test('the team password under the admin name still gets no admin token', () => {
  // Knowing the admin name is not a credential.
  const { fns } = loadCodeGs();
  const res = fns.handleSignIn({ name: 'Logan Brose', password: 'team-pw' });
  assert.equal(res.ok, true);
  assert.equal(res.adminToken, undefined);
});

test('the admin password under the wrong name is refused, indistinguishably', () => {
  // Otherwise the front door becomes a way to confirm the admin name.
  const { fns } = loadCodeGs();
  const wrongName = fns.handleSignIn({ name: 'Someone Else', password: 'admin-pw' });
  const wrongPassword = fns.handleSignIn({ name: 'Someone Else', password: 'nonsense' });

  assert.deepEqual(wrongName, wrongPassword);
  assert.deepEqual(wrongName, { ok: false, reason: 'password' });
});

test('an admin can still sign in while the slowdown is running', () => {
  const { fns } = loadCodeGs();
  for (let i = 0; i < 25; i++) fns.handleSignIn({ name: 'Guesser', password: 'guess' + i });

  const res = fns.handleSignIn({ name: 'Logan Brose', password: 'admin-pw' });
  assert.equal(res.ok, true);
  assert.equal(fns.verifyToken(res.adminToken, 'admin').ok, true);
});

test('the front door works through doPost, not just called directly', () => {
  const { fns } = loadCodeGs();
  const res = post(fns, { action: 'signin', name: 'Logan Brose', password: 'admin-pw' });
  assert.equal(res.ok, true);
  assert.ok(res.adminToken, 'the admin token survives JSON serialisation');
});
