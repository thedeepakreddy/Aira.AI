import { createClient, type Session } from '@supabase/supabase-js';

/**
 * Browser Supabase client.
 *
 * Only the publishable key is used here. It is compiled into the bundle and is
 * safe to expose — it is constrained by Row Level Security. The secret key must
 * never appear in this app; it lives in the gateway alone.
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isAuthConfigured = Boolean(url && anonKey);

export const supabase = isAuthConfigured
  ? createClient(url!, anonKey!, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    })
  : null;

/** Access token for the current session, or null. Sent to the gateway as a bearer token. */
export async function getAccessToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export async function getSession(): Promise<Session | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export function onAuthChange(handler: (session: Session | null) => void): () => void {
  if (!supabase) return () => {};
  const { data } = supabase.auth.onAuthStateChange((_event, session) => handler(session));
  return () => data.subscription.unsubscribe();
}

/**
 * Supabase returns deliberately vague errors for bad credentials so an attacker
 * cannot enumerate registered addresses. They are passed through rather than
 * being made more specific.
 */
export async function signIn(email: string, password: string): Promise<string | null> {
  if (!supabase) return 'Sign-in is not configured.';
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  return error?.message ?? null;
}

export async function signUp(email: string, password: string): Promise<string | null> {
  if (!supabase) return 'Sign-up is not configured.';
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return error.message;
  // With email confirmation enabled, a new account has no session until the
  // link is clicked. Saying so beats a form that silently appears to do nothing.
  if (!data.session) return 'CONFIRM_EMAIL';
  return null;
}

export async function signOut(): Promise<void> {
  await supabase?.auth.signOut();
}
