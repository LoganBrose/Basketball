/**
 * Copy the servable site into dist/.
 *
 * This exists because Cloudflare treats the repo root as its assets directory
 * and walks everything under it — including the node_modules the build
 * container installs, where a 125 MiB `workerd` binary blows past a 25 MiB
 * per-asset limit. The fix is a directory boundary rather than an ignore file:
 * node_modules is not excluded from dist/, it is simply not in it.
 *
 * The list below is a WHITELIST on purpose. A new top-level folder is left out
 * by default rather than silently published, which is also how tests/, tools/,
 * apps-script/ and .github/ stay off the public site.
 *
 * Both hosts publish dist/: Cloudflare Pages via its build settings, and GitHub
 * Pages via .github/workflows/pages.yml.
 */

import { cpSync, existsSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

/** Everything the site actually serves, and nothing else. */
const INCLUDE = [
  'index.html',
  'stats.html',
  'playbook.html',
  'admin.html',
  'assets',
  'data',
  'plays',        // only exists when sign-in is off and plays are published as files
  '.nojekyll',
];

/** Cloudflare's per-asset ceiling — the limit this whole file exists to respect. */
const MAX_ASSET_BYTES = 25 * 1024 * 1024;

function largestFile(dir) {
  let worst = { path: '', size: 0 };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = largestFile(full);
      if (inner.size > worst.size) worst = inner;
    } else {
      const { size } = statSync(full);
      if (size > worst.size) worst = { path: full, size };
    }
  }
  return worst;
}

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const copied = [];
const missing = [];

for (const name of INCLUDE) {
  const from = join(ROOT, name);
  if (!existsSync(from)) {
    missing.push(name);
    continue;
  }
  cpSync(from, join(DIST, name), { recursive: true });
  copied.push(name);
}

const worst = largestFile(DIST);
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MiB`;

console.log(`dist/ ← ${copied.join(', ')}`);
if (missing.length) {
  // Not fatal: plays/ only exists when sign-in is off.
  console.log(`not present, skipped: ${missing.join(', ')}`);
}
console.log(`largest file: ${relative(DIST, worst.path) || '(none)'} — ${mb(worst.size)}`);

if (worst.size > MAX_ASSET_BYTES) {
  console.error(`\nERROR: ${relative(DIST, worst.path)} is ${mb(worst.size)}, over Cloudflare's ${mb(MAX_ASSET_BYTES)} limit.`);
  process.exit(1);
}
