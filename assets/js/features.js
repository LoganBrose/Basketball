/**
 * Which staged features this browser has been told it may use.
 *
 * The list comes from the Apps Script — at sign-in, and again from the
 * background check every page makes — and is only ever a hint for what to
 * build on the page. It is never what protects anything: every request a
 * feature makes is checked again in the script, which refuses a token the
 * feature is not released to. Editing this entry by hand shows a link that
 * leads to nothing.
 *
 * Fails closed. A missing, malformed or unreadable entry is "no features", so
 * a browser that has not heard from the script yet shows exactly what it
 * showed before features existed.
 */

export const FEATURES_KEY = 'bb.features.v1';

/** Every feature the page knows how to show. Anything else in storage is ignored. */
export const KNOWN_FEATURES = ['adminPlaybook', 'scouting'];

/** A clean, de-duplicated list of known feature names, from anything at all. */
export function parseFeatures(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const f of raw) {
    if (KNOWN_FEATURES.includes(f) && !out.includes(f)) out.push(f);
  }
  return out;
}

export function readFeatures() {
  try {
    const raw = globalThis.localStorage?.getItem(FEATURES_KEY);
    return parseFeatures(raw ? JSON.parse(raw)?.list : null);
  } catch {
    return [];
  }
}

/**
 * Store the list the script sent.
 * @returns {boolean} whether it differs from what was stored, so the page
 *   only re-renders when something actually changed.
 */
export function writeFeatures(list) {
  const next = parseFeatures(list);
  const before = readFeatures();
  const changed = next.length !== before.length || next.some((f) => !before.includes(f));
  try {
    globalThis.localStorage?.setItem(FEATURES_KEY, JSON.stringify({ list: next, at: Date.now() }));
  } catch {
    /* blocked storage: the features simply stay off */
  }
  return changed;
}

export function clearFeatures() {
  try {
    globalThis.localStorage?.removeItem(FEATURES_KEY);
  } catch {
    /* nothing to do */
  }
}

export const hasFeature = (name) => readFeatures().includes(name);

/**
 * The features in a script reply, or null when the reply says nothing about
 * them — a network failure, or a script deployed before features existed. Null
 * means "leave what is stored alone", not "take everything away".
 */
export function featuresFrom(result) {
  const data = result && result.ok ? result.data : null;
  if (!data || data.ok !== true || !Array.isArray(data.features)) return null;
  return parseFeatures(data.features);
}
