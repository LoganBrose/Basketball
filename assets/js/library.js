/**
 * Play storage.
 *
 * Plays live in localStorage as structured JSON, never as images, so they stay
 * editable and searchable. Export/import moves the same JSON between devices —
 * on a static host that file *is* the sync mechanism.
 */

const KEY = 'bb.plays.v1';
export const SCHEMA_VERSION = 1;

/** localStorage throws in private mode and when site data is blocked. */
function readStore() {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStore(plays) {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(plays));
    return true;
  } catch {
    return false;
  }
}

export function uid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function emptyFrame(label = 'Initial') {
  return { label, tokens: [], arrows: [], texts: [] };
}

export function newPlay(overrides = {}) {
  const now = new Date().toISOString();
  return {
    schema: SCHEMA_VERSION,
    id: uid(),
    name: 'Untitled play',
    category: '',
    playbook: 'general',
    tags: [],
    notes: '',
    courtType: 'half',
    preset: 'hs',
    youtube: null,
    frames: [emptyFrame()],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export const listPlays = () => readStore();

export const getPlay = (id) => readStore().find((p) => p.id === id) || null;

/**
 * @param {Object} play
 * @param {{touch?: boolean}} opts `touch: false` keeps the existing
 *   `updatedAt` — used when copying a play down from the team playbook, which
 *   is not an edit and must not look like one.
 */
export function savePlay(play, { touch = true } = {}) {
  const plays = readStore();
  const next = touch
    ? { ...play, updatedAt: new Date().toISOString() }
    : { ...play, updatedAt: play.updatedAt || new Date().toISOString() };
  const i = plays.findIndex((p) => p.id === play.id);
  if (i === -1) plays.push(next);
  else plays[i] = next;
  return writeStore(plays) ? next : null;
}

export function deletePlay(id) {
  return writeStore(readStore().filter((p) => p.id !== id));
}

/** A copy is a new play, not a second reference to the same one. */
export function duplicatePlay(play) {
  return savePlay({
    ...structuredClone(play),
    id: uid(),
    name: `${play.name} (copy)`,
    createdAt: new Date().toISOString(),
  });
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

/**
 * Free-text search across everything a coach might remember about a play —
 * including the labels on the tokens, so searching "5" finds plays for the 5.
 */
export function searchPlays(plays, query, { category = '', tag = '' } = {}) {
  const q = String(query || '').trim().toLowerCase();

  return plays.filter((play) => {
    if (category && play.category !== category) return false;
    if (tag && !(play.tags || []).includes(tag)) return false;
    if (!q) return true;

    const haystack = [
      play.name,
      play.category,
      play.notes,
      ...(play.tags || []),
      ...(play.frames || []).flatMap((f) => [
        f.label,
        ...(f.tokens || []).map((t) => t.label),
        ...(f.texts || []).map((t) => t.text),
      ]),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return haystack.includes(q);
  });
}

export function allCategories(plays) {
  return [...new Set(plays.map((p) => p.category).filter(Boolean))].sort();
}

export function allTags(plays) {
  return [...new Set(plays.flatMap((p) => p.tags || []).filter(Boolean))].sort();
}

/* ------------------------------------------------------------------ */
/* Import / export                                                     */
/* ------------------------------------------------------------------ */

/**
 * Accept either a single play or a whole library, so a coach can hand over one
 * file without having to know which kind it is.
 *
 * @returns {{plays: Object[], errors: string[]}}
 */
export function parseImport(text) {
  const errors = [];
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { plays: [], errors: [`Not valid JSON: ${err.message}`] };
  }

  const candidates = Array.isArray(data) ? data : (Array.isArray(data.plays) ? data.plays : [data]);
  const plays = [];

  for (const [i, candidate] of candidates.entries()) {
    const where = candidates.length > 1 ? `Play ${i + 1}` : 'This file';
    if (!candidate || typeof candidate !== 'object') {
      errors.push(`${where}: not a play object.`);
      continue;
    }
    if (!Array.isArray(candidate.frames) || candidate.frames.length === 0) {
      errors.push(`${where}: no frames — this doesn't look like a play.`);
      continue;
    }
    plays.push(normalizePlay(candidate));
  }

  return { plays, errors };
}

/** Fill in anything an older or hand-edited file is missing. */
export function normalizePlay(raw) {
  const frames = (raw.frames || []).map((f, i) => ({
    label: f.label || (i === 0 ? 'Initial' : `Action ${i}`),
    tokens: (f.tokens || []).map((t) => ({
      id: t.id || uid(),
      kind: t.kind || 'offense',
      label: t.label == null ? '' : String(t.label),
      x: Number(t.x) || 0,
      y: Number(t.y) || 0,
      hasBall: Boolean(t.hasBall),
    })),
    arrows: (f.arrows || []).map((a) => ({
      id: a.id || uid(),
      kind: a.kind || 'cut',
      from: { x: Number(a.from?.x) || 0, y: Number(a.from?.y) || 0 },
      to: { x: Number(a.to?.x) || 0, y: Number(a.to?.y) || 0 },
      ctrl: a.ctrl ? { x: Number(a.ctrl.x) || 0, y: Number(a.ctrl.y) || 0 } : null,
    })),
    texts: (f.texts || []).map((t) => ({
      id: t.id || uid(),
      x: Number(t.x) || 0,
      y: Number(t.y) || 0,
      text: String(t.text || ''),
    })),
  }));

  return {
    schema: SCHEMA_VERSION,
    id: raw.id || uid(),
    name: raw.name || 'Untitled play',
    category: raw.category || '',
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    notes: raw.notes || '',
    courtType: raw.courtType === 'full' ? 'full' : 'half',
    preset: ['hs', 'ncaa', 'nba'].includes(raw.preset) ? raw.preset : 'hs',
    // Which playbook this play belongs to — a sibling of name/category, never
    // mixed into frames, and never tied to the lineup, which stays out of the
    // play entirely so any play opens under any lineup.
    playbook: raw.playbook || 'general',
    youtube: raw.youtube || null,
    frames: frames.length ? frames : [emptyFrame()],
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || new Date().toISOString(),
  };
}

/**
 * Add imported plays. An ID that already exists gets a fresh one rather than
 * overwriting — importing should never destroy a play you already had.
 */
export function importPlays(incoming) {
  const existing = readStore();
  const ids = new Set(existing.map((p) => p.id));
  const added = [];

  for (const play of incoming) {
    const copy = ids.has(play.id) ? { ...play, id: uid(), name: `${play.name} (imported)` } : play;
    ids.add(copy.id);
    existing.push(copy);
    added.push(copy);
  }

  writeStore(existing);
  return added;
}

export function exportPlay(play) {
  return JSON.stringify(play, null, 2);
}

export function exportLibrary(plays) {
  return JSON.stringify(
    { exported: new Date().toISOString(), schema: SCHEMA_VERSION, plays },
    null,
    2,
  );
}

/** Safe-ish filename from a play name. */
export function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'play';
}

/* ------------------------------------------------------------------ */
/* Team playbook (read-only, committed to the repo)                    */
/* ------------------------------------------------------------------ */

/**
 * Load the shared playbook from plays/index.json.
 * A missing index is normal — it just means no team plays are committed yet.
 */
export async function loadTeamPlaybook() {
  // no-store, not no-cache: a phone must not serve a stale index after a
  // deploy, and "revalidate" isn't the same as "don't reuse".
  const bust = () => `?t=${Date.now()}`;

  try {
    const res = await fetch('plays/index.json' + bust(), { cache: 'no-store' });
    if (!res.ok) {
      // A 404 and "nothing published yet" are different problems with
      // different fixes, so they must not look the same.
      return { playbooks: [], plays: [], error: `HTTP ${res.status} loading plays/index.json` };
    }

    const index = await res.json();

    // The index groups plays by playbook folder. A phone may still hold the
    // previous flat `{plays: […]}` index during a deploy, so that shape is read
    // as a single "general" playbook rather than as nothing at all.
    const playbooks = Array.isArray(index.playbooks)
      ? index.playbooks
      : [{
        slug: 'general',
        name: 'General',
        description: '',
        order: 1,
        plays: (Array.isArray(index.plays) ? index.plays : [])
          .map((p) => ({ ...p, path: p.path || `plays/${p.file}` })),
      }];

    const failed = [];

    const loaded = await Promise.all(playbooks.map(async (pb) => {
      const plays = await Promise.all((pb.plays || []).map(async (entry) => {
        // `path` is what publishing needs in order to edit this exact file.
        const path = entry.path || `plays/${pb.slug}/${entry.file}`;
        try {
          const r = await fetch(path + bust(), { cache: 'no-store' });
          if (!r.ok) {
            failed.push(`${path} (HTTP ${r.status})`);
            return null;
          }
          return { ...normalizePlay(await r.json()), path, playbook: pb.slug };
        } catch (err) {
          failed.push(`${path} (${err.message})`);
          return null;
        }
      }));
      return { ...pb, plays: plays.filter(Boolean) };
    }));

    return {
      playbooks: loaded,
      plays: loaded.flatMap((pb) => pb.plays),
      error: failed.length ? `Could not load ${failed.join(', ')}` : null,
    };
  } catch (err) {
    return { playbooks: [], plays: [], error: err.message };
  }
}
