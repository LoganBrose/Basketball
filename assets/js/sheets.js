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
 * declared per tab and matched exactly, so a near-miss on another tab can never
 * satisfy it.
 *
 * `required` lists the fields whose absence is a real problem. Anything else is
 * optional and simply won't be read. The Connection panel shows missing
 * required headers in red — a silently absent `FGA` column would otherwise look
 * like a season of missed shots.
 */
export const SCHEMAS = {
  players: {
    label: 'Players',
    key: 'player id',
    required: ['playerId', 'fullName'],
    fields: {
      playerId: ['player id'],
      fullName: ['full name', 'name', 'player name'],
      jersey: ['jersey number', 'jersey', 'number', '#'],
      position: ['position', 'pos'],
    },
  },

  games: {
    label: 'Games',
    key: 'game id',
    required: ['gameId', 'date', 'opponent', 'homeAway'],
    fields: {
      gameId: ['game id'],
      date: ['date'],
      opponent: ['opponent', 'opp'],
      homeAway: ['home/away', 'h/a', 'home away', 'homeaway'],
      // Optional. Present, they unlock record and margin on the dashboard.
      teamScore: ['team score', 'our score', 'points for', 'pf'],
      oppScore: ['opponent score', 'opp score', 'points against', 'pa'],
    },
  },

  /**
   * StatsLog: one row per player per game, typed straight into the sheet.
   * This is the only stats source — there is no Google Form.
   */
  statslog: {
    label: 'StatsLog',
    key: 'stat id',
    required: [
      'statId', 'game', 'player',
      'points', 'rebounds', 'assists', 'steals', 'blocks', 'turnovers',
      'fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta', 'fouls',
    ],
    fields: {
      statId: ['stat id'],
      player: ['player id'],
      game: ['game id'],
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
 * Every tab carries a title line, one or more legend lines and a blank row
 * above the header, and editing a legend line shifts that offset — so the row
 * is located by content, never by a fixed number.
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
 */
export function isSkippableKey(keyValue) {
  const v = String(keyValue == null ? '' : keyValue).trim();
  if (v === '') return true;
  return /^ex/i.test(v);
}

/**
 * Parse one tab's CSV into canonical records.
 *
 * @returns {{records: Object[], headerRow: number, headers: string[],
 *            matched: Object<string,string>, missing: string[],
 *            unknownColumns: string[], skipped: number, error: string|null}}
 */
export function parseTab(csvText, schema) {
  const rows = parseCSV(csvText);
  const headerRow = findHeaderRow(rows, schema.key);

  if (headerRow === -1) {
    return {
      records: [], headerRow: -1, headers: [], matched: {},
      missing: schema.required.slice(), unknownColumns: [], skipped: 0,
      error: `No header row found — expected a column named "${schema.key}".`,
    };
  }

  const headers = rows[headerRow].map(normalizeHeader);

  // Map each canonical field to the first column whose header matches one of
  // its accepted spellings.
  const columnOf = {};
  const matched = {};
  for (const [field, aliases] of Object.entries(schema.fields)) {
    const idx = headers.findIndex((h) => h !== '' && aliases.includes(h));
    if (idx !== -1) {
      columnOf[field] = idx;
      matched[field] = rows[headerRow][idx];
    }
  }

  const missing = schema.required.filter((field) => !(field in columnOf));

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

  return { records, headerRow, headers, matched, missing, unknownColumns, skipped, error: null };
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

/** The published HTML view, which lists every published tab and its gid. */
export function pubHtmlUrl(pubKey) {
  return `https://docs.google.com/spreadsheets/d/e/${encodeURIComponent(pubKey)}/pubhtml`;
}

/**
 * Pull tab name -> gid out of a published sheet's HTML, so a publish key alone
 * is enough when gids aren't configured.
 *
 * Parsed with the DOM rather than by regex over the whole document, so sheet
 * content can never be interpreted as markup.
 */
export function parseTabGids(html) {
  const map = {};
  if (typeof html !== 'string' || html === '') return map;

  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const li of doc.querySelectorAll('[id^="sheet-button-"]')) {
    const gid = li.id.slice('sheet-button-'.length);
    const name = (li.textContent || '').trim();
    if (gid && name) map[normalizeHeader(name)] = gid;
  }
  return map;
}

let gidPromise = null;
export function discoverGids(pubKey, { force = false } = {}) {
  if (!pubKey) return Promise.resolve({ gids: {}, error: 'No publish key configured.' });
  if (gidPromise && !force) return gidPromise;

  gidPromise = (async () => {
    try {
      const res = await fetch(pubHtmlUrl(pubKey) + '?_=' + Date.now());
      if (!res.ok) return { gids: {}, error: `HTTP ${res.status} fetching the published sheet.` };
      const gids = parseTabGids(await res.text());
      if (Object.keys(gids).length === 0) {
        return { gids: {}, error: 'The published page listed no tabs.' };
      }
      return { gids, error: null };
    } catch (err) {
      return { gids: {}, error: `Could not read the published sheet's tab list (${err.message}). Add tab gids in config.js.` };
    }
  })();

  return gidPromise;
}

/**
 * Build the ordered list of URLs to try for one tab.
 * gviz comes first: it addresses tabs by name, so it survives a tab being moved
 * or re-created, which changes a gid.
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
 *
 * The URL and HTTP status of the *successful* attempt are returned too, not
 * just the failures: the Connection panel has to show what it actually read, or
 * there's no way to tell a stale sheet from a wrong one.
 *
 * @returns {Promise<{text: string|null, strategy: string|null, url: string|null,
 *                    status: number|null, attempts: Object[]}>}
 */
export async function fetchTabText(endpoints) {
  const attempts = [];
  for (const ep of endpoints) {
    try {
      // Cache-bust so a phone doesn't sit on a stale copy after an edit.
      const url = ep.url + (ep.url.includes('?') ? '&' : '?') + '_=' + Date.now();
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) {
        attempts.push({ url: ep.url, strategy: ep.strategy, status: res.status, error: `HTTP ${res.status} ${res.statusText}` });
        continue;
      }
      const text = await res.text();
      // A sheet that isn't published returns an HTML sign-in page with HTTP 200.
      if (/^\s*<(?:!doctype|html)/i.test(text)) {
        attempts.push({
          url: ep.url, strategy: ep.strategy, status: res.status,
          error: 'Got an HTML page instead of CSV — the tab is probably not published to the web.',
        });
        continue;
      }
      return { text, strategy: ep.strategy, url: ep.url, status: res.status, attempts };
    } catch (err) {
      attempts.push({
        url: ep.url, strategy: ep.strategy, status: null,
        error: String(err && err.message ? err.message : err),
      });
    }
  }
  return { text: null, strategy: null, url: null, status: null, attempts };
}

/**
 * Load one tab: the network, then the bundled sample, then the last cached
 * copy. Whatever lands, the result carries enough detail for the Connection
 * panel to explain itself.
 */
export async function loadTab({ name, schema, endpoints, sampleUrl }) {
  const cached = cacheGet(name);

  let result = endpoints.length > 0
    ? await fetchTabText(endpoints)
    : { text: null, strategy: null, url: null, status: null, attempts: [] };

  if (result.text == null && sampleUrl) {
    try {
      const res = await fetch(sampleUrl);
      if (res.ok) {
        result = {
          text: await res.text(), strategy: 'bundled sample data',
          url: sampleUrl, status: res.status, attempts: result.attempts,
        };
      }
    } catch {
      /* fall through to cache */
    }
  }

  if (result.text == null) {
    if (cached) {
      return {
        ...parseTab(cached.text, schema), strategy: 'cached copy', url: null, status: null,
        attempts: result.attempts, fetchedAt: cached.fetchedAt, stale: true,
      };
    }
    return {
      records: [], headerRow: -1, headers: [], matched: {}, missing: schema.required.slice(),
      unknownColumns: [], skipped: 0, error: 'Could not load this tab.',
      strategy: null, url: null, status: null, attempts: result.attempts, fetchedAt: null, stale: false,
    };
  }

  const fetchedAt = new Date().toISOString();
  if (result.strategy !== 'bundled sample data') cacheSet(name, { text: result.text, fetchedAt });

  return {
    ...parseTab(result.text, schema),
    strategy: result.strategy, url: result.url, status: result.status,
    attempts: result.attempts, fetchedAt, stale: false,
  };
}
