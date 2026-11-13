/**
 * Sign-in gate.
 *
 * The page is hidden until someone gives a name and the site password. What
 * that is worth depends entirely on what sits behind it: this check runs in the
 * visitor's browser and can be bypassed with developer tools. It keeps casual
 * visitors out of the pages. The data is protected separately, by the Apps
 * Script refusing to hand anything over without a token it signed.
 *
 * The logic here is exported and pure so it can be tested without a browser;
 * only mount() touches the DOM.
 */

import { CONFIG } from './config.js';
import { writeFeatures, clearFeatures, featuresFrom } from './features.js';

/* The first statement in this module's body, and it has to stay that way.
 *
 * Each page's <head> starts a 3-second timer that reveals the page, for the one
 * case this file cannot handle itself: never loading at all. Once it has
 * loaded, that timer is wrong — left running it would reveal the page three
 * seconds in while the popup was still waiting for Google to answer. */
if (typeof window !== 'undefined' && window.__gateFailsafe) {
  clearTimeout(window.__gateFailsafe);
  window.__gateFailsafe = null;
}

export const SITE_KEY = 'bb.gate.v1';
export const ADMIN_KEY = 'bb.admin.v1';

const MAX_NAME = 60;
const DAY = 24 * 60 * 60 * 1000;
/** Used only if the server didn't say when a viewer sign-in ends. */
const VIEWER_FALLBACK = DAY;

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Strip "|", collapse internal whitespace, trim, cap the length. '' means
 * unusable. Deliberately the same rule as cleanName() in apps-script/Code.gs —
 * the server applies it too, because the endpoint is reachable without this
 * page, and the two must not disagree about what a name is.
 *
 * "|" is removed because it separates the fields inside a token payload. A name
 * containing one produces a token that verifies as malformed, so the sign-in
 * appears to succeed and then nothing works.
 */
export function cleanName(raw) {
  if (raw == null) return '';
  return String(raw).replace(/\|/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

/**
 * The gate is off until a script URL is configured, so an unconfigured or
 * half-configured site can never lock you out of your own pages.
 */
export function isEnabled(gateCfg) {
  return Boolean(gateCfg && typeof gateCfg.url === 'string' && gateCfg.url.trim() !== '');
}

/** localStorage throws in private mode and with site data blocked. */
function readKey(key) {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeKey(key, value) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Storage is unavailable, so this sign-in lasts until the tab closes.
    return false;
  }
}

function dropKey(key) {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    /* nothing to do */
  }
}

export const readSession = () => readKey(SITE_KEY);
export const writeSession = (session) => writeKey(SITE_KEY, session);
export const clearSession = () => dropKey(SITE_KEY);

export const readAdminSession = () => readKey(ADMIN_KEY);
export const writeAdminSession = (session) => writeKey(ADMIN_KEY, session);
export const clearAdminSession = () => dropKey(ADMIN_KEY);

/**
 * Store an admin session, stamped with the moment it stops counting.
 *
 * `until` exists so the inline script in each admin page's <head> can decide
 * whether to redirect without importing config — it runs before any module and
 * has no way to read `adminHours`. Writing the deadline once, here, keeps that
 * number in one place instead of duplicating it into three HTML files.
 */
export function saveAdminSession(name, token, gateCfg = CONFIG.gate) {
  const at = Date.now();
  return writeAdminSession({ name, token, at, until: at + adminMaxAge(gateCfg) });
}

/**
 * Is this browser holding a usable admin session?
 *
 * Fails closed. A missing, malformed, expired or pre-`until` session is not an
 * admin — the whole playbook-only view hangs off this answer, so "not sure"
 * has to mean no.
 */
export function hasAdminSession(now = Date.now()) {
  const session = readAdminSession();
  if (!session || typeof session.token !== 'string' || session.token === '') return false;
  if (typeof session.until !== 'number' || !isFinite(session.until)) return false;
  return session.until > now;
}

/**
 * Is this browser signed in with the view-only password?
 *
 * Only the team playbook is shown to a viewer, and nothing in it can be edited.
 * That is a courtesy of the page; the real limit is the 'viewer' token, which
 * the Apps Script accepts for reading plays and nothing else. A session from
 * before roles existed has no role and is treated as a coach, as it was.
 */
