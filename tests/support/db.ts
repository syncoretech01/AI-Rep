import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { inject } from 'vitest';
import { serviceScope, userScope, type ScopedDb } from '../../src/server/db/scope';
import type { Database } from '../../src/server/db/types';
import { pgliteDatabase, pgliteOptions } from './pglite';

export interface TestDatabase {
  pg: PGlite;
  /** Privileged handle (superuser — bypasses RLS like the production `postgres` role). */
  db: Database;
  /** Service scope (RLS bypassed), as used by the public widget runtime and tools. */
  service: ScopedDb;
  /** User scope: runs as `authenticated` with the user's JWT claims, so RLS applies. */
  asUser(userId: string): ScopedDb;
  close(): Promise<void>;
}

/**
 * A fresh Postgres (PGlite) with the Supabase shim and all migrations applied,
 * loaded from the template built in global setup. Create one per test file.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const template = await readFile(inject('pgliteTemplatePath'));
  const pg = await PGlite.create({ ...pgliteOptions(), loadDataDir: new Blob([template]) });
  const db = pgliteDatabase(pg);
  return {
    pg,
    db,
    service: serviceScope(db),
    asUser: (userId) => userScope(db, userId),
    close: () => pg.close(),
  };
}
