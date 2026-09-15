/**
 * Sheet access: schemas, header-row detection, and the two fetch strategies.
 *
 * Nothing here knows about basketball. It turns a published Google tab into
 * records with canonical field names, and reports what it could not make sense
 * of instead of quietly discarding it.
 */

import { parseCSV, normalizeHeader } from './csv.js';

/**
 * Canonical field -> accepted header spellings (already normalized).
 *
 * `key` is the header the scan looks for to locate the real header row. It is
 * declared per tab and matched exactly, so `Player ID` on the Players tab never
 * satisfies the Form tab's `Player` key.
 */
export const SCHEMAS = {
  players: {
    key: 'player id',
    fields: {
      playerId: ['player id'],
      fullName: ['full name', 'name', 'player name'],
      jersey: ['jersey number', 'jersey', 'number', '#'],
      position: ['position', 'pos'],
    },
  },
  games: {
    key: 'game id',
    fields: {
      gameId: ['game id'],
      date: ['date'],
      opponent: ['opponent', 'opp'],
      homeAway: ['home/away', 'h/a', 'home away', 'homeaway'],
    },
  },
  responses: {
    key: 'player',
    fields: {
      timestamp: ['timestamp'],
      player: ['player', 'player id'],
      game: ['game', 'game id'],
      points: ['points', 'pts'],
      rebounds: ['rebounds', 'reb', 'rebs'],
      assists: ['assists', 'ast'],
      steals: ['steals', 'stl'],
      blocks: ['blocks', 'blk'],
      turnovers: ['turnovers', 'tov', 'to'],
      fgm: ['fgm'],
      fga: ['fga'],
      tpm: ['3pm', '3ptm'],
      tpa: ['3pa', '3pta'],
      ftm: ['ftm'],
      fta: ['fta'],
      fouls: ['fouls', 'pf'],
      notes: ['notes', 'note'],
    },
  },
};

/**
 * Find the index of the real header row.
 *
 * Tabs carry a title line, one or more legend lines and a blank row above the
 * header, and editing a legend line shifts that offset — so the row is located
 * by content, never by a fixed number.
 *
 * @param {string[][]} rows
 * @param {string} keyHeader normalized key header for this tab
 * @returns {number} row index, or -1 if not found
 */
export function findHeaderRow(rows, keyHeader) {
  const want = normalizeHeader(keyHeader);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].some((cell) => normalizeHeader(cell) === want)) return i;
  }
  return -1;
}

/**
 * True for rows that are structurally not data: a blank key, or an example row.
 *
 * Example rows are identified by an `EX`-prefixed ID rather than by their
 * contents, so a real player never disappears for resembling the sample.
 *
 * @param {string} keyValue
 * @returns {boolean}
 */
export function isSkippableKey(keyValue) {
  const v = String(keyValue == null ? '' : keyValue).trim();
  if (v === '') return true;
  return /^ex/i.test(v);
}

/**
 * Parse one tab's CSV into canonical records.
 *
 * @param {string} csvText
 * @param {{key: string, fields: Object<string,string[]>}} schema
 * @returns {{records: Object[], headerRow: number, headers: string[],
 *            unknownColumns: string[], skipped: number, error: string|null}}
 */
export function parseTab(csvText, schema) {
  const rows = parseCSV(csvText);
  const headerRow = findHeaderRow(rows, schema.key);

  if (headerRow === -1) {
    return {
      records: [],
      headerRow: -1,
      headers: [],
      unknownColumns: [],
      skipped: 0,
      error: `No header row found — expected a column named "${schema.key}".`,
    };
  }

  const headers = rows[headerRow].map(normalizeHeader);

  // Map each canonical field to the first column whose header matches one of
  // its accepted spellings.
  const columnOf = {};
  for (const [field, aliases] of Object.entries(schema.fields)) {
    const idx = headers.findIndex((h) => h !== '' && aliases.includes(h));
    if (idx !== -1) columnOf[field] = idx;
  }

  const claimed = new Set(Object.values(columnOf));
  const unknownColumns = headers
    .map((h, i) => (h !== '' && !claimed.has(i) ? rows[headerRow][i] : null))
    .filter((h) => h !== null);

  const keyColumn = headers.findIndex((h) => h === normalizeHeader(schema.key));
  const records = [];
  let skipped = 0;

  for (let i = headerRow + 1; i < rows.length; i++) {
    const row = rows[i];
    if (isSkippableKey(row[keyColumn])) {
      // A wholly blank row is padding, not a rejected record.
      if (row.some((c) => String(c).trim() !== '')) skipped++;
      continue;
    }

    const record = { _sheetRow: i + 1 };
    for (const [field, idx] of Object.entries(columnOf)) {
      record[field] = row[idx] == null ? '' : String(row[idx]).trim();
    }
    records.push(record);
  }

  return { records, headerRow, headers, unknownColumns, skipped, error: null };
}

