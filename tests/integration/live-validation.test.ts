import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMigrations } from '@/server/db/migrations';
import { VALIDATION_PREFIX, runLiveValidation } from '../../scripts/validate-live';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { createAuthUser } from '../support/fixtures';

/**
 * The live validation script (`npm run validate:live`) is meant for a real Supabase project. Its database checks
 * run here against PGlite so the script itself is known to work before anyone points it at production; this is
 * NOT evidence about Supabase (see LIVE_VALIDATION.md).
 */

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
  // What `npm run db:migrate` records on a real project.
  await t.db.query('create schema if not exists supabase_migrations');
  await t.db.query('create table if not exists supabase_migrations.schema_migrations (version text primary key)');
  for (const migration of await loadMigrations()) {
    await t.db.query('insert into supabase_migrations.schema_migrations (version) values ($1) on conflict do nothing', [
      migration.version,
    ]);
  }
});

afterAll(async () => {
  await t.close();
});

describe('validate:live (against the test database)', () => {
  it('passes every database check and cleans up after itself', async () => {
    const userA = await t.service.run((sql) => createAuthUser(sql));
    const userB = await t.service.run((sql) => createAuthUser(sql));
    const lines: string[] = [];

    const checks = await runLiveValidation({
      db: t.db,
      config: { url: 'postgresql://postgres:postgres@localhost:54322/postgres', tls: { mode: 'disable' } },
      auth: null,
      users: [userA.id, userB.id],
      print: (line) => lines.push(line),
    });

    expect(checks.filter((item) => item.status !== 'pass')).toEqual([]);
    expect(checks.map((item) => item.name)).toEqual([
      'connection: verified TLS',
      'connection: pgvector installed',
      'migrations: all applied',
      'transaction pooling: settings stay transaction-local',
      'rls isolation: a user sees and changes only their organization',
      'pgvector retrieval: finds the tenant’s own knowledge, never another tenant’s',
      'concurrency: exactly one turn-lock owner',
      'concurrency: parallel spend reservations never overshoot the limit',
      'concurrency: one execution claim per external operation',
      'usage accounting: records feed the daily spend totals',
    ]);
    expect(lines.filter((line) => line.includes('cleanup'))).toEqual([]);
    const leftovers = await t.db.query('select id from public.organizations where name like $1', [`${VALIDATION_PREFIX}%`]);
    expect(leftovers).toEqual([]);
  });

  it('reports the checks that need Supabase Auth as skipped when it is not configured', async () => {
    const checks = await runLiveValidation({
      db: t.db,
      config: { url: 'postgresql://u:p@db.example.supabase.co:6543/postgres', tls: { mode: 'require' } },
      auth: null,
      print: () => undefined,
    });
    expect(checks.find((item) => item.name === 'connection: verified TLS')).toMatchObject({ status: 'fail', detail: 'tls=require' });
    expect(checks.filter((item) => item.status === 'skip').map((item) => item.name)).toEqual([
      'supabase auth',
      'rls isolation',
      'pgvector retrieval',
      'concurrency',
      'usage accounting',
    ]);
  });
});
