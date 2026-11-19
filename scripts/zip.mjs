// Builds dist/match-music.zip: a top-level match-music/ folder holding what WordPress needs at
// runtime (the PHP files and build/). Run through `npm run zip`, which builds first.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugin = path.join(root, 'match-music');
const out = path.join(root, 'dist', 'match-music.zip');

if (!existsSync(path.join(plugin, 'build', '.vite', 'manifest.json'))) {
  throw new Error('match-music/build is missing: run `npm run build` first (or use `npm run zip`).');
}

// Source maps would ship the whole front-end source; refuse to package them.
const maps = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.map')) maps.push(p);
  }
})(path.join(plugin, 'build'));
if (maps.length) throw new Error(`Source maps found in the build, remove them first: ${maps.join(', ')}`);

mkdirSync(path.dirname(out), { recursive: true });
rmSync(out, { force: true });

// -r recurse, -X no extra file attributes. Excludes .DS_Store, git files, source maps and logs.
// build/.vite/manifest.json is kept: the plugin reads it to find the hashed asset names.
execFileSync(
  'zip',
  ['-r', '-X', out, 'match-music', '-x', '*.DS_Store', '-x', '*/.git*', '-x', '*.map', '-x', '*.log'],
  { cwd: root, stdio: 'inherit' },
);

console.log(`Wrote ${path.relative(root, out)} (${(statSync(out).size / 1024).toFixed(0)} KB)`);
