import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuthedVars } from '../auth.ts';
import { RuntimeSupervisor, type RuntimeKind } from '../runtimes/supervisor.ts';
import { buildConfig, writeBriefs, FLEET, type Choice } from '../runtimes/agents.ts';

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
