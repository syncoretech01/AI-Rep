import type { Embedder } from '@/server/ai/embedder';
import { EMBEDDING_DIMENSIONS } from '@/server/config/env';
import type { ScopedDb } from '@/server/db/scope';
import { toNumber, vectorParam } from '@/server/db/sql';
import type { Sql } from '@/server/db/types';
import { normalizeQuery } from './normalize';
import type { RetrievalBudget, RetrievedChunk } from './types';

/**
 * Knowledge retrieval: an exact, tenant-filtered nearest-neighbour scan with a
 * relevance threshold, a top-K cap and a hard token cap, so a model only ever
 * sees the smallest useful amount of evidence — and none when nothing is relevant.
 */

export interface RetrievalQuery {
  organizationId: string;
  agentId: string;
  embedding: readonly number[];
  /** Only chunks embedded by this model are comparable with `embedding`. */
  embeddingModel: string;
  maxChunks: number;
  maxTokens: number;
  minSimilarity: number;
}

interface CandidateRow {
  chunk_id: string;
  source_id: string;
  source_title: string;
  content: string;
  token_count: number | string;
  distance: number | string;
}

/** Candidates scanned per requested chunk before the threshold and token cap apply. */
const CANDIDATES_PER_CHUNK = 3;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Chunks most similar to `embedding` from this organization's ready sources
 * that are shared (agent_id null) or belong to this agent. Ordered by
 * similarity; at most `maxChunks`, only those with similarity >= minSimilarity,
 * taken in order while their token sum stays within `maxTokens`.
 * Runs inside the caller's transaction.
 */
export async function retrieveChunks(sql: Sql, query: RetrievalQuery): Promise<RetrievedChunk[]> {
  const maxChunks = Math.floor(query.maxChunks);
  if (
    !UUID_RE.test(query.organizationId) ||
    !UUID_RE.test(query.agentId) ||
    query.embeddingModel === '' ||
    !(maxChunks >= 1) ||
    !(query.maxTokens > 0)
  ) {
    return [];
  }
  if (query.embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Query embedding has ${query.embedding.length} dimensions; expected ${EMBEDDING_DIMENSIONS}`);
  }

  // The agent must belong to the organization: a foreign agent id yields nothing,
  // not the organization's shared knowledge.
  const rows = await sql.query<CandidateRow>(
    `select c.id as chunk_id, c.source_id, s.title as source_title, c.content, c.token_count,
            (c.embedding <=> $1::extensions.vector)::float8 as distance
     from public.knowledge_chunks c
     join public.knowledge_sources s on s.id = c.source_id and s.organization_id = c.organization_id
     where c.organization_id = $2
       and s.organization_id = $2
       and s.status = 'ready'
       and (s.agent_id is null or s.agent_id = $3)
       and c.embedding_model = $4
       and exists (select 1 from public.agents a where a.id = $3 and a.organization_id = $2)
     order by distance, c.id
     limit $5`,
    [vectorParam(query.embedding), query.organizationId, query.agentId, query.embeddingModel, maxChunks * CANDIDATES_PER_CHUNK],
  );

  const selected: RetrievedChunk[] = [];
  let tokens = 0;
  for (const row of rows) {
    if (selected.length >= maxChunks) break;
    const similarity = 1 - toNumber(row.distance);
    // NaN (a zero vector) never passes the threshold.
    if (!(similarity >= query.minSimilarity)) continue;
    const tokenCount = toNumber(row.token_count);
    if (tokens + tokenCount > query.maxTokens) break;
    tokens += tokenCount;
    selected.push({
      chunkId: row.chunk_id,
      sourceId: row.source_id,
      sourceTitle: row.source_title,
      content: row.content,
      similarity,
      tokenCount,
    });
  }
  return selected;
}

/**
 * searchKnowledge for an agent: normalizes and embeds the query (metered as
 * 'knowledge_query' against the organization/agent/conversation), then
 * retrieves within the budget. Embedding failures propagate so callers can
 * report "unavailable" instead of pretending nothing was found.
 */
export async function searchKnowledge(
  db: ScopedDb,
  embedder: Embedder,
  params: {
    organizationId: string;
    agentId: string;
    conversationId?: string | null;
    query: string;
    budget: RetrievalBudget;
  },
): Promise<RetrievedChunk[]> {
  const query = normalizeQuery(params.query);
  if (query === '' || !UUID_RE.test(params.organizationId) || !UUID_RE.test(params.agentId)) return [];

  const outcome = await embedder.embed([query], {
    organizationId: params.organizationId,
    agentId: params.agentId,
    conversationId: params.conversationId ?? null,
    purpose: 'knowledge_query',
  });
  const embedding = outcome.vectors[0];
  if (outcome.vectors.length !== 1 || embedding === undefined) {
    throw new Error(`Expected 1 query embedding, received ${outcome.vectors.length}`);
  }

  // Compare with chunks embedded by the model that produced this vector.
  return db.run((sql) =>
    retrieveChunks(sql, {
      organizationId: params.organizationId,
      agentId: params.agentId,
      embedding,
      embeddingModel: outcome.model,
      maxChunks: params.budget.maxChunks,
      maxTokens: params.budget.maxTokens,
      minSimilarity: params.budget.minSimilarity,
    }),
  );
}
