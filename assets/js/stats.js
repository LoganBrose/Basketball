/**
 * Stats tracker UI.
 *
 * Sheet-derived text is always written with textContent, never innerHTML:
 * the sheet is editable by anyone you've shared it with and this page is
 * public, so a player name is untrusted input as far as the DOM is concerned.
 */

import { CONFIG } from './config.js';
import { SCHEMAS, endpointsFor, loadTab, discoverGids } from './sheets.js';
import { normalizeHeader } from './csv.js';
import {
  buildDataset, aggregate, displayName, STAT_FIELDS, STAT_LABELS,
} from './model.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  players: [],
  games: [],
  rows: [],
  issues: null,
  meta: {},
  discovery: null,
  statsTabLabel: 'Stats',
  view: 'player',
  teamMode: 'totals',
  sort: { key: 'date', dir: 'asc' },
  filters: { player: '', ha: '', opp: '', from: '', to: '' },
};

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const fmtInt = (n) => (n == null ? '—' : String(n));
const fmtAvg = (n) => (n == null ? '—' : n.toFixed(1));
const fmtPct = (p) => (p == null ? '—' : (p * 100).toFixed(1) + '%');

function fmtDate(date) {
  if (!date) return '—';
  return `${date.month}/${date.day}`;
}

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
  state.filters.player = q.get('player') || '';
  state.filters.ha = q.get('ha') || '';
  state.filters.opp = q.get('opp') || '';
  state.filters.from = q.get('from') || '';
  state.filters.to = q.get('to') || '';
  state.view = q.get('view') === 'team' ? 'team' : 'player';
  state.teamMode = q.get('mode') === 'avg' ? 'avg' : 'totals';
  if (q.get('sort')) state.sort = { key: q.get('sort'), dir: q.get('dir') === 'desc' ? 'desc' : 'asc' };
  else state.sort = state.view === 'team' ? { key: 'points', dir: 'desc' } : { key: 'date', dir: 'asc' };
}

function writeUrl() {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(state.filters)) if (v) q.set(k, v);
  if (state.view !== 'player') q.set('view', state.view);
  if (state.view === 'team' && state.teamMode === 'avg') q.set('mode', 'avg');
  q.set('sort', state.sort.key);
  q.set('dir', state.sort.dir);
  const url = `${location.pathname}?${q}`;
  history.replaceState(null, '', url);
}

/* ------------------------------------------------------------------ */
/* Filtering                                                           */
/* ------------------------------------------------------------------ */

/** Everything except the player filter — team view wants all players. */
function applyGameFilters(rows) {
  const { ha, opp, from, to } = state.filters;
  return rows.filter((r) => {
    if (ha && r.homeAway !== ha) return false;
    if (opp && r.opponent !== opp) return false;
    if (from && (!r.date || r.date.key < from)) return false;
    if (to && (!r.date || r.date.key > to)) return false;
    return true;
  });
}

function filteredRows() {
  const rows = applyGameFilters(state.rows);
  if (!state.filters.player) return rows;
  return rows.filter((r) => r.playerId === state.filters.player);
}

/* ------------------------------------------------------------------ */
/* Sorting                                                             */
/* ------------------------------------------------------------------ */

/** Stable sort: null and DNP values always sink, whichever direction. */
function sortRows(rows, valueOf) {
  const dir = state.sort.dir === 'desc' ? -1 : 1;
  return rows
    .map((row, i) => ({ row, i, v: valueOf(row) }))
    .sort((a, b) => {
      const an = a.v == null;
      const bn = b.v == null;
      if (an && bn) return a.i - b.i;
      if (an) return 1;
      if (bn) return -1;
      if (a.v < b.v) return -1 * dir;
      if (a.v > b.v) return 1 * dir;
      return a.i - b.i;
    })
    .map((x) => x.row);
}

function onSort(key) {
  if (state.sort.key === key) {
    state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    // Numbers are most useful highest-first; names and dates read better ascending.
    state.sort = { key, dir: key === 'date' || key === 'player' || key === 'opponent' ? 'asc' : 'desc' };
  }
  writeUrl();
  render();
}

