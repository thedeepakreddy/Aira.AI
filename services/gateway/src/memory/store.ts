import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Cross-surface memory.
 *
 * Aira has four surfaces — chat, voice, the coding agent, the task agent — and
 * exactly one place where all four meet: this gateway. The agents are
 * subprocesses that call it directly and never touch the frontend, so anything
 * the app remembered locally would be invisible to them. Memory has to live
 * where the traffic already converges, which is here.
 *
 * Storage is deliberately in two tiers:
 *
 *   * Supabase when it is configured, which is what makes memory survive a
 *     redeploy and follow the user between the desktop app and the web.
 *   * An in-process ring otherwise, so the layer works on a laptop with no
 *     database and no migration run.
 *
 * The fallback is not a stub — it is the same interface with a smaller horizon,
 * and the gateway says at boot which one it got.
 */

export interface MemoryEntry {
  /** ISO-8601 UTC. */
  at: string;
  /** Which surface this came from: chat, voice, code, task. */
  surface: string;
  role: 'user' | 'assistant';
  text: string;
}

export interface MemoryStore {
  readonly kind: 'supabase' | 'ephemeral';
  remember(userId: string, entry: MemoryEntry): Promise<void>;
  recall(userId: string, limit: number): Promise<MemoryEntry[]>;
}

/** Beyond this a single turn is a transcript, not a memory. */
const MAX_TEXT = 400;
/** Per user, in the fallback store. Roughly a working session. */
const RING = 60;

export function trim(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > MAX_TEXT ? clean.slice(0, MAX_TEXT - 1) + '…' : clean;
}

class EphemeralStore implements MemoryStore {
  readonly kind = 'ephemeral' as const;
  private readonly byUser = new Map<string, MemoryEntry[]>();

  async remember(userId: string, entry: MemoryEntry): Promise<void> {
    const list = this.byUser.get(userId) ?? [];
    list.push(entry);
    if (list.length > RING) list.splice(0, list.length - RING);
    this.byUser.set(userId, list);
  }

  async recall(userId: string, limit: number): Promise<MemoryEntry[]> {
    const list = this.byUser.get(userId) ?? [];
    return list.slice(-limit);
  }
}

class SupabaseStore implements MemoryStore {
  readonly kind = 'supabase' as const;
  private readonly client: SupabaseClient;

  constructor(url: string, serviceKey: string) {
    this.client = createClient(url, serviceKey, { auth: { persistSession: false } });
  }

  async remember(userId: string, entry: MemoryEntry): Promise<void> {
    const { error } = await this.client.from('aira_memory').insert({
      user_id: userId,
      surface: entry.surface,
      role: entry.role,
      text: entry.text,
      at: entry.at,
    });
    if (error) throw new Error(error.message);
  }

  async recall(userId: string, limit: number): Promise<MemoryEntry[]> {
    const { data, error } = await this.client
      .from('aira_memory')
      .select('at, surface, role, text')
      .eq('user_id', userId)
      .order('at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    // Newest-first from the query, oldest-first for reading.
    return (data ?? []).reverse() as MemoryEntry[];
  }
}

let store: MemoryStore = new EphemeralStore();

export function initMemory(options: {
  supabaseUrl?: string;
  supabaseServiceKey?: string;
  enabled: boolean;
}): MemoryStore {
  if (!options.enabled) {
    store = new EphemeralStore();
    return store;
  }
  store = options.supabaseUrl && options.supabaseServiceKey
    ? new SupabaseStore(options.supabaseUrl, options.supabaseServiceKey)
    : new EphemeralStore();
  return store;
}

export function memory(): MemoryStore {
  return store;
}
