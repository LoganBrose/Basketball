/**
 * One place that loads the sheet, so the home page, the stats page and the
 * playbook's lineup selector all read the same data the same way — and share
 * one cache rather than three.
 */

import { CONFIG } from './config.js';
import { SCHEMAS, endpointsFor, loadTab, discoverGids } from './sheets.js';
import { normalizeHeader } from './csv.js';
import { buildDataset, gameSummaries, scoreMismatches } from './model.js';

/**
 * Fetch all three tabs, join them, and return everything the pages need —
 * including enough detail for the Connection panel to explain itself.
 *
 * @returns {Promise<{players, games, rows, issues, summaries, mismatches,
 *                    meta, discovery, usingSample, stale, banner}>}
 */
export async function loadAll() {
  const { sheet } = CONFIG;

  // With only a publish key configured, read the gids off the published page
  // rather than making anyone look them up by hand.
  const needsDiscovery = !sheet.fileId && Object.values(sheet.tabs).every((t) => !t.gid);
  const discovery = needsDiscovery && sheet.pubKey
    ? await discoverGids(sheet.pubKey)
    : { gids: {}, error: null, skipped: true };

  const gidFor = (tab) => tab.gid || discovery.gids[normalizeHeader(tab.name)] || '';

  const wanted = [
    ['statslog', SCHEMAS.statslog, sheet.tabs.statslog, CONFIG.sample.statslog],
    ['players', SCHEMAS.players, sheet.tabs.players, CONFIG.sample.players],
    ['games', SCHEMAS.games, sheet.tabs.games, CONFIG.sample.games],
  ];

  const results = await Promise.all(wanted.map(([name, schema, tab, sampleUrl]) =>
    loadTab({ name, schema, endpoints: endpointsFor(sheet, tab.name, gidFor(tab)), sampleUrl })));

  const [statslog, players, games] = results;

  const meta = {
    StatsLog: { ...statslog, tab: sheet.tabs.statslog, schema: SCHEMAS.statslog },
    Players: { ...players, tab: sheet.tabs.players, schema: SCHEMAS.players },
    Games: { ...games, tab: sheet.tabs.games, schema: SCHEMAS.games },
  };

  const { rows, issues, gameById } = buildDataset({
    players: players.records,
    games: games.records,
    stats: statslog.records,
  });

  const gameList = [...gameById.values()];
  const summaries = gameSummaries(rows, gameList);

  const usingSample = results.some((r) => r.strategy === 'bundled sample data');
  const stale = results.some((r) => r.stale);

  return {
    players: players.records,
    games: gameList,
    rows,
    issues,
    summaries,
    mismatches: scoreMismatches(summaries),
    meta,
    discovery,
    usingSample,
    stale,
    banner: bannerFor({ results, discovery, usingSample, stale, sheet }),
  };
}

/**
 * Everything wrong with a load, split by how urgent it is.
 *
 * `blocking` means the numbers on screen aren't your sheet's — the page has to
 * say so. `quality` means they are your sheet's, but something in the data
 * looks off. When both are empty the Connection panel has nothing to tell you
 * and stays out of the way.
 *
 * @returns {{blocking: string[], quality: number}}
 */
export function sheetProblems(data) {
  const { meta = {}, issues = {}, mismatches = [], usingSample, stale } = data || {};

  const blocking = [];
  if (usingSample) blocking.push('showing sample data');
  if (stale) blocking.push('showing a cached copy');
  for (const [name, m] of Object.entries(meta)) {
    if (m.error) blocking.push(`${name}: ${m.error}`);
    else if (m.missing?.length) blocking.push(`${name}: missing ${m.missing.length} column${m.missing.length > 1 ? 's' : ''}`);
  }

  const counts = [
    issues.superseded, issues.unmatchedGames, issues.unmatchedPlayers,
    issues.invalidDates, issues.sanityFlags, mismatches,
  ];
  const quality = counts.reduce((sum, list) => sum + (list?.length ?? 0), 0);

  return { blocking, quality };
}

/**
 * "Not configured" and "configured but unreachable" need different fixes, so
 * don't tell someone to fill in config they've already filled in.
 */
function bannerFor({ discovery, usingSample, stale, sheet }) {
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
