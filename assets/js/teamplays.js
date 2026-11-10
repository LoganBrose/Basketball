/**
 * The team playbook, held in the sheet rather than in the repo.
 *
 * Why it moved: plays under `plays/` are files in a public repo, so the sign-in
 * popup hid the page while `plays/general/horns-flare.json` stayed one URL
 * away. Here the script hands nothing over without a token it signed.
 *
 * Reading takes a site token, so the playbook works on a phone with the team
 * password. Writing does too: any coach signed in with the team password can
 * publish to or remove from the team playbook. A view-only sign-in can only
 * read, and the script refuses a viewer token for anything else.
 *
 * The old `plays/` folder has been deleted; with sign-in configured the sheet
 * is the only team playbook.
 */

import { CONFIG } from './config.js';
import { callScript, isEnabled, isViewer, readSession, readAdminSession, sessionValid, siteMaxAge, adminMaxAge } from './gate.js';
import { normalizePlay, loadTeamPlaybook } from './library.js';
import { DEFAULT_PLAYBOOK } from './playbooks.js';

/** True when the sheet is the team playbook, rather than `plays/`. */
export const usingScript = () => isEnabled(CONFIG.gate);

const siteToken = () => {
  const gate = CONFIG.gate || {};
  const admin = readAdminSession();
  if (sessionValid(admin, adminMaxAge(gate))) return admin.token;
  const site = readSession();
  return sessionValid(site, siteMaxAge(gate)) ? site.token : '';
};

/**
 * The token that may change the team playbook: the admin's if there is one,
 * otherwise the coach's. A viewer's session holds a viewer token, which the
 * script would refuse, so a viewer gets none.
 */
const writeToken = () => (isViewer() ? '' : siteToken());

/** Any signed-in coach (or the admin) may change the team playbook. */
export const canPublish = () => !usingScript() || Boolean(writeToken());

/** "zone-offense" -> "Zone Offense", for a playbook nobody named. */
export function titleFromSlug(slug) {
  if (slug === DEFAULT_PLAYBOOK) return 'General';
  return String(slug)
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || slug;
}

/**
 * Sheet rows -> the same `{plays, playbooks}` the file index produced.
 *
 * Pure, so the shape the rest of the editor depends on is pinned by a test
 * rather than by whichever of the two sources happened to be wired up last.
 *
 * @param {{id, playbook, name, updated, updatedBy, play}[]} rows
 */
export function rowsToTeam(rows = []) {
  const plays = [];
  const bySlug = new Map();

  for (const row of rows) {
    if (!row || !row.play) continue;

    const slug = row.playbook || DEFAULT_PLAYBOOK;
    // Normalized on the way in: a hand-edited cell should not be able to put a
    // shape the editor cannot render into the library.
    const play = { ...normalizePlay(row.play), id: row.id, playbook: slug };
    play.updatedBy = row.updatedBy || '';

    plays.push(play);
    if (!bySlug.has(slug)) {
      bySlug.set(slug, { slug, name: titleFromSlug(slug), description: '', order: 99, plays: [] });
    }
    bySlug.get(slug).plays.push(play);
  }

  const playbooks = [...bySlug.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { plays, playbooks };
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

/**
 * @returns {Promise<{plays, playbooks, error, source}>}
 *   `source` is 'script' or 'files', so the UI can say which one it is reading
 *   rather than leaving "where did my play go" unanswerable.
 */
export async function fetchTeamPlays() {
  if (!usingScript()) {
    return { ...(await loadTeamPlaybook()), source: 'files' };
  }

  const token = siteToken();
  if (!token) {
    return { plays: [], playbooks: [], error: 'sign in to load it.', source: 'script' };
  }

  const result = await callScript(CONFIG.gate.url, { action: 'plays', token });

  if (!result.ok) {
    return { plays: [], playbooks: [], error: result.error, source: 'script' };
  }
  if (!result.data?.ok) {
    return {
      plays: [], playbooks: [],
      error: result.data?.reason === 'auth' ? 'your sign-in has expired.' : 'the script refused the request.',
      source: 'script',
    };
  }

  return { ...rowsToTeam(result.data.plays), error: null, source: 'script' };
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

/** What the UI should say for each way a save can fail. */
export function saveMessage(result) {
  if (!result.ok) return "Couldn't reach the team playbook. Try again.";

  const data = result.data || {};
  if (data.ok) return '';

  switch (data.reason) {
    case 'auth':
      return 'Your sign-in has expired. Sign in again to publish.';
    case 'too_big':
      return 'This play is too large to save to the team playbook. Split it into two plays or remove frames.';
    default:
      return "Couldn't save this play to the team playbook.";
  }
}

/**
 * Add or replace one play in the team playbook.
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function saveTeamPlay(play) {
  const token = writeToken();
  if (!token) return { ok: false, message: 'Sign in to publish to the team playbook.' };

  const result = await callScript(CONFIG.gate.url, { action: 'savePlay', token, play });
  const message = saveMessage(result);
  return { ok: message === '', message };
}

/** Remove one play from the team playbook. */
export async function deleteTeamPlay(id) {
  const token = writeToken();
  if (!token) return { ok: false, message: 'Sign in to remove from the team playbook.' };

  const result = await callScript(CONFIG.gate.url, { action: 'deletePlay', token, id });
  if (!result.ok) return { ok: false, message: "Couldn't reach the team playbook. Try again." };
  if (!result.data?.ok) {
    return {
      ok: false,
      message: result.data?.reason === 'auth'
        ? 'Your sign-in has expired. Sign in again to remove.'
        : "Couldn't remove this play.",
    };
  }
  return { ok: true, message: '' };
}
