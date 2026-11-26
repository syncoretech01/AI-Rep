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
  /**
   * For sideEffects:'external' tools: the durable identity of this operation. Pass `key` to the provider as
   * its idempotency key where the provider supports one.
   */
  readonly operation?: { readonly id: string; readonly key: string; readonly attempt: number };
}

export type ToolFailureCode =
  | 'unknown_tool'
  | 'invalid_arguments'
  | 'not_permitted'
  | 'missing_information'
  | 'not_found'
  | 'unavailable'
  | 'failed'
  /** A per-turn limit refused the call (e.g. AI_MAX_TOOL_CALLS_PER_TURN). */
  | 'limit_reached'
  /** The same external operation is being executed right now (another claim holds it). */
  | 'in_progress'
  /** An external operation was sent but its result is not confirmed: it must not be repeated or reported as done. */
  | 'outcome_unknown';

export interface ToolFailure {
  code: ToolFailureCode;
  /** Safe to show to the model (and, through it, the visitor). Never includes internals. */
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

/**
 * What an external handler knows about a failure. Default 'failed' (the provider refused it). 'not_attempted':
 * nothing was sent. 'unknown': it may have been executed (e.g. a timeout after sending) — never retried blindly.
 */
export type ExternalFailureOutcome = 'not_attempted' | 'failed' | 'unknown';

export type ToolOutcome<TData> =
  | { ok: true; data: TData; /** Provider-side id of an external operation (e.g. a message id). */ externalReference?: string }
  | { ok: false; error: ToolFailure; outcome?: ExternalFailureOutcome };

/**
 * - none: read-only.
 * - writes: transactional writes to our own database (atomic: a failure means nothing was written).
 * - external: calls a third party (SMS, calendar, CRM). Executed under a durable operation record
 *   (app_private.tool_operations): one execution per operation identity, success replayed, an unconfirmed
 *   outcome held for reconciliation instead of being repeated.
 */
export type ToolSideEffects = 'none' | 'writes' | 'external';

/**
 * - `none`: safe to repeat (read-only tools).
 * - `conversation_arguments`: a repeat of the tool's LATEST successful run in the same conversation (identical
 *   normalized arguments) is replayed instead of executed again; after a different call (A, B, A) it runs again.
 */
export type ToolIdempotency = 'none' | 'conversation_arguments';
// External tools are always idempotent per operation identity (see operationKey); 'idempotency' governs internal writes.

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
  /**
   * External tools only: the operation identity (default: conversation + tool + normalized arguments). Two calls
   * with the same identity are the same operation: it executes at most once successfully.
   */
  operationKey?(input: z.output<TSchema>, context: ToolContext): string;
  handler(input: z.output<TSchema>, context: ToolContext): Promise<ToolOutcome<TData>>;
}

export function defineTool<TSchema extends z.ZodType, TData>(
  definition: ToolDefinition<TSchema, TData>,
): ToolDefinition<TSchema, TData> {
  return definition;
}