export function isViewer(gateCfg = CONFIG.gate, now = Date.now()) {
  if (!isEnabled(gateCfg)) return false;
  if (hasAdminSession(now)) return false;
  const session = readSession();
  return sessionValid(session, siteMaxAge(gateCfg), now) && session.role === 'viewer';
}

/**
 * Is a stored session still offerable?
 *
 * This only decides whether the browser bothers trying. The expiry that matters
 * is baked into the token's signature and enforced by the Apps Script, because
 * a browser can be told to lie about this one and that one it cannot.
 *
 * @param {{token?: string, at?: number}|null} session
 * @param {number} maxAgeMs
 * @param {number} [now]
 */
export function sessionValid(session, maxAgeMs, now = Date.now()) {
  if (!session || typeof session.token !== 'string' || session.token === '') return false;
  if (typeof session.at !== 'number' || !isFinite(session.at)) return false;
  if (session.at > now) return false;              // a clock moved backwards
  // A session that knows its own end (a viewer's, an admin's) stops there,
  // even inside the general limit.
  if (typeof session.until === 'number' && session.until <= now) return false;
  return now - session.at < maxAgeMs;
}

/**
 * The strongest token this browser holds: the admin's while that session lasts,
 * otherwise the site (or viewer) one. '' when signed out. The script works out
 * the role from the token itself, so sending the strongest one is always right.
 */
export function bestToken(gateCfg = CONFIG.gate) {
  const admin = readAdminSession();
  if (sessionValid(admin, adminMaxAge(gateCfg))) return admin.token;
  const site = readSession();
  return sessionValid(site, siteMaxAge(gateCfg)) ? site.token : '';
}

/** The admin token alone, or '' — for the actions only an admin may call. */
export function adminToken(now = Date.now()) {
  return hasAdminSession(now) ? readAdminSession().token : '';
}

export const siteMaxAge = (gateCfg) => (Number(gateCfg?.days) || 30) * DAY;
export const adminMaxAge = (gateCfg) => (Number(gateCfg?.adminHours) || 24) * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

/**
 * POST one action to the Apps Script.
 *
 * Two layers of "ok", and keeping them apart is the point of this function:
 *
 *   {ok: false, error}                  — could not reach or read the script
 *   {ok: true, data: {ok: false, ...}}  — the script answered, and said no
 *   {ok: true, data: {ok: true, ...}}   — the script answered yes
 *
 * A network failure must never be treated as a refusal (it would hide a broken
 * setup behind "wrong password"), and a refusal must never be treated as a
 * network failure (it would offer a Retry button that can only fail again).
 *
 * The body goes as text/plain on purpose: any other content type triggers a
 * CORS preflight, and Apps Script does not answer OPTIONS.
 */
export async function callScript(url, payload, { fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return { ok: false, data: null, error: 'No fetch available.' };
  }

  let res;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow',
    });
  } catch (err) {
    return { ok: false, data: null, error: String((err && err.message) || err) };
  }

  if (!res.ok) return { ok: false, data: null, error: `HTTP ${res.status}` };

  let text;
  try {
    text = await res.text();
  } catch (err) {
    return { ok: false, data: null, error: String((err && err.message) || err) };
  }

  try {
    return { ok: true, data: JSON.parse(text), error: null };
  } catch {
    // Usually a Google sign-in page: the deployment's access is not "Anyone".
    return {
      ok: false, data: null,
      error: 'The sign-in script did not return data. Check that the web app is deployed with "Who has access: Anyone".',
    };
  }
}

/** Where we are, for the log. Just the filename. */
export function pageName(pathname = globalThis.location?.pathname || '') {
  const last = String(pathname).split('/').pop() || 'index.html';
  return last === '' ? 'index.html' : last;
}

/** Self-reported, like the name — Apps Script cannot see request headers. */
function shortUa() {
  return String(globalThis.navigator?.userAgent || '').slice(0, 120);
}

/**
 * "10 minutes", "1 minute" or "45s". The script locks sign-in for ten minutes
 * after too many wrong passwords, so that is the fallback when it sends no
 * time.
 */
