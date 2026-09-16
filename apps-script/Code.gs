/**
 * Coach Tools — sign-in backend.
 *
 * Paste this whole file into a Google Apps Script project bound to (or just
 * owned by) your account, then deploy it as a web app. See the "Sign-in setup"
 * section of README.md for the click-by-click version.
 *
 * NOTHING SECRET LIVES IN THIS FILE. Passwords, your name and the sheet IDs are
 * all read from Script Properties, so this file is safe in a public repo:
 *
 *   SITE_PASSWORD   what the team types
 *   ADMIN_PASSWORD  what only you type
 *   ADMIN_NAME      the admin password only works alongside this name
 *   LOG_SHEET_ID    a NEW, SEPARATE spreadsheet for the sign-in log
 *   TOKEN_SECRET    any long random string
 *
 * Optional, if you want different session lengths than the defaults:
 *
 *   SITE_DAYS       how long a team sign-in lasts   (default 30)
 *   ADMIN_HOURS     how long an admin session lasts (default 24)
 *
 * These are the lengths that actually matter. config.gate.days and
 * config.gate.adminHours on the site only decide when a browser stops offering
 * a stored session; the expiry baked into the token is what this script
 * enforces, because a browser can lie and this cannot.
 *
 * To update this script later: Deploy -> Manage deployments -> Edit (pencil)
 * -> Version: New version -> Deploy. That keeps the same URL. "New deployment"
 * mints a *different* URL that config.js is not pointing at, and the site will
 * look broken while the old code quietly keeps serving.
 */

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

var SIGNIN_SHEET = 'SignIns';
var SIGNIN_HEADERS = ['Timestamp', 'Name', 'Page', 'User agent', 'Result'];

/** Names are free text from a public endpoint, so they get a hard ceiling. */
var MAX_NAME = 60;

/** Failures allowed in a rolling minute before failed attempts are slowed. */
var THROTTLE_MAX = 10;
var THROTTLE_WINDOW_SECONDS = 60;
var THROTTLE_RETRY_AFTER = 30;

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * The site POSTs JSON as text/plain. That is not a style choice: Apps Script
 * does not answer OPTIONS, so any content type that triggers a CORS preflight
 * fails before doPost is ever reached.
 */
function doPost(e) {
  var body;
  try {
    body = JSON.parse(e && e.postData ? e.postData.contents : '{}');
  } catch (err) {
    return json({ ok: false, reason: 'bad_request' });
  }

  try {
    switch (body.action) {
      case 'signin': return json(handleSignIn(body));
      case 'admin': return json(handleAdmin(body));
      default: return json({ ok: false, reason: 'unknown_action' });
    }
  } catch (err) {
    // Never leak a stack trace to a public endpoint; the Executions log in the
    // script editor has the detail.
    console.error(err);
    return json({ ok: false, reason: 'error' });
  }
}

