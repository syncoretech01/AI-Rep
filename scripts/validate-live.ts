/**
 * Live infrastructure validation against a REAL Supabase project (LIVE_VALIDATION.md).
 *
 *   npm run validate:live [-- --allow-unverified-tls]
 *
 * Uses DATABASE_URL (ideally the transaction pooler, port 6543) and, for the authentication checks,
 * NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and SUPABASE_SECRET_KEY (used only by this script,
 * never by the app). It creates two throwaway organizations (named "live-validation-…") and two throwaway auth
 * users, runs the checks below, and deletes everything it created, even when a check fails.
 *
 *   1. connection: TLS mode, Postgres and pgvector versions
 *   2. migrations: every file in supabase/migrations is recorded as applied
 *   3. transaction pooling: transaction-local settings (role, JWT claims) never leak into the next transaction
 *   4. Supabase Auth: real users sign in; their verified JWT `sub` is what the app's user scope runs as
 *   5. RLS isolation: under user scope each user sees only their organization (Supabase's real policies/roles)
 *   6. pgvector retrieval: tenant-scoped nearest-neighbour search on the real database
 *   7. concurrency on the real connection pool: one turn-lock owner, spend reservations never overshoot,
 *      one external-operation claim
 *   8. usage accounting: usage records maintain the daily spend totals the limits read
 *
 * Model behaviour (grounded answers, tool calling, embeddings, retries) is validated by `npm run eval:live`.
 * Exit code 1 when any check fails or required configuration is missing; checks that need missing optional
 * configuration are reported as SKIP.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { claimOperation } from '@/server/agent/tools/operations';
import type { Embedder } from '@/server/ai/embedder';
import { isUnverifiedRemoteDatabase, loadDatabaseConfig, type DatabaseConfig } from '@/server/config/env';
import { loadMigrations } from '@/server/db/migrations';
import { createPostgresDatabase } from '@/server/db/postgres';
import { serviceScope, userScope } from '@/server/db/scope';
import { maybeOne, toNumber } from '@/server/db/sql';
import type { Database } from '@/server/db/types';
import { getOrCreateVisitorConversation, tryAcquireTurnLock } from '@/server/domain/conversations/service';
import { ingestTextSource } from '@/server/domain/knowledge/ingestion';
import { searchKnowledge } from '@/server/domain/knowledge/retrieval';
import { createOrganization } from '@/server/domain/organizations/service';
import { createCostEstimator } from '@/server/domain/usage/cost';
import { UsageLimitError, createUsageGuard } from '@/server/domain/usage/limits';
import { createUsageRecorder } from '@/server/domain/usage/service';
import { silentLogger } from '@/server/observability/logger';
import { fakeEmbed } from '../tests/support/fake-embeddings';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const VALIDATION_PREFIX = 'live-validation';

export interface LiveCheck {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  detail?: string;
}

/** Real Supabase Auth operations (injected so the database checks can also run against a test database). */
export interface AuthHarness {
  /** Creates a confirmed user and returns its id. */
  createUser(email: string, password: string): Promise<string>;
  /** Signs in with the publishable key and returns the VERIFIED JWT claims (getClaims). */
  signIn(email: string, password: string): Promise<{ sub: string; role: string }>;
  deleteUser(id: string): Promise<void>;
}

export interface ValidationOptions {
  db: Database;
  config: Pick<DatabaseConfig, 'tls' | 'url'>;
  auth: AuthHarness | null;
  /** Ids of two existing auth users, when `auth` is null (tests). */
  users?: readonly [string, string];
  print?: (line: string) => void;
}

/** Deterministic stand-in embeddings: retrieval mechanics are validated without calling a provider. */
const validationEmbedder: Embedder = {
  model: `${VALIDATION_PREFIX}-embedding`,
  embed: (texts) => Promise.resolve({ vectors: texts.map((text) => fakeEmbed(text)), model: `${VALIDATION_PREFIX}-embedding` }),
};

