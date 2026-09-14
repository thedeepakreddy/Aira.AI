/**
 * Runs the checks that start real runtimes.
 *
 * These existed and never ran. The test script globs `tests/*.test.mjs` and
 * these are named `.integration.mjs`, so nothing matched them and no CI step
 * named them — three working tests, orphaned by a naming convention.
 *
 * They are kept out of the ordinary suite on purpose. Each one launches a real
 * binary, takes seconds rather than milliseconds, and needs software that a
 * contributor may not have installed. What they must never do is fail because
 * of that: a check that goes red on a machine without OpenClaw is a check
 * people learn to ignore, which is how they end up orphaned again.
 *
 * So a missing runtime is a skip, and a skip says what was missing and how to
 * get it. The exit code counts failures only.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Finds a binary the way a login shell would; a CI shell's PATH is thin. */
function which(name) {
  try {
    return execFileSync('sh', ['-lc', `command -v ${name}`], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

/** The interpreter with browser-use, which is never the plain `python3`. */
function browserPython() {
  const candidates = [
    process.env.AIRA_BROWSER_PYTHON,
    process.env.HOME ? `${process.env.HOME}/.aira/browser/venv/bin/python` : null,
  ].filter(Boolean);
  return candidates.find((path) => existsSync(path)) ?? null;
}

/**
 * Long enough for a cold runtime, short enough that a hang is reported rather
 * than waited on. A stuck child otherwise holds CI until the job's own limit.
 */
const TIMEOUT_MS = 180_000;

const suites = [
  {
    name: 'opencode',
    file: 'tests/opencode.integration.mjs',
    needs: () => which('opencode'),
    missing: 'OpenCode is not installed — npm install -g opencode-ai',
  },
  {
    name: 'openclaw',
    file: 'tests/openclaw.integration.mjs',
    needs: () => which('openclaw'),
    missing: 'OpenClaw is not installed — npm install -g openclaw',
  },
  {
    name: 'browser',
    file: 'tests/browser-client.integration.mjs',
    needs: browserPython,
    missing: 'The browser environment is not installed — set AIRA_BROWSER_PYTHON to a python with browser-use',
    env: () => ({ AIRA_BROWSER_PYTHON: browserPython() }),
  },
];

function run(suite, found) {
  return new Promise((resolve) => {
    /*
     * The child gets the PATH that found the binary, not the one this process
     * started with.
     *
     * `which` asks a login shell, which sources the user's profile and so sees
     * far more than a CI or GUI-launched process does. Without this the two
     * disagree: detection succeeds, the child cannot execute what was detected,
     * and the suite reports a failure that is really a missing PATH entry.
     */
    const foundDir = found && found.includes('/') ? dirname(found) : null;
    const child = spawn(process.execPath, ['--experimental-strip-types', suite.file], {
      cwd: root,
      env: {
        ...process.env,
        ...(foundDir ? { PATH: `${foundDir}:${process.env.PATH ?? ''}` } : {}),
        ...(suite.env ? suite.env() : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ status: 'fail', detail: `timed out after ${TIMEOUT_MS / 1000}s`, output });
    }, TIMEOUT_MS);

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0
        ? { status: 'pass', detail: found, output }
        : { status: 'fail', detail: `exited ${code}`, output });
    });
  });
}

let failed = 0;
let skipped = 0;
let passed = 0;

for (const suite of suites) {
  const found = suite.needs();
  if (!found) {
    console.log(`- ${suite.name}: skipped — ${suite.missing}`);
    skipped += 1;
    continue;
  }
  const result = await run(suite, found);
  if (result.status === 'pass') {
    console.log(`✔ ${suite.name}: passed against ${result.detail}`);
    passed += 1;
  } else {
    console.log(`✖ ${suite.name}: ${result.detail}`);
    // The child's own output, only when it failed — these are verbose on
    // success and the useful part is the last thing they said.
    console.log(result.output.split('\n').slice(-12).map((line) => `    ${line}`).join('\n'));
    failed += 1;
  }
}

console.log(`\n${passed} passed · ${skipped} skipped · ${failed} failed`);
if (skipped && !failed) {
  console.log('Skips are not failures. Install the runtimes above to cover those paths.');
}
// Only a real failure is a failure. A machine without the runtimes is not
// broken, and pretending otherwise is how these stopped being run.
process.exit(failed ? 1 : 0);
