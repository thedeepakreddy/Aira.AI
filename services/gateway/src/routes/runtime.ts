import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AuthedVars } from '../auth.ts';
import { RuntimeSupervisor, type RuntimeKind } from '../runtimes/supervisor.ts';
import { buildConfig, writeBriefs, FLEET, type Choice } from '../runtimes/agents.ts';
import { buildConfig as buildCodeConfig, seedWorkspace } from '../runtimes/code.ts';
import { planFor, serveStatic, withBase, PREVIEW_BASE } from '../runtimes/preview.ts';

/**
 * The desktop's command vocabulary, served over HTTP.
 *
 * The web client speaks exactly the same command names the Tauri shell does —
 * `openclaw_start`, `browser_api`, and the rest — so every panel works unchanged
 * whichever it is talking to. That is the whole point of dispatching by name
 * here rather than designing a fresh REST surface: a second API shape would
 * mean every panel growing a branch for which one it is on, and those branches
 * are where the two builds drift apart.
 *
 * Commands that cannot be honoured on a server answer plainly rather than
 * pretending. A hosted fleet is reaped when idle, so it cannot keep a schedule;
 * saying so beats accepting one and silently never firing it.
 */
export function createRuntimeRoutes(supervisor: RuntimeSupervisor, gatewayUrl: string) {
  const routes = new Hono<{ Variables: AuthedVars }>();

  /** Finds a binary the way a login shell would, since a service has a thin PATH. */
  function binary(name: string): string {
    return name;
  }

  /** The browser service ships with the repo rather than being installed. */
  function browserScript(): string {
    return process.env.AIRA_BROWSER_SCRIPT
      ?? new URL('../../../browser/server.py', import.meta.url).pathname;
  }

  /**
   * The interpreter that actually has the browser library.
   *
   * `python3` on PATH is almost never it: the dependency is heavy and lives in
   * a virtualenv, which is how the desktop installs it too. Launching the wrong
   * interpreter starts a service that answers health checks and fails every
   * real call with "No module named 'browser_use'" — a failure that looks like
   * the browser is broken rather than absent.
   */
  function browserPython(): string {
    const home = process.env.HOME ?? '';
    const candidates = [
      process.env.AIRA_BROWSER_PYTHON,
      home ? `${home}/.aira/browser/venv/bin/python` : undefined,
      '/usr/bin/python3',
      'python3',
    ].filter((path): path is string => Boolean(path));
    for (const candidate of candidates) {
      if (candidate.includes('/') && !existsSync(candidate)) continue;
      return candidate;
    }
    return 'python3';
  }

  async function proxy(port: number, token: string, path: string, init?: RequestInit): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  }

  /** Starts the fleet for this user, or returns the one already running. */
  async function startAgents(userId: string, args: Record<string, unknown>) {
    const model = String(args.model ?? '');
    const token = String(args.token ?? '');
    if (!model) throw new Error('A model is required to start agents.');
    const catalogue: Choice[] = (args.catalogue as string[] ?? []).flatMap((entry) => {
      const [id, tier, provider = ''] = entry.split('|');
      return id && tier ? [{ id, tier, provider }] : [];
    });

    const running = await supervisor.start(userId, 'agents', ({ port, token: secret, stateDir }) => {
      const workspace = join(stateDir, 'workspace');
      writeBriefs(workspace);
      const config = buildConfig({
        gatewayUrl, token, model, catalogue, port, workspace,
        localOnly: Boolean(args.localOnly),
      });
      const configPath = join(stateDir, 'openclaw.json');
      writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
      return {
        command: binary('openclaw'),
        args: ['gateway', '--port', String(port), '--bind', 'loopback', '--auth', 'token'],
        env: {
          OPENCLAW_STATE_DIR: join(stateDir, 'state'),
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_GATEWAY_TOKEN: secret,
          // Substituted into the config's ${AIRA_TOKEN} at load, so the session
          // token is never written to disk.
          AIRA_TOKEN: token,
        },
        cwd: workspace,
      };
    });
    return { running: true, port: running.port, token: running.token, binary: 'openclaw', model, fleet: FLEET.length };
  }

  const handlers: Record<string, (userId: string, args: Record<string, unknown>) => Promise<unknown>> = {
    // ── agents ──────────────────────────────────────────────────────────────
    openclaw_status: async (userId) => {
      const running = supervisor.get(userId, 'agents');
      return running
        ? { running: true, port: running.port, token: running.token, binary: 'openclaw', model: null, fleet: FLEET.length }
        : { running: false, port: null, token: null, binary: 'openclaw', model: null, fleet: FLEET.length };
    },
    openclaw_start: (userId, args) => startAgents(userId, args),
    openclaw_stop: async (userId) => { supervisor.stop(userId, 'agents'); return null; },
    openclaw_log: async (userId) => supervisor.get(userId, 'agents')?.log ?? [],

    openclaw_agents: async (userId) => {
      const running = supervisor.get(userId, 'agents');
      if (!running) throw new Error('The agent runtime is not running.');
      const response = await proxy(running.port, running.token, '/v1/models');
      if (!response.ok) throw new Error(`The agent refused the request: ${response.status}`);
      const body = await response.json() as { data?: Array<{ id?: string }> };
      return (body.data ?? [])
        .map((m) => m.id ?? '')
        // Two aliases for the same worker; listing either alongside the named
        // team puts a second card on the board for an agent already there.
        .filter((id) => id.includes('/') && !id.endsWith('/default'))
        .map((id) => {
          const slug = id.split('/').slice(1).join('/');
          return { id, name: FLEET.find((m) => m.id === slug)?.name ?? slug };
        });
    },

    openclaw_run: async (userId, args) => {
      const running = supervisor.get(userId, 'agents');
      if (!running) throw new Error('The agent runtime is not running.');
      const response = await proxy(running.port, running.token, '/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: String(args.agent ?? ''),
          messages: [{ role: 'user', content: String(args.message ?? '') }],
        }),
      });
      const body = await response.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
      if (body.error) throw new Error(body.error.message ?? 'The agent failed.');
      return body.choices?.[0]?.message?.content ?? '';
    },

    // Cron is off for a hosted fleet, which is reaped when idle. Accepting a
    // schedule the server would silently never fire is worse than refusing.
    openclaw_schedules: async () => [],
    openclaw_schedule_add: async () => {
      throw new Error('Scheduled runs need the desktop app — a hosted fleet sleeps when you are away.');
    },
    openclaw_schedule_remove: async () => {
      throw new Error('Scheduled runs need the desktop app.');
    },
    openclaw_cancel: async () => null,

    // ── code ────────────────────────────────────────────────────────────────
    /*
     * The coding agent on a workspace the server owns.
     *
     * Seeded from a public repository, or a starter for someone with nothing to
     * clone. Every edit and command still asks, exactly as on the desktop — a
     * hosted agent is not more trusted for being further away.
     */
    opencode_start: async (userId, args) => {
      // Seeded before the process starts, because a clone is asynchronous and
      // because OpenCode's working directory has to exist when it launches.
      const project = await seedWorkspace(
        supervisor.pathFor(userId, 'code'),
        typeof args.repo === 'string' && args.repo.trim() ? args.repo.trim() : undefined,
      );
      const running = await supervisor.start(userId, 'code', ({ port, token }) => ({
        command: binary('opencode'),
        args: ['serve', '--port', String(port), '--hostname', '127.0.0.1'],
        env: {
          OPENCODE_SERVER_PASSWORD: token,
          OPENCODE_CONFIG_CONTENT: buildCodeConfig({
            gatewayUrl,
            token: String(args.token ?? ''),
            model: String(args.model ?? ''),
            catalogue: (args.catalogue as string[]) ?? [],
          }),
        },
        cwd: project,
      }));
      return { running: true, port: running.port, password: running.token, directory: project, binary: 'opencode' };
    },
    opencode_status: async (userId) => {
      const running = supervisor.get(userId, 'code');
      return running
        ? { running: true, port: running.port, password: running.token, directory: join(running.stateDir, 'project'), binary: 'opencode' }
        : { running: false, port: null, password: null, directory: null, binary: 'opencode' };
    },
    opencode_stop: async (userId) => { supervisor.stop(userId, 'code'); return null; },
    opencode_log: async (userId) => supervisor.get(userId, 'code')?.log ?? [],

    /*
     * Running the project, so the loop closes.
     *
     * A dev server is started only when the project has one; plain files are
     * served by this process, because spawning npm to hand back two files would
     * be absurd. Either way it answers under the same path.
     */
    preview_start: async (userId) => {
      const project = join(supervisor.pathFor(userId, 'code'), 'project');
      if (!existsSync(project)) throw new Error('Connect the coding agent first — there is no project to preview.');
      const plan = planFor(project, 0);
      if (plan.kind === 'static') {
        // Nothing to supervise. The route reads from disk on each request, so
        // a file the agent just wrote is live immediately.
        return { running: true, kind: 'static', url: `${PREVIEW_BASE}/` };
      }
      const running = await supervisor.start(userId, 'preview', ({ port }) => {
        const planned = planFor(project, port);
        return { command: planned.command, args: planned.args, env: planned.env, cwd: project };
      });
      return { running: true, kind: 'dev-server', port: running.port, url: `${PREVIEW_BASE}/` };
    },
    preview_stop: async (userId) => { supervisor.stop(userId, 'preview'); return null; },
    preview_status: async (userId) => {
      const project = join(supervisor.pathFor(userId, 'code'), 'project');
      const running = supervisor.get(userId, 'preview');
      return {
        available: existsSync(project),
        running: Boolean(running) || existsSync(project),
        kind: running ? 'dev-server' : 'static',
        url: `${PREVIEW_BASE}/`,
      };
    },
    preview_log: async (userId) => supervisor.get(userId, 'preview')?.log ?? [],

    // ── browser ─────────────────────────────────────────────────────────────
    /*
     * One browser per user, shared between them and the agent.
     *
     * The service already holds a single session and hands that same session to
     * the agent, so a tab the agent opens is a tab the user is looking at and
     * the other way round. That is the whole reason this is worth hosting
     * rather than giving the agent a second, invisible browser: an agent
     * working in a window you cannot see is one you cannot stop.
     *
     * Headless here, because there is no screen on a server — the panel already
     * drives it by screenshot and synthetic input, which is the same way it
     * works on a laptop.
     */
    browser_start: async (userId, args) => {
      const running = await supervisor.start(userId, 'browser', ({ port, token, stateDir }) => ({
        command: browserPython(),
        args: [browserScript()],
        env: {
          AIRA_BROWSER_PORT: String(port),
          AIRA_BROWSER_TOKEN: token,
          AIRA_BROWSER_HEADLESS: '1',
          AIRA_GATEWAY_URL: gatewayUrl,
          AIRA_BROWSER_MODEL: String(args.model ?? ''),
          AIRA_BROWSER_STATE: stateDir,
          AIRA_TOKEN: String(args.token ?? ''),
        },
      }));
      return { running: true, port: running.port, token: running.token, python: browserPython() };
    },
    browser_status: async (userId) => {
      const running = supervisor.get(userId, 'browser');
      return running
        ? { running: true, port: running.port, token: running.token, python: browserPython() }
        : { running: false, port: null, token: null, python: browserPython() };
    },
    browser_stop: async (userId) => { supervisor.stop(userId, 'browser'); return null; },
    browser_log: async (userId) => supervisor.get(userId, 'browser')?.log ?? [],

    /** The panel's own calls — screenshots, tabs, navigation, input. */
    browser_api: async (userId, args) => {
      const running = supervisor.get(userId, 'browser');
      if (!running) throw new Error('The browser is not running.');
      const path = String(args.path ?? '');
      // The path comes from the panel, but this proxies onto a loopback service
      // that trusts whatever it is asked — so it may only ever be a path.
      if (!path.startsWith('/') || path.includes('..')) throw new Error('Invalid browser path.');
      const method = String(args.method ?? 'GET');
      const response = await proxy(running.port, running.token, path, {
        method,
        ...(method === 'POST' && args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
      });
      if (!response.ok) throw new Error(`The browser refused the request: ${response.status}`);
      return response.json().catch(() => null);
    },

    browser_run: async (userId, args) => {
      const running = supervisor.get(userId, 'browser');
      if (!running) throw new Error('The browser is not running.');
      const response = await proxy(running.port, running.token, '/run', {
        method: 'POST',
        body: JSON.stringify({ task: String(args.task ?? ''), run: String(args.run ?? '') }),
      });
      if (!response.ok) throw new Error(`The browser refused the task: ${response.status}`);
      return response.json().catch(() => null);
    },

    // ── the fleet editor ────────────────────────────────────────────────────
    // Custom agents are a desktop feature for now: they are stored in a file
    // next to the app, and a hosted equivalent needs a per-user store this
    // route does not have yet. Reporting the built-in six is honest; claiming
    // an empty list the user could add to would not be.
    fleet_list: async () => ({
      members: FLEET.map((m) => ({ ...m, custom: false })),
      grantable: [], tiers: ['frontier', 'balanced', 'fast'], max_custom: 0, used: 0,
    }),
    fleet_add: async () => { throw new Error('Adding agents needs the Aira desktop app.'); },
    fleet_remove: async () => { throw new Error('Adding agents needs the Aira desktop app.'); },
  };

  routes.post('/invoke', async (c) => {
    const userId = c.get('userId');
    if (!userId) return c.json({ error: 'Sign in to use hosted runtimes.' }, 401);
    const body = await c.req.json().catch(() => null) as { command?: string; args?: Record<string, unknown> } | null;
    const command = body?.command ?? '';
    const handler = handlers[command];
    if (!handler) {
      return c.json({ error: `${command || 'That'} is not available on the web. It needs the Aira desktop app.` }, 501);
    }
    try {
      return c.json({ result: await handler(userId, body?.args ?? {}) });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  });

  /**
   * The streaming half.
   *
   * `openclaw_stream` cannot go through /invoke — it produces deltas, and the
   * desktop delivers them over a Tauri channel. Here they arrive as SSE, which
   * is the shape the rest of this app already streams in.
   */
  routes.post('/stream', async (c) => {
    const userId = c.get('userId');
    if (!userId) return c.json({ error: 'Sign in to use hosted runtimes.' }, 401);
    const body = await c.req.json().catch(() => null) as { agent?: string; message?: string } | null;
    const running = supervisor.get(userId, 'agents');
    if (!running) return c.json({ error: 'The agent runtime is not running.' }, 409);

    return streamSSE(c, async (sse) => {
      try {
        const upstream = await proxy(running.port, running.token, '/v1/chat/completions', {
          method: 'POST',
          body: JSON.stringify({
            model: String(body?.agent ?? ''),
            messages: [{ role: 'user', content: String(body?.message ?? '') }],
            stream: true,
          }),
        });
        if (!upstream.ok || !upstream.body) throw new Error(`The agent refused the request: ${upstream.status}`);
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // Frames are newline-delimited; a chunk can split one in half, so the
          // tail is kept until it is complete.
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();
            if (payload === '[DONE]') continue;
            try {
              const frame = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
              const delta = frame.choices?.[0]?.delta?.content;
              if (delta) await sse.writeSSE({ data: JSON.stringify({ delta }) });
            } catch { /* not a frame we need */ }
          }
        }
        await sse.writeSSE({ data: JSON.stringify({ done: true }) });
      } catch (error) {
        await sse.writeSSE({ data: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) });
      }
    });
  });

  /**
   * The preview.
   *
   * Served under a path rather than a domain, which is the compromise that
   * makes this work without DNS per user — and the reason HTML gets a <base>
   * on the way through.
   */
  routes.all('/preview/*', async (c) => {
    const userId = c.get('userId');
    if (!userId) return c.text('Sign in to see your preview.', 401);
    const project = join(supervisor.pathFor(userId, 'code'), 'project');
    const path = c.req.path.slice(`${PREVIEW_BASE}`.length) || '/';

    const dev = supervisor.get(userId, 'preview');
    if (dev) {
      // Forward to the project's own dev server, headers and all.
      const upstream = await fetch(`http://127.0.0.1:${dev.port}${path}${new URL(c.req.url).search}`, {
        method: c.req.method,
        headers: c.req.raw.headers,
        body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body,
        duplex: 'half',
      }).catch(() => null);
      if (!upstream) return c.text('The preview server is not answering yet. Give it a moment.', 503);
      const type = upstream.headers.get('content-type') ?? '';
      if (type.includes('text/html')) {
        return c.html(withBase(await upstream.text(), PREVIEW_BASE), upstream.status as 200);
      }
      return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
    }

    if (!existsSync(project)) return c.text('No project yet. Connect the coding agent first.', 404);
    const hit = serveStatic(project, path);
    if (!hit) return c.text('Not found in this project.', 404);
    if (hit.type.startsWith('text/html')) return c.html(withBase(hit.body.toString('utf8'), PREVIEW_BASE));
    return new Response(new Uint8Array(hit.body), { headers: { 'content-type': hit.type } });
  });

  /** What is running, for the workspace screen. */
  routes.get('/', async (c) => {
    const userId = c.get('userId');
    if (!userId) return c.json({ error: 'Sign in.' }, 401);
    const kinds: RuntimeKind[] = ['agents', 'code', 'browser'];
    return c.json({
      hosted: true,
      runtimes: kinds.map((kind) => {
        const running = supervisor.get(userId, kind);
        return { kind, running: Boolean(running), since: running?.startedAt ?? null };
      }),
    });
  });

  return routes;
}
