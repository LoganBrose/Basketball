/**
 * Pure data logic: resolve Form dropdown tokens, dedupe resubmissions, decide
 * what counts as a game played, run sanity checks, and aggregate.
 *
 * Every function here is side-effect free so the whole rule set is unit-tested
 * without a browser. Nothing is ever silently discarded: anything that cannot
 * be resolved comes back in `issues` for the connection panel.
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

/**
 * Take the ID token from a Form dropdown label such as "12 - John Smith" or
 * "G05 - vs Central (9/15)".
 *
 * Google Forms, a paste from a doc and a hand-typed option produce different
 * dashes, so en dash, em dash and hyphen are all accepted. A value with no
 * separator is treated as a bare ID, which keeps typed-ID sheets working.
 */
export function parseIdToken(text) {
  const s = String(text == null ? '' : text).trim();
  if (s === '') return '';
  const m = s.match(/^(.*?)\s+[–—-]\s+/);
  return (m ? m[1] : s).trim();
}

/** Loose equality for IDs and jerseys: case-insensitive, and 07 === 7. */
function tokenMatches(a, b) {
  const x = String(a == null ? '' : a).trim();
  const y = String(b == null ? '' : b).trim();
  if (x === '' || y === '') return false;
  if (x.toLowerCase() === y.toLowerCase()) return true;
  const nx = Number(x);
  const ny = Number(y);
  return Number.isFinite(nx) && Number.isFinite(ny) && nx === ny;
}

/**
 * Resolve a player token against the roster: Player ID first, then jersey.
 *
 * A token that matches one player's ID *and a different player's jersey* is
 * reported rather than resolved — precedence would silently pick one of two
 * real people, and the coach is the only one who can say which was meant.
 *
 * @returns {{playerId: string|null, matchedBy: 'id'|'jersey'|null, issue: string|null}}
 */
export function resolvePlayerToken(token, players) {
  const t = String(token == null ? '' : token).trim();
  if (t === '') return { playerId: null, matchedBy: null, issue: 'blank player' };

  const byId = players.filter((p) => tokenMatches(p.playerId, t));
  const byJersey = players.filter((p) => tokenMatches(p.jersey, t));

  if (byId.length > 1) {
    return {
      playerId: null,
      matchedBy: null,
      issue: `"${t}" matches ${byId.length} rows in Players — Player IDs must be unique`,
    };
  }

  if (byId.length === 1) {
    const conflicting = byJersey.filter((p) => p.playerId !== byId[0].playerId);
    if (conflicting.length > 0) {
      const names = conflicting.map((p) => p.fullName || p.playerId).join(', ');
      const self = byId[0].fullName || byId[0].playerId;
      return {
        playerId: null,
        matchedBy: null,
        issue: `"${t}" is ${self}'s Player ID but also ${names}'s jersey number — rename one so the dropdown is unambiguous`,
      };
    }
    return { playerId: byId[0].playerId, matchedBy: 'id', issue: null };
  }

  if (byJersey.length === 1) {
    return { playerId: byJersey[0].playerId, matchedBy: 'jersey', issue: null };
  }

  if (byJersey.length > 1) {
    const names = byJersey.map((p) => p.fullName || p.playerId).join(', ');
    return { playerId: null, matchedBy: null, issue: `jersey "${t}" is worn by ${names}` };
  }

  return { playerId: null, matchedBy: null, issue: `no player matches "${t}"` };
}

/** Resolve a game token against the schedule. */
export function resolveGameToken(token, games) {
  const t = String(token == null ? '' : token).trim();
  if (t === '') return { gameId: null, issue: 'blank game' };
  const matches = games.filter((g) => tokenMatches(g.gameId, t));
  if (matches.length === 1) return { gameId: matches[0].gameId, issue: null };
  if (matches.length > 1) {
    return { gameId: null, issue: `"${t}" matches ${matches.length} rows in Games — Game IDs must be unique` };
  }
  return { gameId: null, issue: `no game matches "${t}"` };
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
 * Join the three tabs into game rows.
 *
 * Dedupe is by (Game ID, Player ID) with the later sheet row winning.
 * `Timestamp` is never parsed: Form responses append in submission order, so
 * row position already carries it, without depending on the sheet's locale.
 */
export function buildDataset({ players = [], games = [], responses = [] } = {}) {
  const issues = {
    superseded: [], unmatchedPlayers: [], unmatchedGames: [],
    ambiguousTokens: [], sanityFlags: [], invalidDates: [],
  };

  const playerById = new Map();
  for (const p of players) playerById.set(p.playerId, p);

  const gameById = new Map();
  for (const g of games) {
    const date = parseSheetDate(g.date);
    if (g.date && !date) issues.invalidDates.push({ gameId: g.gameId, value: g.date });
    gameById.set(g.gameId, { ...g, date, dateRaw: g.date });
  }

  // Resolve tokens first; unresolvable rows are reported, not carried forward.
  const resolved = [];
  for (const r of responses) {
    const p = resolvePlayerToken(parseIdToken(r.player), players);
    const g = resolveGameToken(parseIdToken(r.game), games);

    if (p.issue) {
      const ambiguous = /also|worn by|must be unique/.test(p.issue);
      (ambiguous ? issues.ambiguousTokens : issues.unmatchedPlayers).push({
        sheetRow: r._sheetRow, value: r.player, detail: p.issue,
      });
    }
    if (g.issue) {
      const ambiguous = /must be unique/.test(g.issue);
      (ambiguous ? issues.ambiguousTokens : issues.unmatchedGames).push({
        sheetRow: r._sheetRow, value: r.game, detail: g.issue,
      });
    }
    if (!p.playerId || !g.gameId) continue;

    const stats = {};
    for (const f of STAT_FIELDS) stats[f] = toNumber(r[f]);

    resolved.push({
      key: `${g.gameId}::${p.playerId}`,
      gameId: g.gameId,
      playerId: p.playerId,
      stats,
      notes: r.notes || '',
      sheetRow: r._sheetRow,
    });
  }

  // Later sheet row wins. Resubmitting the Form is how a coach fixes a mistake.
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
      ...row,
      dnp,
      flags,
      player,
      game,
      opponent: game?.opponent || '',
      homeAway: normalizeHomeAway(game?.homeAway),
      date: game?.date || null,
    });
  }

  rows.sort((a, b) => (a.date?.ms ?? 0) - (b.date?.ms ?? 0) || a.gameId.localeCompare(b.gameId));
  return { rows, issues };
}

/** The sheet's dropdown says Home or Away; be forgiving about spelling anyway. */
export function normalizeHomeAway(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  if (s.startsWith('h')) return 'Home';
  if (s.startsWith('a')) return 'Away';
  return '';
}

/* ------------------------------------------------------------------ */
/* Aggregation                                                         */
/* ------------------------------------------------------------------ */

/**
 * Totals, percentages, games played and per-game averages.
 * Averages divide by games played, so a DNP never drags an average down.
 */
export function aggregate(rows) {
  const totals = {};
  for (const f of STAT_FIELDS) totals[f] = 0;

  let gp = 0;
  for (const row of rows) {
    if (!row.dnp) gp++;
    for (const f of STAT_FIELDS) totals[f] += row.stats[f] == null ? 0 : row.stats[f];
  }

  const averages = {};
  for (const f of STAT_FIELDS) averages[f] = gp > 0 ? totals[f] / gp : null;

  return {
    gp,
    games: rows.length,
    totals,
    averages,
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

function initials(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  return parts.map((p) => p[0].toUpperCase() + '.').join('');
}
