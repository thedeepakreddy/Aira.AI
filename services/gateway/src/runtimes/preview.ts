/**
 * Running what the agent just built, and showing it back.
 *
 * The missing half of a browser IDE. The agent can write a project into the
 * hosted workspace, and until now nobody could see it run — which makes the
 * whole loop guesswork, since the interesting failures are the ones that only
 * appear when the thing is actually rendering.
 *
 * Two kinds of project, decided by looking rather than asking:
 *
 * **One that builds itself.** A package.json with a dev script gets that script
 * run. The port is handed to it rather than discovered, because a dev server
 * that picks its own port is one this cannot proxy.
 *
 * **One that is already files.** Plain HTML, or a build output, gets a static
 * server. This is most of what a starter project is, and running `npm install`
 * to serve two files would be absurd.
 *
 * THE PATH PROBLEM, which is the whole reason this file has opinions: the
 * preview is proxied under a path, not served at a domain root, so a page
 * asking for `/assets/app.js` would miss. Vite and friends take a `--base`;
 * anything else gets a `<base>` tag injected into its HTML on the way through.
 * Neither is perfect, and the comments say where each gives up.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';

/** Where previews are mounted. Everything here assumes this prefix. */
export const PREVIEW_BASE = '/v1/runtime/preview';

export interface PreviewPlan {
  kind: 'dev-server' | 'static';
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * What running this project would mean.
 *
 * `npm run dev` is preferred over `start` because `start` on a Node project is
 * as often a production server as a dev one, and the point here is the loop
 * where a change shows up.
 */
export function planFor(project: string, port: number): PreviewPlan {
  const manifest = join(project, 'package.json');
  if (existsSync(manifest)) {
    try {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      const script = scripts.dev ? 'dev' : scripts.start ? 'start' : null;
      if (script) {
        const command = scripts[script] ?? '';
        // Vite, and anything that takes the same flag, can be told where it is
        // mounted. Without that its asset URLs are absolute and miss.
        const base = /vite/.test(command) ? ['--', '--base', `${PREVIEW_BASE}/`] : [];
        return {
          kind: 'dev-server',
          command: 'npm',
          args: ['run', script, ...base],
          // PORT is the near-universal convention; the flag covers Vite, which
          // ignores it.
          env: { PORT: String(port), VITE_PORT: String(port), BROWSER: 'none' },
        };
      }
    } catch {
      // A malformed package.json is not a reason to refuse a preview — the
      // files are still there, and serving them is better than nothing.
    }
  }
  return { kind: 'static', command: '', args: [], env: {} };
}

/** Content types for the static server. Narrow on purpose. */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Resolves a request path inside the project, or refuses.
 *
 * The path comes from a browser and the root is a directory on a shared
 * server, so this is the boundary that stops a preview reading the rest of the
 * disk. Normalising first and then checking the prefix is the check that
 * actually holds — rejecting ".." by substring does not, because an encoded
 * one slips past it.
 */
export function resolveInside(root: string, requested: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const full = normalize(join(root, decoded));
  // The trailing separator matters: without it "/root-evil" passes a check
  // against "/root".
  if (full !== root && !full.startsWith(root.endsWith('/') ? root : `${root}/`)) return null;
  return full;
}

export interface StaticHit {
  body: Buffer;
  type: string;
}

/**
 * Serves a file from the project.
 *
 * A directory falls back to its index.html, and a miss falls back to the
 * project's index.html — which is what makes a single-page app work at all,
 * since its routes are not files.
 */
export function serveStatic(root: string, requested: string): StaticHit | null {
  const resolved = resolveInside(root, requested);
  if (!resolved) return null;

  const candidates = [resolved];
  if (existsSync(resolved) && statSync(resolved).isDirectory()) candidates.push(join(resolved, 'index.html'));
  // The SPA fallback, last so a real file always wins.
  candidates.push(join(root, 'index.html'));

  for (const candidate of candidates) {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
    const type = TYPES[extname(candidate).toLowerCase()] ?? 'application/octet-stream';
    return { body: readFileSync(candidate), type };
  }
  return null;
}

/**
 * Points a document's relative URLs at the path it is actually mounted under.
 *
 * Only touches HTML, and only when there is no `<base>` already — a project
 * that set one meant it. Injected after `<head>` so it precedes every asset
 * reference, which is the only position where it does anything.
 *
 * This does not rescue JavaScript that builds absolute URLs at runtime. Nothing
 * short of serving at a domain root would, and that is the honest limit of
 * previewing under a path.
 */
export function withBase(html: string, base: string): string {
  if (/<base\s/i.test(html)) return html;
  const tag = `<base href="${base.endsWith('/') ? base : `${base}/`}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (match) => `${match}${tag}`);
  // No <head>, which hand-written HTML often has none of. It goes after the
  // doctype rather than before it: a doctype that is not the first thing in the
  // document is not a doctype, and the page silently renders in quirks mode —
  // which is how the first preview of the starter came back.
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return `${doctype[0]}${tag}${html.slice(doctype[0].length)}`;
  return `${tag}${html}`;
}
