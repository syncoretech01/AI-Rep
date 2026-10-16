import 'server-only';
import { loadDatabaseConfig } from '@/server/config/env';
import type { Logger } from '@/server/observability/logger';
import { createPostgresDatabase } from './postgres';
import type { Database } from './types';

const globalForDb = globalThis as typeof globalThis & { __syncoreDb?: Database };

/** Process-wide database (HMR-safe). Created lazily so builds never need DATABASE_URL. */
export function getDatabase(logger?: Logger): Database {
  globalForDb.__syncoreDb ??= createPostgresDatabase(loadDatabaseConfig(), logger);
  return globalForDb.__syncoreDb;
}