export async function runLiveValidation(options: ValidationOptions): Promise<LiveCheck[]> {
  const { db } = options;
  const checks: LiveCheck[] = [];
  const print = options.print ?? ((line: string) => console.log(line));
  const record = (name: string, pass: boolean, detail?: string) => {
    checks.push({ name, status: pass ? 'pass' : 'fail', ...(detail !== undefined && { detail }) });
  };
  const skip = (name: string, detail: string) => checks.push({ name, status: 'skip', detail });
  const attempt = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      record(name, false, error instanceof Error ? error.message : String(error));
    }
  };

  // 1. Connection.
  await attempt('connection', async () => {
    const row = maybeOne(
      await db.query<{ version: string; vector: string | null }>(
        `select current_setting('server_version') as version,
                (select extversion from pg_extension where extname = 'vector') as vector`,
      ),
    );
    const tls = options.config.tls.mode;
    record('connection: verified TLS', tls === 'verify' || isLocal(options.config.url), `tls=${tls}`);
    record('connection: pgvector installed', row?.vector != null, `postgres ${row?.version ?? '?'}, pgvector ${row?.vector ?? 'missing'}`);
  });

  // 2. Migrations.
  await attempt('migrations', async () => {
    const expected = (await loadMigrations()).map((migration) => migration.version);
    const present = maybeOne(await db.query<{ present: boolean }>("select to_regclass('supabase_migrations.schema_migrations') is not null as present"));
    if (!present?.present) {
      record('migrations: all applied', false, 'supabase_migrations.schema_migrations is missing: run npm run db:migrate');
      return;
    }
    const applied = new Set((await db.query<{ version: string }>('select version from supabase_migrations.schema_migrations')).map((row) => row.version));
    const missing = expected.filter((version) => !applied.has(version));
    record('migrations: all applied', missing.length === 0, missing.length === 0 ? `${expected.length} migrations` : `missing ${missing.join(', ')}`);
  });

  // 3. Transaction-local settings never leak through pooled connections.
  await attempt('transaction pooling', async () => {
    const leaked: string[] = [];
    for (let round = 0; round < 6; round += 1) {
      await db.transaction(async (sql) => {
        await sql.query("select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)", [
          JSON.stringify({ sub: randomUUID(), role: 'authenticated' }),
        ]);
      });
      const after = maybeOne(
        await db.query<{ claims: string | null; role: string }>(
          "select nullif(current_setting('request.jwt.claims', true), '') as claims, current_user as role",
        ),
      );
      if (after?.claims) leaked.push(`claims leaked: ${after.claims}`);
      if (after && after.role === 'authenticated') leaked.push('role leaked');
    }
    record('transaction pooling: settings stay transaction-local', leaked.length === 0, leaked.join('; ') || undefined);
  });

  // 4. Supabase Auth: real users and verified claims.
  const created: string[] = [];
  let users: readonly [string, string] | null = options.users ?? null;
  if (options.auth) {
    const auth = options.auth;
    await attempt('supabase auth', async () => {
      const password = randomBytes(24).toString('base64url');
      const ids: string[] = [];
      for (const label of ['a', 'b']) {
        const email = `${VALIDATION_PREFIX}+${label}-${randomUUID().slice(0, 8)}@example.com`;
        const id = await auth.createUser(email, password);
        created.push(id);
        const claims = await auth.signIn(email, password);
        record(`supabase auth: user ${label} signs in with verified claims`, claims.sub === id && claims.role === 'authenticated', `role=${claims.role}`);
        ids.push(id);
      }
      const [first, second] = ids;
      if (first !== undefined && second !== undefined) users = [first, second];
    });
  } else if (!users) {
    skip('supabase auth', 'set NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and SUPABASE_SECRET_KEY');
  }

  const organizations: string[] = [];
  try {
    if (users) {
      const [userA, userB] = users;
      // Tracked one by one: a failure creating B must not leak A.
      const a = await createOrganization(db, { name: `${VALIDATION_PREFIX} A`, ownerUserId: userA });
      organizations.push(a.organization.id);
      const b = await createOrganization(db, { name: `${VALIDATION_PREFIX} B`, ownerUserId: userB });
      organizations.push(b.organization.id);

      // 5. RLS isolation with Supabase's real roles and policies.
      await attempt('rls isolation', async () => {
        const seen = await userScope(db, userA).run(async (sql) => ({
          organizations: (await sql.query<{ id: string }>('select id from public.organizations')).map((row) => row.id),
          foreignAgents: await sql.query('select id from public.agents where organization_id = $1', [b.organization.id]),
          hijack: await sql.query("update public.agents set instructions = 'hijacked' where organization_id = $1 returning id", [
            b.organization.id,
          ]),
        }));
        record(
          'rls isolation: a user sees and changes only their organization',
          seen.organizations.length === 1 && seen.organizations[0] === a.organization.id && seen.foreignAgents.length === 0 && seen.hijack.length === 0,
          `organizations visible: ${seen.organizations.length}`,
        );
      });

      // 6. pgvector retrieval, tenant-scoped.
      await attempt('pgvector retrieval', async () => {
        for (const [org, text] of [
          [a, 'Our emergency boiler repair costs 89 dollars per visit.'],
          [b, 'Pinball machine rental costs 300 dollars per weekend.'],
        ] as const) {
          const source = await ingestTextSource(serviceScope(db), validationEmbedder, {
            organizationId: org.organization.id,
            agentId: null,
            kind: 'text',
            title: `${VALIDATION_PREFIX} knowledge`,
            text,
            createdBy: null,
          });
          if (source.status !== 'ready') throw new Error(`ingestion ended as ${source.status}: ${source.error ?? ''}`);
        }
        const results = await searchKnowledge(serviceScope(db), validationEmbedder, {
          organizationId: a.organization.id,
          agentId: a.agent.id,
          query: 'How much does emergency boiler repair cost?',
          budget: { maxChunks: 5, maxTokens: 1000, minSimilarity: 0 },
        });
        const contents = results.map((chunk) => chunk.content).join(' ');
        record(
          'pgvector retrieval: finds the tenant’s own knowledge, never another tenant’s',
          contents.includes('boiler') && !contents.includes('Pinball'),
          `${results.length} chunk(s)`,
        );
      });

      // 7. Concurrency on the real pool.
      await attempt('concurrency', async () => {
        const conversation = await serviceScope(db).run((sql) =>
          getOrCreateVisitorConversation(sql, {
            organizationId: a.organization.id,
            agentId: a.agent.id,
            channel: 'web_chat',
            visitorId: randomUUID(),
          }),
        );
        const tokens = await Promise.all(
          Array.from({ length: 8 }, () =>
            serviceScope(db).run((sql) => tryAcquireTurnLock(sql, a.organization.id, conversation.id, 60)),
          ),
        );
        record('concurrency: exactly one turn-lock owner', tokens.filter((token) => token !== null).length === 1);

        const guard = createUsageGuard({
          db,
          // 0.30 USD per input token: each reservation below is worth 0.30 USD against a 1 USD daily limit.
          costs: createCostEstimator({ [`${VALIDATION_PREFIX}-model`]: { inputPerMTok: 300_000, outputPerMTok: 0 } }),
          defaults: { dailySpendUsd: 1, monthlySpendUsd: 1, maxConversationTurns: 10 },
          logger: silentLogger,
        });
        const reservations = await Promise.allSettled(
          Array.from({ length: 6 }, () =>
            guard.reserveText(a.organization.id, { model: `${VALIDATION_PREFIX}-model`, inputTokens: 1, maxOutputTokens: 0 }),
          ),
        );
        const granted = reservations.filter((result) => result.status === 'fulfilled').length;
        const refusedCleanly = reservations.every((result) => result.status === 'fulfilled' || result.reason instanceof UsageLimitError);
        record('concurrency: parallel spend reservations never overshoot the limit', granted === 3 && refusedCleanly, `${granted} of 6 granted`);

        const claims = await Promise.all(
          Array.from({ length: 5 }, () =>
            serviceScope(db).run((sql) =>
              claimOperation(
                sql,
                {
                  organizationId: a.organization.id,
                  agentId: a.agent.id,
                  conversationId: conversation.id,
                  channel: 'web_chat',
                  toolName: VALIDATION_PREFIX,
                  operationKey: `${VALIDATION_PREFIX}-${conversation.id}`,
                },
                {},
                60,
              ),
            ),
          ),
        );
        record('concurrency: one execution claim per external operation', claims.filter((claim) => claim.claimed).length === 1);
      });

      // 8. Usage accounting.
      await attempt('usage accounting', async () => {
        const recorder = createUsageRecorder({
          db,
          costs: createCostEstimator({ [`${VALIDATION_PREFIX}-model`]: { inputPerMTok: 1, outputPerMTok: 2 } }),
          logger: silentLogger,
          pricingVersion: VALIDATION_PREFIX,
        });
        await recorder.recordTextGeneration({ organizationId: b.organization.id }, 'chat_response', {
          provider: VALIDATION_PREFIX,
          model: `${VALIDATION_PREFIX}-model`,
          usage: { inputTokens: 1_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 500, reasoningTokens: 0 },
          toolCalls: 0,
          durationMs: 1,
        });
        const total = maybeOne(
          await db.query<{ cost: string | number }>(
            'select coalesce(sum(estimated_cost_usd), 0) as cost from app_private.usage_daily_totals where organization_id = $1',
            [b.organization.id],
          ),
        );
        // 1,000 input tokens at $1/M + 500 output tokens at $2/M.
        record('usage accounting: records feed the daily spend totals', Math.abs(toNumber(total?.cost ?? 0) - 0.002) < 1e-9);
      });
    } else {
      for (const name of ['rls isolation', 'pgvector retrieval', 'concurrency', 'usage accounting']) {
        skip(name, 'needs two auth users (Supabase Auth checks)');
      }
    }
  } finally {
    for (const id of organizations) {
      await db.query('delete from public.organizations where id = $1', [id]).catch((error: unknown) => {
        print(`  cleanup: could not delete organization ${id}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    if (options.auth) {
      for (const id of created) {
        await options.auth.deleteUser(id).catch((error: unknown) => {
          print(`  cleanup: could not delete auth user ${id}: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    }
  }

  for (const item of checks) {
    print(`  ${item.status.toUpperCase().padEnd(4)}  ${item.name}${item.detail === undefined ? '' : ` — ${item.detail}`}`);
  }
  return checks;
}

function isLocal(url: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Real Supabase Auth through supabase-js: admin calls with the secret key, sign-in with the publishable key. */
function supabaseAuthHarness(url: string, publishableKey: string, secretKey: string): AuthHarness {
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(url, secretKey, options);
  return {
    async createUser(email, password) {
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (error) throw new Error(`createUser: ${error.message}`);
      return data.user.id;
    },
    async signIn(email, password) {
      const client = createClient(url, publishableKey, options);
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw new Error(`signInWithPassword: ${error.message}`);
      const { data, error: claimsError } = await client.auth.getClaims();
      if (claimsError || !data) throw new Error(`getClaims: ${claimsError?.message ?? 'no claims'}`);
      return { sub: data.claims.sub, role: data.claims.role };
    },
    async deleteUser(id) {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) throw new Error(`deleteUser: ${error.message}`);
    },
  };
}

// ── entry point ───────────────────────────────────────────────────────────────

function loadEnvFiles(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(path.join(ROOT, file));
    } catch {
      // Missing file: nothing to load.
    }
  }
}

