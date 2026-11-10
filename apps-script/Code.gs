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
 * Optional:
 *
 *   VIEWER_PASSWORD a view-only login: the team playbook and nothing else.
 *                   Leave it unset and there is no viewer login at all.
 *                   It only works for a name on the Players tab of the
 *                   stats spreadsheet (the Full Name column).
 *   SITE_DAYS       how long a team sign-in lasts, in days   (default 30)
 *   VIEWER_HOURS    how long a viewer sign-in lasts, in hours (default 24)
 *   ADMIN_HOURS     how long an admin session lasts         (default 24)
 *   SIGNIN_DAYS     how far back the admin sign-in list goes (default 30)
 *
 * Written by the script itself — do not set it by hand:
 *
 *   SESSION_EPOCH   bumped by the admin's "Sign everyone out" button. It is
 *                   mixed into every token signature, so changing it makes
 *                   every outstanding token stop verifying at once.
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

/**
 * Wrong passwords allowed within a minute. The next one locks sign-in for
 * LOCKOUT_SECONDS for EVERYONE, correct password or not.
 *
 * Apps Script cannot see IP addresses, so there is no telling one guesser from
 * another: the lock has to be global. The trade-off is deliberate. Someone
 * hammering the endpoint can stop new sign-ins for ten minutes at a time, but
 * cannot try more than a handful of passwords in that time. People already
 * signed in are unaffected — their tokens keep working throughout.
 */
var THROTTLE_MAX = 5;
var THROTTLE_WINDOW_SECONDS = 60;
var LOCKOUT_SECONDS = 600;

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
      case 'signIns': return json(handleSignIns(body));
      case 'data': return json(handleData(body));
      case 'plays': return json(handlePlays(body));
      case 'savePlay': return json(handleSavePlay(body));
      case 'deletePlay': return json(handleDeletePlay(body));
      case 'check': return json(handleCheck(body));
      case 'signOutAll': return json(handleSignOutAll(body));
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
 *
 * The viewer password, if VIEWER_PASSWORD is set, signs you in with a 'viewer'
 * token. That token reads the team playbook and nothing else: no roster, no
 * stats, no writes. If two passwords happen to match, the stronger role wins.
 */
function handleSignIn(body) {
  var name = cleanName(body.name);
  var page = String(body.page || '').slice(0, 80);
  var ua = String(body.ua || '').slice(0, 120);

  if (name === '') return { ok: false, reason: 'name' };

  // Before any comparison: during a lockout no password is checked at all, so
  // a guess made now cannot succeed and is not even worth making.
  var locked = lockedOut();
  if (locked) return locked;

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

  // Optional, so an unset property must never match an empty password.
  var viewerPassword = optionalProp('VIEWER_PASSWORD');
  var okViewer = constantTimeEquals(given, viewerPassword) && viewerPassword !== '';

  // One failure path, whichever half was wrong. The admin password under the
  // wrong name is refused exactly like any other bad guess.
  if (!(okSite || okAdmin || okViewer)) return failed(name, page, ua, 'site');

  if (!okSite && !okAdmin) {
    // The view-only password is shared with the players, so it is only good
    // under a name on the roster. Saying so tells the person the password was
    // right, which is why it still counts toward the lockout like any miss.
    if (!onRoster(name)) return failed(name, page, ua, 'roster', 'not_on_roster');

    log(name, page, ua, 'viewer');
    var viewerUntil = viewerExpiry();
    return {
      ok: true, name: name, role: 'viewer',
      token: makeToken('viewer', name, viewerUntil),
      expiresAt: viewerUntil,   // so the browser asks again when the token stops working
    };
  }

  log(name, page, ua, okAdmin ? 'admin' : 'signin');

  var out = {
    ok: true,
    name: name,
    role: okAdmin ? 'admin' : 'site',
    token: makeToken('site', name, siteExpiry()),
  };
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

  var locked = lockedOut();
  if (locked) return locked;

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
    active: readActiveSessions(),
    days: numberProp('SIGNIN_DAYS', 30),
  };
}

/**
 * The sign-in log, for a browser that already holds an admin token.
 *
 * The admin page used to ask for the password again to get this list. It no
 * longer asks for anything — a prompt would tell a coach that an admin page
 * exists — so the list has to be reachable with the token the sign-in already
 * produced.
 */
function handleSignIns(body) {
  var admin = verifyToken(body.token, 'admin');
  if (!admin.ok) return { ok: false, reason: 'auth' };
  return {
    ok: true,
    signIns: readSignIns(),
    active: readActiveSessions(),
    days: numberProp('SIGNIN_DAYS', 30),
  };
}

