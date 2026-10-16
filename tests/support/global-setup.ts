import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { TestProject } from 'vitest/node';
import { loadMigrations } from '../../src/server/db/migrations';
import { SHIM_PATH, TEMPLATE_DIR, pgliteOptions } from './pglite';

const STALE_TEMPLATE_MS = 6 * 60 * 60 * 1000;

/**
 * Builds the template database once per test run: Supabase shim + every
 * migration in supabase/migrations, each applied atomically (one exec per file).
 * Test files load the snapshot instead of re-running migrations. The path is
 * unique per run so concurrent `vitest` processes never share a file.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  await mkdir(TEMPLATE_DIR, { recursive: true });
  await removeStaleTemplates();
  const templatePath = path.join(TEMPLATE_DIR, `template-${process.pid}-${Date.now()}.tar`);

  const pg = await PGlite.create(pgliteOptions());
  try {
    await pg.exec(await readFile(SHIM_PATH, 'utf8'));
    for (const migration of await loadMigrations()) {
      try {
        await pg.exec(migration.sql);
      } catch (error) {
        throw new Error(`Migration ${migration.version}_${migration.name} failed: ${(error as Error).message}`, {
          cause: error,
        });
      }
    }
    const dump = await pg.dumpDataDir('none');
    await writeFile(templatePath, Buffer.from(await dump.arrayBuffer()));
  } finally {
    await pg.close();
  }

  project.provide('pgliteTemplatePath', templatePath);
  return async () => {
    await rm(templatePath, { force: true });
  };
}

/** True while the vitest process that wrote `template-<pid>-<time>.tar` is still running (e.g. a watch session). */
function ownerIsAlive(file: string): boolean {
  const pid = Number(/^template-(\d+)-\d+\.tar$/.exec(file)?.[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function removeStaleTemplates(): Promise<void> {
  const now = Date.now();
  for (const file of await readdir(TEMPLATE_DIR)) {
    const full = path.join(TEMPLATE_DIR, file);
    try {
      if (now - (await stat(full)).mtimeMs > STALE_TEMPLATE_MS && !ownerIsAlive(file)) await rm(full, { force: true });
    } catch {
      // Another run may be removing it concurrently.
    }
  }
}
