import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { FACT_SURFACE } from './facts.ts';

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
  id?: string;
  /** ISO-8601 UTC. */
  at: string;
  /** Which surface this came from: chat, voice, code, task. */
  surface: string;
  role: 'user' | 'assistant';
  text: string;
}

export interface MemoryStore {
  readonly kind: 'supabase' | 'ephemeral' | 'disabled';
  /**
   * Checks what this store can actually do, rather than what it was handed.
   *
   * Called once at boot so `kind` is answered from evidence before anything
   * asks. A store configured with a Supabase URL and no schema behind it looks
   * identical to a working one until someone tries to use it, which is how a
   * gateway spent months reporting durable memory it did not have.
   */
  verify(): Promise<MemoryStore['kind']>;
  remember(userId: string, entry: MemoryEntry): Promise<MemoryEntry>;
  recall(userId: string, limit: number, query?: string): Promise<MemoryEntry[]>;
  forget(userId: string, id?: string): Promise<boolean>;
  enabled(userId: string): Promise<boolean>;
  setEnabled(userId: string, enabled: boolean): Promise<void>;
}

/** Beyond this a single turn is a transcript, not a memory. */
const MAX_TEXT = 400;
/** Per user, in the fallback store. Roughly a working session. */
const RING = 200;
const MAX_USERS = 1000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function trim(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > MAX_TEXT ? clean.slice(0, MAX_TEXT - 1) + '…' : clean;
}

class EphemeralStore implements MemoryStore {
  readonly kind = 'ephemeral' as const;
  /** Nothing to check: it is already what it says it is. */
  async verify(): Promise<'ephemeral'> { return 'ephemeral'; }
  private readonly byUser = new Map<string, { entries: MemoryEntry[]; enabled: boolean }>();

  private user(userId: string) {
    let user = this.byUser.get(userId);
    if (!user) {
      // Never evict a user's paused preference and silently re-enable it.
      if (this.byUser.size >= MAX_USERS) throw new Error('Local memory capacity reached. Configure persistent storage.');
      user = { entries: [], enabled: true };
      this.byUser.set(userId, user);
    }
    // Facts are exempt: they are what stays true, so ageing them out after a
    // month would make "durable" mean "durable for four weeks" and quietly
    // relearn the same things forever.
    user.entries = user.entries.filter((entry) =>
      entry.surface === FACT_SURFACE || Date.parse(entry.at) > Date.now() - RETENTION_MS);
    return user;
  }

  async enabled(userId: string): Promise<boolean> { return this.user(userId).enabled; }
  async setEnabled(userId: string, enabled: boolean): Promise<void> { this.user(userId).enabled = enabled; }

  async remember(userId: string, entry: MemoryEntry): Promise<MemoryEntry> {
    const user = this.user(userId);
    if (!user.enabled) throw new Error('Shared memory is paused for this user.');
    const recent = user.entries.slice(-10).find((saved) => saved.text === entry.text && saved.surface === entry.surface && saved.role === entry.role);
    if (recent) return { ...recent };
    const saved = { ...entry, id: crypto.randomUUID() };
    user.entries.push(saved);
    if (user.entries.length > RING) user.entries.splice(0, user.entries.length - RING);
    return { ...saved };
  }

  async recall(userId: string, limit: number, query?: string): Promise<MemoryEntry[]> {
    const needle = query?.toLowerCase();
    return this.user(userId).entries.filter((entry) => !needle || entry.text.toLowerCase().includes(needle)).slice(-limit).map((entry) => ({ ...entry }));
  }

  async forget(userId: string, id?: string): Promise<boolean> {
    const user = this.user(userId);
    const count = user.entries.length;
    user.entries = id ? user.entries.filter((entry) => entry.id !== id) : [];
    return !id || user.entries.length < count;
  }
}

