import type { MiddlewareHandler } from 'hono';
import type { AuthedVars } from './auth.ts';

/** Per-instance controls; a shared limiter belongs at ingress for multi-replica deployments. */
export function requestLimits(maxPerMinute: number, maxConcurrent: number): MiddlewareHandler<{ Variables: AuthedVars }> {
  const users = new Map<string, { started: number; count: number; active: number }>();
  return async (c, next) => {
    const user = c.get('userId');
    if (!user) return c.json({ error: 'Authentication required.' }, 401);
    const now = Date.now();
    for (const [id, state] of users) if (now - state.started > 60_000 && state.active === 0) users.delete(id);
    const state = users.get(user) ?? { started: now, count: 0, active: 0 };
    if (now - state.started > 60_000) { state.started = now; state.count = 0; }
    users.set(user, state);
    const isModel = c.req.method === 'POST' && (c.req.path.endsWith('/chat') || c.req.path.endsWith('/chat/completions'));
    if (state.count >= maxPerMinute || (isModel && state.active >= maxConcurrent)) {
      c.header('Retry-After', '15');
      return c.json({ error: { message: 'Too many active requests. Wait for a running request to finish and retry.', type: 'rate_limit_error' } }, 429);
    }
    state.count++;
    if (!isModel) return next();
    state.active++;
    let released = false;
    const release = () => { if (!released) { released = true; state.active--; } };
    try {
      await next();
      if (!c.res.body) { release(); return; }
      const reader = c.res.body.getReader();
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) { release(); controller.close(); }
            else controller.enqueue(chunk.value);
          } catch (error) { release(); controller.error(error); }
        },
        async cancel(reason) { release(); await reader.cancel(reason); },
      });
      c.res = new Response(stream, { status: c.res.status, statusText: c.res.statusText, headers: c.res.headers });
    } catch (error) { release(); throw error; }
  };
}
