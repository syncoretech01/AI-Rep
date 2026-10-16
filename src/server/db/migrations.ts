import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface MigrationFile {
  /** 14-digit timestamp prefix, as used by the Supabase CLI. */
  version: string;
  name: string;
  sql: string;
}

const MIGRATION_FILE = /^(\d{14})_([a-z0-9_]+)\.sql$/;

export const MIGRATIONS_DIR = path.join(process.cwd(), 'supabase', 'migrations');

/** Reads `supabase/migrations/<version>_<name>.sql` files in version order. */
export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const files = entries
    .map((file) => ({ file, match: MIGRATION_FILE.exec(file) }))
    .filter((entry): entry is { file: string; match: RegExpExecArray } => entry.match !== null)
    .sort((a, b) => a.file.localeCompare(b.file));

  return Promise.all(
    files.map(async ({ file, match }) => ({
      version: match[1] ?? '',
      name: match[2] ?? '',
      sql: await readFile(path.join(dir, file), 'utf8'),
    })),
  );
}
