import { Hono } from 'hono';
import type { AuthedVars } from '../auth.ts';
import { summarise } from '../usage/recent.ts';

/**
 * What the signed-in user has spent recently.
 *
 * Scoped to the caller by the auth middleware's user id and never by anything
 * in the request, so one account cannot read another's spend by asking for it.
 */
export function createUsageRoutes() {
  const routes = new Hono<{ Variables: AuthedVars }>();

  routes.get('/', (c) => {
    const userId = c.get('userId');
    if (!userId) return c.json({ error: 'Sign in to see usage.' }, 401);
    const surface = c.req.query('surface');
    const allowed = ['chat', 'voice', 'code', 'task'];
    if (surface && !allowed.includes(surface)) {
      return c.json({ error: `surface must be one of ${allowed.join(', ')}.` }, 400);
    }
    return c.json({
      ...summarise(userId, surface),
      // The window is in memory, so a restart empties it. Callers that show a
      // total need to know it is a recent read-out and not a bill.
      durable: false,
    });
  });

  return routes;
}
