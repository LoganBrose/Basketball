/**
 * The sign-in log.
 *
 * Reached only with an admin session, and it never asks for one — a prompt here
 * would tell a coach that an admin page exists. Anyone without the session is
 * sent to the playbook before this module runs.
 *
 * Nothing is cached. The rows are other people's names, and a shared laptop
 * should not keep them after the tab closes.
 */

import { CONFIG } from './config.js';
import {
  callScript, cleanName, readAdminSession, clearAdminSession, hasAdminSession,
  writeSession, saveAdminSession, pageName,
} from './gate.js';

const el = (tag, opts = {}, ...children) => {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text != null) node.textContent = opts.text;
  for (const [k, v] of Object.entries(opts.attrs || {})) if (v != null) node.setAttribute(k, v);
  for (const child of children) if (child) node.append(child);
  return node;
};

/* ------------------------------------------------------------------ */
/* Pure: summarising the log                                           */
/* ------------------------------------------------------------------ */

/** A row is a failed attempt when the script marked it one. */
export const isFailure = (row) => String(row?.result || '').startsWith('failed');

/** The admin pressing "Sign everyone out" is logged, but it is not a sign-in. */
export const isSignOutAll = (row) => row?.result === 'signout-all';

/** Sign-in was locked after too many wrong passwords. Logged once per lock. */
export const isLockout = (row) => row?.result === 'lockout';

/**
 * One line per person: how many times they signed in, and when they were last
 * seen. Failed attempts are counted separately rather than folded in, so a
 * name with ten failures and no successes is visible as exactly that.
 *
 * Rows arrive newest first, which is the order the counts assume.
 */
export function peopleFrom(rows) {
  const byName = new Map();

  for (const row of rows || []) {
    if (isSignOutAll(row) || isLockout(row)) continue;
    const name = cleanName(row.name) || '(no name)';
    if (!byName.has(name)) {
      byName.set(name, { name, signIns: 0, failures: 0, lastSeen: row.at });
    }
    const person = byName.get(name);
    if (isFailure(row)) person.failures++;
    else person.signIns++;
  }

  return [...byName.values()].sort((a, b) => b.signIns - a.signIns || a.name.localeCompare(b.name));
}

/** What the Result column says for one row. */
export function resultLabel(row) {
  if (isFailure(row)) return 'Failed attempt';
  if (isSignOutAll(row)) return 'Signed everyone out';
  if (isLockout(row)) return 'Sign-in locked for 10 minutes (too many wrong passwords)';
  if (row?.result === 'admin') return 'Signed in (admin)';
  if (row?.result === 'viewer') return 'Signed in (view only)';
  return 'Signed in';
}

/** Free-text filter across every column a person might search by. */
export function filterRows(rows, query) {
  const q = String(query || '').trim().toLowerCase();
  if (q === '') return rows || [];
  return (rows || []).filter((row) =>
    [row.name, row.page, row.at, row.result].some((v) => String(v || '').toLowerCase().includes(q)));
}

/** What a "Signed in now" entry's access column says. */
export function roleLabel(role) {
  if (role === 'admin') return 'Admin';
  if (role === 'viewer') return 'View only';
  return 'Coach';
}

