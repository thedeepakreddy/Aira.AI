/**
 * Applies the memory schema to Supabase, and says whether it is there.
 *
 * The migrations shipped as three .sql files and an ALL.sql with a comment
 * saying to paste it into the Supabase SQL editor. Nobody did — this project
 * ran for months against a database with none of these tables, and the only
 * symptom was that memory quietly stopped surviving a restart. A migration you
 * apply by remembering to is a migration that does not get applied.
 *
 * So: `npm run migrate:check` tells you the truth with nothing but the key the
 * gateway already has, and `npm run migrate` applies it.
 *
 * WHY TWO DIFFERENT CREDENTIALS. The service-role key talks to PostgREST, which
 * serves tables and cannot create them — there is no DDL over that interface at
 * any privilege. Creating a table needs either the database password or a
 * personal access token for Supabase's management API. The token is the better
 * of the two: it is revocable on its own, it is what Supabase's own CLI uses,
 * and it means the database password never has to be written down here.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

const url = process.env.SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const token = process.env.SUPABASE_ACCESS_TOKEN?.trim();

if (!url || !serviceKey) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (services/gateway/.env).');
  process.exit(2);
}

/** Every table the gateway reads or writes. Checking is asking each one. */
const TABLES = ['aira_memory', 'aira_memory_preferences'];

/** The project ref is the first label of the Supabase hostname. */
function projectRef(supabaseUrl) {
  try {
    return new URL(supabaseUrl).hostname.split('.')[0] || null;
  } catch {
    return null;
  }
}

/**
 * Whether a table answers.
 *
 * PostgREST reports a missing table as PGRST205 — the same code the gateway's
 * own store watches for, so this check and the runtime behaviour agree by
 * construction rather than by comment.
 */
async function present(table) {
  const response = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.ok) return true;
  const body = await response.json().catch(() => ({}));
  if (body.code === 'PGRST205') return false;
  throw new Error(`${table}: ${response.status} ${body.message ?? ''}`.trim());
}

async function report(quiet = false) {
  const rows = await Promise.all(TABLES.map(async (table) => [table, await present(table)]));
  if (!quiet) for (const [table, ok] of rows) console.log(`  ${ok ? '✔' : '✖'} ${table}${ok ? '' : ' — missing'}`);
  return rows.every(([, ok]) => ok);
}

/**
 * Waits for PostgREST to notice the tables that were just created.
 *
 * PostgREST answers from a cached picture of the schema and reloads it a moment
 * after the DDL lands, so checking immediately reports PGRST205 — "not in the
 * schema cache" — for tables that exist. The first run of this script did
 * exactly that: the migration succeeded and it announced a failure, which is a
 * worse outcome than the problem it was written to solve, because it invites
 * someone to run the DDL again looking for an error that was never there.
 */
async function settle() {
  const DEADLINE_MS = 45_000;
  const started = Date.now();
  for (let wait = 1000; ; wait = Math.min(wait * 1.5, 5000)) {
    if (await report(true)) return true;
    if (Date.now() - started > DEADLINE_MS) return false;
    if (Date.now() - started < 1500) console.log('Waiting for PostgREST to reload its schema cache…');
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

console.log(`Supabase project ${projectRef(url) ?? '(unknown)'}\n`);
console.log('Schema:');
const already = await report();

if (check) {
  console.log(already
    ? '\nMemory is durable: every table is present.'
    : '\nMemory is NOT durable — the gateway will fall back to per-process memory.\nRun `npm run migrate` to apply the schema.');
  process.exit(already ? 0 : 1);
}

if (already) {
  // Re-running is safe — every statement is `if not exists` — but saying so
  // beats a silent no-op that looks identical to a successful apply.
  console.log('\nNothing to do. The schema is already applied.');
  process.exit(0);
}

if (!token) {
  console.error(`
The schema is missing and there is no SUPABASE_ACCESS_TOKEN to apply it with.

Two ways to fix it, both one-time:

  A. Let this script do it
     1. Create a token at https://supabase.com/dashboard/account/tokens
     2. SUPABASE_ACCESS_TOKEN=sbp_... npm run migrate
     The token is revocable from that same page afterwards.

  B. Do it by hand
     Paste services/gateway/migrations/ALL.sql into the SQL editor at
     https://supabase.com/dashboard/project/${projectRef(url) ?? '<project>'}/sql
     and run it once.

Either way, 'npm run migrate:check' will confirm it afterwards, and a running
gateway picks the schema up on its own within five minutes — no restart.`);
  process.exit(1);
}

const sql = readFileSync(join(root, 'migrations', 'ALL.sql'), 'utf8');
console.log(`\nApplying migrations/ALL.sql (${sql.split('\n').length} lines)…`);

const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef(url)}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ query: sql }),
  signal: AbortSignal.timeout(60_000),
});

if (!response.ok) {
  const detail = await response.text().catch(() => '');
  console.error(`\nThe management API refused (${response.status}).`);
  // 401 is overwhelmingly a token that is not a token — an anon or service key
  // pasted into the variable, which looks right and cannot work here.
  if (response.status === 401) console.error('That usually means SUPABASE_ACCESS_TOKEN is not a personal access token (it starts with `sbp_`).');
  if (detail) console.error(detail.slice(0, 600));
  process.exit(1);
}

console.log('Applied.\n');
const ok = await settle();
console.log('Schema:');
await report();
console.log(ok
  ? '\nMemory is durable. A running gateway picks this up within five minutes, no restart needed.'
  : `\nThe statements ran, but PostgREST still does not list every table after 45s.
Run 'npm run migrate:check' again in a minute — the cache may simply be slow.
If it is still missing, check the SQL editor for what the database said.`);
process.exit(ok ? 0 : 1);
