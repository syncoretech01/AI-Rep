import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Embedder } from '@/server/ai/embedder';
import { ProviderError } from '@/server/ai/types';
import { EMBEDDING_DIMENSIONS } from '@/server/config/env';
import type { ScopedDb } from '@/server/db/scope';
import { jsonParam, maybeOne, one, toDate, toNumber, vectorParam } from '@/server/db/sql';
import type { Sql, SqlParam } from '@/server/db/types';
import { DomainError } from '@/server/domain/types';
import { createLogger, type Logger } from '@/server/observability/logger';
import { chunkText, type TextChunk } from './chunker';
import { normalizeKnowledgeText, normalizeLabel } from './normalize';
import { MAX_KNOWLEDGE_FILE_BYTES, textSourceInputSchema } from './schemas';
import {
  KNOWLEDGE_SOURCE_KINDS,
  type KnowledgeSource,
  type KnowledgeSourceKind,
  type KnowledgeSourceStatus,
} from './types';

/**
 * Knowledge ingestion: source -> document (normalized text) -> chunks ->
 * embeddings -> pgvector. Embedding is slow, external I/O, so it runs between
 * transactions, never inside one: tx1 records the source ('processing') and its
 * document, the chunks are embedded, then tx2 stores them and marks the source
 * 'ready' (or tx3 marks it 'failed' with an admin-safe reason).
 *
 * Works under user scope (admin actions: RLS requires owner/admin) and service
 * scope (seed script). Every statement is scoped by organization_id.
 */

export interface IngestTextInput {
  organizationId: string;
  agentId: string | null;
  kind: KnowledgeSourceKind;
  title: string;
  text: string;
  createdBy: string | null;
  file?: { name: string; mimeType: string; byteSize: number };
}

export interface IngestionOptions {
  /** Receives failure details that are never shown to admins. Defaults to a module logger. */
  logger?: Logger;
}

export interface ReindexOptions extends IngestionOptions {
  /**
   * Claim the source only while it is retryable: 'failed', or 'pending'/'processing' without progress for this
   * long (an interrupted request). The check is part of the claiming UPDATE, so two concurrent retries cannot both
   * re-embed (and pay for) the same source; the loser gets DomainError('conflict').
   */
  onlyIfRetryable?: {
    staleProcessingMs: number;
    /** Also claim 'ready' sources (re-embedding after an embedding-model change). */
    includeReady?: boolean;
  };
}

/** Inputs per embedding request. */
const EMBED_BATCH_SIZE = 64;
/** Rows per insert statement (each row carries a 1536-dimension vector literal). */
const INSERT_BATCH_SIZE = 32;

const NO_TEXT_MESSAGE = 'No readable text found.';
/** Exported so batch callers (the re-embed command) can stop on a provider outage. */
export const EMBEDDING_UNAVAILABLE_MESSAGE = 'The embedding service is unavailable. Please try again later.';
const INVALID_EMBEDDINGS_MESSAGE = 'The embedding service returned an invalid result. Please try again later.';
const PROCESSING_FAILED_MESSAGE = 'Processing failed.';
const NOT_FOUND_MESSAGE = 'Knowledge source not found.';
const FORBIDDEN_MESSAGE = 'Only owners and admins can manage knowledge.';
const NOT_RETRYABLE_MESSAGE = 'This source is being processed or does not need a retry.';
const INVALID_AGENT_MESSAGE = 'Choose a valid agent.';
const INVALID_FILE_MESSAGE = 'The file details are invalid.';
const AGENT_FOREIGN_KEY = 'knowledge_sources_agent_id_organization_id_fkey';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SOURCE_COLUMNS =
  'id, organization_id, agent_id, kind, title, status, error, file_name, mime_type, byte_size, chunk_count, created_at, updated_at';

const defaultLogger = createLogger({ bindings: { module: 'knowledge.ingestion' } });

const idSchema = z.string().regex(UUID_RE, 'Invalid identifier.');

