/**
 * Playbooks — "Man Offense", "Zone Offense", "BLOBs/SLOBs", "Press Break".
 *
 * A playbook is a slug. Its plays can live on the site, on this device, or
 * both, and the picker merges them into one entry: publishing a play moves it
 * from one badge to the other inside the same playbook, which is how a coach
 * thinks about it. Splitting them into "Zone Offense (team)" and "Zone Offense
 * (device)" would make you check two places for one thing.
 */

const KEY = 'bb.playbooks.v1';

/** Where plays land when nothing says otherwise, matching the site's folder. */
export const DEFAULT_PLAYBOOK = 'general';

export function slugifyPlaybook(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'playbook';
}

/* ------------------------------------------------------------------ */
/* Local playbooks                                                     */
/* ------------------------------------------------------------------ */

export function readLocalPlaybooks() {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeLocalPlaybooks(list) {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** Create a playbook on this device. Returns the existing one if the slug is taken. */
export function addLocalPlaybook(name, description = '') {
  const slug = slugifyPlaybook(name);
  const list = readLocalPlaybooks();
  const existing = list.find((p) => p.slug === slug);
  if (existing) return existing;

  const entry = { slug, name: String(name).trim() || slug, description };
  list.push(entry);
  writeLocalPlaybooks(list);
  return entry;
}

/* ------------------------------------------------------------------ */
/* Merging                                                             */
/* ------------------------------------------------------------------ */

/** The playbook a play belongs to, defaulting rather than going missing. */
export const playbookOf = (play) => play?.playbook || DEFAULT_PLAYBOOK;

/**
 * Every playbook the coach can see, merged by slug.
 *
 * @param {Object[]} teamPlaybooks from plays/index.json
 * @param {Object[]} localPlaybooks from localStorage
 * @param {Object[]} devicePlays used for counts and to surface a playbook that
 *   only exists because a play claims it
 * @returns {{slug, name, description, order, onSite, teamCount, deviceCount, count}[]}
 */
export function mergePlaybooks(teamPlaybooks = [], localPlaybooks = [], devicePlays = []) {
  const bySlug = new Map();

  for (const pb of teamPlaybooks) {
    bySlug.set(pb.slug, {
      slug: pb.slug,
      name: pb.name || pb.slug,
      description: pb.description || '',
      order: Number.isFinite(pb.order) ? pb.order : 99,
      onSite: true,
      teamCount: (pb.plays || []).length,
      deviceCount: 0,
    });
  }

  for (const pb of localPlaybooks) {
    const existing = bySlug.get(pb.slug);
    if (existing) {
      // A local playbook with the same slug is the same playbook. Keep the
      // site's name as authoritative — it's the one everyone else sees.
      if (!existing.description) existing.description = pb.description || '';
      continue;
    }
    bySlug.set(pb.slug, {
      slug: pb.slug,
      name: pb.name || pb.slug,
      description: pb.description || '',
      order: 99,
      onSite: false,
      teamCount: 0,
      deviceCount: 0,
    });
  }

  for (const play of devicePlays) {
    const slug = playbookOf(play);
    if (!bySlug.has(slug)) {
      // A play referencing a playbook nobody declared still needs somewhere to
      // live, or it would vanish from every view.
      bySlug.set(slug, {
        slug,
        name: slug === DEFAULT_PLAYBOOK ? 'General' : slug,
        description: '',
        order: 99,
        onSite: false,
        teamCount: 0,
        deviceCount: 0,
      });
    }
    bySlug.get(slug).deviceCount++;
  }

  return [...bySlug.values()]
    .map((pb) => ({ ...pb, count: pb.teamCount + pb.deviceCount }))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/** Flatten the index's nested plays, tagging each with its playbook. */
export function flattenTeamPlays(teamPlaybooks = []) {
  return teamPlaybooks.flatMap((pb) => (pb.plays || []).map((play) => ({ ...play, playbook: pb.slug })));
}

/**
 * Does this playbook already have a play at this filename, and is it a
 * different play?
 *
 * Publishing over someone else's file is the one destructive thing this app
 * can cause, so it's checked by slug *and* id before anything opens.
 */
export function findSlugConflict(teamPlays, playbookSlug, fileSlug, playId) {
  const path = `plays/${playbookSlug}/${fileSlug}.json`;
  return teamPlays.find((t) => t.path === path && t.id !== playId) || null;
}

export const playbookExistsOnSite = (teamPlaybooks, slug) =>
  teamPlaybooks.some((pb) => pb.slug === slug);
