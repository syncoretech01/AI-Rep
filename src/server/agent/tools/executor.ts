import { createHash } from 'node:crypto';
import type { Embedder } from '@/server/ai/embedder';
import type { ModelToolCall } from '@/server/ai/types';
import { serviceScope } from '@/server/db/scope';
import { isUuid, jsonParam, maybeOne, truncateText } from '@/server/db/sql';
import type { Database, Sql } from '@/server/db/types';
import type { Agent } from '@/server/domain/agents/types';
import { recordAudit } from '@/server/domain/audit/service';
import { DomainError, type Channel } from '@/server/domain/types';
import type { Logger } from '@/server/observability/logger';
import { claimOperation, settleOperation, type Settlement as OperationSettlement } from './operations';
import type { ToolRegistry } from './registry';
import type { RetrievalBudget, ToolContext, ToolDefinition, ToolFailure, ToolFailureCode, ToolOutcome } from './types';

/**
 * Runs a model-requested tool call through the server-side pipeline
 * (ARCHITECTURE.md §8): lookup -> availability for this agent/channel -> argument
 * parsing and Zod validation -> idempotency -> tool_run -> handler -> persisted
 * outcome (+ audit for side effects) -> a minimal structured result for the model.
 *
 * Every step is recorded in `tool_runs` through service scope, each in its own
 * short transaction: never nested, never held open across the handler call. When
 * the caller holds a conversation turn lock, the run is only started while that lock
 * is still owned (fencing), so a stale worker cannot start a side effect.
 *
 * Tools with EXTERNAL side effects additionally run under a durable operation record
 * (./operations.ts): at most one execution per operation identity, successes replayed,
 * unconfirmed outcomes held for reconciliation and never repeated automatically.
 */

export interface ToolExecutionContext {
  organizationId: string;
  agent: Agent;
  conversationId: string;
  channel: Channel;
  now: Date;
  signal?: AbortSignal;
  /** Owner token of the conversation turn lock held by the caller: runs start only while it is still owned. */
  lockToken?: string;
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
  /** Refuses a call without running it (e.g. a per-turn limit), recording a 'rejected' run like any other refusal. */
  refuse(call: ModelToolCall, context: ToolExecutionContext, failure: ToolFailure): Promise<ToolExecutionResult>;
}

export interface ToolExecutorDeps {
  db: Database;
  registry: ToolRegistry;
  embedder: Embedder;
  retrieval: RetrievalBudget;
  logger: Logger;
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** An external operation's claim outlives its handler's time limit by this much before it counts as abandoned. */
const OPERATION_LEASE_MARGIN_SECONDS = 30;
const LOCK_LOST_MESSAGE = 'This action could not be started because the conversation moved on.';
const IN_PROGRESS_MESSAGE =
  'This request is already being processed. Do not repeat it; tell the visitor it is in progress.';
const OUTCOME_UNKNOWN_MESSAGE =
  'This request was sent but its result could not be confirmed. Do not say it succeeded or failed and do not try ' +
  'it again; tell the visitor the team will confirm.';
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
const MAX_OPERATION_KEY_CHARS = 128;

type RunStatus = 'succeeded' | 'failed' | 'rejected' | 'unknown';

/** What one call resolved to, before it is persisted. */
type Settlement = { ok: true; data: unknown } | { ok: false; error: ToolFailure; status: 'failed' | 'rejected' | 'unknown' };

/** The caller's turn lock was taken over: nothing may start for this turn any more. */
class RunFencedError extends Error {
  constructor() {
    super('The conversation turn lock is no longer held');
    this.name = 'RunFencedError';
  }
}

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

  function identityOf(call: ModelToolCall, context: ToolExecutionContext): RunIdentity {
    return {
      organizationId: context.organizationId,
      agentId: context.agent.id,
      conversationId: context.conversationId,
      channel: context.channel,
      // The name is model output: stored bounded (and never empty, per the column check).
      toolName: truncateText(call.name, MAX_TOOL_NAME_CHARS) || '(unnamed)',
      callId: truncateText(call.callId, MAX_CALL_ID_CHARS),
    };
  }

