/**
 * Local runtimes, hosted for web users.
 *
 * The desktop app supervises OpenClaw, OpenCode and the browser as children of
 * itself: one user, one machine, processes that die when the window closes.
 * None of that holds here. This is a shared server, so every assumption the
 * desktop supervisor could make has to be replaced with something enforced.
 *
 * Four rules, and they are the whole reason this file is not fifty lines.
 *
 * **One process per user, and a ceiling on the total.** Without a cap, the
 * hundredth user is the one who takes the machine down for the other
 * ninety-nine. A user who cannot get a slot is told so plainly rather than
 * queued behind a process that may never free up.
 *
 * **Nothing outlives the tab that started it.** A desktop runtime ends when the
 * app quits; a hosted one has no such moment, so it is reaped after a period
 * with no request. A browser tab closed on a train would otherwise hold a
 * process and its memory until the box was restarted.
 *
 * **Every user gets their own state directory, and never sees another's.** The
 * desktop had one user by construction. Here the path is derived from the
 * authenticated id and nothing in a request can influence it.
 *
 * **A crashed runtime is forgotten, not retried forever.** A process that dies
 * on start is a configuration problem, and restarting it in a loop turns one
 * broken install into a busy loop on a shared machine.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

export type RuntimeKind = 'agents' | 'code' | 'browser';

export interface Running {
  kind: RuntimeKind;
  port: number;
  /** Per-launch secret the runtime requires; never leaves this process or the owner. */
  token: string;
  child: ChildProcess;
  stateDir: string;
  startedAt: number;
  /** Bumped on every request, so idle means idle. */
  touchedAt: number;
  /** Recent stderr, for saying why a start failed. */
  log: string[];
}

export interface SupervisorOptions {
  /** How many runtimes may exist at once across every user. */
  maxTotal?: number;
  /** How long a runtime may go unused before it is reaped. */
  idleMs?: number;
  /** Where per-user state lives. */
  root?: string;
  /** Overridable for tests. */
  spawnImpl?: typeof spawn;
  now?: () => number;
}

const LOG_LINES = 40;

/**
 * A user's directory name.
 *
 * Hashed rather than used raw: a user id is an opaque token from the auth
 * provider, and putting one straight into a path invites both traversal and a
 * directory listing that reads as a user list.
 */
export function stateDirFor(root: string, userId: string): string {
  const digest = createHash('sha256').update(userId).digest('hex').slice(0, 32);
  return join(root, digest);
}

/** An OS-assigned free port, so two users never collide. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

export class RuntimeSupervisor {
  private readonly running = new Map<string, Running>();
  private readonly maxTotal: number;
  private readonly idleMs: number;
  private readonly root: string;
  private readonly spawnImpl: typeof spawn;
  private readonly now: () => number;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(options: SupervisorOptions = {}) {
    this.maxTotal = options.maxTotal ?? 8;
    this.idleMs = options.idleMs ?? 15 * 60_000;
    this.root = options.root ?? join(tmpdir(), 'aira-runtimes');
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.now = options.now ?? Date.now;
  }

  /** Composite key: a user may hold one of each kind, not one in total. */
  private key(userId: string, kind: RuntimeKind): string {
    return `${userId}::${kind}`;
  }

  get(userId: string, kind: RuntimeKind): Running | undefined {
    const found = this.running.get(this.key(userId, kind));
    if (found) found.touchedAt = this.now();
    return found;
  }

  /** How many are alive, for the cap and for reporting. */
  get size(): number {
    return this.running.size;
  }

  /**
   * Starts a runtime, or returns the one already running.
   *
   * Idempotent on purpose: a client that retries a start because a response was
   * slow must not end up with two processes and only a handle to one.
   */
  async start(
    userId: string,
    kind: RuntimeKind,
    build: (context: { port: number; token: string; stateDir: string }) => {
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd?: string;
    },
  ): Promise<Running> {
    const existing = this.get(userId, kind);
    if (existing) return existing;

    if (this.running.size >= this.maxTotal) {
      // Try to make room from the idle ones before refusing.
      this.sweep();
    }
    if (this.running.size >= this.maxTotal) {
      throw new Error('Aira is at capacity for hosted runtimes right now. Try again in a few minutes, or use the desktop app.');
    }

    const port = await freePort();
    const token = randomUUID();
    const stateDir = join(stateDirFor(this.root, userId), kind);
    mkdirSync(stateDir, { recursive: true });

    const plan = build({ port, token, stateDir });
    const child = this.spawnImpl(plan.command, plan.args, {
      env: { ...process.env, ...plan.env },
      cwd: plan.cwd ?? stateDir,
      stdio: ['ignore', 'ignore', 'pipe'],
      // Its own group, so stopping the runtime stops whatever it started.
      detached: true,
    });

    const entry: Running = {
      kind, port, token, child, stateDir,
      startedAt: this.now(), touchedAt: this.now(), log: [],
    };

    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue;
        entry.log.push(line.trim());
        if (entry.log.length > LOG_LINES) entry.log.shift();
      }
    });

    // A runtime that dies is forgotten rather than restarted: a broken install
    // would otherwise become a spawn loop on a machine other people are using.
    child.on('exit', () => { this.running.delete(this.key(userId, kind)); });

    this.running.set(this.key(userId, kind), entry);
    this.ensureSweeper();
    return entry;
  }

  /** Stops one runtime and removes its state. */
  stop(userId: string, kind: RuntimeKind): boolean {
    const key = this.key(userId, kind);
    const entry = this.running.get(key);
    if (!entry) return false;
    this.running.delete(key);
    this.kill(entry);
    return true;
  }

  private kill(entry: Running): void {
    try {
      // Negative pid signals the whole group, so a runtime's own children go too.
      if (entry.child.pid) process.kill(-entry.child.pid, 'SIGTERM');
      else entry.child.kill('SIGTERM');
    } catch { /* already gone */ }
    // State is per-session and worth nothing once the process is gone. Leaving
    // it would accumulate a directory per user per restart, forever.
    try { rmSync(entry.stateDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  /** Reaps anything idle past the limit. Returns how many were taken. */
  sweep(): number {
    const cutoff = this.now() - this.idleMs;
    let taken = 0;
    for (const [key, entry] of [...this.running]) {
      if (entry.touchedAt > cutoff) continue;
      this.running.delete(key);
      this.kill(entry);
      taken += 1;
    }
    return taken;
  }

  private ensureSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      this.sweep();
      if (!this.running.size && this.sweeper) {
        clearInterval(this.sweeper);
        this.sweeper = null;
      }
    }, 60_000);
    this.sweeper.unref?.();
  }

  /** Everything, for gateway shutdown. */
  shutdown(): void {
    for (const [key, entry] of [...this.running]) {
      this.running.delete(key);
      this.kill(entry);
    }
    if (this.sweeper) { clearInterval(this.sweeper); this.sweeper = null; }
  }
}
