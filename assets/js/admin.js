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

/** Free-text filter across every column a person might search by. */
export function filterRows(rows, query) {
  const q = String(query || '').trim().toLowerCase();
  if (q === '') return rows || [];
  return (rows || []).filter((row) =>
    [row.name, row.page, row.at, row.result].some((v) => String(v || '').toLowerCase().includes(q)));
}

/* ------------------------------------------------------------------ */
/* The log                                                             */
/* ------------------------------------------------------------------ */

export function renderSignIns(host, rows) {
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
    el('h2', { text: 'Every sign-in' }),
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
      const tr = el('tr', { class: isFailure(row) ? 'flagged-row' : '' });
      tr.append(el('td', { text: cleanName(row.name) || '(no name)' }));
      tr.append(el('td', { text: row.at || '—' }));
      tr.append(el('td', { text: row.page || '—' }));
      tr.append(el('td', { text: isFailure(row) ? 'Failed attempt' : 'Signed in' }));
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

  renderSignIns(host, result.data.signIns || []);
}