async function main(args: readonly string[]): Promise<number> {
  loadEnvFiles();
  let config: DatabaseConfig;
  try {
    config = loadDatabaseConfig();
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\nSet DATABASE_URL in .env.local (see LIVE_VALIDATION.md).`);
    return 1;
  }
  if (isUnverifiedRemoteDatabase(config) && !args.includes('--allow-unverified-tls')) {
    console.error('Refusing to connect without verified TLS: set DATABASE_SSL_CA (or pass --allow-unverified-tls).');
    return 1;
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  const auth = url && publishableKey && secretKey ? supabaseAuthHarness(url, publishableKey, secretKey) : null;

  const db = createPostgresDatabase(config);
  try {
    console.log(`Live validation against ${new URL(config.url).hostname} (tls: ${config.tls.mode})`);
    const checks = await runLiveValidation({ db, config, auth });
    const failed = checks.filter((item) => item.status === 'fail').length;
    const skipped = checks.filter((item) => item.status === 'skip').length;
    console.log(`\n${checks.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
    return failed > 0 ? 1 : 0;
  } catch (error) {
    console.error(`Live validation failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await db.close();
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const normalize = (file: string) => {
    const resolved = path.resolve(file);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(fileURLToPath(import.meta.url)) === normalize(entry);
}

if (isEntryPoint()) {
  process.exitCode = await main(process.argv.slice(2));
}