function headerCell(key, label, title) {
  const th = el('th', { class: 'sortable', text: label, attrs: { scope: 'col', title, tabindex: '0', role: 'button' } });
  if (state.sort.key === key) th.setAttribute('aria-sort', state.sort.dir === 'asc' ? 'ascending' : 'descending');
  const go = () => onSort(key);
  th.addEventListener('click', go);
  th.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
  });
  return th;
}

/* ------------------------------------------------------------------ */
/* Render: player card                                                 */
/* ------------------------------------------------------------------ */

function renderPlayerCard(rows) {
  const card = $('#player-card');
  card.replaceChildren();

  const player = state.players.find((p) => p.playerId === state.filters.player);
  const agg = aggregate(rows);

  const head = el('div', { class: 'player-head' });
  head.append(el('h2', { text: player ? nameOf(player) : 'All players' }));

  const bits = [];
  if (player) {
    if (player.jersey && CONFIG.nameDisplay !== 'jersey') bits.push(`#${player.jersey}`);
    if (player.position) bits.push(player.position);
  }
  const scope = [];
  if (state.filters.ha) scope.push(state.filters.ha.toLowerCase() + ' games');
  if (state.filters.opp) scope.push('vs ' + state.filters.opp);
  if (scope.length) bits.push(scope.join(', '));
  if (bits.length) head.append(el('span', { class: 'meta', text: bits.join(' · ') }));
  card.append(head);

  if (rows.length === 0) {
    card.append(el('div', { class: 'empty', text: 'No games match these filters.' }));
    return;
  }

  // "GP" means games played for one player; across the roster it's player-games.
  const gpLabel = player ? 'GP' : 'Player-games';
  const dnpCount = rows.filter((r) => r.dnp).length;

  const lead = el('div', { class: 'statgrid' });
  lead.append(statTile(gpLabel, String(agg.gp), dnpCount ? `${dnpCount} DNP` : null, true));
  lead.append(statTile('PTS', String(agg.totals.points), fmtAvg(agg.averages.points) + ' per game', true));
  lead.append(statTile('REB', String(agg.totals.rebounds), fmtAvg(agg.averages.rebounds) + ' per game', true));
  lead.append(statTile('AST', String(agg.totals.assists), fmtAvg(agg.averages.assists) + ' per game', true));
  lead.append(statTile('FG%', fmtPct(agg.fgPct), `${agg.totals.fgm}/${agg.totals.fga}`));
  lead.append(statTile('3PT%', fmtPct(agg.tpPct), `${agg.totals.tpm}/${agg.totals.tpa}`));
  lead.append(statTile('FT%', fmtPct(agg.ftPct), `${agg.totals.ftm}/${agg.totals.fta}`));
  card.append(lead);

  card.append(el('div', { class: 'section-label', text: 'Totals · per game' }));
  const grid = el('div', { class: 'statgrid' });
  for (const f of STAT_FIELDS) {
    grid.append(statTile(STAT_LABELS[f], String(agg.totals[f]), fmtAvg(agg.averages[f]) + ' pg'));
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
/* Render: game log                                                    */
/* ------------------------------------------------------------------ */

function renderGameLog(rows) {
  const table = $('#gamelog');
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');
  const tfoot = table.querySelector('tfoot');
  thead.replaceChildren();
  tbody.replaceChildren();
  tfoot.replaceChildren();

  const showPlayer = !state.filters.player;

  const hr = el('tr');
  hr.append(headerCell('date', 'Date'));
  if (showPlayer) hr.append(headerCell('player', 'Player'));
  hr.append(headerCell('opponent', 'Opponent'));
  hr.append(headerCell('homeAway', 'H/A'));
  for (const f of STAT_FIELDS) hr.append(headerCell(f, STAT_LABELS[f]));
  thead.append(hr);

  const sorted = sortRows(rows, (r) => {
    const k = state.sort.key;
    if (k === 'date') return r.date ? r.date.ms : null;
    if (k === 'player') return r.player ? nameOf(r.player).toLowerCase() : null;
    if (k === 'opponent') return r.opponent.toLowerCase();
    if (k === 'homeAway') return r.homeAway;
    return r.dnp ? null : r.stats[k];
  });

  if (sorted.length === 0) {
    const span = STAT_FIELDS.length + (showPlayer ? 4 : 3);
    tbody.append(el('tr', {}, el('td', { class: 'empty', text: 'No games match these filters.', attrs: { colspan: String(span) } })));
    return;
  }

  for (const row of sorted) {
    const tr = el('tr');
    tr.append(el('td', { text: fmtDate(row.date) }));
    if (showPlayer) tr.append(el('td', { text: nameOf(row.player) }));

    const opp = el('td', { text: row.opponent || '—' });
    if (row.flags.length > 0) {
      opp.append(document.createTextNode(' '));
      opp.append(el('span', {
        class: 'flagged',
        text: '!',
        attrs: { title: 'Check this row: ' + row.flags.join('; ') },
      }));
    }
    tr.append(opp);
    tr.append(el('td', { text: row.homeAway || '—' }));

    for (const f of STAT_FIELDS) {
      if (row.dnp) {
        tr.append(el('td', { class: 'dnp', text: f === 'points' ? 'DNP' : '' }));
      } else {
        tr.append(el('td', { text: fmtInt(row.stats[f]) }));
      }
    }
    tbody.append(tr);
  }

  const agg = aggregate(sorted);
  const ftr = el('tr');
  ftr.append(el('td', { text: `${agg.gp} GP` }));
  if (showPlayer) ftr.append(el('td', { text: '' }));
  ftr.append(el('td', { text: 'Totals' }));
  ftr.append(el('td', { text: '' }));
  for (const f of STAT_FIELDS) ftr.append(el('td', { text: String(agg.totals[f]) }));
  tfoot.append(ftr);
}

/* ------------------------------------------------------------------ */
/* Render: team table                                                  */
/* ------------------------------------------------------------------ */

function renderTeam(rows) {
  const table = $('#teamtable');
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');
  const tfoot = table.querySelector('tfoot');
  thead.replaceChildren();
  tbody.replaceChildren();
  tfoot.replaceChildren();

  const byPlayer = new Map();
  for (const row of rows) {
    if (!byPlayer.has(row.playerId)) byPlayer.set(row.playerId, []);
    byPlayer.get(row.playerId).push(row);
  }

  const lines = [...byPlayer.entries()].map(([playerId, playerRows]) => ({
    playerId,
    player: state.players.find((p) => p.playerId === playerId),
    agg: aggregate(playerRows),
  }));

  const avg = state.teamMode === 'avg';

  const hr = el('tr');
  hr.append(headerCell('player', 'Player'));
  hr.append(headerCell('gp', 'GP'));
  for (const f of STAT_FIELDS) hr.append(headerCell(f, STAT_LABELS[f]));
  hr.append(headerCell('fgPct', 'FG%'));
  hr.append(headerCell('tpPct', '3PT%'));
  hr.append(headerCell('ftPct', 'FT%'));
  thead.append(hr);

  const sorted = sortRows(lines, (line) => {
    const k = state.sort.key;
    if (k === 'player') return line.player ? nameOf(line.player).toLowerCase() : line.playerId;
    if (k === 'gp') return line.agg.gp;
    if (k === 'fgPct' || k === 'tpPct' || k === 'ftPct') return line.agg[k];
    return avg ? line.agg.averages[k] : line.agg.totals[k];
  });

  if (sorted.length === 0) {
    const span = STAT_FIELDS.length + 5;
    tbody.append(el('tr', {}, el('td', { class: 'empty', text: 'No games match these filters.', attrs: { colspan: String(span) } })));
    return;
  }

  for (const line of sorted) {
    const tr = el('tr');
    tr.append(el('td', { text: line.player ? nameOf(line.player) : line.playerId }));
    tr.append(el('td', { text: String(line.agg.gp) }));
    for (const f of STAT_FIELDS) {
      tr.append(el('td', { text: avg ? fmtAvg(line.agg.averages[f]) : String(line.agg.totals[f]) }));
    }
    tr.append(el('td', { text: fmtPct(line.agg.fgPct) }));
    tr.append(el('td', { text: fmtPct(line.agg.tpPct) }));
    tr.append(el('td', { text: fmtPct(line.agg.ftPct) }));
    tbody.append(tr);
  }

  const team = aggregate(rows);
  const ftr = el('tr');
  ftr.append(el('td', { text: 'Team' }));
  ftr.append(el('td', { text: String(team.gp) }));
  for (const f of STAT_FIELDS) {
    ftr.append(el('td', { text: avg ? fmtAvg(team.averages[f]) : String(team.totals[f]) }));
  }
  ftr.append(el('td', { text: fmtPct(team.fgPct) }));
  ftr.append(el('td', { text: fmtPct(team.tpPct) }));
  ftr.append(el('td', { text: fmtPct(team.ftPct) }));
  tfoot.append(ftr);
}

/* ------------------------------------------------------------------ */
/* Render: connection panel                                            */
/* ------------------------------------------------------------------ */

function renderConnection() {
  const body = $('#conn-body');
  const pill = $('#conn-pill');
  body.replaceChildren();

  const metas = Object.entries(state.meta);
  const failed = metas.filter(([, m]) => m.error || m.records.length === 0 && m.headerRow === -1);
  const sample = metas.some(([, m]) => m.strategy === 'bundled sample data');

  pill.className = 'pill ' + (failed.length ? 'warn' : 'ok');
  pill.textContent = failed.length ? `${failed.length} problem${failed.length > 1 ? 's' : ''}` : (sample ? 'sample data' : 'connected');

  const dl = el('dl', { class: 'dl' });
  for (const [name, m] of metas) {
    dl.append(el('dt', { text: name }));
    const parts = [];
    parts.push(m.strategy || 'not loaded');
    parts.push(`${m.records.length} row${m.records.length === 1 ? '' : 's'}`);
    if (m.headerRow >= 0) parts.push(`header on sheet row ${m.headerRow + 1}`);
    if (m.skipped) parts.push(`${m.skipped} example/blank row${m.skipped === 1 ? '' : 's'} skipped`);
    if (m.stale) parts.push('served from cache');
    dl.append(el('dd', { text: parts.join(' · ') }));
  }

  const disc = state.discovery;
  if (disc && !disc.skipped) {
    dl.append(el('dt', { text: 'Tab discovery' }));
    const found = Object.keys(disc.gids || {});
    dl.append(el('dd', {
      text: disc.error
        ? disc.error
        : `read ${found.length} tab${found.length === 1 ? '' : 's'} from the published page — ${found.join(', ')}`,
    }));
  }

  const fetchedAt = metas.map(([, m]) => m.fetchedAt).filter(Boolean).sort().pop();
  dl.append(el('dt', { text: 'Last refresh' }));
  dl.append(el('dd', {
    text: (fetchedAt ? new Date(fetchedAt).toLocaleString() : '—') +
      ' — published sheets can lag up to ~5 minutes behind a new Form entry, so a stat you just submitted may not be here yet.',
  }));
  body.append(dl);

  for (const [name, m] of metas) {
    if (m.error) {
      body.append(el('p', { class: 'small', text: `${name}: ${m.error}` }));
    }
    for (const a of m.attempts || []) {
      body.append(el('p', { class: 'small muted', text: `${name} — ${a.strategy} failed: ${a.error}` }));
    }
    if (m.unknownColumns && m.unknownColumns.length) {
      body.append(el('p', { class: 'small muted', text: `${name}: columns the site doesn't use — ${m.unknownColumns.join(', ')}` }));
    }
  }

  const issues = state.issues || {};
  issueBlock(body, 'Corrected entries (superseded by a later submission)', issues.superseded, (s) =>
    `Row ${s.sheetRow} replaced by row ${s.supersededBy} — ${s.gameId}, ${s.playerId}`);
  issueBlock(body, 'Rows with no matching game', issues.unmatchedGames, (i) => `Row ${i.sheetRow}: ${i.detail}`);
  issueBlock(body, 'Rows with no matching player', issues.unmatchedPlayers, (i) => `Row ${i.sheetRow}: ${i.detail}`);
  issueBlock(body, 'Ambiguous dropdown values', issues.ambiguousTokens, (i) => `Row ${i.sheetRow}: ${i.detail}`);
  issueBlock(body, 'Dates that could not be read', issues.invalidDates, (i) => `${i.gameId}: "${i.value}" — use M/D/YYYY or YYYY-MM-DD`);
  issueBlock(body, 'Rows worth double-checking', issues.sanityFlags, (f) =>
    `Row ${f.sheetRow} — ${f.player}, ${f.game}: ${f.flags.join('; ')}`);

  if (!body.querySelector('.issue-list')) {
    body.append(el('p', { class: 'small muted', text: 'No data problems found.' }));
  }
}

function issueBlock(parent, title, items, format) {
  if (!items || items.length === 0) return;
  parent.append(el('h3', { text: `${title} (${items.length})` }));
  const ul = el('ul', { class: 'issue-list small' });
  for (const item of items) ul.append(el('li', { text: format(item) }));
  parent.append(ul);
}

/* ------------------------------------------------------------------ */
/* Render: Form dropdown options                                       */
/* ------------------------------------------------------------------ */

function renderFormOptions() {
  // Always full names here: this text is pasted into your private Form, not
  // rendered on the public page, and a jersey alone wouldn't identify anyone.
  $('#opts-players').value = state.players
    .map((p) => `${p.jersey || p.playerId} – ${p.fullName || p.playerId}`)
    .join('\n');

  $('#opts-games').value = state.games
    .map((g) => {
      const d = g.date ? `${g.date.month}/${g.date.day}` : g.dateRaw || '';
      const side = g.homeAway && g.homeAway.toLowerCase().startsWith('a') ? 'at' : 'vs';
      return `${g.gameId} – ${side} ${g.opponent}${d ? ` (${d})` : ''}`;
    })
    .join('\n');
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

function render() {
  const playerView = state.view === 'player';
  $('#view-player').hidden = !playerView;
  $('#view-team').hidden = playerView;
  $('#v-player').setAttribute('aria-pressed', String(playerView));
  $('#v-team').setAttribute('aria-pressed', String(!playerView));

  if (playerView) {
    const rows = filteredRows();
    renderPlayerCard(rows);
    renderGameLog(rows);
  } else {
    $('#m-totals').setAttribute('aria-pressed', String(state.teamMode === 'totals'));
    $('#m-avg').setAttribute('aria-pressed', String(state.teamMode === 'avg'));
    // The team view deliberately ignores the player filter — say so rather than
    // leaving the filter looking broken.
    $('#team-hint').textContent = state.filters.player ? 'Team view shows every player; the player filter applies to the Player tab.' : '';
    renderTeam(applyGameFilters(state.rows));
  }
  renderConnection();
}

function populateFilters() {
  const playerSel = $('#f-player');
  playerSel.replaceChildren(el('option', { text: 'All players', attrs: { value: '' } }));
  for (const p of state.players) {
    playerSel.append(el('option', { text: nameOf(p), attrs: { value: p.playerId } }));
  }
  playerSel.value = state.filters.player;

  const opponents = [...new Set(state.games.map((g) => g.opponent).filter(Boolean))].sort();
  const oppSel = $('#f-opp');
  oppSel.replaceChildren(el('option', { text: 'All opponents', attrs: { value: '' } }));
  for (const o of opponents) oppSel.append(el('option', { text: o, attrs: { value: o } }));
  oppSel.value = state.filters.opp;

  $('#f-ha').value = state.filters.ha;
  $('#f-from').value = state.filters.from;
  $('#f-to').value = state.filters.to;
}

function setBanner(message) {
  const banner = $('#banner');
  if (!message) { banner.hidden = true; return; }
  banner.replaceChildren();
  banner.append(document.createTextNode(message));
  banner.hidden = false;
}

/* ------------------------------------------------------------------ */
/* Load                                                                */
/* ------------------------------------------------------------------ */

async function load() {
  const { sheet } = CONFIG;

  // With only a publish key configured, read the gids off the published page
  // rather than making anyone look them up by hand.
  const needsDiscovery = !sheet.fileId && Object.values(sheet.tabs).every((t) => !t.gid);
  state.discovery = needsDiscovery && sheet.pubKey
    ? await discoverGids(sheet.pubKey)
    : { gids: {}, error: null, skipped: true };

  const gidFor = (tab) => tab.gid || state.discovery.gids[normalizeHeader(tab.name)] || '';

  // The stats source is either the hand-typed StatsLog tab or the Form's own
  // responses tab. They share every stat column and differ only in their key.
  const source = CONFIG.statsSource === 'responses' ? 'responses' : 'statslog';
  state.statsTabLabel = sheet.tabs[source].name;

  const tabs = [
    ['players', SCHEMAS.players, sheet.tabs.players, CONFIG.sample.players],
    ['games', SCHEMAS.games, sheet.tabs.games, CONFIG.sample.games],
    [source, SCHEMAS[source], sheet.tabs[source], CONFIG.sample[source]],
  ];

  const results = await Promise.all(tabs.map(([name, schema, tab, sampleUrl]) =>
    loadTab({
      name,
      schema,
      endpoints: endpointsFor(sheet, tab.name, gidFor(tab)),
      sampleUrl,
    })));

  state.meta = { Players: results[0], Games: results[1], [state.statsTabLabel]: results[2] };
  state.players = results[0].records;

  const built = buildDataset({
    players: results[0].records,
    games: results[1].records,
    responses: results[2].records,
  });
  state.rows = built.rows;
  state.issues = built.issues;

  // Games carry their parsed date through buildDataset; re-read them for filters.
  state.games = results[1].records.map((g) => {
    const row = state.rows.find((r) => r.gameId === g.gameId);
    return { ...g, date: row?.date || null, dateRaw: g.date };
  });

  if (results.some((r) => r.strategy === 'bundled sample data')) {
    // "Not configured" and "configured but unreachable" need different fixes,
    // so don't tell someone to fill in config they've already filled in.
    const configured = Boolean(sheet.fileId) || Object.values(sheet.tabs).some((t) => t.gid);
    let why;
    if (state.discovery?.error) {
      why = `Showing sample data — ${state.discovery.error}`;
    } else if (configured) {
      why = 'Showing sample data — the Google Sheet couldn\'t be reached. Open Connection below for the exact error: usually the sheet needs "Anyone with the link" access, or the tabs need publishing.';
    } else {
      why = 'Showing sample data — the Google Sheet isn\'t configured yet. Add your fileId or tab gids in assets/js/config.js. See the README.';
    }
    setBanner(why);
  } else if (results.some((r) => r.stale)) {
    setBanner('Showing the last saved copy — the sheet couldn\'t be reached just now. Open Connection below for the exact error.');
  } else {
    setBanner('');
  }

  populateFilters();
  renderFormOptions();
  render();
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

function bindFilter(sel, key) {
  $(sel).addEventListener('change', (e) => {
    state.filters[key] = e.target.value;
    writeUrl();
    render();
  });
}

function init() {
  readUrl();

  bindFilter('#f-player', 'player');
  bindFilter('#f-ha', 'ha');
  bindFilter('#f-opp', 'opp');
  bindFilter('#f-from', 'from');
  bindFilter('#f-to', 'to');

  $('#v-player').addEventListener('click', () => {
    state.view = 'player';
    state.sort = { key: 'date', dir: 'asc' };
    writeUrl();
    render();
  });

  $('#v-team').addEventListener('click', () => {
    state.view = 'team';
    state.sort = { key: 'points', dir: 'desc' };
    writeUrl();
    render();
  });

  $('#m-totals').addEventListener('click', () => {
    state.teamMode = 'totals';
    writeUrl();
    render();
  });

  $('#m-avg').addEventListener('click', () => {
    state.teamMode = 'avg';
    writeUrl();
    render();
  });

  $('#btn-reset').addEventListener('click', () => {
    state.filters = { player: '', ha: '', opp: '', from: '', to: '' };
    populateFilters();
    writeUrl();
    render();
  });

  $('#btn-refresh').addEventListener('click', () => {
    setBanner('Refreshing…');
    load();
  });

  if (CONFIG.formUrl) {
    const btn = $('#btn-log');
    btn.href = CONFIG.formUrl;
    btn.target = '_blank';
    btn.rel = 'noopener';
    btn.hidden = false;
  }

  load();
}

init();
