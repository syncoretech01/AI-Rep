import type { z } from 'zod';
import type { Embedder } from '@/server/ai/embedder';
import type { ScopedDb } from '@/server/db/scope';
import type { Agent } from '@/server/domain/agents/types';
import type { RetrievalBudget } from '@/server/domain/knowledge/types';
import type { Channel } from '@/server/domain/types';

export type { RetrievalBudget };

/**
 * Tools are server-side capabilities, not model privileges. The model may only
 * *request* a tool; the executor validates, authorizes, audits and runs it.
 */

/** Capabilities an agent configuration can grant to tools. */
export type AgentCapability = 'knowledge' | 'business_info' | 'lead_capture';

/** Everything a handler may use. Tenant identity is resolved server-side, never taken from model output. */
export interface ToolContext {
  readonly organizationId: string;
  readonly agent: Agent;
  readonly conversationId: string;
  readonly channel: Channel;
  readonly now: Date;
  /** Service-scope database access: every statement MUST filter by organizationId. */
  readonly db: ScopedDb;
  readonly embedder: Embedder;
  readonly retrieval: RetrievalBudget;
  readonly signal?: AbortSignal;
}

export type ToolFailureCode =
  | 'unknown_tool'
  | 'invalid_arguments'
  | 'not_permitted'
  | 'missing_information'
  | 'not_found'
  | 'unavailable'
  | 'failed';

export interface ToolFailure {
  code: ToolFailureCode;
  /** Safe to show to the model (and, through it, the visitor). Never includes internals. */
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export type ToolOutcome<TData> = { ok: true; data: TData } | { ok: false; error: ToolFailure };

export type ToolSideEffects = 'none' | 'writes';

/**
 * - `none`: safe to repeat (read-only tools).
 * - `conversation_arguments`: a repeat of the tool's LATEST successful run in the same conversation (identical
 *   normalized arguments) is replayed instead of executed again; after a different call (A, B, A) it runs again.
 */
export type ToolIdempotency = 'none' | 'conversation_arguments';

export interface ToolDefinition<TSchema extends z.ZodType = z.ZodType, TData = unknown> {
  /** Stable name exposed to models. Never rename once shipped. */
  readonly name: string;
  readonly description: string;
  readonly input: TSchema;
  readonly channels: readonly Channel[];
  readonly requires: readonly AgentCapability[];
  readonly sideEffects: ToolSideEffects;
  readonly idempotency: ToolIdempotency;
  /** Short public label shown while the tool runs (e.g. "Searching our information"). */
  readonly label: string;
  /**
   * Time limit for read-only tools (default 10 s). A started sideEffects:'writes' handler is always awaited, so its
   * outcome (and audit) is recorded truthfully; it must bound its own I/O (DB statement/connection timeouts do).
   */
  readonly timeoutMs?: number;
  handler(input: z.output<TSchema>, context: ToolContext): Promise<ToolOutcome<TData>>;
}

export function defineTool<TSchema extends z.ZodType, TData>(
  definition: ToolDefinition<TSchema, TData>,
): ToolDefinition<TSchema, TData> {
  return definition;
}