// Column limits from supabase/migrations (knowledge_sources.file_name / mime_type).
const fileDetailsSchema = z.object(
  {
    name: z
      .string(INVALID_FILE_MESSAGE)
      .transform(normalizeLabel)
      .pipe(z.string().min(1, INVALID_FILE_MESSAGE).max(255, INVALID_FILE_MESSAGE)),
    mimeType: z.string(INVALID_FILE_MESSAGE).trim().min(1, INVALID_FILE_MESSAGE).max(100, INVALID_FILE_MESSAGE),
    byteSize: z
      .number(INVALID_FILE_MESSAGE)
      .int(INVALID_FILE_MESSAGE)
      .min(0, INVALID_FILE_MESSAGE)
      .max(MAX_KNOWLEDGE_FILE_BYTES, 'The file is too large (maximum 1 MB).'),
  },
  INVALID_FILE_MESSAGE,
);

const ingestInputSchema = textSourceInputSchema
  .extend({
    organizationId: idSchema,
    kind: z.enum(KNOWLEDGE_SOURCE_KINDS, 'Choose a valid source type.'),
    createdBy: idSchema.nullable(),
    file: fileDetailsSchema.optional(),
  })
  .refine((input) => input.kind === 'text' || input.file !== undefined, 'File details are required.');

type ValidIngestInput = z.output<typeof ingestInputSchema>;

interface SourceRow {
  id: string;
  organization_id: string;
  agent_id: string | null;
  kind: KnowledgeSourceKind;
  title: string;
  status: KnowledgeSourceStatus;
  error: string | null;
  file_name: string | null;
  mime_type: string | null;
  byte_size: number | string | null;
  chunk_count: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

/** The document of a source being (re)indexed. */
interface IndexTarget {
  organizationId: string;
  agentId: string | null;
  sourceId: string;
  documentId: string;
  content: string;
}

interface EmbeddedChunks {
  vectors: number[][];
  model: string;
}

/** A processing failure whose message is safe to show to an admin. */
class IngestionError extends Error {}

function mapSource(row: SourceRow): KnowledgeSource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    agentId: row.agent_id,
    kind: row.kind,
    title: row.title,
    status: row.status,
    error: row.error,
    fileName: row.file_name,
    mimeType: row.mime_type,
    byteSize: row.byte_size === null ? null : toNumber(row.byte_size),
    chunkCount: toNumber(row.chunk_count),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** SQLSTATE and constraint name of a driver error (node-postgres and PGlite share these fields). */
function databaseErrorInfo(error: unknown): { code: unknown; constraint: unknown } {
  if (typeof error !== 'object' || error === null) return { code: undefined, constraint: undefined };
  const record = error as { code?: unknown; constraint?: unknown };
  return { code: record.code, constraint: record.constraint };
}

/** Maps write failures the admin can act on; anything else is rethrown unchanged. */
function toDomainWriteError(error: unknown): DomainError | null {
  const { code, constraint } = databaseErrorInfo(error);
  // The composite FK (agent_id, organization_id) rejects an agent of another organization.
  if (code === '23503' && constraint === AGENT_FOREIGN_KEY) return new DomainError('invalid', INVALID_AGENT_MESSAGE);
  // RLS (user scope): only owners/admins may write knowledge.
  if (code === '42501') return new DomainError('forbidden', FORBIDDEN_MESSAGE);
  return null;
}

function parseIngestInput(input: IngestTextInput): ValidIngestInput {
  const parsed = ingestInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new DomainError('invalid', parsed.error.issues[0]?.message ?? 'Invalid knowledge source.');
  }
  return parsed.data;
}

