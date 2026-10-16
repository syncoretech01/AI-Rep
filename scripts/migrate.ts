/**
 * Applies supabase/migrations/* to DATABASE_URL and records them in the Supabase
 * CLI's history table (supabase_migrations.schema_migrations), so this script and
 * `supabase db push` agree on what is applied.
 *
 *   npm run db:migrate              apply pending migrations
 *   npm run db:migrate -- --dry-run list pending migrations only
 *
 * Use a session-mode connection (direct, or the session pooler on 5432) for migrations.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadDatabaseConfig, type DatabaseConfig } from '@/server/config/env';
import { loadMigrations, type MigrationFile } from '@/server/db/migrations';
import { pgConnectionOptions } from '@/server/db/postgres';

/** What the migration logic needs from a connection; `pg.Client` satisfies it. */
export interface MigrationClient {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface MigrationReport {
  /** Applied by this run, in order. */
  applied: MigrationFile[];
  /** Still pending (everything pending on a dry run). */
  pending: MigrationFile[];
}

// Serializes concurrent runs. Transaction-scoped, so it also works through a transaction pooler.
const LOCK_SQL = 'select pg_advisory_xact_lock(7262025100)';

async function inTransaction<T>(client: MigrationClient, work: () => Promise<T>): Promise<T> {
  await client.query('begin');
  try {
    await client.query(LOCK_SQL);
    const result = await work();
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
}

/** Creates the Supabase CLI's history table (or adds the columns we write to an older one). */
export async function ensureMigrationHistory(client: MigrationClient): Promise<void> {
  await inTransaction(client, async () => {
    await client.query(`
      create schema if not exists supabase_migrations;
      create table if not exists supabase_migrations.schema_migrations (version text not null primary key);
      alter table supabase_migrations.schema_migrations add column if not exists statements text[];
      alter table supabase_migrations.schema_migrations add column if not exists name text;
    `);
  });
}

/** Versions recorded as applied; empty when the history table does not exist yet. */
export async function appliedVersions(client: MigrationClient): Promise<Set<string>> {
  const exists = await client.query(`select to_regclass('supabase_migrations.schema_migrations') is not null as present`);
  if ((exists.rows[0] as { present?: unknown } | undefined)?.present !== true) return new Set();
  const { rows } = await client.query('select version from supabase_migrations.schema_migrations');
  return new Set(rows.map((row) => String((row as { version: unknown }).version)));
}

/**
 * Applies each pending migration in its own transaction (the file runs through the simple
 * query protocol, so it may contain many statements) and records it in the same transaction:
 * a failed migration leaves no trace and stops the run.
 */
export async function applyMigrations(
  client: MigrationClient,
  migrations: readonly MigrationFile[],
  options: { dryRun?: boolean; onApplied?: (migration: MigrationFile) => void } = {},
): Promise<MigrationReport> {
  // A dry run only reads: it does not even create the history table.
  if (!options.dryRun) await ensureMigrationHistory(client);
  const done = await appliedVersions(client);
  const pending = migrations.filter((migration) => !done.has(migration.version));
  if (options.dryRun) return { applied: [], pending };

  const applied: MigrationFile[] = [];
  for (const migration of pending) {
    const label = `${migration.version}_${migration.name}`;
    try {
      const ran = await inTransaction(client, async () => {
        // A concurrent run may have applied it while this one waited for the lock.
        const existing = await client.query('select 1 from supabase_migrations.schema_migrations where version = $1', [
          migration.version,
        ]);
        if (existing.rows.length > 0) return false;
        await client.query(migration.sql);
        await client.query(
          `insert into supabase_migrations.schema_migrations (version, name, statements)
           values ($1, $2, array[$3::text])`,
          [migration.version, migration.name, migration.sql],
        );
        return true;
      });
      if (ran) {
        applied.push(migration);
        options.onApplied?.(migration);
      }
    } catch (error) {
      throw new Error(`Migration ${label} failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  }
  return { applied, pending: [] };
}

/** `.env.local` wins over `.env`; variables already set in the environment win over both. */
function loadEnvFiles(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
    } catch {
      // Missing file: nothing to load.
    }
  }
}

const describe = (migration: MigrationFile) => `${migration.version}_${migration.name}`;

async function main(args: readonly string[]): Promise<number> {
  const unknown = args.filter((arg) => arg !== '--dry-run');
  if (unknown.length > 0) {
    console.error(`Unknown argument: ${unknown.join(' ')}\nUsage: npm run db:migrate [-- --dry-run]`);
    return 2;
  }
  const dryRun = args.includes('--dry-run');

  loadEnvFiles();
  let config: DatabaseConfig;
  try {
    config = loadDatabaseConfig();
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\nSet DATABASE_URL in .env.local (see .env.example).`);
    return 1;
  }

  if (config.tls.mode === 'require') {
    console.warn('Warning: TLS without certificate verification. Set DATABASE_SSL_CA to verify the database certificate.');
  }
  const client = new pg.Client({
    ...pgConnectionOptions(config),
    connectionTimeoutMillis: 10_000,
    application_name: 'syncore-migrate',
  });
  try {
    // Read from ./supabase/migrations: run from the repository root (as the npm script does).
    const migrations = await loadMigrations();
    await client.connect();
    const report = await applyMigrations(client, migrations, {
      dryRun,
      onApplied: (migration) => {
        console.log(`  applied  ${describe(migration)}`);
      },
    });
    if (dryRun) {
      if (report.pending.length === 0) console.log(`No pending migrations (${migrations.length} applied).`);
      else console.log(`Pending migrations (${report.pending.length}):\n${report.pending.map((m) => `  ${describe(m)}`).join('\n')}`);
    } else if (report.applied.length === 0) {
      console.log(`Database is up to date (${migrations.length} migrations applied).`);
    } else {
      console.log(`Applied ${report.applied.length} migration(s).`);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await client.end().catch(() => undefined);
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
