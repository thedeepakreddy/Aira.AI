import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Context, Next } from 'hono';
import type { Env } from './env.ts';

/**
 * Supabase-backed bearer auth.
 *
 * The gateway pays for every token it forwards, so an unauthenticated request
 * is an unattributed cost. Auth is therefore required unless explicitly
 * disabled for local testing.
 */
export interface AuthedVars {
  userId: string | null;
}

export function createAuthMiddleware(env: Env) {
  let client: SupabaseClient | null = null;
  if (env.supabaseUrl && env.supabaseServiceKey) {
    client = createClient(env.supabaseUrl, env.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  return async (c: Context<{ Variables: AuthedVars }>, next: Next) => {
    if (!env.requireAuth) {
      // Development is a single local identity. A caller-controlled user id
      // would let a browser select another user's shared memory.
      c.set('userId', 'dev-user');
      return next();
    }

    const header = c.req.header('authorization');
    const token = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token || !client) {
      return c.json({ error: 'Authentication required.' }, 401);
    }

    let result;
    try { result = await client.auth.getUser(token); } catch {
      return c.json({ error: 'Authentication service unavailable. Please retry.' }, 503);
    }
    const { data, error } = result;
    if (error || !data.user) {
      return c.json({ error: 'Invalid or expired session.' }, 401);
    }

    c.set('userId', data.user.id);
    return next();
  };
}
