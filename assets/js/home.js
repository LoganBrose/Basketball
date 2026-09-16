/**
 * Home dashboard: the season at a glance.
 *
 * Deliberately not a debugging surface — if the sheet can't be read, this page
 * says so in one line and points at the stats page's Connection panel rather
 * than reproducing it.
 */

import { CONFIG } from './config.js';
import { loadAll } from './data.js';
import {
  isEnabled, readSession, sessionValid, siteMaxAge, hasAdminSession,
} from './gate.js';
import { summaryFor, seasonRecord, leaders, displayName } from './model.js';

const $ = (s) => document.querySelector(s);

function el(tag, opts = {}, ...children) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text != null) node.textContent = opts.text;
  for (const [k, v] of Object.entries(opts.attrs || {})) if (v != null) node.setAttribute(k, v);
  for (const child of children) if (child) node.append(child);
  return node;
}

const fmtAvg = (n) => (n == null ? '—' : n.toFixed(1));
const fmtPct = (p) => (p == null ? '—' : (p * 100).toFixed(1) + '%');

function tile(key, value, sub, href, lead = false) {
  const inner = el('div', { class: lead ? 'stat lead' : 'stat' });
  inner.append(el('div', { class: 'k', text: key }));
  inner.append(el('div', { class: 'v', text: value }));
  if (sub) inner.append(el('div', { class: 'sub', text: sub }));
  if (!href) return inner;

  const link = el('a', { class: 'stat-link', attrs: { href } });
  link.append(inner);
  return link;
}

/** Skeleton tiles while loading: a real 0 must never look like "not loaded". */
function renderSkeleton() {
  const grid = $('#dash-grid');
  grid.replaceChildren();
  for (let i = 0; i < 7; i++) {
    const s = el('div', { class: 'stat skeleton' });
    s.append(el('div', { class: 'k', text: ' ' }));
    s.append(el('div', { class: 'v', text: ' ' }));
    grid.append(s);
  }
}

function renderError(message) {
  $('#dash-grid').replaceChildren();
  const note = $('#dash-note');
  note.replaceChildren();
  note.append(document.createTextNode(message + ' '));
  note.append(el('a', { text: 'Open the stats page', attrs: { href: 'stats.html#conn-panel' } }));
  note.append(document.createTextNode(' for the exact error.'));
  note.hidden = false;
}

/** The season tiles are stats, so they follow the same rule the stats page does. */
function hasAdmin() {
  return isEnabled(CONFIG.gate) ? hasAdminSession() : true;
}

/**
 * Leave rather than render a reduced version of this page.
 *
 * A locked dashboard would still announce that a dashboard exists. The inline
 * script in <head> normally gets here first; this is the backstop for a session
 * that expired while the tab sat open.
 */
function leave() {
  globalThis.location.replace('playbook.html');
}

async function init() {
  if (!hasAdmin()) {
    leave();
    return;
  }

  renderSkeleton();

  let data;
  try {
    data = await loadAll();
  } catch (err) {
    renderError('The season summary couldn’t be loaded.');
    return;
  }

  const { summaries, games, rows, players, usingSample } = data;

  if (summaries.length === 0) {
    renderError('No games have stats logged yet.');
    return;
  }

  if (usingSample) {
    const note = $('#dash-note');
    note.textContent = 'Showing sample data — the Google Sheet couldn’t be reached.';
    note.hidden = false;
  }

  const summary = summaryFor(summaries);
  const record = seasonRecord(games);

  const grid = $('#dash-grid');
  grid.replaceChildren();

  // Record only exists when both scores are filled in; otherwise the tile is
  // absent rather than showing a meaningless 0–0.
  if (record) {
    const label = record.ties > 0
      ? `${record.wins}–${record.losses}–${record.ties}`
      : `${record.wins}–${record.losses}`;
    const sub = record.unscored > 0
      ? `${record.unscored} unscored`
      : `${record.margin >= 0 ? '+' : ''}${record.margin.toFixed(1)} avg margin`;
    grid.append(tile('Record', label, sub, null, true));
  }

  grid.append(tile('Games', String(summary.gp), null, 'stats.html', true));
  grid.append(tile('PPG', fmtAvg(summary.averages.points), `${summary.totals.points} total`, 'stats.html', true));
  grid.append(tile('RPG', fmtAvg(summary.averages.rebounds), null, 'stats.html'));
  grid.append(tile('APG', fmtAvg(summary.averages.assists), null, 'stats.html'));
  grid.append(tile('FG%', fmtPct(summary.fgPct), `${summary.totals.fgm}/${summary.totals.fga}`, 'stats.html'));
  grid.append(tile('3PT%', fmtPct(summary.tpPct), `${summary.totals.tpm}/${summary.totals.tpa}`, 'stats.html'));
  grid.append(tile('FT%', fmtPct(summary.ftPct), `${summary.totals.ftm}/${summary.totals.fta}`, 'stats.html'));

  // Leaders — linked so the name is a way into that player's numbers.
  const leaderGrid = $('#dash-leaders');
  leaderGrid.replaceChildren();
  for (const [field, label] of [['points', 'Points'], ['rebounds', 'Rebounds'], ['assists', 'Assists']]) {
    const top = leaders(rows, players, field)[0];
    if (!top || top.total === 0) continue;
    leaderGrid.append(tile(
      label,
      displayName(top.player, CONFIG.nameDisplay),
      `${top.total} total`,
      `stats.html?players=${encodeURIComponent(top.playerId)}`,
    ));
  }

  $('#dash').hidden = false;
}

/**
 * The dashboard reads stats, so it cannot run before sign-in has happened.
 *
 * gate.js announces it, but modules execute in document order and gate.js comes
 * first — on a reload with a session already stored it has announced before this
 * module exists. So check the session directly and only wait when there is none.
 */
function start() {
  const gate = CONFIG.gate || {};
  if (!hasAdmin()) { leave(); return; }

  if (isEnabled(gate) && !sessionValid(readSession(), siteMaxAge(gate))) {
    document.addEventListener('bb:signedin', init, { once: true });
    return;
  }
  init();
}

start();