export function waitText(seconds) {
  const s = Number(seconds) > 0 ? Math.ceil(Number(seconds)) : 600;
  if (s < 60) return `${s}s`;
  const m = Math.ceil(s / 60);
  return `${m} minute${m === 1 ? '' : 's'}`;
}

/**
 * Turn a callScript result into the one sentence the popup should show.
 * Exported so the tests assert on the real strings people will read.
 */
export function messageFor(result) {
  if (!result.ok) return { kind: 'network', text: "Can't reach sign-in right now. Try again." };

  const data = result.data || {};
  if (data.ok) return { kind: 'ok', text: '' };

  switch (data.reason) {
    case 'slow':
      return {
        kind: 'slow',
        text: `Too many wrong passwords. Sign-in is paused — try again in ${waitText(data.retryAfter)}.`,
      };
    case 'name':
      return { kind: 'name', text: 'Please enter your name.' };
    case 'not_on_roster':
      return {
        kind: 'name',
        text: "That name isn't on the team list. Use your full name as your coach entered it.",
      };
    case 'password':
      return { kind: 'password', text: "That password isn't right." };
    default:
      return { kind: 'error', text: 'Sign-in is not set up correctly. Check the script deployment.' };
  }
}

/* ------------------------------------------------------------------ */
/* Sign-in calls                                                       */
/* ------------------------------------------------------------------ */

export async function signIn(name, password, opts = {}) {
  const gate = CONFIG.gate || {};
  return callScript(gate.url, {
    action: 'signin',
    name: cleanName(name),
    password,
    page: pageName(),
    ua: shortUa(),
  }, opts);
}

export async function adminSignIn(name, password, opts = {}) {
  const gate = CONFIG.gate || {};
  return callScript(gate.url, {
    action: 'admin',
    name: cleanName(name),
    password,
    page: pageName(),
    ua: shortUa(),
  }, opts);
}

/* ------------------------------------------------------------------ */
/* Is the stored session still good?                                   */
/* ------------------------------------------------------------------ */

/**
 * What to do with a stored session after asking the script about it.
 *
 *   'keep'       — still good, or the script couldn't be asked
 *   'signout'    — the token was revoked or has expired at the script's end
 *   'drop-admin' — still a coach, but the admin part no longer works
 *
 * A network failure, or a script deployed before the check existed, is 'keep':
 * a flaky connection must never throw a coach out mid-practice.
 */
export function sessionVerdict(result) {
  const data = result && result.ok ? result.data : null;
  if (!data || data.ok !== true) return 'keep';
  if (data.valid === false) return 'signout';
  if (data.adminValid === false) return 'drop-admin';
  return 'keep';
}

/**
 * Ask the script whether this browser's tokens still work. Run in the
 * background on every page so the page is not held up waiting for Google.
 *
 * This is what makes the admin's "Sign everyone out" reach browsers: the next
 * page anyone opens sends them back to the sign-in popup.
 */
export async function verifyStoredSession(gate = CONFIG.gate, opts = {}) {
  const session = readSession();
  if (!session?.token) return 'keep';

  const payload = { action: 'check', token: session.token };
  const admin = readAdminSession();
  if (hasAdminSession() && admin?.token) payload.adminToken = admin.token;

  const result = await callScript(gate.url, payload, opts);
  const verdict = sessionVerdict(result);

  if (verdict === 'signout') {
    clearSession();
    clearAdminSession();
    clearFeatures();
    globalThis.location?.reload();
  } else if (verdict === 'drop-admin') {
    clearAdminSession();
    clearFeatures();   // the next check fills in what a coach has
    globalThis.location?.reload();
  } else {
    // A release stage may have moved since the last page. Only re-render when
    // the list actually changed, so an ordinary page load does nothing extra.
    const features = featuresFrom(result);
    if (features && writeFeatures(features)) announceFeatures();
  }
  return verdict;
}

/**
 * Tell the page the feature list changed, so it can add (or drop) what the
 * script now allows without a reload. Pages that care listen for bb:features.
 */
function announceFeatures() {
  if (typeof document === 'undefined') return;
  renderNav();
  document.dispatchEvent(new CustomEvent('bb:features'));
}

/* ------------------------------------------------------------------ */
/* The overlay                                                         */
/* ------------------------------------------------------------------ */

