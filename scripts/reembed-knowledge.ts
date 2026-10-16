/**
 * Re-embeds knowledge after an embedding-model change (AI_EMBEDDING_MODEL).
 *
 * Retrieval only compares a query with chunks embedded by the same model, so sources embedded with a
 * previous model stay 'ready' but are invisible to searchKnowledge until they are re-embedded. Run this
 * once after changing the model (for every organization):
 *
 *   npm run knowledge:reembed
 *   npm run knowledge:reembed -- --dry-run     (lists affected sources, changes nothing)
 *
 * Sources are processed one at a time through the normal ingestion path, so embedding usage is metered
 * against each organization. The command is resumable: it selects every source that has text but no chunks
 * for the configured model (ready, failed, or stuck processing), so a re-run picks up whatever an earlier run
 * did not finish. On an embedding-provider outage it stops at once (exit 1) instead of failing every
 * remaining source; re-run it when the provider recovers.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Embedder } from '@/server/ai/embedder';
import { getAppServices } from '@/server/app-services';
import { serviceScope } from '@/server/db/scope';
import type { Database } from '@/server/db/types';
import { EMBEDDING_UNAVAILABLE_MESSAGE, reindexKnowledgeSource } from '@/server/domain/knowledge/ingestion';
import type { Logger } from '@/server/observability/logger';

export interface StaleSource {
  organizationId: string;
  sourceId: string;
  title: string;
  status: string;
  /** Embedding models of the source's current chunks (none is the configured model; empty after a failure). */
  models: string[];
}

/** Same threshold as the admin Retry: a 'processing' source older than this was interrupted. */
const STALE_PROCESSING_MS = 5 * 60 * 1000;

export interface ReembedSummary {
  found: number;
  reembedded: number;
  failed: number;
  /** Sources left for a re-run because the run stopped on a provider outage. */
  remaining: number;
}

/**
 * Sources that have text but no chunks for `model`: ready sources still on an older model, sources whose earlier
 * re-embed failed, and sources stuck processing (an interrupted run). Oldest first per organization.
 */
export async function findStaleSources(db: Database, model: string): Promise<StaleSource[]> {
  const rows = await db.query<{ organization_id: string; source_id: string; title: string; status: string; models: string[] | null }>(
    `select s.organization_id, s.id as source_id, s.title, s.status,
            (select array_agg(distinct c.embedding_model order by c.embedding_model)
             from public.knowledge_chunks c
             where c.source_id = s.id and c.organization_id = s.organization_id) as models
     from public.knowledge_sources s
     where exists (select 1 from public.knowledge_documents d
                   where d.source_id = s.id and d.organization_id = s.organization_id)
       and not exists (select 1 from public.knowledge_chunks c
                       where c.source_id = s.id and c.organization_id = s.organization_id and c.embedding_model = $1)
       and (s.status in ('ready', 'failed')
            or (s.status in ('pending', 'processing')
                and s.updated_at < now() - make_interval(secs => $2::double precision / 1000)))
     order by s.organization_id, s.created_at, s.id`,
    [model, STALE_PROCESSING_MS],
  );
  return rows.map((row) => ({
    organizationId: row.organization_id,
    sourceId: row.source_id,
    title: row.title,
    status: row.status,
    models: row.models ?? [],
  }));
}

export async function reembedStaleSources(
  deps: { db: Database; embedder: Embedder; logger: Logger },
  options: { dryRun: boolean; print: (line: string) => void },
): Promise<ReembedSummary> {
  const stale = await findStaleSources(deps.db, deps.embedder.model);
  const summary: ReembedSummary = { found: stale.length, reembedded: 0, failed: 0, remaining: 0 };
  options.print(`Configured embedding model: ${deps.embedder.model}. Sources to re-embed: ${stale.length}.`);
  const describe = (source: StaleSource) =>
    `${source.organizationId} "${source.title}" (${source.status}; ${source.models.join(', ') || 'no chunks'})`;
  if (options.dryRun) {
    for (const source of stale) options.print(`  [dry run] ${describe(source)}`);
    return summary;
  }

  const db = serviceScope(deps.db);
  for (const [index, source] of stale.entries()) {
    try {
      // Same atomic claim guard as the admin Retry (plus ready sources): never races a run already in progress.
      const result = await reindexKnowledgeSource(db, deps.embedder, source.organizationId, source.sourceId, {
        logger: deps.logger,
        onlyIfRetryable: { staleProcessingMs: STALE_PROCESSING_MS, includeReady: true },
      });
      if (result.status === 'ready') {
        summary.reembedded += 1;
        options.print(`  re-embedded ${describe(source)} -> ${result.chunkCount} chunks`);
        continue;
      }
      summary.failed += 1;
      options.print(`  FAILED ${describe(source)}: ${result.error ?? 'processing failed'}`);
      if (result.error === EMBEDDING_UNAVAILABLE_MESSAGE) {
        // Provider outage: stop instead of failing every remaining source. A re-run resumes from here.
        summary.remaining = stale.length - index - 1;
        options.print(`Stopped: the embedding provider is unavailable. ${summary.remaining} source(s) not processed; re-run when it recovers.`);
        return summary;
      }
    } catch (error) {
      summary.failed += 1;
      options.print(`  FAILED ${describe(source)}: ${(error as Error).message}`);
    }
  }
  options.print(`Done: ${summary.reembedded} re-embedded, ${summary.failed} failed.`);
  return summary;
}

function loadEnvFiles(): void {
  for (const file of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(file);
    } catch {
      // Missing file: nothing to load.
    }
  }
}

async function main(args: readonly string[]): Promise<number> {
  loadEnvFiles();
  const unknown = args.filter((arg) => arg !== '--dry-run');
  if (unknown.length > 0) {
    console.error(`Unknown argument(s): ${unknown.join(' ')}. Usage: npm run knowledge:reembed [-- --dry-run]`);
    return 2;
  }
  let services: ReturnType<typeof getAppServices>;
  try {
    services = getAppServices();
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
  try {
    const summary = await reembedStaleSources(services, { dryRun: args.includes('--dry-run'), print: console.log });
    return summary.failed > 0 ? 1 : 0;
  } catch (error) {
    console.error(`Re-embedding failed: ${(error as Error).message}`);
    return 1;
  } finally {
    await services.db.close();
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
