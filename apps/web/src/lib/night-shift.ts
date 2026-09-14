/**
 * Work that happens while nobody is watching.
 *
 * Aira could already repeat a task, but only ever one agent at a time, and the
 * comment explaining why said it plainly: an unattended board that fans out to
 * five agents is five times the spend with nobody there to stop it. That was
 * the right call while every token had a price.
 *
 * A local model does not have one. The restriction was never about the fleet
 * being dangerous — it was about the bill — so it is lifted exactly where the
 * bill is zero and kept everywhere else. `mayRunFleet` is that rule, in one
 * place, so it cannot drift apart from the reason for it.
 *
 * One thing this deliberately does not claim: the runtime is a child of the
 * app, and quitting Aira terminates it. A scheduled run happens while Aira is
 * open and not otherwise. The UI says so rather than implying a cron daemon
 * that does not exist.
 */

export interface NightShift {
  /** The task to run, verbatim, each time it fires. */
  prompt: string;
  /** Agent ids to run it across. */
  agents: string[];
  /** Minutes between runs. */
  everyMinutes: number;
  /** Epoch ms of the last fire, so a reopened app does not immediately re-run. */
  lastRunAt: number;
}

export const NIGHT_SHIFT_KEY = 'aira.night-shift.v1';

/** Offered intervals. Nothing under an hour: this is unattended work. */
export const INTERVALS: Array<{ label: string; minutes: number }> = [
  { label: 'Every hour', minutes: 60 },
  { label: 'Every 3 hours', minutes: 180 },
  { label: 'Every 6 hours', minutes: 360 },
  { label: 'Once a day', minutes: 1440 },
];

/**
 * Whether the whole selected fleet may run unattended on this model.
 *
 * Free means free: a model priced at zero on both sides, which today is a local
 * one. A model with no pricing at all is *not* free — unpriced means "not
 * verified", and treating unknown as zero is how an unattended loop quietly
 * spends money all night.
 */
export function mayRunFleet(pricing: { inputPerMTok: number; outputPerMTok: number } | undefined): boolean {
  if (!pricing) return false;
  return pricing.inputPerMTok === 0 && pricing.outputPerMTok === 0;
}

/** How many agents a schedule may carry on this model. */
export function agentLimit(pricing: Parameters<typeof mayRunFleet>[0]): number {
  return mayRunFleet(pricing) ? Infinity : 1;
}

export function load(userId: string | null): NightShift | null {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(`${NIGHT_SHIFT_KEY}.${userId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as NightShift;
    if (typeof parsed?.prompt !== 'string' || !parsed.prompt.trim()) return null;
    if (!Array.isArray(parsed.agents) || !parsed.agents.length) return null;
    if (!Number.isFinite(parsed.everyMinutes) || parsed.everyMinutes < 60) return null;
    return {
      prompt: parsed.prompt.slice(0, 4_000),
      agents: parsed.agents.slice(0, 12).map(String),
      everyMinutes: Math.min(parsed.everyMinutes, 10_080),
      lastRunAt: Number.isFinite(parsed.lastRunAt) ? parsed.lastRunAt : 0,
    };
  } catch { return null; }
}

export function save(userId: string | null, shift: NightShift | null): void {
  if (!userId) return;
  try {
    const key = `${NIGHT_SHIFT_KEY}.${userId}`;
    if (shift) localStorage.setItem(key, JSON.stringify(shift));
    else localStorage.removeItem(key);
  } catch { /* a full store must not break the board */ }
}

/**
 * Whether it is time to run.
 *
 * A first fire is not immediate: `lastRunAt` starts at the moment the schedule
 * is created, so turning it on does not launch a run the same second. The user
 * set it up to happen later, not now.
 */
export function isDue(shift: NightShift, now: number = Date.now()): boolean {
  return now - shift.lastRunAt >= shift.everyMinutes * 60_000;
}

/** Human interval, for the control and for the briefing. */
export function describeInterval(minutes: number): string {
  const match = INTERVALS.find((item) => item.minutes === minutes);
  if (match) return match.label.toLowerCase();
  if (minutes % 1440 === 0) return `every ${minutes / 1440} days`;
  if (minutes % 60 === 0) return `every ${minutes / 60} hours`;
  return `every ${minutes} minutes`;
}
