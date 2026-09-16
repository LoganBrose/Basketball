/**
 * One place that loads the sheet, so the home page, the stats page and the
 * playbook's lineup selector all read the same data the same way — and share
 * one cache rather than three.
 *
 * Two sources, chosen by whether sign-in is configured:
 *
 *   gate.url set    Apps Script. The sheet is not published; the script hands
 *                   over tabs only against a token it signed.
 *   gate.url empty  the published CSV, exactly as before.
 *
 * Both end in the same parseRows(), so the two paths cannot disagree about what
 * a header row is or which rows count.
 */

import { CONFIG } from './config.js';
import {
  SCHEMAS, endpointsFor, loadTab, discoverGids, parseRows, dropCached,
} from './sheets.js';
import { normalizeHeader } from './csv.js';
import { buildDataset, gameSummaries, scoreMismatches } from './model.js';
import {
  isEnabled, readSession, readAdminSession, sessionValid,
  siteMaxAge, adminMaxAge, callScript,
} from './gate.js';

/** Canonical name -> the tab name the script and the sheet both use. */
const TAB_NAMES = { statslog: 'StatsLog', players: 'Players', games: 'Games' };
const ALL_TABS = ['statslog', 'players', 'games'];

/** Which tabs must never outlive a sign-out on a shared device. */
const SENSITIVE = new Set(['statslog', 'games']);

/**
 * Fetch the tabs a page needs, join them, and return enough detail for the
 * Connection panel to explain itself.
 *
 * @param {{tabs?: string[]}} [opts] which tabs to load. The playbook asks for
 *   the roster alone — requesting StatsLog with only a site token would be
 *   refused, and would look like a broken sheet rather than a page asking for
 *   something it has no business seeing.
 */
export async function loadAll({ tabs = ALL_TABS } = {}) {
  const wanted = ALL_TABS.filter((t) => tabs.includes(t));
  return isEnabled(CONFIG.gate)
    ? loadViaScript(wanted)
    : loadViaCsv(wanted);
}

/** Anything not asked for still has to have a shape the pages can read. */
function emptyTab(schema) {
  return {
    records: [], headerRow: -1, headers: [], matched: {}, missing: [],
    unknownColumns: [], skipped: 0, error: null,
    strategy: null, url: null, status: null, attempts: [], fetchedAt: null,
    stale: false, skippedLoad: true,
  };
}

/* ------------------------------------------------------------------ */
/* Apps Script                                                         */
/* ------------------------------------------------------------------ */

/** The strongest token this browser holds. Admin implies site. */
function currentToken() {
  const gate = CONFIG.gate || {};
  const admin = readAdminSession();
  if (sessionValid(admin, adminMaxAge(gate))) return { token: admin.token, role: 'admin' };

  const site = readSession();
  if (sessionValid(site, siteMaxAge(gate))) return { token: site.token, role: 'site' };

  return { token: '', role: 'none' };
}

async function loadViaScript(wanted) {
  const gate = CONFIG.gate || {};
  const { token, role } = currentToken();
  const names = wanted.map((t) => TAB_NAMES[t]);

  const result = token
    ? await callScript(gate.url, { action: 'data', token, tabs: names })
    : { ok: true, data: { ok: false, reason: 'auth' }, error: null };

  const fetchedAt = new Date().toISOString();
  const byTab = {};

  // One error for the whole request: the script answers all-or-nothing, because
  // a partial answer would render an empty season as though it were a real one.
  let error = null;
  let auth = false;

  if (!result.ok) {
    error = result.error || 'Could not reach the sign-in script.';
  } else if (!result.data?.ok) {
    auth = result.data?.reason === 'auth';
    error = auth
      ? (role === 'none'
        ? 'Sign in to load this.'
        : 'This needs the admin password.')
      : 'The script refused the request.';
  }

  for (const name of wanted) {
    const schema = SCHEMAS[name];
    const rows = result.ok && result.data?.ok ? result.data.tabs?.[TAB_NAMES[name]] : null;

    byTab[name] = Array.isArray(rows)
      ? {
        ...parseRows(rows, schema),
        strategy: 'Apps Script', url: null, status: null, attempts: [],
        fetchedAt, stale: false, auth: false,
      }
      : {
        records: [], headerRow: -1, headers: [], matched: {},
        missing: error ? [] : schema.required.slice(),
        unknownColumns: [], skipped: 0,
        error: error || `The script returned no "${TAB_NAMES[name]}" tab.`,
        strategy: 'Apps Script', url: null, status: null, attempts: [],
        fetchedAt: null, stale: false, auth,
      };
  }

  // A shared laptop must not keep the numbers after someone signs out, so the
  // sensitive tabs are never written to storage under this source. The roster
  // is names the team already knows.
  for (const name of wanted) {
    if (SENSITIVE.has(name)) dropCached(TAB_NAMES[name]);
  }

  return assemble(wanted, byTab, {
    discovery: { gids: {}, error: null, skipped: true },
    source: 'apps-script',
    auth,
    banner: bannerForScript({ error, auth, role }),
  });
}

/** Signing out of admin must take the numbers with it, cache included. */
export function forgetSensitiveCache() {
  for (const name of SENSITIVE) dropCached(TAB_NAMES[name]);
}

