/**
 * Pure data logic: join the three tabs, dedupe, decide what counts as a game
 * played, run sanity checks, and aggregate.
 *
 * Every function here is side-effect free so the whole rule set is unit-tested
 * without a browser. Nothing is ever silently discarded: anything that cannot
 * be resolved comes back in `issues` for the Connection panel.
 */

/** The 13 stat columns. `Notes` is deliberately not one of them. */
export const STAT_FIELDS = [
  'points', 'rebounds', 'assists', 'steals', 'blocks', 'turnovers',
  'fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta', 'fouls',
];

export const STAT_LABELS = {
  points: 'PTS', rebounds: 'REB', assists: 'AST', steals: 'STL', blocks: 'BLK',
  turnovers: 'TOV', fgm: 'FGM', fga: 'FGA', tpm: '3PM', tpa: '3PA',
  ftm: 'FTM', fta: 'FTA', fouls: 'PF',
};

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

/**
 * Parse a stat cell. Blank means "not entered" (null), which is what separates
 * a did-not-play row from a row of real zeros.
 * @returns {number|null}
 */
export function toNumber(value) {
  const s = String(value == null ? '' : value).trim();
  if (s === '') return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Loose equality for IDs: case-insensitive, and 07 === 7. */
export function idMatches(a, b) {
  const x = String(a == null ? '' : a).trim();
  const y = String(b == null ? '' : b).trim();
  if (x === '' || y === '') return false;
  if (x.toLowerCase() === y.toLowerCase()) return true;
  const nx = Number(x);
  const ny = Number(y);
  return Number.isFinite(nx) && Number.isFinite(ny) && nx === ny;
}

/**
 * Parse M/D/YYYY or YYYY-MM-DD from explicit parts.
 *
 * Built by parts on purpose: `new Date("2025-09-15")` is parsed as UTC midnight
 * and renders as the 14th anywhere west of Greenwich.
 *
 * @returns {{year:number, month:number, day:number, key:string, ms:number}|null}
 */
export function parseSheetDate(value) {
  const s = String(value == null ? '' : value).trim();
  if (s === '') return null;

  let year, month, day;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    year = Number(m[1]);
    month = Number(m[2]);
    day = Number(m[3]);
  } else {
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    month = Number(m[1]);
    day = Number(m[2]);
    year = Number(m[3]);
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;

  const pad = (n) => String(n).padStart(2, '0');
  return { year, month, day, key: `${year}-${pad(month)}-${pad(day)}`, ms: d.getTime() };
}

/** The sheet's dropdown says Home or Away; be forgiving about spelling anyway. */
export function normalizeHomeAway(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  if (s.startsWith('h')) return 'Home';
  if (s.startsWith('a')) return 'Away';
  return '';
}

/* ------------------------------------------------------------------ */
/* Row rules                                                           */
/* ------------------------------------------------------------------ */

/** A row with every stat column blank means the player did not dress. */
export function isDNP(stats) {
  return STAT_FIELDS.every((f) => stats[f] == null);
}

/**
 * Sanity checks. These flag, never drop — a flagged row still counts in totals.
 * @returns {string[]} human-readable rule descriptions
 */
export function sanityCheck(stats) {
  const flags = [];
  const n = (f) => (stats[f] == null ? 0 : stats[f]);

  if (n('fgm') > n('fga')) flags.push('FGM > FGA');
  if (n('tpm') > n('tpa')) flags.push('3PM > 3PA');
  if (n('ftm') > n('fta')) flags.push('FTM > FTA');
  if (n('tpm') > n('fgm')) flags.push('3PM > FGM');

  // Only reconcile points against shooting when some shooting was actually
  // entered; a points-only row has nothing to reconcile against.
  const shootingEntered = stats.fgm != null || stats.tpm != null || stats.ftm != null;
  if (shootingEntered) {
    const expected = 2 * n('fgm') + n('tpm') + n('ftm');
    if (n('points') !== expected) {
      flags.push(`PTS ${n('points')} != 2xFGM + 3PM + FTM (${expected})`);
    }
  }

  return flags;
}

/* ------------------------------------------------------------------ */
/* Dataset                                                             */
/* ------------------------------------------------------------------ */

/**
 * Join StatsLog rows to Players and Games.
 *
 * Dedupe is by (Game ID, Player ID) with the later sheet row winning — adding a
 * corrected row below the original is how a mistake gets fixed.
 */
export function buildDataset({ players = [], games = [], stats = [] } = {}) {
  const issues = {
    superseded: [], unmatchedPlayers: [], unmatchedGames: [],
    sanityFlags: [], invalidDates: [],
  };

  const playerById = new Map();
  for (const p of players) playerById.set(p.playerId, p);

  const gameById = new Map();
  for (const g of games) {
    const date = parseSheetDate(g.date);
    if (g.date && !date) issues.invalidDates.push({ gameId: g.gameId, value: g.date });
    gameById.set(g.gameId, {
      ...g,
      date,
      dateRaw: g.date,
      homeAway: normalizeHomeAway(g.homeAway),
      teamScore: toNumber(g.teamScore),
      oppScore: toNumber(g.oppScore),
      sheetRow: g._sheetRow,
    });
  }

  const resolved = [];
  for (const r of stats) {
    const player = players.find((p) => idMatches(p.playerId, r.player));
    const game = games.find((g) => idMatches(g.gameId, r.game));

    if (!player) {
      issues.unmatchedPlayers.push({ sheetRow: r._sheetRow, value: r.player, detail: `no player matches "${r.player}"` });
    }
    if (!game) {
      issues.unmatchedGames.push({ sheetRow: r._sheetRow, value: r.game, detail: `no game matches "${r.game}"` });
    }
    if (!player || !game) continue;

    const rowStats = {};
    for (const f of STAT_FIELDS) rowStats[f] = toNumber(r[f]);

    resolved.push({
      key: `${game.gameId}::${player.playerId}`,
      gameId: game.gameId,
      playerId: player.playerId,
      statId: r.statId || '',
      stats: rowStats,
      notes: r.notes || '',
      sheetRow: r._sheetRow,
    });
  }

  // Later sheet row wins.
  const winner = new Map();
  for (const row of resolved) {
    const prev = winner.get(row.key);
    if (prev && prev.sheetRow > row.sheetRow) {
      issues.superseded.push({ ...row, supersededBy: prev.sheetRow });
      continue;
    }
    if (prev) issues.superseded.push({ ...prev, supersededBy: row.sheetRow });
    winner.set(row.key, row);
  }

  const rows = [];
  for (const row of winner.values()) {
    const game = gameById.get(row.gameId);
    const player = playerById.get(row.playerId);
    const dnp = isDNP(row.stats);
    const flags = dnp ? [] : sanityCheck(row.stats);

    if (flags.length > 0) {
      issues.sanityFlags.push({
        sheetRow: row.sheetRow,
        player: player?.fullName || row.playerId,
        game: row.gameId,
        flags,
      });
    }

    rows.push({
      ...row, dnp, flags, player, game,
      opponent: game?.opponent || '',
      homeAway: game?.homeAway || '',
      date: game?.date || null,
    });
  }

  return { rows, issues, gameById, playerById };
}

/* ------------------------------------------------------------------ */
/* Games                                                               */
/* ------------------------------------------------------------------ */

/**
 * Newest first; ties broken by the later sheet row; undated games last.
 * Undated games sink rather than sorting as epoch zero, which would bury them
 * under every real game and look like a bug.
 */
export function compareGames(a, b) {
  const ad = a.date?.ms ?? null;
  const bd = b.date?.ms ?? null;
  if (ad == null && bd == null) return (b.sheetRow ?? 0) - (a.sheetRow ?? 0);
  if (ad == null) return 1;
  if (bd == null) return -1;
  if (bd !== ad) return bd - ad;
  return (b.sheetRow ?? 0) - (a.sheetRow ?? 0);
}

/**
 * One entry per game that has stat rows, carrying its rows and who actually
 * played. A game on the schedule with nothing logged doesn't appear — an empty
 * box score is never something you meant to open.
 */
export function gameSummaries(rows, games) {
  const byGame = new Map();
  for (const row of rows) {
    if (!byGame.has(row.gameId)) byGame.set(row.gameId, []);
    byGame.get(row.gameId).push(row);
  }

  const summaries = [];
  for (const [gameId, gameRows] of byGame) {
    const game = games.find((g) => g.gameId === gameId);
    const played = new Set(gameRows.filter((r) => !r.dnp).map((r) => r.playerId));

    summaries.push({
      gameId,
      game,
      date: gameRows[0].date,
      sheetRow: game?.sheetRow ?? 0,
      opponent: gameRows[0].opponent,
      homeAway: gameRows[0].homeAway,
      rows: gameRows,
      played,
      teamPoints: gameRows.reduce((sum, r) => sum + (r.stats.points ?? 0), 0),
    });
  }

  return summaries.sort(compareGames);
}

/**
 * Narrow games to those involving the selected players.
 *
 * `all`  — every selected player played
 * `any`  — at least one selected player played
 *
 * A DNP row is not playing, which is the whole reason `played` excludes them.
 * No selection means no narrowing.
 */
export function gamesForPlayers(summaries, playerIds, mode = 'all') {
  if (!playerIds || playerIds.length === 0) return summaries;
  return summaries.filter((s) => (mode === 'any'
    ? playerIds.some((id) => s.played.has(id))
    : playerIds.every((id) => s.played.has(id))));
}

/**
 * Totals and per-game averages across the games shown.
 *
 * Averages divide by **distinct games**, never by player rows: three players
 * across nine games is 27 rows, and dividing by 27 would understate every
 * average threefold. A game whose only rows are DNPs is listed but doesn't
 * count as played.
 */
export function summaryFor(summaries, playerIds = []) {
  const selected = playerIds && playerIds.length > 0 ? new Set(playerIds) : null;

  const totals = {};
  for (const f of STAT_FIELDS) totals[f] = 0;

  let gp = 0;
  let rowCount = 0;

  for (const s of summaries) {
    const rows = selected ? s.rows.filter((r) => selected.has(r.playerId)) : s.rows;
    if (rows.some((r) => !r.dnp)) gp++;
    for (const r of rows) {
      rowCount++;
      for (const f of STAT_FIELDS) totals[f] += r.stats[f] ?? 0;
    }
  }

  const averages = {};
  for (const f of STAT_FIELDS) averages[f] = gp > 0 ? totals[f] / gp : null;

  return {
    gp,
    games: summaries.length,
    rowCount,
    totals,
    averages,
    // From summed makes over summed attempts — never an average of percentages.
    fgPct: pct(totals.fgm, totals.fga),
    tpPct: pct(totals.tpm, totals.tpa),
    ftPct: pct(totals.ftm, totals.fta),
  };
}

/** Points scored by the selected players in one game. */
export function selectedPoints(summary, playerIds = []) {
  if (!playerIds || playerIds.length === 0) return null;
  const selected = new Set(playerIds);
  return summary.rows
    .filter((r) => selected.has(r.playerId))
    .reduce((sum, r) => sum + (r.stats.points ?? 0), 0);
}

/* ------------------------------------------------------------------ */
/* Season record                                                       */
/* ------------------------------------------------------------------ */

/**
 * Wins, losses and average margin, from games where **both** scores are filled
 * in — including games with no stat rows, since a result is a result whether or
 * not anyone logged a box score.
 *
 * Returns null when no game has both, so the dashboard can omit the tile rather
 * than show a meaningless 0–0.
 */
export function seasonRecord(games) {
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let scored = 0;
  let marginTotal = 0;

  for (const g of games) {
    const us = toNumber(g.teamScore);
    const them = toNumber(g.oppScore);
    if (us == null || them == null) continue;
    scored++;
    marginTotal += us - them;
    if (us > them) wins++;
    else if (us < them) losses++;
    else ties++;
  }

  if (scored === 0) return null;

  return {
    wins, losses, ties, scored,
    unscored: games.length - scored,
    margin: marginTotal / scored,
  };
}

/**
 * Games where the recorded Team Score doesn't equal the points logged in
 * StatsLog. Neither number is changed — one of them is wrong and only the coach
 * knows which.
 */
export function scoreMismatches(summaries) {
  const out = [];
  for (const s of summaries) {
    const recorded = toNumber(s.game?.teamScore);
    if (recorded == null) continue;
    if (recorded !== s.teamPoints) {
      out.push({ gameId: s.gameId, opponent: s.opponent, recorded, logged: s.teamPoints });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Aggregation helpers                                                 */
/* ------------------------------------------------------------------ */

/** Totals for an arbitrary set of rows, counting games played as non-DNP rows. */
export function aggregate(rows) {
  const totals = {};
  for (const f of STAT_FIELDS) totals[f] = 0;

  let gp = 0;
  for (const row of rows) {
    if (!row.dnp) gp++;
    for (const f of STAT_FIELDS) totals[f] += row.stats[f] ?? 0;
  }

  const averages = {};
  for (const f of STAT_FIELDS) averages[f] = gp > 0 ? totals[f] / gp : null;

  return {
    gp, games: rows.length, totals, averages,
    fgPct: pct(totals.fgm, totals.fga),
    tpPct: pct(totals.tpm, totals.tpa),
    ftPct: pct(totals.ftm, totals.fta),
  };
}

/** Null on zero attempts — a blank is honest where 0.0% is not. */
export function pct(made, attempted) {
  if (!attempted || attempted <= 0) return null;
  return made / attempted;
}

/** Season leaders by total, for the dashboard. */
export function leaders(rows, players, field = 'points') {
  const byPlayer = new Map();
  for (const row of rows) {
    byPlayer.set(row.playerId, (byPlayer.get(row.playerId) ?? 0) + (row.stats[field] ?? 0));
  }
  return [...byPlayer.entries()]
    .map(([playerId, total]) => ({ playerId, total, player: players.find((p) => p.playerId === playerId) }))
    .sort((a, b) => b.total - a.total);
}

/* ------------------------------------------------------------------ */
/* Display                                                             */
/* ------------------------------------------------------------------ */

/**
 * Render a player's name under the configured privacy mode. A GitHub Pages site
 * is readable by anyone with the link, so this is the lever for keeping minors'
 * names off a public page.
 */
export function displayName(player, mode = 'full') {
  if (!player) return '—';
  const full = player.fullName || player.playerId || '—';

  if (mode === 'jersey') return player.jersey ? `#${player.jersey}` : initials(full);
  if (mode === 'initials') return initials(full);
  return full;
}

/** A short form for tight spaces: "John S." */
export function shortName(player, mode = 'full') {
  if (!player) return '—';
  if (mode !== 'full') return displayName(player, mode);
  const parts = String(player.fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return displayName(player, mode);
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

function initials(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  return parts.map((p) => p[0].toUpperCase() + '.').join('');
}