class DisabledStore implements MemoryStore {
  readonly kind = 'disabled' as const;
  async verify(): Promise<'disabled'> { return 'disabled'; }
  async enabled(): Promise<boolean> { return false; }
  async setEnabled(): Promise<void> { throw new Error('Shared memory is disabled by the gateway.'); }
  async remember(): Promise<MemoryEntry> { throw new Error('Shared memory is disabled by the gateway.'); }
  async recall(): Promise<MemoryEntry[]> { return []; }
  async forget(): Promise<boolean> { return false; }
}

/**
 * Thrown when Supabase answers but the schema is not there.
 *
 * PostgREST reports a missing table as PGRST205 with "Could not find the table
 * ... in the schema cache" — a deployment that skipped the migrations, not a
 * transient fault, so retrying it forever is pointless.
 */
function isMissingSchema(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === 'PGRST205'
    || /could not find the table|schema cache|does not exist/i.test(error.message ?? '');
}

class SupabaseStore implements MemoryStore {
  /**
   * How long to stay on the local store before trying Supabase again.
   *
   * Degrading used to be permanent for the life of the process, which made
   * applying the migrations to a running gateway do nothing visible — the fix
   * was in place and the symptom stayed until someone thought to restart. Five
   * minutes is short enough that the repair is noticed while the person who
   * made it is still watching, and long enough that a genuinely missing schema
   * is not re-probed on every request.
   */
  private static readonly RECHECK_MS = 5 * 60_000;

  private degraded = false;
  /*
   * When Supabase was last actually asked. Kept separate from the flag above
   * rather than encoded as "degraded since T", because a timestamp doubling as
   * a boolean makes T=0 mean "healthy" — which is not reachable in production
   * and is exactly what a test with a mocked clock produces.
   */
  private lastAttempt = 0;
  /** Announced once per outage, not once per recheck. */
  private announced = false;

  /** Reports what it is actually doing, not what it was configured to do. */
  get kind(): 'supabase' | 'ephemeral' { return this.degraded ? 'ephemeral' : 'supabase'; }
  /** Takes over when the schema is missing, so memory keeps working. */
  private readonly fallback = new EphemeralStore();
  private readonly client: SupabaseClient;

