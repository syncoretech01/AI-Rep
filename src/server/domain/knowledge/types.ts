/**
 * Knowledge domain types. Unstructured knowledge flows
 * `source -> document (normalized text) -> chunks -> embeddings (pgvector)`;
 * structured business facts live in their own tables, never here.
 */

export const KNOWLEDGE_SOURCE_KINDS = ['text', 'file'] as const;
export type KnowledgeSourceKind = (typeof KNOWLEDGE_SOURCE_KINDS)[number];

export const KNOWLEDGE_SOURCE_STATUSES = ['pending', 'processing', 'ready', 'failed'] as const;
export type KnowledgeSourceStatus = (typeof KNOWLEDGE_SOURCE_STATUSES)[number];

export interface KnowledgeSource {
  id: string;
  organizationId: string;
  /** null = shared by every agent in the organization. */
  agentId: string | null;
  kind: KnowledgeSourceKind;
  title: string;
  status: KnowledgeSourceStatus;
  /** Safe, admin-facing failure reason (status 'failed' only). */
  error: string | null;
  fileName: string | null;
  mimeType: string | null;
  byteSize: number | null;
  chunkCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A knowledge chunk selected for a model context. */
export interface RetrievedChunk {
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  content: string;
  /** Cosine similarity to the query (1 = identical direction). */
  similarity: number;
  tokenCount: number;
}

/** Retrieval limits per knowledge search (AI_MAX_RETRIEVED_CHUNKS / AI_MAX_RETRIEVED_TOKENS / AI_MIN_RETRIEVAL_SIMILARITY). */
export interface RetrievalBudget {
  maxChunks: number;
  maxTokens: number;
  minSimilarity: number;
}
