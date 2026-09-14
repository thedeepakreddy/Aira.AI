/**
 * The coding agent, hosted, with a workspace of its own.
 *
 * This is the one surface that could not simply be moved. The desktop's coding
 * agent works on the user's files; a web page has none, and a browser cannot
 * reach the machine it is running on. So the shape has to change: the project
 * lives on the server, seeded from a git repository or a starter, and the agent
 * works there. That is the same trade every browser IDE makes.
 *
 * What follows from that, and is worth being explicit about:
 *
 * **It is not your laptop.** Nothing here touches the user's own files, and
 * nothing they do here changes them. A project reaches this workspace by being
 * cloned into it and leaves by being pushed back out.
 *
 * **The approval model does not relax.** The desktop asks before every edit and
 * every command, and so does this. A hosted agent is not more trusted for being
 * further away — if anything less, since the user cannot see the machine.
 *
 * **The workspace is disposable.** It is reaped with the runtime, so anything
 * that matters has to be committed and pushed. The panel says so rather than
 * letting someone discover it.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Long enough for a real repository, short enough that a hung clone gives up. */
const CLONE_TIMEOUT_MS = 90_000;

/**
 * Only public HTTPS repositories.
 *
 * An ssh remote would need the server's key, which would be one key for every
 * user — and a `file://` or a path would let a request read the server's own
 * disk. Neither is a thing to allow because it was convenient.
 */
export function cloneable(url: string): boolean {
  if (!/^https:\/\//i.test(url)) return false;
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return false;
    // A credential in a URL would be written into the workspace's git config
    // and then live as long as the workspace does.
    return /^[\w.-]+\.[a-z]{2,}$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

/** A starter, for someone with nothing to clone. */
export function writeStarter(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), [
    '# New project',
    '',
    'This workspace lives on Aira\'s server, not on your machine.',
    '',
    'Anything you want to keep has to be committed and pushed — the workspace is',
    'removed when the runtime is reaped, which happens after a period of no use.',
  ].join('\n'), 'utf8');
  writeFileSync(join(dir, 'index.html'), [
    '<!doctype html>',
    '<meta charset="utf-8">',
    '<title>New project</title>',
    '<h1>New project</h1>',
    '<p>Ask the coding agent to build something here.</p>',
  ].join('\n'), 'utf8');
}

/**
 * Puts a project in the workspace.
 *
 * Returns where it landed. A failed clone is reported rather than silently
 * leaving an empty directory the agent would then "fix" by inventing a project.
 */
export async function seedWorkspace(stateDir: string, repo?: string): Promise<string> {
  const project = join(stateDir, 'project');
  if (existsSync(join(project, '.git')) || existsSync(join(project, 'README.md'))) return project;

  if (!repo) {
    writeStarter(project);
    return project;
  }
  if (!cloneable(repo)) {
    throw new Error('Only public https:// repositories can be opened here. Private repositories need the desktop app.');
  }
  mkdirSync(stateDir, { recursive: true });
  try {
    await run('git', ['clone', '--depth', '1', repo, project], { timeout: CLONE_TIMEOUT_MS });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // The remote's own words, trimmed: "repository not found" is far more use
    // than "clone failed".
    throw new Error(`Could not clone that repository. ${detail.split('\n').slice(-2).join(' ').slice(0, 200)}`);
  }
  return project;
}

/**
 * The config a hosted coding agent runs under.
 *
 * The permission block is the desktop's, unchanged and deliberately so. The one
 * difference is `external_directory`, which is denied here rather than asked:
 * on a laptop reaching outside the project is a question worth putting to the
 * user, and on a shared server the rest of the disk belongs to other people.
 */
export function buildConfig(options: {
  gatewayUrl: string;
  token: string;
  model: string;
  catalogue: string[];
}): string {
  const { gatewayUrl, token, model, catalogue } = options;
  const base = gatewayUrl.replace(/\/+$/, '');
  const models: Record<string, unknown> = {};
  for (const id of catalogue.length ? catalogue : [model]) {
    models[id] = { name: id === model ? 'Aira Agent' : id };
  }
  return JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: {
      aira: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Aira Gateway',
        options: { baseURL: `${base}/openai/code/v1`, apiKey: token },
        models,
      },
    },
    model: `aira/${model}`,
    mcp: {
      aira_memory: {
        type: 'remote',
        url: `${base}/mcp`,
        headers: { Authorization: `Bearer ${token}` },
        oauth: false,
      },
    },
    permission: {
      '*': 'ask',
      read: 'allow',
      list: 'allow',
      glob: 'allow',
      grep: 'allow',
      lsp: 'allow',
      edit: 'ask',
      bash: 'ask',
      task: 'ask',
      webfetch: 'deny',
      websearch: 'deny',
      // Denied rather than asked, unlike the desktop. On a laptop the rest of
      // the disk is the user's own; here it belongs to other people.
      external_directory: 'deny',
      'aira_memory*': 'ask',
    },
  });
}