  /** `client` is a test seam: production always builds its own. */
  constructor(url: string, serviceKey: string, client?: SupabaseClient) {
    this.client = client ?? createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(5000) }) },
    });
  }

  /**
   * Switches to the local store the first time the schema turns out to be
   * missing.
   *
   * Without this the gateway kept reporting `storage: supabase` while every
   * read and write failed — 168 silent failures in one session — so the
   * interface showed shared memory as on and working while nothing was being
   * remembered at all. Degrading loudly once beats failing quietly forever.
   */
  private degrade(error: { code?: string; message?: string } | null): boolean {
    if (!isMissingSchema(error)) return false;
    // Stamped on every confirmation, so the next recheck is five minutes from
    // the last time we actually looked rather than from the first failure.
    this.degraded = true;
    this.lastAttempt = Date.now();
    if (!this.announced) {
      this.announced = true;
      console.error(
        '[memory] Supabase schema is missing — falling back to local, ephemeral memory. '
          + 'Run `npm run migrate` in services/gateway to store memory durably.',
      );
    }
    return true;
  }

  /**
   * Whether this call should go to the local store.
   *
   * Once the recheck window has passed it returns false — letting one call
   * through to Supabase to find out. If the schema is still missing that call
   * degrades again and falls back, costing one round trip per five minutes.
   */
  private useFallback(): boolean {
    if (!this.degraded) return false;
    return Date.now() - this.lastAttempt < SupabaseStore.RECHECK_MS;
  }

  /** Called on any successful query, which is proof the schema is back. */
  private recovered(): void {
    if (!this.degraded) return;
    this.degraded = false;
    this.announced = false;
    console.warn(
      '[memory] Supabase is answering again — memory is durable from here. '
        + 'What was written while it was not stayed local and is not copied up.',
    );
  }

  /**
   * One cheap query, to find out what this store really is.
   *
   * Only a missing schema degrades. A timeout or a network blip at boot is not
   * a reason to spend the whole process in fallback — those are what the
   * per-operation handling is for, and a gateway that starts during a five
   * second Supabase hiccup should not give up on the database entirely.
   */
  async verify(): Promise<'supabase' | 'ephemeral'> {
    const { error } = await this.client.from('aira_memory').select('id').limit(1);
    if (error) this.degrade(error);
    else this.recovered();
    return this.kind;
  }

  async enabled(userId: string): Promise<boolean> {
    if (this.useFallback()) return this.fallback.enabled(userId);
    const { data, error } = await this.client.from('aira_memory_preferences').select('enabled').eq('user_id', userId).maybeSingle();
    if (error) {
      if (this.degrade(error)) return this.fallback.enabled(userId);
      throw new Error(error.message);
    }
    this.recovered();
    return data?.enabled ?? true;
  }

  async setEnabled(userId: string, enabled: boolean): Promise<void> {
    if (this.useFallback()) return this.fallback.setEnabled(userId, enabled);
    const { error } = await this.client.from('aira_memory_preferences').upsert({ user_id: userId, enabled, updated_at: new Date().toISOString() });
    if (error) {
      if (this.degrade(error)) return this.fallback.setEnabled(userId, enabled);
      throw new Error(error.message);
    }
    this.recovered();
  }

  async remember(userId: string, entry: MemoryEntry): Promise<MemoryEntry> {
    if (this.useFallback()) return this.fallback.remember(userId, entry);
    if (!await this.enabled(userId)) throw new Error('Shared memory is paused for this user.');
    const { data, error } = await this.client.from('aira_memory').insert({
      user_id: userId,
      surface: entry.surface,
      role: entry.role,
      text: entry.text,
      at: entry.at,
    }).select('id, at, surface, role, text').single();
    if (error) {
      if (this.degrade(error)) return this.fallback.remember(userId, entry);
      throw new Error(error.message);
    }
    this.recovered();
    return { ...data, id: String(data.id) } as MemoryEntry;
  }

  async recall(userId: string, limit: number, query?: string): Promise<MemoryEntry[]> {
    if (this.useFallback()) return this.fallback.recall(userId, limit, query);
    let request = this.client
      .from('aira_memory')
      .select('id, at, surface, role, text')
      .eq('user_id', userId)
      // Facts never age out; episodes do. `or` keeps both in one round trip.
      .or(`at.gte.${new Date(Date.now() - RETENTION_MS).toISOString()},surface.eq.${FACT_SURFACE}`);
    if (query) request = request.ilike('text', `%${query.replace(/[\\%_]/g, '\\$&')}%`);
    const { data, error } = await request.order('at', { ascending: false }).limit(limit);
    if (error) {
      if (this.degrade(error)) return this.fallback.recall(userId, limit, query);
      throw new Error(error.message);
    }
    this.recovered();
    // Newest-first from the query, oldest-first for reading.
    return (data ?? []).reverse().map((entry) => ({ ...entry, id: String(entry.id) })) as MemoryEntry[];
  }

  async forget(userId: string, id?: string): Promise<boolean> {
    if (this.useFallback()) return this.fallback.forget(userId, id);
    if (id && !/^\d+$/.test(id)) return false;
    let request = this.client.from('aira_memory').delete().eq('user_id', userId);
    if (id) request = request.eq('id', id);
    const { data, error } = await request.select('id');
    if (error) {
      if (this.degrade(error)) return this.fallback.forget(userId, id);
      throw new Error(error.message);
    }
    this.recovered();
    return !id || !!data?.length;
  }
}

let store: MemoryStore = new DisabledStore();

export function initMemory(options: {
  supabaseUrl?: string;
  supabaseServiceKey?: string;
  enabled: boolean;
  /** Test seam. Supplying a client skips the real one. */
  client?: SupabaseClient;
}): MemoryStore {
  if (!options.enabled) {
    store = new DisabledStore();
    return store;
  }
  store = options.client || (options.supabaseUrl && options.supabaseServiceKey)
    ? new SupabaseStore(options.supabaseUrl ?? '', options.supabaseServiceKey ?? '', options.client)
    : new EphemeralStore();
  return store;
}

export function memory(): MemoryStore {
  return store;
}