const el = (tag, opts = {}, ...children) => {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text != null) node.textContent = opts.text;
  for (const [k, v] of Object.entries(opts.attrs || {})) if (v != null) node.setAttribute(k, v);
  for (const child of children) if (child) node.append(child);
  return node;
};

function reveal() {
  document.documentElement.classList.remove('gated');
}

/**
 * Tell the page a site session now exists.
 *
 * Fired for a restored session as well as a fresh sign-in, so a listener has
 * one hook rather than two cases. Anything that needs the signed-in name — the
 * admin prompt prefills it — must wait for this rather than read storage at
 * load, because at load the sign-in has usually not happened yet.
 */
function announce(name) {
  document.dispatchEvent(new CustomEvent('bb:signedin', { detail: { name } }));
}

/** "Casey Jones · Sign out" alongside the nav. */
/**
 * Add the admin-only links to the nav.
 *
 * The static markup carries Playbook and nothing else, so for anyone without an
 * admin session these elements are never created. That is the requirement: not
 * hidden, not disabled, not present. `view-source` on a coach's browser shows a
 * playbook site, because that is all there is.
 */
function renderNav() {
  const nav = document.querySelector('.site-header .site-nav');
  // With sign-in switched off there is no admin to distinguish from anyone
  // else, so the site is whole again and every link belongs.
  if (!nav || !(isEnabled(CONFIG.gate) ? hasAdminSession() : true)) return;

  const here = (globalThis.location?.pathname || '').split('/').pop() || 'index.html';
  const links = [
    ['index.html', 'Home'],
    ['stats.html', 'Stats'],
    ['admin.html', 'Admin'],
  ];

  // Prepending walks backwards, so the leading links are reversed first to
  // land as Home, Stats, Playbook — reading order, not insertion order.
  const lead = links.filter(([href]) => href !== 'admin.html').reverse();
  for (const [href, label] of [...lead, ...links.filter(([h]) => h === 'admin.html')]) {
    // Safe to run again when the feature list changes: a link is built once.
    if (nav.querySelector(`a[href="${href}"]`)) continue;
    const a = el('a', { text: label, attrs: { href } });
    if (href === here) a.setAttribute('aria-current', 'page');
    if (href === 'admin.html') nav.append(a);
    else nav.insertBefore(a, nav.firstChild);
  }

  // The brand goes to the dashboard for an admin and stays on the playbook for
  // everyone else, so it never bounces through a redirect.
  const brand = document.querySelector('.site-header .brand');
  if (brand) brand.setAttribute('href', 'index.html');

  // The footer link is created the same way, for the same reason.
  const footer = document.querySelector('.site-footer .wrap');
  if (footer && !footer.querySelector('a[href="admin.html"]')) {
    footer.append(el('a', { text: 'Admin', attrs: { href: 'admin.html' } }));
  }
}

function renderSignedIn(name) {
  const nav = document.querySelector('.site-header .site-nav');
  if (!nav || document.getElementById('gate-who')) return;

  const who = el('span', { class: 'gate-who', attrs: { id: 'gate-who' } });
  who.append(el('span', { class: 'gate-name', text: name }));

  const out = el('button', { class: 'linkish', text: 'Sign out', attrs: { type: 'button' } });
  out.addEventListener('click', () => {
    clearSession();
    clearAdminSession();
    clearFeatures();
    globalThis.location.reload();
  });

  who.append(document.createTextNode(' · '));
  who.append(out);
  nav.after(who);
}

