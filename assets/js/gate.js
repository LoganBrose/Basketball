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

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Trim, collapse internal whitespace, cap the length. '' means unusable.
 * Deliberately the same rule as cleanName() in apps-script/Code.gs — the server
 * applies it too, because the endpoint is reachable without this page.
 */
export function cleanName(raw) {
  if (raw == null) return '';
  return String(raw).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
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
  return now - session.at < maxAgeMs;
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
        text: `Too many failed attempts. Try again in ${Number(data.retryAfter) || 30}s.`,
      };
    case 'name':
      return { kind: 'name', text: 'Please enter your name.' };
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
function renderSignedIn(name) {
  const nav = document.querySelector('.site-header .site-nav');
  if (!nav || document.getElementById('gate-who')) return;

  const who = el('span', { class: 'gate-who', attrs: { id: 'gate-who' } });
  who.append(el('span', { class: 'gate-name', text: name }));

  const out = el('button', { class: 'linkish', text: 'Sign out', attrs: { type: 'button' } });
  out.addEventListener('click', () => {
    clearSession();
    clearAdminSession();
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
      writeSession({ name: result.data.name || name, token: result.data.token, at: Date.now() });
      const signedInAs = result.data.name || name;
      overlay.remove();
      reveal();
      renderSignedIn(signedInAs);
      announce(signedInAs);
      if (onDone) onDone();
      return;
    }

    // A network failure offers Retry and keeps the page hidden. A blip is not
    // a way in.
    retry.hidden = message.kind !== 'network';
    show(message.text);
    if (message.kind !== 'network') {
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

  if (!isEnabled(gate)) {
    reveal();
    announce('');
    return;
  }

  const session = readSession();
  if (sessionValid(session, siteMaxAge(gate))) {
    reveal();
    renderSignedIn(session.name);
    announce(session.name);
    return;
  }

  clearSession();
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