  async function execute(call: ModelToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const startedAt = Date.now();
    const identity = identityOf(call, context);

    const lockToken = context.lockToken ?? null;
    const definition = deps.registry.get(call.name);
    if (!definition) {
      const message = `Unknown tool "${identity.toolName}". Use only the tools you were given.`;
      return reject(identity, UNKNOWN_TOOL_LABEL, call.arguments, startedAt, failure('unknown_tool', message, false), lockToken);
    }
    if (!deps.registry.availableFor(context.agent, context.channel).includes(definition)) {
      const message = 'This tool is not available in this conversation.';
      return reject(identity, definition.label, call.arguments, startedAt, failure('not_permitted', message, false), lockToken);
    }

    const parsed = parseArguments(call.arguments);
    if (!parsed.ok) {
      const invalid = failure('invalid_arguments', INVALID_JSON_MESSAGE, true);
      return reject(identity, definition.label, call.arguments, startedAt, invalid, lockToken);
    }
    const validation = definition.input.safeParse(parsed.value);
    if (!validation.success) {
      const message = describeIssues(validation.error.issues);
      return reject(identity, definition.label, call.arguments, startedAt, failure('invalid_arguments', message, true), lockToken);
    }
    const input: unknown = validation.data;
    if (definition.sideEffects === 'external') return executeExternal(identity, definition, input, context, startedAt);

    const idempotencyKey =
      definition.idempotency === 'conversation_arguments'
        ? sha256Hex(`${context.conversationId}|${definition.name}|${stableStringify(input)}`)
        : null;
    if (idempotencyKey !== null) {
      const replay = await replayEarlierRun(identity, definition, input, idempotencyKey, startedAt, lockToken);
      if (replay) return replay;
    }

    const started = await startRun(identity, definition, input, idempotencyKey, lockToken);
    if (!started.ok) return started.result;
    const runId = started.runId;

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
    lockToken: string | null,
  ): Promise<ToolExecutionResult> {
    const settlement: Settlement = { ok: false, status: 'rejected', error };
    let runId: string | null = null;
    try {
      runId = await db.run((sql) =>
        insertRun(
          sql,
          identity,
          { status: 'rejected', input: storedArguments(rawArguments), idempotencyKey: null, settlement, startedAt },
          lockToken,
        ),
      );
    } catch (dbError) {
      if (dbError instanceof RunFencedError) logger.warn('agent.tool.lock_lost', { toolName: identity.toolName, stage: 'reject' });
      else logger.error('agent.tool.record_failed', { toolName: identity.toolName, stage: 'reject', error: dbError });
    }
    return result(identity, label, runId, settlement);
  }

  async function refuse(call: ModelToolCall, context: ToolExecutionContext, error: ToolFailure): Promise<ToolExecutionResult> {
    const identity = identityOf(call, context);
    const label = deps.registry.get(call.name)?.label ?? UNKNOWN_TOOL_LABEL;
    return reject(identity, label, call.arguments, Date.now(), error, context.lockToken ?? null);
  }

  /**
   * Records the 'running' row that must exist before any side effect starts. Fails closed: without the row (or
   * once the caller's turn lock was taken over) nothing runs.
   */
  async function startRun(
    identity: RunIdentity,
    definition: ToolDefinition,
    input: unknown,
    idempotencyKey: string | null,
    lockToken: string | null,
  ): Promise<{ ok: true; runId: string } | { ok: false; result: ToolExecutionResult }> {
    try {
      const runId = await db.run((sql) => insertRun(sql, identity, { status: 'running', input, idempotencyKey }, lockToken));
      return { ok: true, runId };
    } catch (error) {
      if (error instanceof RunFencedError) {
        logger.warn('agent.tool.lock_lost', { toolName: definition.name, stage: 'start' });
        return {
          ok: false,
          result: result(identity, definition.label, null, {
            ok: false,
            status: 'failed',
            error: failure('unavailable', LOCK_LOST_MESSAGE, false),
          }),
        };
      }
      // No audit row means no execution: a side effect must never happen unrecorded.
      logger.error('agent.tool.record_failed', { toolName: definition.name, stage: 'start', error });
      return {
        ok: false,
        result: result(identity, definition.label, null, {
          ok: false,
          status: 'failed',
          error: failure('unavailable', 'This action is temporarily unavailable.', true),
        }),
      };
    }
  }

