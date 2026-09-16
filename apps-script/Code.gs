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
 *   STATS_SHEET_ID  the spreadsheet holding StatsLog, Players and Games
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
      case 'data': return json(handleData(body));
      case 'plays': return json(handlePlays(body));
      case 'savePlay': return json(handleSavePlay(body));
      case 'deletePlay': return json(handleDeletePlay(body));
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
 * Site sign-in. Either password works here.
 *
 * The team password signs you in as a coach. The admin password, alongside
 * ADMIN_NAME, signs you straight in as admin — no second prompt. That matters
 * because the person who owns the site is the one who needs admin, and making
 * them type two passwords in a row is how the front door came to look like a
 * broken password.
 *
 * An admin always gets a site token as well as an admin one, so every path that
 * only needs a site token keeps working without special-casing the admin.
 */
function handleSignIn(body) {
  var name = cleanName(body.name);
  var page = String(body.page || '').slice(0, 80);
  var ua = String(body.ua || '').slice(0, 120);

  if (name === '') return { ok: false, reason: 'name' };

  var given = String(body.password || '');

  // Every comparison runs every time and they are combined at the end, exactly
  // as in handleAdmin. Returning early on the first match would answer one
  // wrong guess measurably faster than another and say which door you got
  // closest to.
  var okSite = constantTimeEquals(given, prop('SITE_PASSWORD'));
  var okAdminName = constantTimeEquals(
    name.toLowerCase(), cleanName(prop('ADMIN_NAME')).toLowerCase());
  var okAdminPassword = constantTimeEquals(given, prop('ADMIN_PASSWORD'));
  var okAdmin = okAdminName && okAdminPassword;

  // One failure path, whichever half was wrong. The admin password under the
  // wrong name is refused exactly like any other bad guess.
  if (!(okSite || okAdmin)) return failed(name, page, ua, 'site');

  log(name, page, ua, okAdmin ? 'admin' : 'signin');

  var out = { ok: true, name: name, token: makeToken('site', name, siteExpiry()) };
  if (okAdmin) out.adminToken = makeToken('admin', name, adminExpiry());
  return out;
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

/* ------------------------------------------------------------------ */
/* Reading the stats sheet                                             */
/* ------------------------------------------------------------------ */

/**
 * Which token each tab needs.
 *
 * Players is readable with a site token because the playbook's lineup selector
 * needs names, and every signed-in coach uses it. The numbers are admin-only.
 */
var TAB_ROLES = {
  StatsLog: 'admin',
  Games: 'admin',
  Players: 'site',
};

/**
 * Return whole tabs as 2D arrays.
 *
 * getDisplayValues(), not getValues(): the site's header-row detection and date
 * parsing were written against what the CSV export produced, which is the
 * displayed text. Handing over raw values would turn every date into a Date
 * object and every number into a float, and the parser would have to grow a
 * second set of rules for no gain.
 */
function handleData(body) {
  var tabs = Array.isArray(body.tabs) ? body.tabs : [];
  if (tabs.length === 0) return { ok: false, reason: 'bad_request' };

  var site = verifyToken(body.token, 'site');
  var admin = verifyToken(body.token, 'admin');
  if (!site.ok && !admin.ok) return { ok: false, reason: 'auth' };

  // One refusal for the whole request rather than a partial answer: a page that
  // asked for stats and silently got back only the roster would render an empty
  // season as though it were a real one.
  for (var i = 0; i < tabs.length; i++) {
    var need = TAB_ROLES[tabs[i]];
    if (!need) return { ok: false, reason: 'bad_request' };
    if (need === 'admin' && !admin.ok) return { ok: false, reason: 'auth' };
  }

  var ss = SpreadsheetApp.openById(prop('STATS_SHEET_ID'));
  var out = {};
  for (var j = 0; j < tabs.length; j++) {
    var sheet = ss.getSheetByName(tabs[j]);
    out[tabs[j]] = sheet ? sheet.getDataRange().getDisplayValues() : null;
  }

  return { ok: true, tabs: out };
}

/* ------------------------------------------------------------------ */
/* The team playbook                                                   */
/* ------------------------------------------------------------------ */

var PLAYS_SHEET = 'Plays';
var PLAYS_HEADERS = ['Id', 'Slug', 'Playbook', 'Name', 'Updated', 'UpdatedBy', 'JSON'];

/**
 * A Google Sheets cell holds 50,000 characters. Refusing at 45,000 with a
 * sentence someone can act on beats writing a truncated cell that turns into
 * unparseable JSON the next time the playbook is read.
 */
var MAX_PLAY_CHARS = 45000;

function playsSheet() {
  var ss = SpreadsheetApp.openById(prop('LOG_SHEET_ID'));
  var sheet = ss.getSheetByName(PLAYS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(PLAYS_SHEET);
    sheet.appendRow(PLAYS_HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * Every play, for any signed-in coach.
 *
 * Reading takes a site token so the playbook works on a phone with the team
 * password. Writing does not — see handleSavePlay.
 */
function handlePlays(body) {
  var site = verifyToken(body.token, 'site');
  var admin = verifyToken(body.token, 'admin');
  if (!site.ok && !admin.ok) return { ok: false, reason: 'auth' };

  var values = playsSheet().getDataRange().getDisplayValues();
  var plays = [];

  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row[0]) continue;

    var play;
    try {
      play = JSON.parse(row[6]);
    } catch (err) {
      continue;   // one unreadable row must not take the whole playbook down
    }

    plays.push({
      id: row[0],
      slug: row[1],
      playbook: row[2],
      name: row[3],
      updated: row[4],
      updatedBy: row[5],
      play: play,
    });
  }

  return { ok: true, plays: plays };
}

/**
 * Add or replace one play. Admin only.
 *
 * Reading the playbook is a site token, but writing it is not: the shared
 * password is shared, and the team playbook is not something everyone who
 * knows it should be able to rewrite. A coach can still save as many plays as
 * they like on their own device.
 */
function handleSavePlay(body) {
  var admin = verifyToken(body.token, 'admin');
  if (!admin.ok) return { ok: false, reason: 'auth' };

  var play = body.play;
  if (!play || !play.id) return { ok: false, reason: 'bad_request' };

  var text = JSON.stringify(play);
  if (text.length > MAX_PLAY_CHARS) return { ok: false, reason: 'too_big' };

  // Two coaches saving at once can otherwise interleave between finding the row
  // and writing it, and one save disappears with no error anywhere.
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = playsSheet();
    var row = [
      play.id,
      String(play.slug || ''),
      String(play.playbook || 'general'),
      String(play.name || 'Untitled play'),
      new Date(),
      admin.name,
      text,
    ];

    var rowIndex = findPlayRow(sheet, play.id);
    if (rowIndex === -1) sheet.appendRow(row);
    else sheet.getRange(rowIndex, 1, 1, PLAYS_HEADERS.length).setValues([row]);

    return { ok: true, id: play.id, updatedBy: admin.name };
  } finally {
    lock.releaseLock();
  }
}

/** Remove one play from the team playbook. Admin only. */
function handleDeletePlay(body) {
  var admin = verifyToken(body.token, 'admin');
  if (!admin.ok) return { ok: false, reason: 'auth' };
  if (!body.id) return { ok: false, reason: 'bad_request' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = playsSheet();
    var rowIndex = findPlayRow(sheet, body.id);
    // Already gone is the outcome that was asked for, not an error.
    if (rowIndex !== -1) sheet.deleteRow(rowIndex);
    return { ok: true, id: body.id };
  } finally {
    lock.releaseLock();
  }
}

/** 1-based sheet row for a play id, or -1. Must be called holding the lock. */
function findPlayRow(sheet, id) {
  var values = sheet.getDataRange().getDisplayValues();
  for (var i = 1; i < values.length; i++) {
    if (values[i][0] === String(id)) return i + 1;
  }
  return -1;
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
 * Strip "|", collapse internal whitespace, trim, cap the length. Returns '' for
 * anything unusable. The site applies the same rule, but this endpoint is
 * reachable directly, so the rule has to hold here too.
 *
 * The "|" removal is load-bearing, not tidiness: it is the field separator in a
 * token payload, and verifyToken requires exactly three fields. A name
 * containing one would sign in, hand back a token, and then fail every request
 * made with it — which looks like a broken site, not a rejected name.
 */
function cleanName(raw) {
  if (raw == null) return '';
  return String(raw).replace(/\|/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
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
  var required = ['SITE_PASSWORD', 'ADMIN_PASSWORD', 'ADMIN_NAME', 'LOG_SHEET_ID',
    'STATS_SHEET_ID', 'TOKEN_SECRET'];
  var missing = required.filter(function (key) {
    var v = PropertiesService.getScriptProperties().getProperty(key);
    return v == null || v === '';
  });

  if (missing.length) {
    Logger.log('MISSING Script Properties: ' + missing.join(', '));
    return;
  }

  logSheet();
  playsSheet();
  Logger.log('Log sheet is reachable; the "%s" and "%s" tabs exist.', SIGNIN_SHEET, PLAYS_SHEET);

  var stats = SpreadsheetApp.openById(prop('STATS_SHEET_ID'));
  var names = Object.keys(TAB_ROLES);
  for (var i = 0; i < names.length; i++) {
    var tab = stats.getSheetByName(names[i]);
    Logger.log('Stats tab "%s": %s', names[i], tab ? 'found' : 'MISSING');
  }

  Logger.log('Admin name is "%s".', cleanName(prop('ADMIN_NAME')));
  Logger.log('Setup looks good.');
}