function bannerForScript({ error, auth, role }) {
  if (!error) return '';
  if (auth) {
    return role === 'none'
      ? 'Sign in to load the season.'
      : 'These numbers need the admin password.';
  }
  return `Couldn't load the season — ${error}`;
}

/* ------------------------------------------------------------------ */
/* Published CSV (unchanged behaviour)                                 */
/* ------------------------------------------------------------------ */

async function loadViaCsv(wanted) {
  const { sheet } = CONFIG;

  // With only a publish key configured, read the gids off the published page
  // rather than making anyone look them up by hand.
  const needsDiscovery = !sheet.fileId && Object.values(sheet.tabs).every((t) => !t.gid);
  const discovery = needsDiscovery && sheet.pubKey
    ? await discoverGids(sheet.pubKey)
    : { gids: {}, error: null, skipped: true };

  const gidFor = (tab) => tab.gid || discovery.gids[normalizeHeader(tab.name)] || '';

  const results = await Promise.all(wanted.map((name) => loadTab({
    name,
    schema: SCHEMAS[name],
    endpoints: endpointsFor(sheet, sheet.tabs[name].name, gidFor(sheet.tabs[name])),
    sampleUrl: CONFIG.sample[name],
  })));

  const byTab = {};
  wanted.forEach((name, i) => { byTab[name] = results[i]; });

  const usingSample = results.some((r) => r.strategy === 'bundled sample data');
  const stale = results.some((r) => r.stale);

  return assemble(wanted, byTab, {
    discovery,
    source: 'csv',
    auth: false,
    banner: bannerForCsv({ discovery, usingSample, stale, sheet }),
  });
}

/**
 * "Not configured" and "configured but unreachable" need different fixes, so
 * don't tell someone to fill in config they've already filled in.
 */
function bannerForCsv({ discovery, usingSample, stale, sheet }) {
  if (usingSample) {
    if (discovery?.error) return `Showing sample data — ${discovery.error}`;
    const configured = Boolean(sheet.fileId) || Object.values(sheet.tabs).some((t) => t.gid);
    return configured
      ? 'Showing sample data — the Google Sheet couldn\'t be reached. Open Connection below for the exact error: usually the sheet needs "Anyone with the link" access, or the tabs need publishing.'
      : 'Showing sample data — the Google Sheet isn\'t configured yet. Add your fileId or tab gids in assets/js/config.js. See the README.';
  }
  if (stale) {
    return 'Showing the last saved copy — the sheet couldn\'t be reached just now. Open Connection below for the exact error.';
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* Shared assembly                                                     */
/* ------------------------------------------------------------------ */

function assemble(wanted, byTab, { discovery, source, auth, banner }) {
  const statslog = byTab.statslog || emptyTab(SCHEMAS.statslog);
  const players = byTab.players || emptyTab(SCHEMAS.players);
  const games = byTab.games || emptyTab(SCHEMAS.games);

  const meta = {};
  if (wanted.includes('statslog')) meta.StatsLog = { ...statslog, tab: CONFIG.sheet.tabs.statslog, schema: SCHEMAS.statslog };
  if (wanted.includes('players')) meta.Players = { ...players, tab: CONFIG.sheet.tabs.players, schema: SCHEMAS.players };
  if (wanted.includes('games')) meta.Games = { ...games, tab: CONFIG.sheet.tabs.games, schema: SCHEMAS.games };

  const { rows, issues, gameById } = buildDataset({
    players: players.records,
    games: games.records,
    stats: statslog.records,
  });

  const gameList = [...gameById.values()];
  const summaries = gameSummaries(rows, gameList);

  const results = wanted.map((n) => byTab[n]);

  return {
    players: players.records,
    games: gameList,
    rows,
    issues,
    summaries,
    mismatches: scoreMismatches(summaries),
    meta,
    discovery,
    source,
    auth,
    usingSample: results.some((r) => r.strategy === 'bundled sample data'),
    stale: results.some((r) => r.stale),
    banner,
  };
}

/**
 * Everything wrong with a load, split by how urgent it is.
 *
 * `blocking` means the numbers on screen aren't your sheet's — the page has to
 * say so. `auth` is kept apart from it: "you need the admin password" is not a
 * broken sheet, and reporting it as a missing column would send you hunting
 * through a spreadsheet that is perfectly fine. `quality` means the numbers are
 * yours, but something in them looks off.
 *
 * @returns {{blocking: string[], auth: string[], quality: number}}
 */
export function sheetProblems(data) {
  const { meta = {}, issues = {}, mismatches = [], usingSample, stale } = data || {};

  const blocking = [];
  const auth = [];

  if (usingSample) blocking.push('showing sample data');
  if (stale) blocking.push('showing a cached copy');

  for (const [name, m] of Object.entries(meta)) {
    if (m.skippedLoad) continue;
    if (m.auth) auth.push(`${name}: ${m.error}`);
    else if (m.error) blocking.push(`${name}: ${m.error}`);
    else if (m.missing?.length) blocking.push(`${name}: missing ${m.missing.length} column${m.missing.length > 1 ? 's' : ''}`);
  }

  const counts = [
    issues.superseded, issues.unmatchedGames, issues.unmatchedPlayers,
    issues.invalidDates, issues.sanityFlags, mismatches,
  ];
  const quality = counts.reduce((sum, list) => sum + (list?.length ?? 0), 0);

  return { blocking, auth, quality };
}