  /**
   * External side effects: claim the operation identity atomically, execute at most once, replay a confirmed
   * success, and never repeat an operation whose outcome is in progress elsewhere or unknown.
   */
  async function executeExternal(
    identity: RunIdentity,
    definition: ToolDefinition,
    input: unknown,
    context: ToolExecutionContext,
    startedAt: number,
  ): Promise<ToolExecutionResult> {
    const baseContext = toolContextFor(context, context.signal);
    // Always namespaced by tool: two tools can never share (and replay) each other's operation. A custom key
    // decides its own scope (e.g. per conversation or per phone number); the default is conversation + arguments.
    const operationScope = definition.operationKey?.(input, baseContext) ?? `${context.conversationId}|${stableStringify(input)}`;
    const operationKey = truncateText(sha256Hex(`${definition.name}|${operationScope}`), MAX_OPERATION_KEY_CHARS);
    const started = await startRun(identity, definition, input, operationKey, context.lockToken ?? null);
    if (!started.ok) return started.result;
    const runId = started.runId;
    const timeoutMs = definition.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const leaseSeconds = Math.ceil(timeoutMs / 1000) + OPERATION_LEASE_MARGIN_SECONDS;
    const fields = { toolName: definition.name, toolRunId: runId };

    let claim: Awaited<ReturnType<typeof claimOperation>>;
    try {
      claim = await db.run((sql) =>
        claimOperation(
          sql,
          {
            organizationId: identity.organizationId,
            agentId: identity.agentId,
            conversationId: identity.conversationId,
            channel: identity.channel,
            toolName: definition.name,
            operationKey,
          },
          input,
          leaseSeconds,
        ),
      );
    } catch (error) {
      logger.error('agent.tool.record_failed', { ...fields, stage: 'claim', error });
      const settlement: Settlement = {
        ok: false,
        status: 'failed',
        error: failure('unavailable', 'This action is temporarily unavailable.', true),
      };
      await finish(identity, runId, settlement, null, startedAt, fields);
      return result(identity, definition.label, runId, settlement);
    }

    if (!claim.claimed) {
      const { existing } = claim;
      if (existing.status === 'succeeded') {
        const output = serializeOutput(existing.result);
        if (output) {
          await finish(identity, runId, { ok: true, data: existing.result }, output, startedAt, fields, { replayed: true });
          return result(identity, definition.label, runId, { ok: true, data: null }, output.modelOutput, true);
        }
      }
      const inProgress = existing.status === 'in_progress';
      logger.warn('agent.tool.operation_blocked', { ...fields, operationStatus: existing.status });
      const settlement: Settlement = {
        ok: false,
        status: 'rejected',
        error: inProgress
          ? failure('in_progress', IN_PROGRESS_MESSAGE, false)
          : failure('outcome_unknown', OUTCOME_UNKNOWN_MESSAGE, false),
      };
      await finish(identity, runId, settlement, null, startedAt, fields);
      return result(identity, definition.label, runId, settlement);
    }

    const operation = { id: claim.id, key: operationKey, attempt: claim.attempt };
    const outcome = await runExternalHandler(definition, input, context, operation, timeoutMs, fields);
    // The provider confirmed the action, so it is reported as a success even if the handler's data is unusable
    // (not JSON, or too large): the stored and replayed result is then minimal, never "failed".
    let output = outcome.run.ok ? serializeOutput(outcome.run.data) : null;
    let settlement = outcome.operation;
    if (outcome.run.ok && output === null) {
      logger.error('agent.tool.output_rejected', fields);
      output = serializeOutput({});
      if (settlement.status === 'succeeded') settlement = { ...settlement, result: {} };
    }
    try {
      const settled = await db.run((sql) => settleOperation(sql, identity.organizationId, claim, settlement));
      if (!settled) logger.error('agent.tool.operation_claim_lost', { ...fields, operationStatus: settlement.status });
    } catch (error) {
      // The claim lapses and the operation becomes `unknown`: it is never repeated blindly.
      logger.error('agent.tool.record_failed', { ...fields, stage: 'settle', error });
    }
    const final: Settlement = outcome.run.ok ? { ok: true, data: outcome.run.data } : outcome.run;
    const audited = final.ok || final.status === 'unknown';
    await finish(identity, runId, final, output, startedAt, fields, {
      ...(audited && { audit: { toolName: definition.name, outcome: final.ok ? 'succeeded' : 'unknown' } }),
    });
    return result(identity, definition.label, runId, final, output?.modelOutput);
  }

