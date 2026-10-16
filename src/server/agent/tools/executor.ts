import { createHash } from 'node:crypto';
import type { Embedder } from '@/server/ai/embedder';
import type { ModelToolCall } from '@/server/ai/types';
import { serviceScope } from '@/server/db/scope';
import { jsonParam, maybeOne, truncateText } from '@/server/db/sql';
import type { Database, Sql } from '@/server/db/types';
import type { Agent } from '@/server/domain/agents/types';
import { recordAudit } from '@/server/domain/audit/service';
import { DomainError, type Channel } from '@/server/domain/types';
import type { Logger } from '@/server/observability/logger';
import type { ToolRegistry } from './registry';
import type { RetrievalBudget, ToolContext, ToolDefinition, ToolFailure, ToolFailureCode, ToolOutcome } from './types';

/**
 * Runs a model-requested tool call through the server-side pipeline
 * (ARCHITECTURE.md §8): lookup -> availability for this agent/channel -> argument
 * parsing and Zod validation -> idempotency -> tool_run -> handler -> persisted
 * outcome (+ audit for side effects) -> a minimal structured result for the model.
 *
 * Every step is recorded in `tool_runs` through service scope, each in its own
 * short transaction: never nested, never held open across the handler call.
 */

export interface ToolExecutionContext {
  organizationId: string;
  agent: Agent;
  conversationId: string;
  channel: Channel;
  now: Date;
  signal?: AbortSignal;
}

export interface ToolExecutionResult {
  /** null only if even the tool_runs insert failed. */
  toolRunId: string | null;
  toolName: string;
  ok: boolean;
  /** JSON for the model: { ok: true, ...data } | { ok: false, error: { code, message, details? } } */
  modelOutput: string;
  errorCode: ToolFailureCode | null;
  /** Public label (definition label, or 'Working on it' for unknown tools). */
  label: string;
  replayed: boolean;
}