async function insertSourceWithDocument(sql: Sql, input: ValidIngestInput, content: string): Promise<IndexTarget> {
  const file = input.kind === 'file' ? (input.file ?? null) : null;
  const source = one(
    await sql.query<{ id: string }>(
      `insert into public.knowledge_sources
         (organization_id, agent_id, kind, title, status, file_name, mime_type, byte_size, created_by)
       values ($1, $2, $3, $4, 'processing', $5, $6, $7, $8)
       returning id`,
      [
        input.organizationId,
        input.agentId,
        input.kind,
        input.title,
        file?.name ?? null,
        file?.mimeType ?? null,
        file?.byteSize ?? null,
        input.createdBy,
      ],
    ),
    'knowledge source',
  );
  const document = one(
    await sql.query<{ id: string }>(
      `insert into public.knowledge_documents (organization_id, source_id, title, content, content_sha256, char_count)
       values ($1, $2, $3, $4::text, $5, char_length($4::text))
       returning id`,
      [input.organizationId, source.id, input.title, content, sha256Hex(content)],
    ),
    'knowledge document',
  );
  return {
    organizationId: input.organizationId,
    agentId: input.agentId,
    sourceId: source.id,
    documentId: document.id,
    content,
  };
}

/** Row lock on the source: serializes concurrent (re)indexing and detects deletion while embedding. */
async function lockSource(sql: Sql, organizationId: string, sourceId: string): Promise<boolean> {
  const rows = await sql.query(
    'select id from public.knowledge_sources where id = $1 and organization_id = $2 for update',
    [sourceId, organizationId],
  );
  return rows.length > 0;
}

async function embedChunks(embedder: Embedder, chunks: readonly TextChunk[], target: IndexTarget): Promise<EmbeddedChunks> {
  const vectors: number[][] = [];
  let model: string | null = null;
  for (let start = 0; start < chunks.length; start += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(start, start + EMBED_BATCH_SIZE).map((chunk) => chunk.content);
    const outcome = await embedder.embed(batch, {
      organizationId: target.organizationId,
      agentId: target.agentId,
      purpose: 'knowledge_ingestion',
    });
    const valid =
      outcome.vectors.length === batch.length &&
      outcome.vectors.every((vector) => vector.length === EMBEDDING_DIMENSIONS) &&
      (model === null || outcome.model === model);
    if (!valid) throw new IngestionError(INVALID_EMBEDDINGS_MESSAGE);
    model = outcome.model;
    vectors.push(...outcome.vectors);
  }
  if (model === null) throw new IngestionError(NO_TEXT_MESSAGE);
  return { vectors, model };
}

/** tx2: replaces the document's chunks and marks the source ready. Null when the source no longer exists. */
async function storeChunks(
  sql: Sql,
  target: IndexTarget,
  chunks: readonly TextChunk[],
  embedded: EmbeddedChunks,
): Promise<SourceRow | null> {
  if (!(await lockSource(sql, target.organizationId, target.sourceId))) return null;
  await sql.query('delete from public.knowledge_chunks where document_id = $1 and organization_id = $2', [
    target.documentId,
    target.organizationId,
  ]);
  for (let start = 0; start < chunks.length; start += INSERT_BATCH_SIZE) {
    const params: SqlParam[] = [target.organizationId, target.sourceId, target.documentId, embedded.model];
    const rows: string[] = [];
    chunks.slice(start, start + INSERT_BATCH_SIZE).forEach((chunk, offset) => {
      const vector = embedded.vectors[start + offset];
      if (vector === undefined) throw new IngestionError(INVALID_EMBEDDINGS_MESSAGE);
      const n = params.length;
      params.push(chunk.index, chunk.content, chunk.tokenCount, vectorParam(vector), jsonParam({ heading: chunk.heading }));
      rows.push(`($1, $2, $3, $${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}::extensions.vector, $4, $${n + 5}::jsonb)`);
    });
    await sql.query(
      `insert into public.knowledge_chunks
         (organization_id, source_id, document_id, chunk_index, content, token_count, embedding, embedding_model, metadata)
       values ${rows.join(', ')}`,
      params,
    );
  }
  return maybeOne(
    await sql.query<SourceRow>(
      `update public.knowledge_sources set status = 'ready', error = null, chunk_count = $3
       where id = $1 and organization_id = $2
       returning ${SOURCE_COLUMNS}`,
      [target.sourceId, target.organizationId, chunks.length],
    ),
  );
}

