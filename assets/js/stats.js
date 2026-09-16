/**
 * Stats tracker UI.
 *
 * Sheet-derived text is always written with textContent, never innerHTML: the
 * sheet is editable by anyone you've shared it with and this page is public, so
 * a player name is untrusted input as far as the DOM is concerned.
 */

import { CONFIG } from './config.js';
import { loadAll, sheetProblems, forgetSensitiveCache } from './data.js';
import {
  isEnabled, readSession, readAdminSession, clearAdminSession, sessionValid,
  siteMaxAge, adminMaxAge,
} from './gate.js';
import { mountAdminPrompt } from './admin.js';
import {
  gamesForPlayers, summaryFor, selectedPoints, displayName,
  STAT_FIELDS, STAT_LABELS,
} from './model.js';

const $ = (s) => document.querySelector(s);

const state = {
  data: null,
  selected: [],      // player IDs
  mode: 'all',       // 'all' | 'any'
  ha: '',
  expanded: new Set(),
};

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const fmtInt = (n) => (n == null ? '—' : String(n));
const fmtAvg = (n) => (n == null ? '—' : n.toFixed(1));
const fmtPct = (p) => (p == null ? '—' : (p * 100).toFixed(1) + '%');
const fmtDate = (d) => (d ? `${d.month}/${d.day}` : '—');

