/**
 * Minimal database seam. Domain code issues parameterized SQL ($1, $2, …)
 * through `Sql`; production binds it to node-postgres (Supabase Postgres) and
 * tests bind it to PGlite (real Postgres + pgvector compiled to WASM).
 *
 * Parameters are deliberately narrow: JSON must be passed pre-serialized with
 * an explicit `::jsonb` cast, vectors as `'[…]'` text with `::extensions.vector`,
 * and arrays as Postgres array literals (see `pgTextArray`).
 */
export type SqlParam = string | number | boolean | null | Date;

export type Row = Record<string, unknown>;

export interface Sql {
  readonly query: <T extends object = Row>(text: string, params?: readonly SqlParam[]) => Promise<T[]>;
}

export interface Database extends Sql {
  /** Runs `fn` in a single transaction; rolls back if it throws. */
  readonly transaction: <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>;
  readonly close: () => Promise<void>;
}
