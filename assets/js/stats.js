/**
 * Stats tracker UI.
 *
 * Sheet-derived text is always written with textContent, never innerHTML: the
 * sheet is editable by anyone you've shared it with and this page is public, so
 * a player name is untrusted input as far as the DOM is concerned.
 */

import { CONFIG } from './config.js';
import { loadAll } from './data.js';
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
  const broken = entries.filter(([, m]) => m.error || m.missing.length > 0);

  pill.className = 'pill ' + (broken.length ? 'warn' : 'ok');
  pill.textContent = broken.length
    ? `${broken.length} tab${broken.length > 1 ? 's' : ''} need attention`
    : (usingSample ? 'sample data' : 'connected');

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
    text: `Last refresh: ${fetchedAt ? new Date(fetchedAt).toLocaleString() : '—'} — published sheets can lag up to ~5 minutes behind an edit, so a stat you just typed may not be here yet.`,
  }));

  issueBlock(body, 'Duplicate rows replaced by a later row', issues.superseded, (s) =>
    `Row ${s.sheetRow} replaced by row ${s.supersededBy} — ${s.gameId}, ${s.playerId}`);
  issueBlock(body, 'Rows with no matching game', issues.unmatchedGames, (i) => `Row ${i.sheetRow}: ${i.detail}`);
  issueBlock(body, 'Rows with no matching player', issues.unmatchedPlayers, (i) => `Row ${i.sheetRow}: ${i.detail}`);
  issueBlock(body, 'Dates that could not be read', issues.invalidDates, (i) =>
    `${i.gameId}: "${i.value}" — use M/D/YYYY or YYYY-MM-DD`);
  issueBlock(body, 'Rows worth double-checking', issues.sanityFlags, (f) =>
    `Row ${f.sheetRow} — ${f.player}, ${f.game}: ${f.flags.join('; ')}`);
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

function issueBlock(parent, title, items, format) {
  if (!items || items.length === 0) return;
  parent.append(el('h3', { text: `${title} (${items.length})` }));
  const ul = el('ul', { class: 'issue-list small' });
  for (const item of items) ul.append(el('li', { text: format(item) }));
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

function init() {
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

  load();
}

init();
