/**
 * Publishing a play to the team playbook.
 *
 * A static site can't write to the repo, so publishing hands the work to
 * GitHub's own editor with the path and content already filled in. The only
 * judgement here is *which* GitHub page to open, and that turns on identity:
 * a play is its `id`, not its filename.
 */

export const REPO = { owner: 'loganbrose', repo: 'basketball', branch: 'Main' };

/**
 * GitHub rejects very long URLs. A three-frame play is ~6KB pretty-printed and
 * percent-encoding inflates it further, so past this the content goes via the
 * clipboard instead of the query string.
 */
export const URL_LIMIT = 7500;

/** Safe-ish filename from a play name. Mirrors library.js slugify. */
export function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'play';
}

/** Where a play lives on the site. A blank playbook means the plays/ root. */
export function playPath(play, playbookSlug = '') {
  const file = `${slugify(play.name)}.json`;
  return playbookSlug ? `plays/${playbookSlug}/${file}` : `plays/${file}`;
}

export function playbookPath(playbookSlug) {
  return `plays/${playbookSlug}/playbook.json`;
}

const base = ({ owner, repo } = REPO) => `https://github.com/${owner}/${repo}`;

export function newFileUrl(path, content, repoCfg = REPO) {
  // encodeURIComponent, not URLSearchParams: the latter encodes spaces as "+",
  // which only decodes back to a space under form-urlencoded rules. For JSON
  // travelling in a query string, %20 is unambiguous either way.
  const parts = [`filename=${encodeURIComponent(path)}`];
  if (content != null) parts.push(`value=${encodeURIComponent(content)}`);
  return `${base(repoCfg)}/new/${repoCfg.branch}?${parts.join('&')}`;
}

export function editFileUrl(path, repoCfg = REPO) {
  return `${base(repoCfg)}/edit/${repoCfg.branch}/${path}`;
}

export function fileUrl(path, repoCfg = REPO) {
  return `${base(repoCfg)}/blob/${repoCfg.branch}/${path}`;
}

/** What actually gets committed: compact, because it travels through a URL. */
export function minify(play) {
  return JSON.stringify(play);
}

/**
 * Decide how to publish one play.
 *
 * Resolved against the team index so that re-publishing an edited play updates
 * it rather than silently forking it into a second file.
 *
 * - `update`   — the same `id` is already on the site. Open its edit page with
 *                the new content on the clipboard.
 * - `conflict` — a *different* play already owns that filename. Refuse and ask
 *                for another name rather than overwriting someone's work.
 * - `create`   — not on the site. Prefill the new-file page.
 * - `create`   with `clipboardOnly` when the content is too long for a URL.
 *
 * @param {Object} play
 * @param {Object[]} teamPlays entries with at least {id, path}
 * @param {{playbook?: string, playbookExists?: boolean, repo?: Object}} opts
 * @returns {{action:string, url:string|null, clipboard:string|null,
 *            message:string, path:string, clipboardOnly:boolean,
 *            playbookUrl?: string|null, conflictWith?: Object}}
 */
export function publishPlan(play, teamPlays = [], opts = {}) {
  const repoCfg = opts.repo || REPO;
  const playbook = opts.playbook || '';
  const path = playPath(play, playbook);
  const content = minify(play);

  // Identity first: the same play, wherever it currently sits on the site.
  const sameId = teamPlays.find((t) => t.id && play.id && t.id === play.id);
  if (sameId) {
    const target = sameId.path || path;
    return {
      action: 'update',
      path: target,
      url: editFileUrl(target, repoCfg),
      clipboard: content,
      clipboardOnly: true,
      message: 'Copied. Select all in the editor, paste, and commit.',
    };
  }

  // Same filename, different play — publishing would overwrite it.
  const sameSlug = teamPlays.find((t) => (t.path || '') === path);
  if (sameSlug) {
    return {
      action: 'conflict',
      path,
      url: null,
      clipboard: null,
      clipboardOnly: false,
      conflictWith: sameSlug,
      message: `“${sameSlug.name || path}” already uses this filename. Rename this play before publishing.`,
    };
  }

  // A playbook folder that doesn't exist yet needs its playbook.json first.
  const playbookUrl = playbook && opts.playbookExists === false
    ? newFileUrl(
      playbookPath(playbook),
      JSON.stringify({ name: opts.playbookName || playbook, description: '', order: 99 }),
      repoCfg,
    )
    : null;

  const prefilled = newFileUrl(path, content, repoCfg);
  if (prefilled.length <= URL_LIMIT) {
    return {
      action: 'create',
      path,
      url: prefilled,
      clipboard: content,
      clipboardOnly: false,
      playbookUrl,
      message: playbookUrl
        ? 'Two commits: the playbook first, then the play.'
        : 'Review the file on GitHub and commit.',
    };
  }

  // Too long to prefill. The clipboard works on a phone; dragging a downloaded
  // file into a browser does not.
  return {
    action: 'create',
    path,
    url: newFileUrl(path, null, repoCfg),
    clipboard: content,
    clipboardOnly: true,
    playbookUrl,
    message: 'Copied. Paste into the editor and commit.',
  };
}

/**
 * Mark which device plays already exist on the site, by `id`.
 *
 * A device copy that's newer than the published one is an unpublished edit —
 * worth saying, because otherwise it looks identical to a stale duplicate.
 */
export function markPublished(devicePlays, teamPlays = []) {
  const byId = new Map(teamPlays.filter((t) => t.id).map((t) => [t.id, t]));
  return devicePlays.map((play) => {
    const team = byId.get(play.id);
    if (!team) return { ...play, published: false, newerThanTeam: false };
    return {
      ...play,
      published: true,
      newerThanTeam: String(play.updatedAt || '') > String(team.updatedAt || ''),
      teamPath: team.path || null,
    };
  });
}

/**
 * One card per play for a merged view: the team version wins, but a newer
 * device copy is flagged rather than hidden — that's the coach's own unpublished
 * work and quietly showing the older file would lose it.
 */
export function mergeById(devicePlays = [], teamPlays = []) {
  const out = [];
  const deviceById = new Map(devicePlays.filter((p) => p.id).map((p) => [p.id, p]));

  for (const team of teamPlays) {
    const device = team.id ? deviceById.get(team.id) : null;
    out.push({
      ...team,
      source: 'team',
      hasDeviceCopy: Boolean(device),
      deviceNewer: Boolean(device) && String(device.updatedAt || '') > String(team.updatedAt || ''),
    });
    if (device) deviceById.delete(team.id);
  }

  for (const play of devicePlays) {
    if (play.id && !deviceById.has(play.id)) continue; // already represented by its team version
    out.push({ ...play, source: 'device', hasDeviceCopy: true, deviceNewer: false });
  }

  return out;
}