function el(tag, opts = {}, ...children) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text != null) node.textContent = opts.text;
  for (const [k, v] of Object.entries(opts.attrs || {})) {
    if (v != null) node.setAttribute(k, v);
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

const nameOf = (player) => displayName(player, CONFIG.nameDisplay);

/* ------------------------------------------------------------------ */
/* URL state                                                           */
/* ------------------------------------------------------------------ */

function readUrl() {
  const q = new URLSearchParams(location.search);
  const players = q.get('players');
  state.selected = players ? players.split(',').map((s) => s.trim()).filter(Boolean) : [];
  state.mode = q.get('mode') === 'any' ? 'any' : 'all';
  state.ha = q.get('ha') || '';
}

function writeUrl() {
  const q = new URLSearchParams();
  if (state.selected.length) q.set('players', state.selected.join(','));
  if (state.mode !== 'all') q.set('mode', state.mode);
  if (state.ha) q.set('ha', state.ha);
  // Commas are legal in a query value; leaving them encoded as %2C makes a
  // shared link needlessly ugly.
  const qs = q.toString().replace(/%2C/g, ',');
  history.replaceState(null, '', qs ? `${location.pathname}?${qs}` : location.pathname);
}

/* ------------------------------------------------------------------ */
/* Filtering                                                           */
/* ------------------------------------------------------------------ */

/** Games after the home/away filter and the Any/All player rule. */
function visibleGames() {
  let games = state.data.summaries;
  if (state.ha) games = games.filter((s) => s.homeAway === state.ha);
  return gamesForPlayers(games, state.selected, state.mode);
}

/* ------------------------------------------------------------------ */
/* Player chips                                                        */
/* ------------------------------------------------------------------ */

function renderChips() {
  const wrap = $('#player-chips');
  wrap.replaceChildren();

  if (state.data.players.length === 0) {
    wrap.append(el('p', { class: 'small muted', text: 'No players loaded — check the Connection panel.' }));
    return;
  }

  for (const player of state.data.players) {
    const on = state.selected.includes(player.playerId);
    const chip = el('button', {
      class: 'chip-toggle' + (on ? ' on' : ''),
      attrs: { type: 'button', 'aria-pressed': String(on) },
    });
    if (player.jersey && CONFIG.nameDisplay === 'full') {
      chip.append(el('span', { class: 'chip-num', text: player.jersey }));
    }
    chip.append(el('span', { text: nameOf(player) }));

    chip.addEventListener('click', () => {
      state.selected = on
        ? state.selected.filter((id) => id !== player.playerId)
        : [...state.selected, player.playerId];
      writeUrl();
      render();
    });
    wrap.append(chip);
  }
}

function renderFilterHint() {
  const n = state.selected.length;
  const hint = $('#filter-hint');
  if (n === 0) {
    hint.textContent = 'No players selected — showing the whole team.';
    return;
  }
  hint.textContent = state.mode === 'all'
    ? `Showing games where all ${n} selected player${n === 1 ? '' : 's'} played.`
    : `Showing games where any of the ${n} selected players played.`;
}

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

function renderSummary(games) {
  const card = $('#summary-card');
  card.replaceChildren();

  const summary = summaryFor(games, state.selected);
  const filtered = state.selected.length > 0;

  const head = el('div', { class: 'player-head' });
  head.append(el('h2', { text: filtered ? 'Combined stats for selected players' : 'Team stats' }));

  const names = state.selected
    .map((id) => nameOf(state.data.players.find((p) => p.playerId === id)))
    .join(', ');
  if (filtered) head.append(el('span', { class: 'meta', text: names }));
  if (state.ha) head.append(el('span', { class: 'meta', text: state.ha.toLowerCase() + ' games' }));
  card.append(head);

  if (filtered) {
    // Box scores don't record who shared the floor, so this is a sum of
    // individual lines — not a lineup rating. Say so rather than let it be read
    // as plus/minus.
    card.append(el('p', {
      class: 'small muted',
      text: 'Their individual lines added together across these games. Box scores don’t record who was on the floor at the same time, so this isn’t a lineup rating.',
    }));
  }

  if (summary.gp === 0) {
    card.append(el('div', { class: 'empty', text: 'No games match this selection.' }));
    return;
  }

  const lead = el('div', { class: 'statgrid' });
  lead.append(statTile('Games', String(summary.gp), summary.games > summary.gp
    ? `${summary.games - summary.gp} with no minutes` : null, true));
  lead.append(statTile('PTS', String(summary.totals.points), fmtAvg(summary.averages.points) + ' per game', true));
  lead.append(statTile('REB', String(summary.totals.rebounds), fmtAvg(summary.averages.rebounds) + ' per game', true));
  lead.append(statTile('AST', String(summary.totals.assists), fmtAvg(summary.averages.assists) + ' per game', true));
  lead.append(statTile('FG%', fmtPct(summary.fgPct), `${summary.totals.fgm}/${summary.totals.fga}`));
  lead.append(statTile('3PT%', fmtPct(summary.tpPct), `${summary.totals.tpm}/${summary.totals.tpa}`));
  lead.append(statTile('FT%', fmtPct(summary.ftPct), `${summary.totals.ftm}/${summary.totals.fta}`));
  card.append(lead);

  card.append(el('div', { class: 'section-label', text: 'Totals · per game' }));
  const grid = el('div', { class: 'statgrid' });
  for (const f of STAT_FIELDS) {
    grid.append(statTile(STAT_LABELS[f], String(summary.totals[f]), fmtAvg(summary.averages[f]) + ' pg'));
  }
  card.append(grid);
}

function statTile(key, value, sub, lead = false) {
  const tile = el('div', { class: lead ? 'stat lead' : 'stat' });
  tile.append(el('div', { class: 'k', text: key }));
  tile.append(el('div', { class: 'v', text: value }));
  if (sub) tile.append(el('div', { class: 'sub', text: sub }));
  return tile;
}

/* ------------------------------------------------------------------ */
/* Game list                                                           */
/* ------------------------------------------------------------------ */

function renderGames(games) {
  const list = $('#game-list');
  list.replaceChildren();

  if (games.length === 0) {
    list.append(el('div', { class: 'card' }, el('div', { class: 'empty', text: 'No games match this selection.' })));
    return;
  }

  for (const game of games) list.append(gameRow(game));
}

function gameRow(game) {
  const open = state.expanded.has(game.gameId);
  const wrap = el('div', { class: 'game' + (open ? ' open' : '') });

  const header = el('button', {
    class: 'game-head',
    attrs: { type: 'button', 'aria-expanded': String(open) },
  });

  header.append(el('span', { class: 'game-caret', text: open ? '▾' : '▸' }));
  header.append(el('span', { class: 'game-date', text: fmtDate(game.date) }));
  header.append(el('span', {
    class: 'game-opp',
    text: `${game.homeAway === 'Away' ? 'at' : 'vs'} ${game.opponent || game.gameId}`,
  }));
  header.append(el('span', { class: 'pill', text: game.homeAway || '—' }));

  const pts = el('span', { class: 'game-pts' });
  pts.append(el('span', { text: `Team ${game.teamPoints}` }));
  const sel = selectedPoints(game, state.selected);
  if (sel != null) {
    pts.append(el('span', { class: 'dot', text: '·' }));
    pts.append(el('span', { class: 'game-sel', text: `Selected ${sel}` }));
  }
  header.append(pts);

  header.addEventListener('click', () => {
    if (state.expanded.has(game.gameId)) state.expanded.delete(game.gameId);
    else state.expanded.add(game.gameId);
    render();
  });

  wrap.append(header);
  if (open) wrap.append(boxScore(game));
  return wrap;
}

function boxScore(game) {
  const scroll = el('div', { class: 'table-scroll' });
  const table = el('table');

  const thead = el('thead');
  const hr = el('tr');
  hr.append(el('th', { text: 'Player', attrs: { scope: 'col' } }));
  for (const f of STAT_FIELDS) hr.append(el('th', { text: STAT_LABELS[f], attrs: { scope: 'col' } }));
  hr.append(el('th', { text: 'FG%', attrs: { scope: 'col' } }));
  thead.append(hr);
  table.append(thead);

  // Highest scorers first; DNPs sink, since they're the least interesting rows.
  const rows = [...game.rows].sort((a, b) => {
    if (a.dnp !== b.dnp) return a.dnp ? 1 : -1;
    return (b.stats.points ?? 0) - (a.stats.points ?? 0);
  });

  const tbody = el('tbody');
  for (const row of rows) {
    const selected = state.selected.includes(row.playerId);
    const tr = el('tr', { class: selected ? 'selected-row' : '' });

    const nameCell = el('td', { text: nameOf(row.player) });
    if (row.flags.length) {
      nameCell.append(document.createTextNode(' '));
      nameCell.append(el('span', {
        class: 'flagged', text: '!',
        attrs: { title: 'Check this row: ' + row.flags.join('; ') },
      }));
    }
    tr.append(nameCell);

    if (row.dnp) {
      tr.append(el('td', { class: 'dnp', text: 'DNP' }));
      for (let i = 1; i < STAT_FIELDS.length; i++) tr.append(el('td', { class: 'dnp', text: '' }));
      tr.append(el('td', { class: 'dnp', text: '' }));
    } else {
      for (const f of STAT_FIELDS) tr.append(el('td', { text: fmtInt(row.stats[f]) }));
      const made = row.stats.fgm ?? 0;
      const att = row.stats.fga ?? 0;
      tr.append(el('td', { text: att > 0 ? fmtPct(made / att) : '—' }));
    }
    tbody.append(tr);
  }
  table.append(tbody);

  const totals = {};
  for (const f of STAT_FIELDS) {
    totals[f] = game.rows.reduce((sum, r) => sum + (r.stats[f] ?? 0), 0);
  }
  const tfoot = el('tfoot');
  const fr = el('tr');
  fr.append(el('td', { text: 'TEAM' }));
  for (const f of STAT_FIELDS) fr.append(el('td', { text: String(totals[f]) }));
  fr.append(el('td', { text: totals.fga > 0 ? fmtPct(totals.fgm / totals.fga) : '—' }));
  tfoot.append(fr);
  table.append(tfoot);

  scroll.append(table);
  return scroll;
}

/* ------------------------------------------------------------------ */
/* Connection panel                                                    */
/* ------------------------------------------------------------------ */

function renderConnection() {
  const body = $('#conn-body');
  const pill = $('#conn-pill');
  body.replaceChildren();

  const { meta, issues, mismatches, discovery, usingSample } = state.data;
  const entries = Object.entries(meta);
  const { blocking, auth, quality } = sheetProblems(state.data);

  // While everything is healthy this whole section stays out of the way. It
  // reappears the moment it has something to tell you — which is the only time
  // it's worth reading.
  const section = $('#sheet-section');
  section.hidden = blocking.length === 0 && quality === 0;
  if (blocking.length > 0 || auth.length > 0) $('#conn-panel').open = true;

  pill.className = 'pill ' + (blocking.length || auth.length || quality ? 'warn' : 'ok');
  pill.textContent = auth.length
    ? 'sign-in needed'
    : (blocking.length
      ? blocking[0]
      : (quality ? `${quality} thing${quality > 1 ? 's' : ''} to check` : (usingSample ? 'sample data' : 'connected')));

  // A refused token is not a broken sheet. Listing it among missing columns
  // would send you hunting through a spreadsheet that is perfectly fine.
  if (auth.length) {
    const box = el('div', { class: 'tab-report' });
    box.append(el('h3', { text: 'Sign-in' }));
    for (const line of auth) box.append(el('p', { class: 'small', text: line }));
    box.append(el('p', {
      class: 'small muted',
      text: 'Nothing is wrong with the sheet — the script refused the request. Sign in again, or use the admin password.',
    }));
    body.append(box);
  }

  for (const [name, m] of entries) {
    body.append(tabReport(name, m));
  }

  if (discovery && !discovery.skipped) {
    const found = Object.keys(discovery.gids || {});
    body.append(el('p', {
      class: 'small muted',
      text: discovery.error
        ? `Tab discovery: ${discovery.error}`
        : `Tab discovery: read ${found.length} tab${found.length === 1 ? '' : 's'} from the published page.`,
    }));
  }

  const fetchedAt = entries.map(([, m]) => m.fetchedAt).filter(Boolean).sort().pop();
  body.append(el('p', {
    class: 'small muted',
    text: state.data?.source === 'apps-script'
      ? `Last refresh: ${fetchedAt ? new Date(fetchedAt).toLocaleString() : '—'} — read straight from the sheet, so an edit shows on the next refresh.`
      : `Last refresh: ${fetchedAt ? new Date(fetchedAt).toLocaleString() : '—'} — published sheets can lag up to ~5 minutes behind an edit, so a stat you just typed may not be here yet.`,
  }));

  issueBlock(body, 'Duplicate rows replaced by a later row', issues.superseded, (s) =>
    `Row ${s.sheetRow} replaced by row ${s.supersededBy} — ${s.gameId}, ${s.playerId}`);
  issueBlock(body, 'Rows with no matching game', issues.unmatchedGames,
    (i) => `Row ${i.sheetRow}: ${i.detail}`, (i) => i.detail);
  issueBlock(body, 'Rows with no matching player', issues.unmatchedPlayers,
    (i) => `Row ${i.sheetRow}: ${i.detail}`, (i) => i.detail);
  issueBlock(body, 'Dates that could not be read', issues.invalidDates, (i) =>
    `${i.gameId}: "${i.value}" — use M/D/YYYY or YYYY-MM-DD`);
  // The same mistake copied down a column is one problem, not seventy.
  issueBlock(body, 'Rows worth double-checking', issues.sanityFlags,
    (f) => `Row ${f.sheetRow} — ${f.player}, ${f.game}: ${f.flags.join('; ')}`,
    (f) => f.flags.join('; '));
  issueBlock(body, 'Team Score doesn’t match the logged points', mismatches, (m) =>
    `${m.gameId} vs ${m.opponent}: Games tab says ${m.recorded}, StatsLog rows add up to ${m.logged}`);

  if (!body.querySelector('.issue-list')) {
    body.append(el('p', { class: 'small muted', text: 'No data problems found.' }));
  }
}

/** Per-tab report: where it came from, what it matched, what's missing. */
function tabReport(name, m) {
  const block = el('div', { class: 'tab-report' });
  block.append(el('h3', { text: name }));

  const dl = el('dl', { class: 'dl' });

  dl.append(el('dt', { text: 'Source' }));
  dl.append(el('dd', {
    text: m.strategy
      ? `${m.strategy}${m.status ? ` — HTTP ${m.status}` : ''}`
      : 'not loaded',
  }));

  if (m.url) {
    dl.append(el('dt', { text: 'URL' }));
    dl.append(el('dd', { class: 'url', text: m.url }));
  }

  dl.append(el('dt', { text: 'Header row' }));
  dl.append(el('dd', {
    text: m.headerRow >= 0 ? `sheet row ${m.headerRow + 1}` : 'not found',
  }));

  const matchedNames = Object.values(m.matched || {});
  dl.append(el('dt', { text: 'Matched' }));
  dl.append(el('dd', { text: matchedNames.length ? matchedNames.join(', ') : '—' }));

  dl.append(el('dt', { text: 'Data rows' }));
  dl.append(el('dd', {
    text: `${m.records.length}${m.skipped ? ` (${m.skipped} blank/EX row${m.skipped === 1 ? '' : 's'} skipped)` : ''}`,
  }));

  block.append(dl);

  if (m.missing && m.missing.length) {
    const expected = m.missing.map((field) => (m.schema.fields[field] || [field])[0]);
    block.append(el('p', {
      class: 'small missing',
      text: `Missing expected column${m.missing.length > 1 ? 's' : ''}: ${expected.join(', ')}`,
    }));
  }
  if (m.error) block.append(el('p', { class: 'small missing', text: m.error }));
  if (m.unknownColumns && m.unknownColumns.length) {
    block.append(el('p', { class: 'small muted', text: `Columns the site doesn't use: ${m.unknownColumns.join(', ')}` }));
  }
  for (const a of m.attempts || []) {
    block.append(el('p', { class: 'small muted', text: `${a.strategy} failed: ${a.error}` }));
  }

  return block;
}

/**
 * List issues, collapsing repeats.
 *
 * One mistake copied down a whole column produces one flag per row. Printing
 * 70 identical lines buries every other finding, so identical messages are
 * grouped and counted, with a few example rows named.
 */
function issueBlock(parent, title, items, format, groupBy) {
  if (!items || items.length === 0) return;
  parent.append(el('h3', { text: `${title} (${items.length})` }));
  const ul = el('ul', { class: 'issue-list small' });

  if (!groupBy) {
    for (const item of items) ul.append(el('li', { text: format(item) }));
    parent.append(ul);
    return;
  }

  const groups = new Map();
  for (const item of items) {
    const key = groupBy(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  for (const [key, group] of groups) {
    if (group.length === 1) {
      ul.append(el('li', { text: format(group[0]) }));
      continue;
    }
    const li = el('li');
    li.append(el('strong', { text: `${group.length} rows: ` }));
    li.append(document.createTextNode(key));
    const rows = group.slice(0, 4).map((g) => g.sheetRow).join(', ');
    const more = group.length > 4 ? `, and ${group.length - 4} more` : '';
    li.append(el('div', { class: 'muted', text: `rows ${rows}${more}` }));
    ul.append(li);
  }
  parent.append(ul);
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

function render() {
  const games = visibleGames();
  renderChips();
  renderFilterHint();
  $('#m-all').setAttribute('aria-pressed', String(state.mode === 'all'));
  $('#m-any').setAttribute('aria-pressed', String(state.mode === 'any'));
  $('#f-ha').value = state.ha;
  renderSummary(games);
  renderGames(games);
  renderConnection();
}

function setBanner(message) {
  const banner = $('#banner');
  if (!message) { banner.hidden = true; return; }
  banner.replaceChildren(document.createTextNode(message));
  banner.hidden = false;
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

async function load() {
  state.data = await loadAll();
  setBanner(state.data.banner);

  // Drop selections for players that aren't on the roster any more, so a stale
  // link doesn't filter against nothing.
  const known = new Set(state.data.players.map((p) => p.playerId));
  state.selected = state.selected.filter((id) => known.has(id));

  render();
}

/** These numbers are admin-only unless sign-in is switched off entirely. */
function hasAdmin() {
  const gate = CONFIG.gate || {};
  if (!isEnabled(gate)) return true;
  return sessionValid(readAdminSession(), adminMaxAge(gate));
}

/**
 * Ask for the admin password instead of the page.
 *
 * loadAll() is never called from here. The script would refuse the request
 * anyway, but not asking at all is the difference between "you need the
 * password" and a page that looks broken.
 */
function showAdminPrompt() {
  $('#stats-body').hidden = true;
  const host = $('#admin-gate');
  host.hidden = false;

  mountAdminPrompt(host, () => {
    host.hidden = true;
    $('#stats-body').hidden = false;
    init();
  }, {
    title: 'These numbers need the admin password',
    note: 'Player stats and box scores are admin-only.',
  });
}

let wired = false;

function init() {
  if (!hasAdmin()) {
    showAdminPrompt();
    return;
  }

  // init() runs again when the admin prompt is satisfied. Wiring the controls
  // twice would make one click on Clear fire two renders.
  if (wired) { load(); return; }
  wired = true;

  readUrl();

  $('#m-all').addEventListener('click', () => { state.mode = 'all'; writeUrl(); render(); });
  $('#m-any').addEventListener('click', () => { state.mode = 'any'; writeUrl(); render(); });
  $('#btn-clear').addEventListener('click', () => {
    state.selected = [];
    writeUrl();
    render();
  });
  $('#f-ha').addEventListener('change', (e) => { state.ha = e.target.value; writeUrl(); render(); });
  $('#btn-refresh').addEventListener('click', () => { setBanner('Refreshing…'); load(); });

  renderAdminSignOut();
  load();
}

/**
 * Signing out of admin has to take the numbers with it — off the screen and out
 * of storage. A shared laptop keeping a box score after sign-out would undo the
 * point of asking for a password at all.
 */
function renderAdminSignOut() {
  const gate = CONFIG.gate || {};
  if (!isEnabled(gate) || $('#admin-out')) return;

  const btn = el('button', { class: 'btn', text: 'Sign out of admin', attrs: { type: 'button', id: 'admin-out' } });
  btn.addEventListener('click', () => {
    clearAdminSession();
    forgetSensitiveCache();
    globalThis.location.reload();
  });
  $('.chips-actions')?.append(btn);
}

/**
 * The admin prompt prefills your name from the site session, so nothing here
 * can run until that sign-in has happened.
 *
 * gate.js announces it — but modules execute in document order and gate.js
 * comes first, so on a reload with a session already stored it has announced
 * before this module exists. Listening alone would wait forever. Check for the
 * session directly, and only wait for the event when there genuinely isn't one.
 */
function start() {
  const gate = CONFIG.gate || {};
  if (isEnabled(gate) && !sessionValid(readSession(), siteMaxAge(gate))) {
    document.addEventListener('bb:signedin', init, { once: true });
    return;
  }
  init();
}

start();
