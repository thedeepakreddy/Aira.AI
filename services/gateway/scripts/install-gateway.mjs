/**
 * Tells the Aira app where its gateway is.
 *
 * The desktop app starts the gateway itself now, which means it has to be able
 * to find it. An installed .app has no idea where the source tree lives, and
 * the source tree is exactly where it lives on the machine this is built on.
 *
 * Two modes, for the two situations:
 *
 * `--link` writes this directory's path to ~/.aira/gateway-path. Nothing is
 * copied, the .env stays the one file it already is, and an edit to the gateway
 * is live the next time the app launches. This is the right mode on a
 * development machine and it is the default here, because this project only
 * runs on one.
 *
 * `--copy` installs a standalone copy under ~/.aira/gateway, which is the shape
 * a shipped build would use — the app keeps working if the repository is moved
 * or deleted, at the cost of a second copy of the keys and of node_modules.
 */

import { existsSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const airaDir = join(homedir(), '.aira');
const pathFile = join(airaDir, 'gateway-path');
const copyDir = join(airaDir, 'gateway');

const copy = process.argv.includes('--copy');

if (!existsSync(join(root, 'src', 'index.ts'))) {
  console.error(`${root} does not look like the gateway — src/index.ts is missing.`);
  process.exit(1);
}

mkdirSync(airaDir, { recursive: true });

if (!copy) {
  writeFileSync(pathFile, root);
  console.log(`Linked.\n  ${pathFile}\n    → ${root}\n`);
} else {
  // Only what it needs to run. node_modules is the bulk of it and there is no
  // build output to carry, because the gateway runs from source.
  if (existsSync(copyDir)) rmSync(copyDir, { recursive: true, force: true });
  mkdirSync(copyDir, { recursive: true });
  for (const entry of ['src', 'scripts', 'migrations', 'node_modules', 'package.json', '.env']) {
    const from = join(root, entry);
    if (existsSync(from)) cpSync(from, join(copyDir, entry), { recursive: true });
  }
  // A stale link would win over the copy, which would be a confusing way to
  // discover that --copy did nothing.
  if (existsSync(pathFile)) rmSync(pathFile);
  console.log(`Installed a copy.\n  ${copyDir}\n`);
  console.log('The keys in .env were copied too. Re-run this after rotating them.\n');
}

console.log('Aira will start this gateway itself from now on. Open the app — there is');
console.log('nothing to connect to.\n');
console.log('If a gateway is already running on 8787, the app uses that one and leaves');
console.log('it alone, so `npm run dev` still works the way it did.');