/* ------------------------------------------------------------------ */
/* Endpoints                                                           */
/* ------------------------------------------------------------------ */

/**
 * gviz export, addressed by tab name. `headers=0` stops Google from folding the
 * title and legend rows into a header of its own — the scan above finds the
 * real one.
 */
export function gvizUrl(fileId, tabName) {
  return (
    `https://docs.google.com/spreadsheets/d/${encodeURIComponent(fileId)}` +
    `/gviz/tq?tqx=out:csv&headers=0&sheet=${encodeURIComponent(tabName)}`
  );
}

/** Published-to-web CSV export, addressed by GID. */
export function pubCsvUrl(pubKey, gid) {
  return (
    `https://docs.google.com/spreadsheets/d/e/${encodeURIComponent(pubKey)}` +
    `/pub?gid=${encodeURIComponent(gid)}&single=true&output=csv`
  );
}

/**
 * Build the ordered list of URLs to try for one tab.
 * gviz comes first: it addresses tabs by name, so it survives a tab being
 * moved or re-created, which changes a GID.
 *
 * @returns {{url: string, strategy: string}[]}
 */
export function endpointsFor(sheetConfig, tabName, gid) {
  const out = [];
  if (sheetConfig.fileId) {
    out.push({ url: gvizUrl(sheetConfig.fileId, tabName), strategy: 'gviz (by tab name)' });
  }
  if (sheetConfig.pubKey && gid !== '' && gid != null) {
    out.push({ url: pubCsvUrl(sheetConfig.pubKey, gid), strategy: 'published CSV (by gid)' });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Fetching (browser only)                                             */
/* ------------------------------------------------------------------ */

const CACHE_PREFIX = 'bb.sheet.';

/** localStorage can throw (private mode, blocked cookies); never let it break a render. */
function cacheGet(name) {
  try {
    const raw = globalThis.localStorage?.getItem(CACHE_PREFIX + name);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function cacheSet(name, payload) {
  try {
    globalThis.localStorage?.setItem(CACHE_PREFIX + name, JSON.stringify(payload));
  } catch {
    /* quota or blocked storage — the page still works, it just won't warm-start */
  }
}

/**
 * Fetch one tab, trying each configured endpoint in order.
 * Returns the CSV text plus which strategy produced it, or every failure.
 *
 * @returns {Promise<{text: string|null, strategy: string|null, attempts: {url:string,strategy:string,error:string}[]}>}
 */
export async function fetchTabText(endpoints) {
  const attempts = [];
  for (const ep of endpoints) {
    try {
      // Cache-bust so a phone doesn't sit on a stale copy after a resubmission.
      const url = ep.url + (ep.url.includes('?') ? '&' : '?') + '_=' + Date.now();
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) {
        attempts.push({ url: ep.url, strategy: ep.strategy, error: `HTTP ${res.status} ${res.statusText}` });
        continue;
      }
      const text = await res.text();
      // A sheet that isn't published returns an HTML sign-in page with HTTP 200.
      if (/^\s*<(?:!doctype|html)/i.test(text)) {
        attempts.push({
          url: ep.url,
          strategy: ep.strategy,
          error: 'Got an HTML page instead of CSV — the tab is probably not published to the web.',
        });
        continue;
      }
      return { text, strategy: ep.strategy, attempts };
    } catch (err) {
      attempts.push({ url: ep.url, strategy: ep.strategy, error: String(err && err.message ? err.message : err) });
    }
  }
  return { text: null, strategy: null, attempts };
}

/**
 * Load one tab: cached copy first (so the page paints immediately), then the
 * network. Falls back to the bundled sample CSV when nothing is configured.
 */
export async function loadTab({ name, schema, endpoints, sampleUrl }) {
  const cached = cacheGet(name);

  let result;
  if (endpoints.length > 0) {
    result = await fetchTabText(endpoints);
  } else {
    result = { text: null, strategy: null, attempts: [] };
  }

  if (result.text == null && sampleUrl) {
    try {
      const res = await fetch(sampleUrl);
      if (res.ok) result = { text: await res.text(), strategy: 'bundled sample data', attempts: result.attempts };
    } catch {
      /* fall through to cache */
    }
  }

  if (result.text == null) {
    if (cached) {
      return { ...parseTab(cached.text, schema), strategy: 'cached copy', attempts: result.attempts, fetchedAt: cached.fetchedAt, stale: true };
    }
    return {
      records: [], headerRow: -1, headers: [], unknownColumns: [], skipped: 0,
      error: 'Could not load this tab.', strategy: null, attempts: result.attempts, fetchedAt: null, stale: false,
    };
  }

  const fetchedAt = new Date().toISOString();
  if (result.strategy !== 'bundled sample data') cacheSet(name, { text: result.text, fetchedAt });

  return { ...parseTab(result.text, schema), strategy: result.strategy, attempts: result.attempts, fetchedAt, stale: false };
}