  /** Persists a run's outcome (and an audit entry when asked). Never throws: the outcome itself stands. */
  async function finish(
    identity: RunIdentity,
    runId: string,
    settlement: Settlement,
    output: SerializedOutput | null,
    startedAt: number,
    fields: Record<string, string>,
    options: { replayed?: boolean; audit?: { toolName: string; outcome: 'succeeded' | 'unknown' } } = {},
  ): Promise<void> {
    try {
      await db.run(async (sql) => {
        await finishRun(sql, identity.organizationId, runId, settlement, output, startedAt, options.replayed ?? false);
        if (options.audit) {
          const { toolName, outcome } = options.audit;
          await recordAudit(sql, {
            organizationId: identity.organizationId,
            actorType: 'agent',
            actorId: identity.agentId,
            action: outcome === 'unknown' ? `tool.${toolName}.outcome_unknown` : `tool.${toolName}`,
            targetType: 'conversation',
            targetId: identity.conversationId,
            metadata: { toolRunId: runId },
          });
        }
      });
    } catch (error) {
      logger.error('agent.tool.record_failed', { ...fields, stage: 'finish', error });
    }
  }

  async function runExternalHandler(
    definition: ToolDefinition,
    input: unknown,
    context: ToolExecutionContext,
    operation: { id: string; key: string; attempt: number },
    timeoutMs: number,
    fields: Record<string, string>,
  ): Promise<{ run: Settlement; operation: OperationSettlement }> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
    const unknown = (reason: string): { run: Settlement; operation: OperationSettlement } => ({
      run: { ok: false, status: 'unknown', error: failure('outcome_unknown', OUTCOME_UNKNOWN_MESSAGE, false) },
      operation: { status: 'unknown', errorCode: reason },
    });
    if (signal.aborted) {
      return {
        run: { ok: false, status: 'failed', error: failure('unavailable', 'The action was cancelled.', false) },
        operation: { status: 'not_attempted', errorCode: 'cancelled' },
      };
    }
    try {
      const outcome = await untilAborted(definition.handler(input, { ...toolContextFor(context, signal), operation }), signal);
      if (outcome.ok) {
        return {
          run: { ok: true, data: outcome.data },
          operation: {
            status: 'succeeded',
            result: outcome.data,
            ...(outcome.externalReference !== undefined && { externalReference: outcome.externalReference }),
          },
        };
      }
      const declared = outcome.outcome ?? 'failed';
      if (declared === 'unknown') return unknown(outcome.error.code);
      return {
        run: { ok: false, status: 'failed', error: outcome.error },
        operation: { status: declared, errorCode: outcome.error.code },
      };
    } catch (error) {
      if (error instanceof DomainError && error.code === 'invalid') {
        // Validation inside the handler happens before anything is sent.
        return {
          run: { ok: false, status: 'failed', error: failure('invalid_arguments', error.message, true) },
          operation: { status: 'not_attempted', errorCode: 'invalid_arguments' },
        };
      }
      // A timeout, cancellation or crash after the handler started: the provider may have executed it.
      const reason = error instanceof ToolAbortError ? (timeout.aborted ? 'timeout' : 'cancelled') : 'handler_error';
      if (error instanceof ToolAbortError) logger.warn('agent.tool.aborted', { ...fields, reason });
      else logger.error('agent.tool.failed', { ...fields, error });
      return unknown(reason);
    }
  }

  function toolContextFor(context: ToolExecutionContext, signal: AbortSignal | undefined): ToolContext {
    return {
      organizationId: context.organizationId,
      agent: context.agent,
      conversationId: context.conversationId,
      channel: context.channel,
      now: context.now,
      db,
      embedder: deps.embedder,
      retrieval: deps.retrieval,
      ...(signal && { signal }),
    };
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
    lockToken: string | null,
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
        const runId = await insertRun(
          sql,
          identity,
          {
            status: 'succeeded',
            input,
            idempotencyKey,
            settlement: { ok: true, data: latest.output },
            output,
            startedAt,
            replayed: true,
          },
          lockToken,
        );
        return { runId, output };
      });
      if (!replayed) return null;
      return result(identity, definition.label, replayed.runId, { ok: true, data: null }, replayed.output.modelOutput, true);
    } catch (error) {
      // The call then runs normally (captureLead itself updates the conversation's single lead); a lost lock
      // stops it when the run starts.
      if (!(error instanceof RunFencedError)) {
        logger.error('agent.tool.record_failed', { toolName: definition.name, stage: 'replay', error });
      }
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
    const toolContext = toolContextFor(context, signal);
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

  return { execute, refuse };
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

/**
 * Inserts a run. With a lock token, the row is only written while the conversation's turn lock is still owned by
 * that token (one statement, so it cannot interleave with a takeover); otherwise RunFencedError.
 */
async function insertRun(sql: Sql, identity: RunIdentity, run: NewRun, lockToken: string | null = null): Promise<string> {
  const finished = run.settlement !== undefined;
  const error = run.settlement && !run.settlement.ok ? run.settlement.error : null;
  const rows = await sql.query<{ id: string }>(
    `insert into public.tool_runs
       (organization_id, agent_id, conversation_id, channel, tool_name, provider_call_id, status, input, output,
        error_code, error_message, idempotency_key, replayed, finished_at, duration_ms)
     select $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13,
            case when $14::boolean then now() end, $15
     where $16::uuid is null or exists (
       select 1 from public.conversations c
       where c.id = $3::uuid and c.organization_id = $1::uuid and c.turn_lock_token = $16::uuid
     )
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
      // A malformed token can never match a lock: it fences like a lost one.
      lockToken === null ? null : isUuid(lockToken) ? lockToken : NIL_UUID,
    ],
  );
  const row = rows[0];
  if (!row) {
    if (lockToken !== null) throw new RunFencedError();
    throw new Error('tool_runs insert returned no row');
  }
  return row.id;
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

async function finishRun(
  sql: Sql,
  organizationId: string,
  runId: string,
  settlement: Settlement,
  output: SerializedOutput | null,
  startedAt: number,
  replayed = false,
): Promise<void> {
  const error = settlement.ok ? null : settlement.error;
  await sql.query(
    `update public.tool_runs
     set status = $3, output = $4::jsonb, error_code = $5, error_message = $6, finished_at = now(), duration_ms = $7,
         replayed = $8
     where id = $1 and organization_id = $2`,
    [
      runId,
      organizationId,
      settlement.ok ? 'succeeded' : settlement.status,
      settlement.ok && output ? output.stored : null,
      error ? error.code : null,
      error ? truncateText(error.message, MAX_ERROR_MESSAGE_CHARS) : null,
      elapsedMs(startedAt),
      replayed,
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
