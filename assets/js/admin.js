/**
 * Admin sign-in and the sign-in log.
 *
 * Two things live here because two pages need them: this page, and (from the
 * next commit) the stats page, which is admin-only. Building the prompt twice
 * would mean two places to get the "name AND password" rule wrong.
 *
 * Nothing on this page is cached. The admin password is never stored anywhere,
 * and neither are the returned rows — they are other people's names, and a
 * shared laptop should not keep them after you close the tab.
 */

import { CONFIG } from './config.js';
import {
  adminSignIn, cleanName, readSession, readAdminSession, writeAdminSession,
  clearAdminSession, messageFor, isEnabled,
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
/* The prompt                                                          */
/* ------------------------------------------------------------------ */

/**
 * Render an admin password prompt into `host`, calling `onSuccess(data)` with
 * the script's reply once it is accepted.
 *
 * The name is prefilled from the site session, so in practice you type only the
 * password — but it is still sent and still checked, because the script refuses
 * the admin password under any other name.
 */
export function mountAdminPrompt(host, onSuccess, opts = {}) {
  host.replaceChildren();

  const gate = CONFIG.gate || {};
  if (!isEnabled(gate)) {
    host.append(el('div', { class: 'card' },
      el('h2', { text: 'Sign-in is not set up' }),
      el('p', { class: 'small muted', text: 'Add your Apps Script web app URL to gate.url in assets/js/config.js. See the README.' })));
    return;
  }

  const card = el('div', { class: 'card gate-card-inline' });
  card.append(el('h2', { text: opts.title || 'Admin password' }));
  if (opts.note) card.append(el('p', { class: 'small muted', text: opts.note }));

  const form = el('form', { class: 'gate-form' });

  const nameField = el('div', { class: 'field' });
  nameField.append(el('label', { text: 'Your name', attrs: { for: 'admin-name' } }));
  const nameInput = el('input', {
    attrs: { type: 'text', id: 'admin-name', autocomplete: 'name', maxlength: '60' },
  });
  nameInput.value = readSession()?.name || '';
  nameField.append(nameInput);

  const pwField = el('div', { class: 'field' });
  pwField.append(el('label', { text: 'Admin password', attrs: { for: 'admin-pw' } }));
  const pwInput = el('input', {
    attrs: { type: 'password', id: 'admin-pw', autocomplete: 'current-password' },
  });
  pwField.append(pwInput);

  const submit = el('button', { class: 'btn btn-primary', text: 'Unlock', attrs: { type: 'submit' } });
  const retry = el('button', { class: 'btn', text: 'Retry', attrs: { type: 'button', hidden: 'hidden' } });
  retry.addEventListener('click', () => form.requestSubmit());

  const error = el('p', { class: 'gate-error', attrs: { role: 'alert', hidden: 'hidden' } });

  form.append(nameField, pwField, el('div', { class: 'gate-actions' }, submit, retry), error);
  card.append(form);
  host.append(card);

  const show = (text) => {
    error.textContent = text;
    error.hidden = text === '';
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    submit.textContent = 'Checking…';
    retry.hidden = true;
    show('');

    const result = await adminSignIn(nameInput.value, pwInput.value);
    const message = messageFor(result);

    submit.disabled = false;
    submit.textContent = 'Unlock';

    if (message.kind === 'ok') {
      writeAdminSession({
        name: result.data.name || cleanName(nameInput.value),
        token: result.data.token,
        at: Date.now(),
      });
      onSuccess(result.data);
      return;
    }

    retry.hidden = message.kind !== 'network';
    // A wrong name and a wrong password come back identically from the script,
    // so there is nothing more specific to say here, and saying more would
    // undo that on the client.
    show(message.kind === 'password' ? "That name and password don't match." : message.text);
    if (message.kind !== 'network') {
      pwInput.value = '';
      pwInput.focus();
    }
  });

  setTimeout(() => (nameInput.value ? pwInput : nameInput).focus(), 0);
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
 * Wire up whichever of the two states applies. Re-prompts when the stored admin
 * session has aged out — the script would refuse the token anyway, so asking is
 * better than showing an error.
 */
export function mountAdminPage(host) {
  // Always ask, even with a valid admin session in storage. The sign-in rows
  // are deliberately never cached, so there is nothing to show without a fresh
  // call, and that call needs the password.
  mountAdminPrompt(host, (data) => renderSignIns(host, data.signIns || []), {
    title: 'Admin password',
    note: 'The admin password only works with the admin name.',
  });
}