function buildOverlay(gate, onDone) {
  const card = el('div', { class: 'gate-card' });
  card.append(el('h1', { text: gate.title || 'Sign in' }));

  const form = el('form', { class: 'gate-form' });

  const nameField = el('div', { class: 'field' });
  nameField.append(el('label', { text: 'Your name', attrs: { for: 'gate-name' } }));
  const nameInput = el('input', {
    attrs: {
      type: 'text', id: 'gate-name', name: 'name', autocomplete: 'name',
      maxlength: String(MAX_NAME), required: 'required',
    },
  });
  nameField.append(nameInput);

  const pwField = el('div', { class: 'field' });
  pwField.append(el('label', { text: 'Password', attrs: { for: 'gate-pw' } }));
  const pwInput = el('input', {
    attrs: {
      type: 'password', id: 'gate-pw', name: 'password',
      autocomplete: 'current-password', required: 'required',
    },
  });
  pwField.append(pwInput);

  const submit = el('button', { class: 'btn btn-primary', text: 'Sign in', attrs: { type: 'submit' } });
  const error = el('p', { class: 'gate-error', attrs: { role: 'alert', hidden: 'hidden' } });

  const retry = el('button', { class: 'btn', text: 'Retry', attrs: { type: 'button', hidden: 'hidden' } });
  retry.addEventListener('click', () => form.requestSubmit());

  form.append(nameField, pwField, el('div', { class: 'gate-actions' }, submit, retry), error);
  card.append(form);
  card.append(el('p', { class: 'small muted', text: 'Your name is recorded when you sign in.' }));

  const overlay = el('div', { class: 'gate', attrs: { id: 'gate', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Sign in' } }, card);

  const show = (text) => {
    error.textContent = text;
    error.hidden = text === '';
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = cleanName(nameInput.value);
    if (name === '') {
      show('Please enter your name.');
      nameInput.focus();
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Signing in…';
    retry.hidden = true;
    show('');

    const result = await signIn(name, pwInput.value);
    const message = messageFor(result);

    submit.disabled = false;
    submit.textContent = 'Sign in';

    if (message.kind === 'ok') {
      const signedInAs = result.data.name || name;
      const at = Date.now();
      const viewer = result.data.role === 'viewer';
      writeSession({
        name: signedInAs,
        token: result.data.token,
        role: viewer ? 'viewer' : 'site',
        at,
        // A viewer sign-in lasts a day, not the team's 30 days. The server's
        // own expiry is used when it sends one, so the two never disagree.
        ...(viewer ? { until: Number(result.data.expiresAt) || at + VIEWER_FALLBACK } : {}),
      });

      // The admin password at the front door signs you straight in as admin.
      // Stats, the dashboard tiles and Publish all read bb.admin.v1, so they
      // unlock on the next render with nothing else to do.
      if (result.data.adminToken) {
        saveAdminSession(signedInAs, result.data.adminToken);
      }
      // Which staged features this login may see. A script from before
      // features existed sends none, and none is what the page then shows.
      writeFeatures(Array.isArray(result.data.features) ? result.data.features : []);
      overlay.remove();
      reveal();
      renderSignedIn(signedInAs);
      renderNav();
      announce(signedInAs);
      if (onDone) onDone();
      return;
    }

    // A network failure offers Retry and keeps the page hidden. A blip is not
    // a way in.
    retry.hidden = message.kind !== 'network';
    show(message.text);
    // A name problem sends you back to the name, password kept; anything else
    // clears the password for another go.
    if (message.kind === 'name') {
      nameInput.focus();
      nameInput.select();
    } else if (message.kind !== 'network') {
      pwInput.value = '';
      pwInput.focus();
    }
  });

  return { overlay, nameInput };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export function mount() {
  const gate = CONFIG.gate || {};

  // Leave a marker saying whether sign-in is switched on at all.
  //
  // The inline redirect in each admin page's <head> runs before any module and
  // cannot read config, so without this it would bounce stats.html even on a
  // site with no sign-in configured. It is only a hint for the earliest
  // possible redirect: every page re-checks properly in its own module, so
  // editing this marker by hand gains nothing.
  try {
    globalThis.localStorage?.setItem('bb.gate.on', isEnabled(gate) ? '1' : '0');
  } catch {
    /* blocked storage — the module checks still run */
  }

  if (!isEnabled(gate)) {
    // With sign-in switched off there is no admin to distinguish, so the whole
    // site is visible exactly as it was before any of this existed.
    reveal();
    renderNav();
    announce('');
    return;
  }

  const session = readSession();
  if (sessionValid(session, siteMaxAge(gate))) {
    reveal();
    renderSignedIn(session.name);
    renderNav();
    announce(session.name);
    verifyStoredSession(gate);
    return;
  }

  clearSession();
  clearFeatures();
  const { overlay, nameInput } = buildOverlay(gate);
  document.body.append(overlay);
  nameInput.focus();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
}