/** A millisecond timestamp from the script, in the viewer's own time zone. */
export function fmtWhen(ms) {
  const d = new Date(Number(ms));
  if (!isFinite(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/* ------------------------------------------------------------------ */
/* Sign everyone out                                                   */
/* ------------------------------------------------------------------ */

/**
 * Revoke every sign-in, then keep this browser signed in with the fresh tokens
 * the script hands back to the admin who asked.
 *
 * @returns {Promise<string>} '' on success, otherwise a sentence to show.
 */
export async function signOutEveryone({ fetchImpl } = {}) {
  const session = readAdminSession();
  if (!session?.token) return 'Your admin session has expired.';

  const result = await callScript(CONFIG.gate.url, {
    action: 'signOutAll',
    token: session.token,
    page: pageName(),
    ua: String(globalThis.navigator?.userAgent || '').slice(0, 120),
  }, { fetchImpl });

  if (!result.ok) return "Couldn't reach the sign-in script. Nobody was signed out.";
  const data = result.data || {};
  if (data.reason === 'unknown_action') {
    return 'The sign-in script needs updating first: paste the new Code.gs and deploy a new version.';
  }
  if (data.reason === 'auth') return 'Your admin session has expired. Sign in again.';
  if (!data.ok || !data.token || !data.adminToken) return "Couldn't sign everyone out.";

  const name = data.name || session.name;
  writeSession({ name, token: data.token, role: 'site', at: Date.now() });
  saveAdminSession(name, data.adminToken);
  return '';
}

function renderActive(host, active) {
  const card = el('details', { class: 'card collapsible', attrs: { open: 'open' } });
  card.append(el('summary', { class: 'pb-side-head' },
    el('h2', { text: 'Signed in now' }),
    el('span', { class: 'pill', text: String(active.length) })));

  card.append(el('p', {
    class: 'small muted',
    text: 'Everyone whose sign-in is still valid. Pressing Sign out on a device only forgets it '
      + 'on that device, so a person stays listed here until their sign-in expires or you sign everyone out.',
  }));

  if (active.length) {
    const table = el('table');
    const head = el('tr');
    for (const h of ['Name', 'Access', 'Signed in', 'Valid until', 'Devices']) head.append(el('th', { text: h }));
    table.append(el('thead', {}, head));
    const body = el('tbody');
    for (const p of active) {
      const tr = el('tr');
      tr.append(el('td', { text: cleanName(p.name) || '(no name)' }));
      tr.append(el('td', { text: roleLabel(p.role) }));
      tr.append(el('td', { text: fmtWhen(p.since) }));
      tr.append(el('td', { text: fmtWhen(p.until) }));
      tr.append(el('td', { text: String(p.sessions || 1) }));
      body.append(tr);
    }
    table.append(body);
    card.append(table);
  } else {
    card.append(el('p', { class: 'small muted', text: 'Nobody is signed in.' }));
  }

  const note = el('p', { class: 'small', attrs: { role: 'status' } });
  const btn = el('button', { class: 'btn danger', text: 'Sign everyone out', attrs: { type: 'button' } });
  btn.addEventListener('click', async () => {
    const ok = globalThis.confirm(
      'Sign everyone out?\n\nEvery coach, viewer and other admin session ends now, on every device. '
      + 'Each of them will need the password again. You stay signed in.');
    if (!ok) return;

    btn.disabled = true;
    btn.textContent = 'Signing everyone out…';
    const message = await signOutEveryone();
    if (message === '') {
      globalThis.location.reload();
      return;
    }
    btn.disabled = false;
    btn.textContent = 'Sign everyone out';
    note.className = 'small missing';
    note.textContent = message;
  });

  card.append(el('div', { class: 'admin-actions' }, btn), note);
  host.append(card);
}

/* ------------------------------------------------------------------ */
/* The log                                                             */
/* ------------------------------------------------------------------ */

export function renderSignIns(host, rows, active, days = 30) {
  host.replaceChildren();

  const signedIn = readAdminSession();
  const head = el('div', { class: 'admin-head' });
  head.append(el('p', { class: 'small muted', text: `Signed in as ${signedIn?.name || 'admin'}.` }));

  const out = el('button', { class: 'btn', text: 'Sign out of admin', attrs: { type: 'button' } });
  out.addEventListener('click', () => {
    clearAdminSession();
    globalThis.location.reload();
  });
  head.append(out);
  host.append(head);

  // An older script deployment doesn't send the list; say nothing rather than
  // claim nobody is signed in.
  if (Array.isArray(active)) renderActive(host, active);

  if (!rows || rows.length === 0) {
    host.append(el('p', { class: 'card small muted', text: 'Nobody has signed in yet.' }));
    return;
  }

  /* People ------------------------------------------------------- */
  const people = peopleFrom(rows);
  const peopleCard = el('details', { class: 'card collapsible', attrs: { open: 'open' } });
  peopleCard.append(el('summary', { class: 'pb-side-head' },
    el('h2', { text: 'People' }),
    el('span', { class: 'pill', text: String(people.length) })));

  const pTable = el('table');
  const pHead = el('tr');
  for (const h of ['Name', 'Sign-ins', 'Failed', 'Last seen']) pHead.append(el('th', { text: h }));
  pTable.append(el('thead', {}, pHead));

  const pBody = el('tbody');
  for (const person of people) {
    const tr = el('tr');
    tr.append(el('td', { text: person.name }));
    tr.append(el('td', { text: String(person.signIns) }));
    tr.append(el('td', { class: person.failures ? 'flagged' : '', text: person.failures ? String(person.failures) : '—' }));
    tr.append(el('td', { text: person.lastSeen || '—' }));
    pBody.append(tr);
  }
  pTable.append(pBody);
  peopleCard.append(pTable);
  host.append(peopleCard);

  /* Every sign-in ------------------------------------------------ */
  const logCard = el('details', { class: 'card collapsible', attrs: { open: 'open' } });
  logCard.append(el('summary', { class: 'pb-side-head' },
    el('h2', { text: `Every sign-in, last ${days} day${days === 1 ? '' : 's'}` }),
    el('span', { class: 'pill', text: String(rows.length) })));

  const search = el('input', { attrs: { type: 'search', id: 'admin-search', placeholder: 'Name, page, date…' } });
  const searchField = el('div', { class: 'field' },
    el('label', { text: 'Search', attrs: { for: 'admin-search' } }), search);
  logCard.append(searchField);

  const table = el('table');
  const thead = el('tr');
  for (const h of ['Name', 'Date/time', 'Page', 'Result']) thead.append(el('th', { text: h }));
  table.append(el('thead', {}, thead));

  const tbody = el('tbody');
  table.append(tbody);
  logCard.append(table);

  const count = el('p', { class: 'small muted' });
  logCard.append(count);
  host.append(logCard);

  const draw = () => {
    const shown = filterRows(rows, search.value);
    tbody.replaceChildren();
    for (const row of shown) {
      const tr = el('tr', { class: isFailure(row) || isLockout(row) ? 'flagged-row' : '' });
      tr.append(el('td', { text: cleanName(row.name) || '(no name)' }));
      tr.append(el('td', { text: row.at || '—' }));
      tr.append(el('td', { text: row.page || '—' }));
      tr.append(el('td', { text: resultLabel(row) }));
      tbody.append(tr);
    }
    count.textContent = shown.length === rows.length
      ? `${rows.length} sign-in${rows.length === 1 ? '' : 's'}.`
      : `${shown.length} of ${rows.length} shown.`;
  };

  search.addEventListener('input', draw);
  draw();
}

/* ------------------------------------------------------------------ */
/* Page entry                                                          */
/* ------------------------------------------------------------------ */

/**
 * Show the log, or leave.
 *
 * There is no password prompt here. Asking would tell a coach that an admin
 * page exists and that a second password opens it — which is the one thing this
 * page must not reveal. The sign-in popup is the only way in, and the token it
 * produced is what fetches the list.
 */
export async function mountAdminPage(host) {
  if (!hasAdminSession()) {
    globalThis.location.replace('playbook.html');
    return;
  }

  host.replaceChildren();
  host.append(el('p', { class: 'small muted', text: 'Loading…' }));

  const session = readAdminSession();
  const result = await callScript(CONFIG.gate.url, { action: 'signIns', token: session.token });

  // An expired token mid-session lands here rather than at the head redirect.
  if (result.ok && result.data?.reason === 'auth') {
    clearAdminSession();
    globalThis.location.replace('playbook.html');
    return;
  }

  if (!result.ok || !result.data?.ok) {
    host.replaceChildren();
    host.append(el('p', { class: 'card small missing', text: "Couldn't load the sign-in log. Try again." }));
    return;
  }

  const days = Number(result.data.days) > 0 ? Number(result.data.days) : 30;
  const lede = globalThis.document?.getElementById('signin-days');
  if (lede) lede.textContent = `${days} day${days === 1 ? '' : 's'}`;
  renderSignIns(host, result.data.signIns || [], result.data.active, days);
}
