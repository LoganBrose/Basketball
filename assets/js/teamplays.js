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
import { callScript, isEnabled, isViewer, bestToken, adminToken } from './gate.js';
import { hasFeature } from './features.js';
import { normalizePlay, loadTeamPlaybook } from './library.js';
import { DEFAULT_PLAYBOOK } from './playbooks.js';

/** True when the sheet is the team playbook, rather than `plays/`. */
export const usingScript = () => isEnabled(CONFIG.gate);

const siteToken = () => bestToken(CONFIG.gate || {});

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
    if (!row || !row.id) continue;
    // A player's list has no diagrams in it (see summaryStub); anything else
    // without a play is a broken row.
    if (!row.play && typeof row.steps !== 'number') continue;

    const slug = row.playbook || DEFAULT_PLAYBOOK;
    // Normalized on the way in: a hand-edited cell should not be able to put a
    // shape the editor cannot render into the library.
    const play = row.play
      ? { ...normalizePlay(row.play), id: row.id, playbook: slug }
      : summaryStub(row, slug);
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
/* The admin playbook                                                  */
/* ------------------------------------------------------------------ */

/**
 * Is the admin playbook offered on this page?
 *
 * It needs an admin session and the script's word that this login has it. The
 * second half matters for the order things are deployed in: a site updated
 * before the script would otherwise show a card the old script cannot fill.
 * The script refuses every non-admin token whatever this says.
 */
export const canUseAdminBook = () => usingScript() && Boolean(adminToken()) && hasFeature('adminPlaybook');

/** How each book is named in a sentence. */
export const BOOK_LABEL = { team: 'team playbook', admin: 'admin playbook' };

/** The token a book is read with, or '' when this browser has none. */
const readToken = (book) => (book === 'admin' ? adminToken() : siteToken());
/** The token a book is changed with. */
const changeToken = (book) => (book === 'admin' ? adminToken() : writeToken());

/** The request body for a book: the team playbook is sent exactly as before. */
const withBook = (payload, book) => (book === 'team' ? payload : { ...payload, book });

/**
 * A list entry for a play whose diagram hasn't been downloaded: what a player
 * gets for each play until they open it. `summary: true` is what tells the
 * page to fetch the play before showing it.
 */
export function summaryStub(row, slug = row.playbook || DEFAULT_PLAYBOOK) {
  return {
    id: row.id,
    name: row.name || 'Untitled play',
    playbook: slug,
    category: row.category || '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    courtType: row.courtType === 'full' ? 'full' : 'half',
    frames: [],
    stepCount: Number(row.steps) || 0,
    summary: true,
  };
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

/**
 * @param {'team'|'admin'} [book]
 * @returns {Promise<{plays, playbooks, error, source}>}
 *   `source` is 'script' or 'files', so the UI can say which one it is reading
 *   rather than leaving "where did my play go" unanswerable.
 */
export async function fetchTeamPlays(book = 'team') {
  if (!usingScript()) {
    if (book !== 'team') return { plays: [], playbooks: [], error: null, source: 'files' };
    return { ...(await loadTeamPlaybook()), source: 'files' };
  }

  const token = readToken(book);
  if (!token) {
    return { plays: [], playbooks: [], error: 'sign in to load it.', source: 'script' };
  }

  const result = await callScript(CONFIG.gate.url, withBook({ action: 'plays', token }, book));

  if (!result.ok) {
    return { plays: [], playbooks: [], error: result.error, source: 'script' };
  }
  if (!result.data?.ok) {
    return {
      plays: [], playbooks: [],
      error: result.data?.reason === 'auth' || book === 'admin'
        ? 'your sign-in has expired.'
        : 'the script refused the request.',
      source: 'script',
    };
  }

  return { ...rowsToTeam(result.data.plays), error: null, source: 'script' };
}

/** One play's reply, sorted into what the page should do about it. */
export function teamPlayResult(result) {
  if (!result || !result.ok) {
    return { ok: false, reason: 'network', message: "Couldn't load this play. Check your connection and try again." };
  }
  const data = result.data || {};
  if (data.ok && data.play && data.play.play) {
    const row = data.play;
    const slug = row.playbook || DEFAULT_PLAYBOOK;
    return { ok: true, play: { ...normalizePlay(row.play), id: row.id, playbook: slug } };
  }
  if (data.reason === 'auth') return { ok: false, reason: 'auth', message: 'Your sign-in has ended. Sign in again.' };
  if (data.reason === 'not_found') {
    return { ok: false, reason: 'not_found', message: 'That play is no longer in the playbook.' };
  }
  return { ok: false, reason: 'error', message: "Couldn't load this play. Try again." };
}

/**
 * Download one team play. A player opens every play this way, so each tap is
 * checked against their sign-in as it is right now.
 */
export async function fetchTeamPlay(id, opts = {}) {
  const token = siteToken();
  if (!token) return { ok: false, reason: 'auth', message: 'Your sign-in has ended. Sign in again.' };
  return teamPlayResult(await callScript(CONFIG.gate.url, { action: 'play', token, id }, opts));
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

/** What the UI should say for each way a save can fail. */
export function saveMessage(result, book = 'team') {
  const label = BOOK_LABEL[book] || BOOK_LABEL.team;
  if (!result.ok) return `Couldn't reach the ${label}. Try again.`;

  const data = result.data || {};
  if (data.ok) return '';

  switch (data.reason) {
    case 'auth':
    // The admin playbook answers a lapsed admin session exactly like a missing
    // action, so that is what an expired admin sign-in looks like from here.
    case 'unknown_action':
      return 'Your sign-in has expired. Sign in again to save.';
    case 'too_big':
      return `This play is too large to save to the ${label}. Split it into two plays or remove frames.`;
    case 'not_found':
      return `That play is no longer in the ${label}. Refresh to see the current list.`;
    default:
      return `Couldn't save this play to the ${label}.`;
  }
}

/**
 * Add or replace one play in a book.
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function saveTeamPlay(play, book = 'team') {
  const token = changeToken(book);
  if (!token) return { ok: false, message: `Sign in to save to the ${BOOK_LABEL[book]}.` };

  const result = await callScript(CONFIG.gate.url, withBook({ action: 'savePlay', token, play }, book));
  const message = saveMessage(result, book);
  return { ok: message === '', message };
}

/** Remove one play from a book. */
export async function deleteTeamPlay(id, book = 'team') {
  const token = changeToken(book);
  if (!token) return { ok: false, message: `Sign in to remove from the ${BOOK_LABEL[book]}.` };

  const result = await callScript(CONFIG.gate.url, withBook({ action: 'deletePlay', token, id }, book));
  if (!result.ok) return { ok: false, message: `Couldn't reach the ${BOOK_LABEL[book]}. Try again.` };
  if (!result.data?.ok) {
    return {
      ok: false,
      message: ['auth', 'unknown_action'].includes(result.data?.reason)
        ? 'Your sign-in has expired. Sign in again to remove.'
        : "Couldn't remove this play.",
    };
  }
  return { ok: true, message: '' };
}

/**
 * Move a play between the team playbook and the admin playbook, in one script
 * call that copies and then deletes under a lock. Admin only.
 */
export async function movePlay(id, from, to) {
  const token = adminToken();
  if (!token) return { ok: false, message: 'Sign in again to move plays.' };

  const result = await callScript(CONFIG.gate.url, { action: 'movePlay', token, id, from, to });
  const message = saveMessage(result, to);
  return { ok: message === '', message };
}