/**
 * Is a stored session still good? Asked by every page in the background, so a
 * browser holding a token that was revoked (or has expired here, whatever the
 * browser thinks) goes back to the sign-in popup instead of half-working.
 *
 * Any role is accepted for `token`; `adminToken` is optional and reported
 * separately, so an admin whose admin session lapsed drops to the coach view
 * rather than being signed out entirely. Not logged: it is not a sign-in.
 */
function handleCheck(body) {
  var site = rosterChecked(verifyToken(body.token));
  var out = { ok: true, valid: site.ok, role: site.role };
  if (body.adminToken) out.adminValid = verifyToken(body.adminToken, 'admin').ok;
  return out;
}

/**
 * Sign everyone out: every coach, every viewer and every other admin session.
 *
 * Done by changing SESSION_EPOCH, which is part of the key every token is
 * signed with, so nothing has to be listed or tracked — every token issued
 * before this moment simply stops verifying. The admin who pressed the button
 * is handed fresh tokens so they are not thrown out with everyone else.
 */
function handleSignOutAll(body) {
  var admin = verifyToken(body.token, 'admin');
  if (!admin.ok) return { ok: false, reason: 'auth' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var props = PropertiesService.getScriptProperties();
    var previous = props.getProperty('SESSION_EPOCH');
    var epoch = String(Date.now());
    // Two presses inside the same millisecond must still change the key.
    if (epoch === previous) epoch += '-1';
    props.setProperty('SESSION_EPOCH', epoch);
  } finally {
    lock.releaseLock();
  }

  log(admin.name, String(body.page || 'admin').slice(0, 80),
    String(body.ua || '').slice(0, 120), 'signout-all');

  return {
    ok: true,
    name: admin.name,
    token: makeToken('site', admin.name, siteExpiry()),
    adminToken: makeToken('admin', admin.name, adminExpiry()),
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
 * Every play, for any signed-in coach or viewer.
 *
 * Reading takes a site (or viewer) token so the playbook works on a phone with
 * the team password. Writing takes a site or admin token — see handleSavePlay.
 * This is the only action a viewer token is good for.
 */
function handlePlays(body) {
  var site = verifyToken(body.token, 'site');
  var admin = verifyToken(body.token, 'admin');
  var viewer = rosterChecked(verifyToken(body.token, 'viewer'));
  if (!site.ok && !admin.ok && !viewer.ok) return { ok: false, reason: 'auth' };

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
 * Who may change the team playbook: any coach (a site token) or the admin.
 * A view-only token is refused — viewers read the playbook and nothing else.
 */
function playWriter(token) {
  var admin = verifyToken(token, 'admin');
  if (admin.ok) return admin;
  return verifyToken(token, 'site');
}

/**
 * Add or replace one play. Any signed-in coach or the admin; never a viewer.
 * The name on the token is recorded as `updatedBy`, so the sheet shows who
 * published each play.
 */
function handleSavePlay(body) {
  var writer = playWriter(body.token);
  if (!writer.ok) return { ok: false, reason: 'auth' };

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
      writer.name,
      text,
    ];

    var rowIndex = findPlayRow(sheet, play.id);
    if (rowIndex === -1) sheet.appendRow(row);
    else sheet.getRange(rowIndex, 1, 1, PLAYS_HEADERS.length).setValues([row]);

    return { ok: true, id: play.id, updatedBy: writer.name };
  } finally {
    lock.releaseLock();
  }
}

/** Remove one play from the team playbook. Any signed-in coach or the admin. */
function handleDeletePlay(body) {
  if (!playWriter(body.token).ok) return { ok: false, reason: 'auth' };
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
 * Each failure is logged, and the one that crosses THROTTLE_MAX also writes a
 * single "lockout" row. During the lockout itself sign-in returns before it
 * gets here, so a flood of guesses adds nothing to the log sheet.
 */
function failed(name, page, ua, kind, reason) {
  log(name, page, ua, 'failed:' + kind);

  if (bumpFailures() > THROTTLE_MAX) {
    startLockout();
    log(name, page, ua, 'lockout');
    return { ok: false, reason: 'slow', retryAfter: LOCKOUT_SECONDS };
  }
  return { ok: false, reason: reason || 'password' };
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
/* The roster: who the view-only password works for                    */
/* ------------------------------------------------------------------ */

var ROSTER_TAB = 'Players';
var ROSTER_CACHE_SECONDS = 300;

/** The header cells the Full Name column may have; the same list sheets.js accepts. */
var ROSTER_NAME_HEADERS = ['full name', 'name', 'player name'];

/** How a name is compared: cleaned exactly as at sign-in, then lowercased. */
function rosterKey(raw) {
  return cleanName(raw).toLowerCase();
}

/**
 * Every Full Name on the Players tab, as roster keys.
 *
 * The header row is found by its Full Name cell, so the legend lines above it
 * are skipped. Rows with a blank name, or a Player ID starting with "EX" (the
 * example rows), are left out — the same rule the site uses.
 *
 * Cached for five minutes, so a sign-in does not open the stats spreadsheet
 * every time; removing a player therefore takes effect within five minutes.
 * A missing or unreadable tab gives an empty list: no view-only sign-ins
 * rather than everyone's.
 */
function rosterNames() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('roster');
  if (cached) return JSON.parse(cached);

  var names = [];
  var sheet = SpreadsheetApp.openById(prop('STATS_SHEET_ID')).getSheetByName(ROSTER_TAB);
  var values = sheet ? sheet.getDataRange().getDisplayValues() : [];

  var nameCol = -1;
  var idCol = -1;
  var r = 0;
  for (; r < values.length && nameCol === -1; r++) {
    var cells = values[r].map(function (c) { return String(c).trim().toLowerCase(); });
    for (var h = 0; h < ROSTER_NAME_HEADERS.length && nameCol === -1; h++) {
      nameCol = cells.indexOf(ROSTER_NAME_HEADERS[h]);
    }
    if (nameCol !== -1) idCol = cells.indexOf('player id');
  }

  if (nameCol !== -1) {
    for (; r < values.length; r++) {
      var id = idCol === -1 ? '' : String(values[r][idCol] || '').trim();
      if (/^ex/i.test(id)) continue;
      var key = rosterKey(values[r][nameCol]);
      if (key !== '' && names.indexOf(key) === -1) names.push(key);
    }
  }

  cache.put('roster', JSON.stringify(names), ROSTER_CACHE_SECONDS);
  return names;
}

function onRoster(name) {
  var key = rosterKey(name);
  return key !== '' && rosterNames().indexOf(key) !== -1;
}

/**
 * A verified viewer token only counts while its name is still on the roster,
 * so taking a player off the Players tab ends their sign-in too. Other roles
 * pass through untouched.
 */
function rosterChecked(result) {
  if (result.ok && result.role === 'viewer' && !onRoster(result.name)) {
    return { ok: false, role: '', name: '' };
  }
  return result;
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

/**
 * The signing key is TOKEN_SECRET plus SESSION_EPOCH when one has been set.
 * With no epoch the key is TOKEN_SECRET alone, exactly as before this existed,
 * so deploying this version signs nobody out; only the button does.
 */
function signingKey() {
  var epoch = optionalProp('SESSION_EPOCH');
  var secret = prop('TOKEN_SECRET');
  return epoch ? secret + '|' + epoch : secret;
}

function hmac(message) {
  return Utilities.computeHmacSha256Signature(message, signingKey());
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

function viewerExpiry() {
  return Date.now() + numberProp('VIEWER_HOURS', 24) * 60 * 60 * 1000;
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

/** Count failures in a rolling window. */
function bumpFailures() {
  var cache = CacheService.getScriptCache();
  var count = Number(cache.get('fails') || 0) + 1;
  cache.put('fails', String(count), THROTTLE_WINDOW_SECONDS);
  return count;
}

/**
 * Lock sign-in. The value is the moment the lock ends, so the reply can say how
 * long is left; the cache expiry is only a backstop for that. The failure count
 * starts again from zero, so the first wrong password after a lockout does not
 * immediately start another one.
 */
function startLockout() {
  var cache = CacheService.getScriptCache();
  cache.put('lockout', String(Date.now() + LOCKOUT_SECONDS * 1000), LOCKOUT_SECONDS);
  cache.put('fails', '0', THROTTLE_WINDOW_SECONDS);
}

/** The refusal to send while sign-in is locked, or null when it is not. */
function lockedOut() {
  var until = Number(CacheService.getScriptCache().get('lockout') || 0);
  var left = Math.ceil((until - Date.now()) / 1000);
  if (!(left > 0)) return null;
  return { ok: false, reason: 'slow', retryAfter: Math.min(left, LOCKOUT_SECONDS) };
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

/**
 * The last SIGNIN_DAYS (default 30) of sign-ins, newest first, so the admin
 * view does not have to sort or trim a growing sheet.
 *
 * Older rows stay in the sheet; they just stop being sent. The cut-off reads
 * the raw cell values, where a timestamp is a real Date, rather than parsing
 * the displayed text, whose format depends on the spreadsheet's locale.
 */
function readSignIns() {
  var range = logSheet().getDataRange();
  var values = range.getDisplayValues();
  if (values.length < 2) return [];

  var raw = range.getValues();
  var cutoff = Date.now() - numberProp('SIGNIN_DAYS', 30) * 24 * 60 * 60 * 1000;

  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var when = raw[i] && raw[i][0];
    var ms = when instanceof Date ? when.getTime() : new Date(when).getTime();
    if (!(ms >= cutoff)) continue;   // too old, or not a readable time

    var r = values[i];
    rows.push({ at: r[0], name: r[1], page: r[2], ua: r[3], result: r[4] || 'signin' });
  }
  return rows.reverse();
}

/**
 * Who is signed in right now, worked out from the log.
 *
 * Tokens are not stored anywhere, so this is a calculation, not a list of live
 * connections: each successful sign-in issued a token with a known lifetime,
 * and it counts while that lifetime has not run out and no "Sign everyone out"
 * has happened since. Pressing Sign out in a browser only forgets the token on
 * that device, so that person is still listed until their sign-in would expire.
 *
 * One entry per name (case-insensitive), newest sign-in first. `sessions` is
 * how many still-valid sign-ins that name has — usually one per device.
 */
function readActiveSessions(now) {
  now = now || Date.now();
  var raw = logSheet().getDataRange().getValues();

  var siteMs = numberProp('SITE_DAYS', 30) * 24 * 60 * 60 * 1000;
  var viewerMs = numberProp('VIEWER_HOURS', 24) * 60 * 60 * 1000;
  var adminMs = numberProp('ADMIN_HOURS', 24) * 60 * 60 * 1000;

  // Everything signed before the most recent "Sign everyone out" is dead. The
  // log is only ever appended to, so its row order is the order things
  // happened — safer than comparing timestamps that can share a millisecond.
  var start = 1;
  for (var i = raw.length - 1; i >= 1; i--) {
    if (String(raw[i][4]) === 'signout-all') { start = i; break; }
  }

  var byName = {};
  for (var j = start; j < raw.length; j++) {
    var row = raw[j];
    var at = timeOf(row[0]);
    var result = String(row[4] || 'signin');
    if (!(at > 0)) continue;

    var role;
    var until;
    if (result === 'signin') {
      role = 'coach'; until = at + siteMs;
    } else if (result === 'viewer') {
      role = 'viewer'; until = at + viewerMs;
    } else if (result === 'admin' || result === 'signout-all') {
      // The admin sign-in also carries a coach token, so once the admin part
      // lapses the person is still signed in as a coach.
      role = at + adminMs > now ? 'admin' : 'coach'; until = at + siteMs;
    } else {
      continue;   // failed attempts
    }

    // The row that starts the loop is the "Sign everyone out" itself: the admin
    // who pressed it was handed fresh tokens in that moment, so it counts.
    if (!(until > now)) continue;

    var name = cleanName(row[1]);
    var key = name.toLowerCase();
    if (!byName[key]) byName[key] = { name: name, role: role, since: at, until: until, sessions: 0 };
    var entry = byName[key];
    entry.sessions++;
    if (at > entry.since) { entry.since = at; entry.name = name; }
    if (until > entry.until) entry.until = until;
    if (rank(role) > rank(entry.role)) entry.role = role;
  }

  var list = [];
  for (var k in byName) list.push(byName[k]);
  list.sort(function (a, b) { return b.since - a.since; });
  return list;
}

function rank(role) {
  return role === 'admin' ? 3 : role === 'coach' ? 2 : 1;
}

function timeOf(cell) {
  var ms = cell instanceof Date ? cell.getTime() : new Date(cell).getTime();
  return isFinite(ms) ? ms : 0;
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

/** A property that may legitimately be unset. '' when it is. */
function optionalProp(key) {
  var value = PropertiesService.getScriptProperties().getProperty(key);
  return value == null ? '' : String(value);
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
  Logger.log('Viewer login is %s.', optionalProp('VIEWER_PASSWORD') ? 'ON' : 'off (VIEWER_PASSWORD not set)');
  if (optionalProp('VIEWER_PASSWORD')) {
    CacheService.getScriptCache().remove('roster');
    var roster = rosterNames();
    Logger.log('Viewer login works for %s name(s) on the "%s" tab.%s', roster.length, ROSTER_TAB,
      roster.length ? '' : ' NOBODY can sign in as view-only until that tab has a Full Name column with names.');
  }
  Logger.log('Setup looks good.');
}