/** tx3: a failed source keeps no chunks. Null when the source no longer exists. */
async function markFailed(sql: Sql, organizationId: string, sourceId: string, message: string): Promise<SourceRow | null> {
  if (!(await lockSource(sql, organizationId, sourceId))) return null;
  await sql.query('delete from public.knowledge_chunks where source_id = $1 and organization_id = $2', [
    sourceId,
    organizationId,
  ]);
  return maybeOne(
    await sql.query<SourceRow>(
      `update public.knowledge_sources set status = 'failed', error = $3, chunk_count = 0
       where id = $1 and organization_id = $2
       returning ${SOURCE_COLUMNS}`,
      [sourceId, organizationId, message],
    ),
  );
}

async function failSource(db: ScopedDb, organizationId: string, sourceId: string, message: string): Promise<KnowledgeSource> {
  const row = await db.run((sql) => markFailed(sql, organizationId, sourceId, message));
  if (!row) throw new DomainError('not_found', NOT_FOUND_MESSAGE);
  return mapSource(row);
}

function failureMessage(error: unknown): string {
  if (error instanceof ProviderError) return EMBEDDING_UNAVAILABLE_MESSAGE;
  if (error instanceof IngestionError) return error.message;
  return PROCESSING_FAILED_MESSAGE;
}

/** Chunks, embeds and stores a document. Provider failures become a 'failed' source rather than an exception. */
async function indexDocument(db: ScopedDb, embedder: Embedder, target: IndexTarget, logger: Logger): Promise<KnowledgeSource> {
  let failure: string;
  try {
    const chunks = chunkText(target.content);
    if (chunks.length === 0) {
      failure = NO_TEXT_MESSAGE;
    } else {
      const embedded = await embedChunks(embedder, chunks, target);
      const ready = await db.run((sql) => storeChunks(sql, target, chunks, embedded));
      if (!ready) throw new DomainError('not_found', NOT_FOUND_MESSAGE);
      return mapSource(ready);
    }
  } catch (error) {
    if (error instanceof DomainError) throw error;
    failure = failureMessage(error);
    const fields = { organizationId: target.organizationId, sourceId: target.sourceId };
    if (error instanceof ProviderError) {
      logger.warn('knowledge.embedding_failed', { ...fields, provider: error.provider, code: error.code });
    } else {
      logger.error('knowledge.indexing_failed', { ...fields, error });
    }
  }
  return failSource(db, target.organizationId, target.sourceId, failure);
}

/**
 * Creates the source + document, chunks, embeds and stores chunks. Returns the
 * final source (status 'ready' or 'failed'). Invalid input — including an agent
 * of another organization, or a caller RLS does not allow to write — throws a
 * DomainError before anything is written.
 */
export async function ingestTextSource(
  db: ScopedDb,
  embedder: Embedder,
  input: IngestTextInput,
  options: IngestionOptions = {},
): Promise<KnowledgeSource> {
  const valid = parseIngestInput(input);
  const content = normalizeKnowledgeText(valid.text);
  let target: IndexTarget;
  try {
    target = await db.run((sql) => insertSourceWithDocument(sql, valid, content));
  } catch (error) {
    throw toDomainWriteError(error) ?? error;
  }
  return indexDocument(db, embedder, target, options.logger ?? defaultLogger);
}

/**
 * Re-chunks and re-embeds a source's stored document with the current embedder
 * (retrying a failed source, or after an embedding model change). Any status
 * is accepted, so a source left 'processing' by an interrupted request can be recovered.
 */
