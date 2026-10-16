import type { Database, Sql } from './types';

/**
 * Who a unit of database work runs as.
 * - `user`: an authenticated admin. Runs as Postgres role `authenticated` with
 *   the user's JWT claims, so Supabase RLS policies apply (defense in depth on
 *   top of the explicit organization filters every query carries).
 * - `service`: the server itself (public widget runtime, tool execution, usage
 *   and audit writes). Bypasses RLS; callers must have resolved the tenant
 *   server-side and must scope every statement by organization_id.
 */
export type DbActor = { readonly kind: 'service' } | { readonly kind: 'user'; readonly userId: string };

export interface ScopedDb {
  readonly actor: DbActor;
  /** Runs `fn` in one transaction under this actor. */
  run<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Per-statement limit for scoped transactions: a hung statement must not hold a chat turn (and its lock) past the request budget. */
const STATEMENT_TIMEOUT_MS = '15000';

export function serviceScope(db: Database): ScopedDb {
  return {
    actor: { kind: 'service' },
    run: (fn) =>
      db.transaction(async (tx) => {
        // Transaction-local (SET LOCAL semantics), so it is safe behind a transaction pooler.
        await tx.query("select set_config('statement_timeout', $1, true)", [STATEMENT_TIMEOUT_MS]);
        return fn(tx);
      }),
  };
}

export function userScope(db: Database, userId: string): ScopedDb {
  if (!UUID_RE.test(userId)) throw new Error('userScope requires a UUID user id');
  const claims = JSON.stringify({ sub: userId, role: 'authenticated' });
  return {
    actor: { kind: 'user', userId },
    run: (fn) =>
      db.transaction(async (tx) => {
        // Same mechanism PostgREST uses. Transaction-local (SET LOCAL semantics):
        // reverts on commit/rollback, so it is safe with connection poolers.
        // SET ROLE does not apply role-level settings, so the statement timeout is set here.
        await tx.query(
          `select set_config('role', 'authenticated', true),
                  set_config('request.jwt.claims', $1, true),
                  set_config('statement_timeout', $2, true)`,
          [claims, STATEMENT_TIMEOUT_MS],
        );
        return fn(tx);
      }),
  };
}
