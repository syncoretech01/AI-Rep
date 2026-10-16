import path from 'node:path';
import { PGlite, types } from '@electric-sql/pglite';
import type { PGliteOptions, Transaction } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import type { Database, Sql, SqlParam } from '../../src/server/db/types';

/** Where global setup writes migrated template databases (one file per test run). */
export const TEMPLATE_DIR = path.join(process.cwd(), 'node_modules', '.cache', 'syncore-tests');
export const SHIM_PATH = path.join(process.cwd(), 'tests', 'support', 'supabase-shim.sql');

/**
 * PGlite options that mirror the production connection: `extensions` on the
 * search_path (as for Supabase's postgres role), UTC session time zone, and
 * int8 returned as string (as node-postgres does).
 */
export function pgliteOptions(): PGliteOptions {
  return {
    extensions: { vector },
    startParams: [...PGlite.defaultStartParams, '-c', 'search_path=public,extensions', '-c', 'timezone=UTC'],
    parsers: { [types.INT8]: (value: string) => value },
  };
}

function bind(client: PGlite | Transaction): Sql {
  return {
    async query<T extends object>(text: string, params: readonly SqlParam[] = []): Promise<T[]> {
      const result = await client.query<T>(text, [...params]);
      return result.rows;
    },
  };
}

/**
 * `Database` over PGlite. PGlite is a single session: never use the root
 * handle (or open another transaction) inside a transaction callback — it
 * deadlocks, just as nested pool usage would be a bug in production.
 */
export function pgliteDatabase(pg: PGlite): Database {
  const root = bind(pg);
  return {
    query: root.query,
    transaction: (fn) => pg.transaction((tx) => fn(bind(tx))),
    close: () => pg.close(),
  };
}