export async function reindexKnowledgeSource(
  db: ScopedDb,
  embedder: Embedder,
  organizationId: string,
  sourceId: string,
  options: ReindexOptions = {},
): Promise<KnowledgeSource> {
  if (!isUuid(organizationId) || !isUuid(sourceId)) throw new DomainError('not_found', NOT_FOUND_MESSAGE);
  const staleMs = options.onlyIfRetryable?.staleProcessingMs ?? null;
  const includeReady = options.onlyIfRetryable?.includeReady ?? false;
  const claimed = await db.run(async (sql) => {
    const source = maybeOne(
      await sql.query<{ agent_id: string | null }>(
        `update public.knowledge_sources set status = 'processing', error = null
         where id = $1 and organization_id = $2
           and ($3::double precision is null
                or status = 'failed'
                or ($4::boolean and status = 'ready')
                or (status in ('pending', 'processing')
                    and updated_at < now() - make_interval(secs => $3::double precision / 1000)))
         returning agent_id`,
        [sourceId, organizationId, staleMs, includeReady],
      ),
    );
    if (!source) return null;
    const document = maybeOne(
      await sql.query<{ id: string; content: string }>(
        `select id, content from public.knowledge_documents
         where source_id = $1 and organization_id = $2
         order by created_at, id
         limit 1`,
        [sourceId, organizationId],
      ),
    );
    return { agentId: source.agent_id, document };
  });

  if (!claimed) {
    // RLS hides the row from a member's update but not from their select: tell the two apart.
    const visible = await getKnowledgeSource(db, organizationId, sourceId);
    if (!visible) throw new DomainError('not_found', NOT_FOUND_MESSAGE);
    if (staleMs !== null && !isRetryable(visible, staleMs, includeReady)) {
      throw new DomainError('conflict', NOT_RETRYABLE_MESSAGE);
    }
    throw new DomainError('forbidden', FORBIDDEN_MESSAGE);
  }
  if (!claimed.document) return failSource(db, organizationId, sourceId, NO_TEXT_MESSAGE);

  const target: IndexTarget = {
    organizationId,
    agentId: claimed.agentId,
    sourceId,
    documentId: claimed.document.id,
    content: claimed.document.content,
  };
  return indexDocument(db, embedder, target, options.logger ?? defaultLogger);
}

function isRetryable(source: KnowledgeSource, staleMs: number, includeReady: boolean): boolean {
  if (source.status === 'failed' || (includeReady && source.status === 'ready')) return true;
  const unfinished = source.status === 'pending' || source.status === 'processing';
  return unfinished && Date.now() - source.updatedAt.getTime() > staleMs;
}

/** Newest first. Works under user scope (RLS) and service scope alike. */
export async function listKnowledgeSources(db: ScopedDb, organizationId: string): Promise<KnowledgeSource[]> {
  if (!isUuid(organizationId)) return [];
  const rows = await db.run((sql) =>
    sql.query<SourceRow>(
      `select ${SOURCE_COLUMNS} from public.knowledge_sources
       where organization_id = $1
       order by created_at desc, id desc`,
      [organizationId],
    ),
  );
  return rows.map(mapSource);
}

export async function getKnowledgeSource(
  db: ScopedDb,
  organizationId: string,
  sourceId: string,
): Promise<KnowledgeSource | null> {
  if (!isUuid(organizationId) || !isUuid(sourceId)) return null;
  const row = maybeOne(
    await db.run((sql) =>
      sql.query<SourceRow>(`select ${SOURCE_COLUMNS} from public.knowledge_sources where id = $1 and organization_id = $2`, [
        sourceId,
        organizationId,
      ]),
    ),
  );
  return row ? mapSource(row) : null;
}

/** Deletes a source; its document and chunks cascade. False when nothing was deleted (missing, other tenant, or RLS). */
export async function deleteKnowledgeSource(db: ScopedDb, organizationId: string, sourceId: string): Promise<boolean> {
  if (!isUuid(organizationId) || !isUuid(sourceId)) return false;
  const rows = await db.run((sql) =>
    sql.query('delete from public.knowledge_sources where id = $1 and organization_id = $2 returning id', [
      sourceId,
      organizationId,
    ]),
  );
  return rows.length > 0;
}