/** A GET is almost always someone pasting the URL into a browser bar. */
function doGet() {
  return json({ ok: false, reason: 'post_only' });
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

/**
 * Site sign-in: any name, plus the shared site password.
 */
function handleSignIn(body) {
  var name = cleanName(body.name);
  var page = String(body.page || '').slice(0, 80);
  var ua = String(body.ua || '').slice(0, 120);

  if (name === '') return { ok: false, reason: 'name' };

  var expected = prop('SITE_PASSWORD');
  var okPassword = constantTimeEquals(String(body.password || ''), expected);

  if (!okPassword) return failed(name, page, ua, 'site');

  log(name, page, ua, 'signin');
  return { ok: true, name: name, token: makeToken('site', name, siteExpiry()) };
}

/**
 * Admin sign-in: the admin password works ONLY alongside the admin name.
 *
 * Both comparisons run every time and are combined at the end. An early return
 * on the name check would answer a wrong name measurably faster than a wrong
 * password, which tells an attacker which half they already have.
 */
function handleAdmin(body) {
  var name = cleanName(body.name);
  var page = String(body.page || 'admin').slice(0, 80);
  var ua = String(body.ua || '').slice(0, 120);

  var adminName = cleanName(prop('ADMIN_NAME'));
  var okName = constantTimeEquals(name.toLowerCase(), adminName.toLowerCase());
  var okPassword = constantTimeEquals(String(body.password || ''), prop('ADMIN_PASSWORD'));

  if (!(okName && okPassword)) return failed(name, page, ua, 'admin');

  log(name, page, ua, 'admin');
  return {
    ok: true,
    name: name,
    token: makeToken('admin', name, adminExpiry()),
    signIns: readSignIns(),
  };
}

/**
 * One failure path for every wrong credential, so the response cannot be used
 * to tell a wrong name from a wrong password.
 *
 * The throttle is consulted HERE, after the comparison — never before it. A
 * correct password is answered normally even mid-slowdown, so nobody can lock
 * the team out by hammering the endpoint with bad guesses.
 */
function failed(name, page, ua, kind) {
  log(name, page, ua, 'failed:' + kind);

  if (bumpFailures() > THROTTLE_MAX) {
    return { ok: false, reason: 'slow', retryAfter: THROTTLE_RETRY_AFTER };
  }
  return { ok: false, reason: 'password' };
}

/* ------------------------------------------------------------------ */
/* Names                                                               */
/* ------------------------------------------------------------------ */

/**
 * Trim, collapse internal whitespace, cap the length. Returns '' for anything
 * unusable. The site applies the same rule, but this endpoint is reachable
 * directly, so the rule has to hold here too.
 */
function cleanName(raw) {
  if (raw == null) return '';
  return String(raw).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

/**
 * base64(role|name|expiryMs) + '.' + base64(HMAC-SHA256(payload, secret))
 *
 * The role, the name and the expiry are all inside the signature:
 *   - role, so a site token can never be replayed as an admin token;
 *   - expiry, so lifetime is enforced here rather than by a browser that could
 *     simply lie about it;
 *   - name, so admin tokens stop working the moment ADMIN_NAME changes.
 */
function makeToken(role, name, expiryMs) {
  var payload = role + '|' + name + '|' + expiryMs;
  return b64(payload) + '.' + b64Bytes(hmac(payload));
}

/**
 * @returns {{ok: boolean, role: string, name: string}}
 */
function verifyToken(token, wantRole) {
  var parts = String(token || '').split('.');
  if (parts.length !== 2) return { ok: false, role: '', name: '' };

  var payload;
  try {
    payload = unb64(parts[0]);
  } catch (err) {
    return { ok: false, role: '', name: '' };
  }

  if (!constantTimeEquals(parts[1], b64Bytes(hmac(payload)))) {
    return { ok: false, role: '', name: '' };
  }

  var fields = payload.split('|');
  if (fields.length !== 3) return { ok: false, role: '', name: '' };

  var role = fields[0];
  var name = fields[1];
  var expiry = Number(fields[2]);

  if (!(expiry > Date.now())) return { ok: false, role: '', name: '' };
  if (wantRole && role !== wantRole) return { ok: false, role: '', name: '' };

  // An admin token is only as good as the current ADMIN_NAME. Changing that
  // property invalidates outstanding admin tokens immediately, rather than
  // leaving them valid for the rest of their 24 hours.
  if (role === 'admin' && name.toLowerCase() !== cleanName(prop('ADMIN_NAME')).toLowerCase()) {
    return { ok: false, role: '', name: '' };
  }

  return { ok: true, role: role, name: name };
}

function hmac(message) {
  return Utilities.computeHmacSha256Signature(message, prop('TOKEN_SECRET'));
}

function b64(text) {
  return Utilities.base64EncodeWebSafe(text);
}

function b64Bytes(bytes) {
  return Utilities.base64EncodeWebSafe(bytes);
}

function unb64(text) {
  return Utilities.newBlob(Utilities.base64DecodeWebSafe(text)).getDataAsString();
}

function siteExpiry() {
  return Date.now() + numberProp('SITE_DAYS', 30) * 24 * 60 * 60 * 1000;
}

function adminExpiry() {
  return Date.now() + numberProp('ADMIN_HOURS', 24) * 60 * 60 * 1000;
}

/* ------------------------------------------------------------------ */
/* Comparison                                                          */
/* ------------------------------------------------------------------ */

/**
 * Compare without returning early on the first differing character.
 *
 * The length is folded into the accumulator rather than short-circuited on, so
 * a wrong-length guess takes the same path as a wrong-content one.
 */
function constantTimeEquals(a, b) {
  a = String(a == null ? '' : a);
  b = String(b == null ? '' : b);

  var diff = a.length ^ b.length;
  var max = Math.max(a.length, b.length);
  for (var i = 0; i < max; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/* ------------------------------------------------------------------ */
/* Throttle                                                            */
/* ------------------------------------------------------------------ */

/**
 * Count failures in a rolling window. Only failures ever reach this, so a
 * correct password is never delayed by someone else's guessing.
 */
function bumpFailures() {
  var cache = CacheService.getScriptCache();
  var count = Number(cache.get('fails') || 0) + 1;
  cache.put('fails', String(count), THROTTLE_WINDOW_SECONDS);
  return count;
}

/* ------------------------------------------------------------------ */
/* The log sheet                                                       */
/* ------------------------------------------------------------------ */

function logSheet() {
  var ss = SpreadsheetApp.openById(prop('LOG_SHEET_ID'));
  var sheet = ss.getSheetByName(SIGNIN_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(SIGNIN_SHEET);
    sheet.appendRow(SIGNIN_HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * Both the name and the user agent are self-reported — Apps Script cannot read
 * request headers, so the page sends them. This is a roster of use, not an
 * audit trail, and the README says so in those words.
 */
function log(name, page, ua, result) {
  logSheet().appendRow([new Date(), name, page, ua, result]);
}

/** Newest first, so the admin view does not have to sort a growing sheet. */
function readSignIns() {
  var values = logSheet().getDataRange().getDisplayValues();
  if (values.length < 2) return [];

  var rows = values.slice(1).map(function (r) {
    return { at: r[0], name: r[1], page: r[2], ua: r[3], result: r[4] || 'signin' };
  });
  return rows.reverse();
}

/* ------------------------------------------------------------------ */
/* Script Properties                                                   */
/* ------------------------------------------------------------------ */

function prop(key) {
  var value = PropertiesService.getScriptProperties().getProperty(key);
  if (value == null || value === '') {
    throw new Error('Missing Script Property: ' + key);
  }
  return value;
}

function numberProp(key, fallback) {
  var value = PropertiesService.getScriptProperties().getProperty(key);
  var n = Number(value);
  return value && isFinite(n) && n > 0 ? n : fallback;
}

/* ------------------------------------------------------------------ */
/* Setup check                                                         */
/* ------------------------------------------------------------------ */

/**
 * Run this once from the editor (Run -> checkSetup) after filling in the Script
 * Properties. It reports what is missing by name instead of leaving you to
 * decode a failure from the site, and it triggers the authorization prompt.
 */
function checkSetup() {
  var required = ['SITE_PASSWORD', 'ADMIN_PASSWORD', 'ADMIN_NAME', 'LOG_SHEET_ID', 'TOKEN_SECRET'];
  var missing = required.filter(function (key) {
    var v = PropertiesService.getScriptProperties().getProperty(key);
    return v == null || v === '';
  });

  if (missing.length) {
    Logger.log('MISSING Script Properties: ' + missing.join(', '));
    return;
  }

  logSheet();
  Logger.log('Setup looks good. Log sheet is reachable and the "%s" tab exists.', SIGNIN_SHEET);
  Logger.log('Admin name is "%s".', cleanName(prop('ADMIN_NAME')));
}
