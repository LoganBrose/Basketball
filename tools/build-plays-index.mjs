#!/usr/bin/env node
/**
 * Generate plays/index.json from the playbook folders under plays/.
 *
 * Each playbook is a folder holding a playbook.json and its play files. Adding
 * a play means dropping one file in; the index is never hand-edited, so it
 * can't drift out of sync with what's actually there.
 *
 *   plays/
 *     general/       playbook.json + *.json
 *     zone-offense/  playbook.json + *.json
 *     index.json     generated
 *
 * Run by the Pages workflow before deploy; safe to run locally.
 */

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const playsDir = join(root, 'plays');
const indexPath = join(playsDir, 'index.json');

/** The folder loose files get swept into, so nothing published disappears. */
const FALLBACK = { slug: 'general', name: 'General', description: '', order: 1 };

const warnings = [];

/** Summary of one play, small enough that the index stays cheap to fetch. */
async function readPlay(dir, file, slug) {
  try {
    const play = JSON.parse(await readFile(join(dir, file), 'utf8'));
    return {
      file,
      // The path the site fetches, and the path publishing edits.
      path: slug ? `plays/${slug}/${file}` : `plays/${file}`,
      id: play.id || file.replace(/\.json$/, ''),
      name: play.name || file.replace(/\.json$/, ''),
      category: play.category || '',
      tags: Array.isArray(play.tags) ? play.tags : [],
      notes: play.notes || '',
      courtType: play.courtType || 'half',
      frames: Array.isArray(play.frames) ? play.frames.length : 0,
      updatedAt: play.updatedAt || null,
    };
  } catch (err) {
    // One malformed file must not take the whole deploy down with it.
    warnings.push(`${slug ? slug + '/' : ''}${file}: ${err.message}`);
    return null;
  }
}

const jsonFiles = (names) => names.filter((f) => f.endsWith('.json') && f !== 'index.json' && f !== 'playbook.json').sort();

async function readPlaybookMeta(dir, slug) {
  try {
    const meta = JSON.parse(await readFile(join(dir, 'playbook.json'), 'utf8'));
    return {
      slug,
      name: meta.name || slug,
      description: meta.description || '',
      order: Number.isFinite(meta.order) ? meta.order : 99,
    };
  } catch {
    // A folder without a playbook.json is still a playbook — titled from its
    // own name rather than skipped, so plays in it still publish.
    return { slug, name: slug, description: '', order: 99 };
  }
}

let entries;
try {
  entries = await readdir(playsDir, { withFileTypes: true });
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
  console.log('plays/ not found; nothing to index.');
  process.exit(0);
}

const playbooks = [];

for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  const dir = join(playsDir, entry.name);
  const meta = await readPlaybookMeta(dir, entry.name);
  const files = jsonFiles(await readdir(dir));
  const plays = (await Promise.all(files.map((f) => readPlay(dir, f, entry.name)))).filter(Boolean);
  playbooks.push({ ...meta, plays });
}

// Loose files at the plays/ root belong to somebody. Sweeping them into
// General means a play dropped in the wrong place still publishes instead of
// silently vanishing.
const looseFiles = jsonFiles(entries.filter((e) => e.isFile()).map((e) => e.name));
if (looseFiles.length) {
  const loose = (await Promise.all(looseFiles.map((f) => readPlay(playsDir, f, '')))).filter(Boolean);
  const general = playbooks.find((p) => p.slug === FALLBACK.slug);
  if (general) general.plays.push(...loose);
  else playbooks.push({ ...FALLBACK, plays: loose });
  console.log(`Swept ${loose.length} loose file(s) at the plays/ root into "${FALLBACK.slug}".`);
}

playbooks.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

const totalPlays = playbooks.reduce((n, p) => n + p.plays.length, 0);

await writeFile(
  indexPath,
  JSON.stringify({ generated: new Date().toISOString(), playbooks }, null, 2) + '\n',
);

console.log(
  `Indexed ${totalPlays} play${totalPlays === 1 ? '' : 's'} across ` +
  `${playbooks.length} playbook${playbooks.length === 1 ? '' : 's'} -> plays/index.json`,
);
for (const w of warnings) console.warn(`  skipped ${w}`);
