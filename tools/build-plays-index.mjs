#!/usr/bin/env node
/**
 * Generate plays/index.json from the play files in plays/.
 *
 * Adding a team play means dropping one .json file into plays/ — the index is
 * never hand-edited, so it can't drift out of sync with what's actually there.
 * Run by the Pages workflow before deploy; safe to run locally too.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const playsDir = join(root, 'plays');
const indexPath = join(playsDir, 'index.json');

let files = [];
try {
  files = (await readdir(playsDir))
    .filter((f) => f.endsWith('.json') && f !== 'index.json')
    .sort();
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
  // No plays/ directory yet — nothing to index, and that's not a failure.
  console.log('plays/ not found; nothing to index.');
  process.exit(0);
}

const entries = [];
const skipped = [];

for (const file of files) {
  try {
    const play = JSON.parse(await readFile(join(playsDir, file), 'utf8'));
    entries.push({
      file,
      id: play.id || file.replace(/\.json$/, ''),
      name: play.name || file.replace(/\.json$/, ''),
      category: play.category || '',
      tags: Array.isArray(play.tags) ? play.tags : [],
      notes: play.notes || '',
      courtType: play.courtType || 'half',
      frames: Array.isArray(play.frames) ? play.frames.length : 0,
      updatedAt: play.updatedAt || null,
    });
  } catch (err) {
    // One malformed file must not take the whole deploy down with it.
    skipped.push(`${file}: ${err.message}`);
  }
}

await writeFile(
  indexPath,
  JSON.stringify({ generated: new Date().toISOString(), plays: entries }, null, 2) + '\n',
);

console.log(`Indexed ${entries.length} play${entries.length === 1 ? '' : 's'} -> plays/index.json`);
for (const s of skipped) console.warn(`  skipped ${s}`);
