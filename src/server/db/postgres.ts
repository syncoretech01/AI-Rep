import type { ConnectionOptions } from 'node:tls';
import pg from 'pg';
import type { PoolClient } from 'pg';
import type { DatabaseConfig } from '@/server/config/env';
import type { Logger } from '@/server/observability/logger';
import type { Database, Sql, SqlParam } from './types';

// node-postgres merges these URL parameters OVER an explicit `ssl` option, so they are removed: TLS comes
// only from DATABASE_SSL / DATABASE_SSL_CA.
const URL_TLS_PARAMETERS = ['ssl', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'sslpassword', 'uselibpqcompat'];

/** Connection options shared by the app pool and the migration CLI. */
export function pgConnectionOptions(config: DatabaseConfig): { connectionString: string; ssl: false | ConnectionOptions } {
  const url = new URL(config.url);
  for (const parameter of URL_TLS_PARAMETERS) url.searchParams.delete(parameter);
  const ssl: false | ConnectionOptions =
    config.tls.mode === 'disable'
      ? false
      : config.tls.mode === 'require'
        ? { rejectUnauthorized: false }
        : { ca: config.tls.ca, rejectUnauthorized: true };
  return { connectionString: url.toString(), ssl };
}

function bind(client: pg.Pool | PoolClient): Sql {
  return {
    async query<T extends object>(text: string, params: readonly SqlParam[] = []): Promise<T[]> {
      const result = await client.query(text, [...params]);
      return result.rows as T[];
    },
  };
}

/**
 * Production database bound to Supabase Postgres via node-postgres.
 *
 * node-postgres queues queries per connection instead of pipelining them,
 * which keeps it safe behind Supavisor's transaction pooler (port 6543).
 * Statements are unnamed (no server-side prepared statements). TLS follows
 * DATABASE_SSL / DATABASE_SSL_CA (see pgConnectionOptions).
 */
export function createPostgresDatabase(config: DatabaseConfig, logger?: Logger): Database {
  if (config.tls.mode === 'require') {
    // Encrypted, but the server certificate is not verified (no DATABASE_SSL_CA).
    logger?.warn('db.tls_unverified', { hint: 'set DATABASE_SSL_CA to verify the database certificate' });
  }
  const pool = new pg.Pool({
    ...pgConnectionOptions(config),
    max: config.poolMax,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'syncore-ai-receptionist',
  });
  // An idle client can be dropped by the server or pooler; never crash the process for it.
  pool.on('error', (error) => logger?.warn('db.idle_client_error', { error }));

  const root = bind(pool);

  return {
    query: root.query,
    async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query('begin');
        const result = await fn(bind(client));
        await client.query('commit');
        return result;
      } catch (error) {
        try {
          await client.query('rollback');
        } catch {
          broken = true;
        }
        throw error;
      } finally {
        // A client whose rollback failed is destroyed rather than returned to the pool.
        client.release(broken);
      }
    },
    async close() {
      await pool.end();
    },
  };
}