export interface ToolExecutor {
  execute(call: ModelToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult>;
}

export interface ToolExecutorDeps {
  db: Database;
  registry: ToolRegistry;
  embedder: Embedder;
  retrieval: RetrievalBudget;
  logger: Logger;
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** Tool results go back into the model context: handlers own their budgets, this is the hard stop. */
export const MAX_MODEL_OUTPUT_CHARS = 12_000;
const UNKNOWN_TOOL_LABEL = 'Working on it';
const FAILED_MESSAGE = 'This action failed because of a technical problem.';
const INVALID_JSON_MESSAGE = 'Invalid arguments: send a JSON object.';
/** Rejected arguments are stored for the audit trail, bounded. */
const MAX_STORED_RAW_ARGUMENT_CHARS = 2_000;
const MAX_ISSUES = 5;

// Column limits from supabase/migrations (tool_runs).
const MAX_TOOL_NAME_CHARS = 64;
const MAX_CALL_ID_CHARS = 128;
const MAX_ERROR_MESSAGE_CHARS = 1_000;

type RunStatus = 'succeeded' | 'failed' | 'rejected';

/** What one call resolved to, before it is persisted. */
type Settlement = { ok: true; data: unknown } | { ok: false; error: ToolFailure; status: 'failed' | 'rejected' };

interface RunIdentity {
  organizationId: string;
  agentId: string;
  conversationId: string;
  channel: Channel;
  toolName: string;
  callId: string;
}

export function createToolExecutor(deps: ToolExecutorDeps): ToolExecutor {
  const db = serviceScope(deps.db);
  const logger = deps.logger;

  async function execute(call: ModelToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const startedAt = Date.now();
    const identity: RunIdentity = {
      organizationId: context.organizationId,
      agentId: context.agent.id,
      conversationId: context.conversationId,
      channel: context.channel,
      // The name is model output: stored bounded (and never empty, per the column check).
      toolName: truncateText(call.name, MAX_TOOL_NAME_CHARS) || '(unnamed)',
      callId: truncateText(call.callId, MAX_CALL_ID_CHARS),
    };

    const definition = deps.registry.get(call.name);
    if (!definition) {
      const message = `Unknown tool "${identity.toolName}". Use only the tools you were given.`;
      return reject(identity, UNKNOWN_TOOL_LABEL, call.arguments, startedAt, failure('unknown_tool', message, false));
    }
    if (!deps.registry.availableFor(context.agent, context.channel).includes(definition)) {
      const message = 'This tool is not available in this conversation.';
      return reject(identity, definition.label, call.arguments, startedAt, failure('not_permitted', message, false));
    }

    const parsed = parseArguments(call.arguments);
    if (!parsed.ok) {
      return reject(identity, definition.label, call.arguments, startedAt, failure('invalid_arguments', INVALID_JSON_MESSAGE, true));
    }
    const validation = definition.input.safeParse(parsed.value);
    if (!validation.success) {
      const message = describeIssues(validation.error.issues);
      return reject(identity, definition.label, call.arguments, startedAt, failure('invalid_arguments', message, true));
    }
    const input: unknown = validation.data;

    const idempotencyKey =
      definition.idempotency === 'conversation_arguments'
        ? sha256Hex(`${context.conversationId}|${definition.name}|${stableStringify(input)}`)
        : null;
    if (idempotencyKey !== null) {
      const replay = await replayEarlierRun(identity, definition, input, idempotencyKey, startedAt);
      if (replay) return replay;
    }

    let runId: string;
    try {
      runId = await db.run((sql) => insertRun(sql, identity, { status: 'running', input, idempotencyKey }));
    } catch (error) {
      // No audit row means no execution: a side effect must never happen unrecorded.
      logger.error('agent.tool.record_failed', { toolName: definition.name, stage: 'start', error });
      return result(identity, definition.label, null, {
        ok: false,
        status: 'failed',
        error: failure('unavailable', 'This action is temporarily unavailable.', true),
      });
    }

    const settlement = await runHandler(definition, input, context, runId);
    const output = settlement.ok ? serializeOutput(settlement.data) : null;
    const final: Settlement =
      settlement.ok && output === null
        ? { ok: false, status: 'failed', error: failure('failed', FAILED_MESSAGE, false) }
        : settlement;
    if (settlement.ok && output === null) {
      logger.error('agent.tool.output_rejected', { toolName: definition.name, toolRunId: runId });
    }

    try {
      await db.run(async (sql) => {
        await finishRun(sql, identity.organizationId, runId, final, output, startedAt);
        if (final.ok && definition.sideEffects === 'writes') {
          await recordAudit(sql, {
            organizationId: identity.organizationId,
            actorType: 'agent',
            actorId: identity.agentId,
            action: `tool.${definition.name}`,
            targetType: 'conversation',
            targetId: identity.conversationId,
            metadata: { toolRunId: runId },
          });
        }
      });
    } catch (error) {
      // The handler's outcome stands (a saved lead WAS saved); only its audit record is incomplete.
      logger.error('agent.tool.record_failed', { toolName: definition.name, toolRunId: runId, stage: 'finish', error });
    }
    return result(identity, definition.label, runId, final, output?.modelOutput);
  }

  /** Refused before running (unknown, unavailable, unparsable or invalid): one 'rejected' row and a result the model can act on. */
  async function reject(
    identity: RunIdentity,
    label: string,
    rawArguments: string,
    startedAt: number,
    error: ToolFailure,
  ): Promise<ToolExecutionResult> {
    const settlement: Settlement = { ok: false, status: 'rejected', error };
    let runId: string | null = null;
    try {
      runId = await db.run((sql) =>
        insertRun(sql, identity, {
          status: 'rejected',
          input: storedArguments(rawArguments),
          idempotencyKey: null,
          settlement,
          startedAt,
        }),
      );
    } catch (dbError) {
      logger.error('agent.tool.record_failed', { toolName: identity.toolName, stage: 'reject', error: dbError });
    }
    return result(identity, label, runId, settlement);
  }

  /**
   * A repeat of this tool's latest successful call in the conversation (same arguments) is replayed: a new
   * 'succeeded' row (replayed = true) with the earlier output, without running the handler again. Only the latest:
   * after A, B, a repeated A must run again, since B changed what A had set.
   */
  async function replayEarlierRun(
    identity: RunIdentity,
    definition: ToolDefinition,
    input: unknown,
    idempotencyKey: string,
    startedAt: number,
  ): Promise<ToolExecutionResult | null> {
    try {
      const replayed = await db.run(async (sql) => {
        const latest = maybeOne(
          await sql.query<{ idempotency_key: string | null; output: unknown }>(
            `select idempotency_key, output from public.tool_runs
             where organization_id = $1 and conversation_id = $2 and tool_name = $3 and status = 'succeeded'
             order by started_at desc, id desc
             limit 1`,
            [identity.organizationId, identity.conversationId, definition.name],
          ),
        );
        if (latest?.idempotency_key !== idempotencyKey) return null;
        const output = serializeOutput(latest.output);
        if (output === null) return null;
        const runId = await insertRun(sql, identity, {
          status: 'succeeded',
          input,
          idempotencyKey,
          settlement: { ok: true, data: latest.output },
          output,
          startedAt,
          replayed: true,
        });
        return { runId, output };
      });
      if (!replayed) return null;
      return result(identity, definition.label, replayed.runId, { ok: true, data: null }, replayed.output.modelOutput, true);
    } catch (error) {
      // The call then runs normally (captureLead itself updates the conversation's single lead).
      logger.error('agent.tool.record_failed', { toolName: definition.name, stage: 'replay', error });
      return null;
    }
  }

  async function runHandler(
    definition: ToolDefinition,
    input: unknown,
    context: ToolExecutionContext,
    runId: string,
  ): Promise<Settlement> {
    const timeout = AbortSignal.timeout(definition.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
    const toolContext: ToolContext = {
      organizationId: context.organizationId,
      agent: context.agent,
      conversationId: context.conversationId,
      channel: context.channel,
      now: context.now,
      db,
      embedder: deps.embedder,
      retrieval: deps.retrieval,
      signal,
    };
    const fields = { toolName: definition.name, toolRunId: runId };
    const writes = definition.sideEffects === 'writes';
    try {
      if (signal.aborted) throw new ToolAbortError();
      const pending = definition.handler(input, toolContext);
      // A write that has started is never abandoned: its transaction could still commit after the run was reported
      // as failed, unaudited. Its real outcome is awaited instead (the database's connection and statement timeouts
      // bound it) and recorded. Read-only work is raced against the time limits.
      const outcome: ToolOutcome<unknown> = writes ? await pending : await untilAborted(pending, signal);
      if (writes && timeout.aborted) logger.warn('agent.tool.slow', fields);
      return outcome.ok ? { ok: true, data: outcome.data } : { ok: false, status: 'failed', error: outcome.error };
    } catch (error) {
      if (error instanceof ToolAbortError) {
        // Raised before a write started, or for read-only work (which may still settle in the background): no side
        // effect is pending, and the run is recorded (and reported to the model) as not completed.
        const timedOut = timeout.aborted;
        logger.warn('agent.tool.aborted', { ...fields, reason: timedOut ? 'timeout' : 'cancelled' });
        const message = timedOut ? 'The action took too long to complete.' : 'The action was cancelled.';
        return { ok: false, status: 'failed', error: failure('unavailable', message, timedOut) };
      }
      if (error instanceof DomainError && error.code === 'invalid') {
        return { ok: false, status: 'failed', error: failure('invalid_arguments', error.message, true) };
      }
      // Details stay in the logs: the model (and visitor) only learns that it failed.
      logger.error('agent.tool.failed', { ...fields, error });
      return { ok: false, status: 'failed', error: failure('failed', FAILED_MESSAGE, false) };
    }
  }

  return { execute };
}

/** The handler's data serialized for storage and for the model; null when unusable (not JSON, or too large). */
interface SerializedOutput {
  stored: string;
  modelOutput: string;
}

function serializeOutput(data: unknown): SerializedOutput | null {
  try {
    const modelOutput = JSON.stringify(isRecord(data) ? { ok: true, ...data } : { ok: true, result: data });
    if (modelOutput.length > MAX_MODEL_OUTPUT_CHARS) return null;
    return { stored: jsonParam(data), modelOutput };
  } catch {
    // e.g. a BigInt or a cycle in handler data.
    return null;
  }
}

function result(
  identity: RunIdentity,
  label: string,
  toolRunId: string | null,
  settlement: Settlement,
  successOutput?: string,
  replayed = false,
): ToolExecutionResult {
  const modelOutput = settlement.ok
    ? (successOutput ?? JSON.stringify({ ok: true }))
    : JSON.stringify({
        ok: false,
        error: {
          code: settlement.error.code,
          message: settlement.error.message,
          ...(settlement.error.details && { details: settlement.error.details }),
        },
      });
  return {
    toolRunId,
    toolName: identity.toolName,
    ok: settlement.ok,
    modelOutput,
    errorCode: settlement.ok ? null : settlement.error.code,
    label,
    replayed,
  };
}

interface NewRun {
  status: 'running' | RunStatus;
  input: unknown;
  idempotencyKey: string | null;
  /** Present for rows that are finished on insert (rejections and replays). */
  settlement?: Settlement;
  output?: SerializedOutput;
  startedAt?: number;
  replayed?: boolean;
}

async function insertRun(sql: Sql, identity: RunIdentity, run: NewRun): Promise<string> {
  const finished = run.settlement !== undefined;
  const error = run.settlement && !run.settlement.ok ? run.settlement.error : null;
  const rows = await sql.query<{ id: string }>(
    `insert into public.tool_runs
       (organization_id, agent_id, conversation_id, channel, tool_name, provider_call_id, status, input, output,
        error_code, error_message, idempotency_key, replayed, finished_at, duration_ms)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13,
             case when $14::boolean then now() end, $15)
     returning id`,
    [
      identity.organizationId,
      identity.agentId,
      identity.conversationId,
      identity.channel,
      identity.toolName,
      identity.callId || null,
      run.status,
      jsonParam(run.input ?? {}),
      run.output ? run.output.stored : null,
      error ? error.code : null,
      error ? truncateText(error.message, MAX_ERROR_MESSAGE_CHARS) : null,
      run.idempotencyKey,
      run.replayed ?? false,
      finished,
      finished && run.startedAt !== undefined ? elapsedMs(run.startedAt) : null,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('tool_runs insert returned no row');
  return row.id;
}

async function finishRun(
  sql: Sql,
  organizationId: string,
  runId: string,
  settlement: Settlement,
  output: SerializedOutput | null,
  startedAt: number,
): Promise<void> {
  const error = settlement.ok ? null : settlement.error;
  await sql.query(
    `update public.tool_runs
     set status = $3, output = $4::jsonb, error_code = $5, error_message = $6, finished_at = now(), duration_ms = $7
     where id = $1 and organization_id = $2`,
    [
      runId,
      organizationId,
      settlement.ok ? 'succeeded' : 'failed',
      settlement.ok && output ? output.stored : null,
      error ? error.code : null,
      error ? truncateText(error.message, MAX_ERROR_MESSAGE_CHARS) : null,
      elapsedMs(startedAt),
    ],
  );
}

function failure(code: ToolFailureCode, message: string, retryable: boolean): ToolFailure {
  return { code, message, retryable };
}

function parseArguments(raw: string): { ok: true; value: unknown } | { ok: false } {
  // Some models send "" for a tool without parameters.
  if (raw.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Rejected arguments as they were sent: the parsed object when it is one, else the (bounded) raw text. */
function storedArguments(raw: string): unknown {
  const parsed = raw.length <= MAX_STORED_RAW_ARGUMENT_CHARS ? parseArguments(raw) : { ok: false as const };
  if (parsed.ok && isRecord(parsed.value)) return parsed.value;
  return { raw: truncateText(raw, MAX_STORED_RAW_ARGUMENT_CHARS, '…') };
}

/** A compact `path: message` list the model can act on. */
function describeIssues(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  const described = issues
    .slice(0, MAX_ISSUES)
    .map((issue) => `${issue.path.map((key) => String(key)).join('.') || 'arguments'}: ${issue.message}`);
  return truncateText(`Invalid arguments: ${described.join('; ')}`, 500, '…');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deterministic JSON (object keys sorted) so equal arguments always produce the same idempotency key. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(Date.now() - startedAt));
}

class ToolAbortError extends Error {
  constructor() {
    super('Tool execution was aborted');
    this.name = 'ToolAbortError';
  }
}

/** Settles with the promise, or rejects with ToolAbortError as soon as the signal aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new ToolAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    // Handling both outcomes here also keeps a late rejection (after an abort) from going unhandled.
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
