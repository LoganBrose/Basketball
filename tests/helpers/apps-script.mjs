/**
 * Run the real apps-script/Code.gs inside Node.
 *
 * Code.gs is pasted into Google by hand and depends on Utilities, CacheService,
 * SpreadsheetApp and PropertiesService — none of which exist here. Rather than
 * shipping it untested, this loads the actual file and supplies those globals,
 * so the token format, the constant-time comparison and the throttle ordering
 * are exercised against the same source that gets pasted.
 *
 * What this does NOT prove: that Google's real Utilities and SpreadsheetApp
 * behave like these shims. The base64 and HMAC shims match Google's documented
 * behaviour, but a deployment is still the only thing that confirms the whole
 * path. See the "What I cannot verify" section of the README.
 */

import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

const SOURCE = new URL('../../apps-script/Code.gs', import.meta.url);

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

/**
 * @param {Object} [props] Script Properties to expose. Sensible defaults are
 *   filled in for anything omitted.
 * @returns {{fns: Object, rows: Array, cache: Map, locks: Object, sheets: Object, props: Object}}
 */
export function loadCodeGs(props = {}) {
  const properties = {
    SITE_PASSWORD: 'team-pw',
    ADMIN_PASSWORD: 'admin-pw',
    ADMIN_NAME: 'Logan Brose',
    LOG_SHEET_ID: 'log-id',
    STATS_SHEET_ID: 'stats-id',
    TOKEN_SECRET: 'a-long-random-secret-value',
    ...props,
  };

  const rows = [];
  const cache = new Map();
  /** Lock bookkeeping — a lock left held blocks every later write. */
  const locks = { taken: 0, released: 0 };
  /** Extra tabs, keyed by name, for the data actions added in later commits. */
  const sheets = {};

  const logTab = {
    appendRow: (r) => rows.push(r),
    setFrozenRows: () => {},
    getDataRange: () => ({
      getDisplayValues: () => [
        ['Timestamp', 'Name', 'Page', 'User agent', 'Result'],
        ...rows.map((r) => r.map((cell) => String(cell))),
      ],
    }),
  };

  const globals = {
    Utilities: {
      computeHmacSha256Signature: (msg, secret) =>
        createHmac('sha256', secret).update(msg, 'utf8').digest(),
      base64EncodeWebSafe: (v) => b64url(typeof v === 'string' ? Buffer.from(v, 'utf8') : v),
      base64DecodeWebSafe: (t) =>
        Buffer.from(String(t).replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
      newBlob: (bytes) => ({ getDataAsString: () => Buffer.from(bytes).toString('utf8') }),
    },

    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in properties ? properties[k] : null),
      }),
    },

    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => cache.set(k, v),
      }),
    },

    SpreadsheetApp: {
      openById: () => ({
        getSheetByName: (name) => (name === 'SignIns' ? logTab : sheets[name] || null),
        insertSheet: (name) => (name === 'SignIns' ? logTab : (sheets[name] = tabFor([]))),
      }),
    },

    LockService: {
      getScriptLock: () => ({
        waitLock: () => { locks.taken++; },
        releaseLock: () => { locks.released++; },
      }),
    },

    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text) => ({ setMimeType: () => ({ body: text }) }),
    },

    Logger: { log: () => {} },
    console: { error: () => {}, log: () => {} },
  };

  // Everything Code.gs defines that a test might want to reach.
  const exported = [
    'doPost', 'doGet', 'handleSignIn', 'handleAdmin', 'handleData',
    'handlePlays', 'handleSavePlay', 'handleDeletePlay', 'playsSheet',
    'makeToken', 'verifyToken', 'cleanName', 'constantTimeEquals', 'readSignIns',
  ];

  const names = Object.keys(globals);
  const src = readFileSync(SOURCE, 'utf8');
  const factory = new Function(
    ...names,
    `${src}\nreturn {${exported.map((n) => `${n}: typeof ${n} === 'function' ? ${n} : undefined`).join(',')}};`,
  );

  return {
    fns: factory(...names.map((n) => globals[n])),
    rows, cache, locks, sheets, props: properties,
  };
}

/**
 * A stand-in for a Google sheet tab.
 *
 * Enough of the API for the plays actions: reading, appending, overwriting one
 * row through getRange().setValues(), and deleting a row. Rows and columns are
 * 1-based here exactly as they are in Sheets, because the code under test does
 * its own index arithmetic and getting that wrong is precisely the kind of bug
 * these tests exist to catch.
 */
export function tabFor(values) {
  const asText = (v) => (v instanceof Date ? v.toISOString() : String(v == null ? '' : v));

  return {
    rows: values,
    getDataRange: () => ({ getDisplayValues: () => values.map((r) => r.map(asText)) }),
    appendRow: (r) => values.push(r.slice()),
    setFrozenRows: () => {},
    deleteRow: (rowIndex) => values.splice(rowIndex - 1, 1),
    getRange: (row, col, numRows, numCols) => ({
      setValues: (block) => {
        for (let r = 0; r < numRows; r++) {
          const target = row - 1 + r;
          while (values.length <= target) values.push([]);
          for (let c = 0; c < numCols; c++) values[target][col - 1 + c] = block[r][c];
        }
      },
    }),
  };
}

/** Parse what doPost hands back to the browser. */
export function post(fns, body) {
  return JSON.parse(fns.doPost({ postData: { contents: JSON.stringify(body) } }).body);
}
