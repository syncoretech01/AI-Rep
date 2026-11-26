import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { phase1Tools } from '@/server/agent/tools/definitions';
import { createToolExecutor, type ToolExecutionContext, type ToolExecutor } from '@/server/agent/tools/executor';
import { listUnresolvedOperations, resolveUnknownOperation } from '@/server/agent/tools/operations';
import { createToolRegistry } from '@/server/agent/tools/registry';
import { defineTool, type ToolContext, type ToolOutcome } from '@/server/agent/tools/types';
import type { Embedder } from '@/server/ai/embedder';
import { getAgent } from '@/server/domain/agents/repository';
import { tryAcquireTurnLock } from '@/server/domain/conversations/service';
import { silentLogger } from '@/server/observability/logger';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { createConversation, createTenant } from '../support/fixtures';

/**
 * Tool execution safety for EXTERNAL side effects (ARCHITECTURE.md "Tool execution safety"): durable operation
 * identities, one atomic execution claim, replay of confirmed successes, explicit not-attempted / in-progress /
 * failed / unknown states, and no blind repetition of an operation whose outcome is unknown. Plus turn-lock
 * fencing of every run.
 */

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.close();
});

interface NoteData {
  sent: string;
}

/** What the fake provider does on the next call(s). */
let behavior: (input: { text: string }, ctx: ToolContext) => Promise<ToolOutcome<NoteData>>;
const handled: Array<{ text: string; operation: ToolContext['operation'] }> = [];

/** A stand-in for a future external action (an SMS, a calendar booking): the side effect happens elsewhere. */
const sendNote = defineTool({
  name: 'sendNote',
  description: 'Sends a note to the business.',
  input: z.object({ text: z.string().min(1).max(200) }),
  channels: ['web_chat'],
  requires: ['business_info'],
  sideEffects: 'external',
  idempotency: 'none',
  label: 'Sending your note',
  timeoutMs: 200,
  handler(input, ctx) {
    handled.push({ text: input.text, operation: ctx.operation });
    return behavior(input, ctx);
  },
});

const noEmbeddings: Embedder = {
  model: 'none',
  embed: () => Promise.reject(new Error('not used')),
};

function executor(): ToolExecutor {
  return createToolExecutor({
    db: t.db,
    registry: createToolRegistry([...phase1Tools, sendNote]),
    embedder: noEmbeddings,
    retrieval: { maxChunks: 3, maxTokens: 500, minSimilarity: 0.3 },
    logger: silentLogger,
  });
}

async function newContext(): Promise<ToolExecutionContext & { other: () => Promise<ToolExecutionContext> }> {
  const tenant = await t.service.run((sql) => createTenant(sql));
  const agent = (await t.service.run((sql) => getAgent(sql, tenant.org.id, tenant.agent.id)))!;
  const conversationId = (await t.service.run((sql) => createConversation(sql, tenant.org.id, tenant.agent.id))).id;
  const base = { organizationId: tenant.org.id, agent, conversationId, channel: 'web_chat' as const, now: new Date() };
  return {
    ...base,
    other: async () => ({
      ...base,
      conversationId: (await t.service.run((sql) => createConversation(sql, tenant.org.id, tenant.agent.id))).id,
    }),
  };
}

let callCounter = 0;
const call = (text: string, name = 'sendNote') => ({
  callId: `call_${(callCounter += 1)}`,
  name,
  arguments: JSON.stringify({ text }),
});

const runsOf = (conversationId: string) =>
  t.db.query<{ status: string; error_code: string | null; replayed: boolean; idempotency_key: string | null }>(
    `select status, error_code, replayed, idempotency_key from public.tool_runs
     where conversation_id = $1 order by started_at, id`,
    [conversationId],
  );

const operationsOf = (organizationId: string) =>
  t.db.query<{ id: string; status: string; attempts: number; error_code: string | null; external_reference: string | null; result: unknown }>(
    `select id, status, attempts, error_code, external_reference, result from app_private.tool_operations
     where organization_id = $1 order by created_at, id`,
    [organizationId],
  );

const modelError = (output: string) => (JSON.parse(output) as { error?: { code: string } }).error?.code;

describe('external operations', () => {
  it('execute once and replay a confirmed success instead of calling the provider again', async () => {
    const context = await newContext();
    const tools = executor();
    handled.length = 0;
    behavior = () => Promise.resolve({ ok: true, data: { sent: 'yes' }, externalReference: 'msg_123' });

    const first = await tools.execute(call('Please call me'), context);
    const repeat = await tools.execute(call('Please call me'), context);

    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(repeat).toMatchObject({ ok: true, replayed: true, modelOutput: first.modelOutput });
    expect(handled).toHaveLength(1);
    expect(handled[0]?.operation).toEqual({ id: expect.any(String) as unknown, key: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown, attempt: 1 });
    expect(await operationsOf(context.organizationId)).toEqual([
      expect.objectContaining({ status: 'succeeded', attempts: 1, external_reference: 'msg_123', result: { sent: 'yes' } }),
    ]);
    expect((await runsOf(context.conversationId)).map((run) => [run.status, run.replayed])).toEqual([
      ['succeeded', false],
      ['succeeded', true],
    ]);
    const audit = await t.db.query<{ action: string }>('select action from public.audit_logs where organization_id = $1', [
      context.organizationId,
    ]);
    expect(audit.map((row) => row.action)).toEqual(['tool.sendNote']);
  });

  it('may execute again after a confirmed failure or when nothing was sent', async () => {
    const context = await newContext();
    const tools = executor();
    handled.length = 0;
    const outcomes: Array<ToolOutcome<NoteData>> = [
      { ok: false, error: { code: 'unavailable', message: 'Not configured.', retryable: true }, outcome: 'not_attempted' },
      { ok: false, error: { code: 'failed', message: 'Rejected by the provider.', retryable: true }, outcome: 'failed' },
      { ok: true, data: { sent: 'finally' } },
    ];
    behavior = () => Promise.resolve(outcomes.shift()!);

    expect(await tools.execute(call('Hi'), context)).toMatchObject({ ok: false, errorCode: 'unavailable' });
    expect((await operationsOf(context.organizationId))[0]).toMatchObject({ status: 'not_attempted', attempts: 1 });
    expect(await tools.execute(call('Hi'), context)).toMatchObject({ ok: false, errorCode: 'failed' });
    expect((await operationsOf(context.organizationId))[0]).toMatchObject({ status: 'failed', attempts: 2 });
    expect(await tools.execute(call('Hi'), context)).toMatchObject({ ok: true, replayed: false });

    expect(handled.map((entry) => entry.operation?.attempt)).toEqual([1, 2, 3]);
    expect(await operationsOf(context.organizationId)).toEqual([expect.objectContaining({ status: 'succeeded', attempts: 3 })]);
  });

  it('never repeats an operation whose outcome is unknown, and tells the model not to claim either outcome', async () => {
    const context = await newContext();
    const tools = executor();
    handled.length = 0;
    behavior = () =>
      Promise.resolve({ ok: false, error: { code: 'unavailable', message: 'Timed out after sending.', retryable: false }, outcome: 'unknown' });

    const first = await tools.execute(call('Book me in'), context);
    const repeat = await tools.execute(call('Book me in'), context);

    expect(first).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
    expect(JSON.parse(first.modelOutput)).toMatchObject({
      ok: false,
      error: { code: 'outcome_unknown', message: expect.stringContaining('could not be confirmed') as unknown },
    });
    expect(repeat).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
    expect(handled).toHaveLength(1);
    expect((await runsOf(context.conversationId)).map((run) => [run.status, run.error_code])).toEqual([
      ['unknown', 'outcome_unknown'],
      ['rejected', 'outcome_unknown'],
    ]);
    expect(await operationsOf(context.organizationId)).toEqual([expect.objectContaining({ status: 'unknown', error_code: 'unavailable' })]);
    const audit = await t.db.query<{ action: string }>('select action from public.audit_logs where organization_id = $1', [
      context.organizationId,
    ]);
    expect(audit.map((row) => row.action)).toEqual(['tool.sendNote.outcome_unknown']);
  });

  it('treats a handler that timed out or crashed after starting as an unknown outcome', async () => {
    for (const [label, run] of [
      ['timeout', () => new Promise<ToolOutcome<NoteData>>(() => undefined)],
      ['crash', () => Promise.reject(new Error('socket hang up'))],
    ] as const) {
      const context = await newContext();
      behavior = run;
      const result = await executor().execute(call('Hello'), context);
      expect(result, label).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
      expect(await operationsOf(context.organizationId), label).toEqual([
        expect.objectContaining({ status: 'unknown', error_code: label === 'timeout' ? 'timeout' : 'handler_error' }),
      ]);
    }
  });

  it('does not run an operation that another worker is executing right now', async () => {
    const context = await newContext();
    const tools = executor();
    handled.length = 0;
    let finish: (outcome: ToolOutcome<NoteData>) => void = () => undefined;
    behavior = () =>
      new Promise((resolve) => {
        finish = resolve;
      });

    const first = tools.execute(call('Callback please'), context);
    // Let the first call claim the operation and enter the handler.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const concurrent = await tools.execute(call('Callback please'), context);
    finish({ ok: true, data: { sent: 'once' } });

    expect(concurrent).toMatchObject({ ok: false, errorCode: 'in_progress' });
    expect(await first).toMatchObject({ ok: true });
    expect(handled).toHaveLength(1);
    expect(await operationsOf(context.organizationId)).toEqual([expect.objectContaining({ status: 'succeeded', attempts: 1 })]);
  });

  it('turns a lapsed claim (its worker died mid-call) into an unknown outcome instead of executing again', async () => {
    const context = await newContext();
    const tools = executor();
    handled.length = 0;
    let finish: (outcome: ToolOutcome<NoteData>) => void = () => undefined;
    behavior = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const abandoned = tools.execute(call('Ring me'), context);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The worker "died": its claim lapses.
    await t.db.query(
      "update app_private.tool_operations set claimed_until = now() - interval '1 second' where organization_id = $1",
      [context.organizationId],
    );

    const retry = await tools.execute(call('Ring me'), context);

    expect(retry).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
    expect(handled).toHaveLength(1);
    expect(await operationsOf(context.organizationId)).toEqual([expect.objectContaining({ status: 'unknown', error_code: 'claim_expired' })]);

    // The original worker is slow but alive: when it learns the confirmed outcome it still records it (nobody
    // re-claimed the operation since), so later requests replay the success instead of staying blocked.
    finish({ ok: true, data: { sent: 'late' } });
    expect(await abandoned).toMatchObject({ ok: true });
    expect(await operationsOf(context.organizationId)).toEqual([expect.objectContaining({ status: 'succeeded', result: { sent: 'late' } })]);
    expect(await tools.execute(call('Ring me'), context)).toMatchObject({ ok: true, replayed: true });
    expect(handled).toHaveLength(1);
  });

  it('reports a confirmed external success as a success even when the handler data is unusable', async () => {
    const context = await newContext();
    const tools = executor();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    behavior = () => Promise.resolve({ ok: true, data: cyclic as unknown as NoteData, externalReference: 'msg_1' });

    const result = await tools.execute(call('Unusable output'), context);

    expect(result).toMatchObject({ ok: true, errorCode: null });
    expect(JSON.parse(result.modelOutput)).toEqual({ ok: true });
    expect(await operationsOf(context.organizationId)).toEqual([
      expect.objectContaining({ status: 'succeeded', result: {}, external_reference: 'msg_1' }),
    ]);
    expect(await tools.execute(call('Unusable output'), context)).toMatchObject({ ok: true, replayed: true });
  });

  it('lets reconciliation resolve an unknown operation; a confirmed success is then replayed', async () => {
    const context = await newContext();
    const tools = executor();
    handled.length = 0;
    behavior = () => Promise.resolve({ ok: false, error: { code: 'unavailable', message: 'Lost.', retryable: false }, outcome: 'unknown' });
    await tools.execute(call('Quote please'), context);

    const unresolved = await t.service.run((sql) => listUnresolvedOperations(sql, context.organizationId));
    expect(unresolved).toEqual([expect.objectContaining({ status: 'unknown' })]);
    const other = await newContext();
    expect(await t.service.run((sql) => listUnresolvedOperations(sql, other.organizationId))).toEqual([]);
    // Resolving through another organization does nothing.
    expect(
      await t.service.run((sql) =>
        resolveUnknownOperation(sql, other.organizationId, unresolved[0]!.id, { status: 'succeeded', result: { sent: 'x' } }),
      ),
    ).toBe(false);
    expect(
      await t.service.run((sql) =>
        resolveUnknownOperation(sql, context.organizationId, unresolved[0]!.id, {
          status: 'succeeded',
          result: { sent: 'confirmed by the provider' },
          externalReference: 'msg_999',
        }),
      ),
    ).toBe(true);

    const replay = await tools.execute(call('Quote please'), context);
    expect(replay).toMatchObject({ ok: true, replayed: true });
    expect(JSON.parse(replay.modelOutput)).toEqual({ ok: true, sent: 'confirmed by the provider' });
    expect(handled).toHaveLength(1);
    // Only unknown operations can be resolved.
    expect(
      await t.service.run((sql) =>
        resolveUnknownOperation(sql, context.organizationId, unresolved[0]!.id, { status: 'failed', errorCode: 'x' }),
      ),
    ).toBe(false);
  });

  it('scopes the default operation identity to the conversation and the normalized arguments', async () => {
    const context = await newContext();
    const tools = executor();
    handled.length = 0;
    behavior = (input) => Promise.resolve({ ok: true, data: { sent: input.text } });

    await tools.execute(call('Same text'), context);
    await tools.execute(call('Same text'), await context.other());
    await tools.execute(call('Other text'), context);

    expect(handled.map((entry) => entry.text)).toEqual(['Same text', 'Same text', 'Other text']);
    expect(await operationsOf(context.organizationId)).toHaveLength(3);
  });
});

describe('turn lock fencing of tool runs', () => {
  it('starts nothing (and records nothing) once the caller no longer owns the conversation turn lock', async () => {
    const context = await newContext();
    const tools = executor();
    handled.length = 0;
    behavior = () => Promise.resolve({ ok: true, data: { sent: 'never' } });
    const current = await t.service.run((sql) => tryAcquireTurnLock(sql, context.organizationId, context.conversationId, 60));
    expect(current).not.toBeNull();
    const stale = { ...context, lockToken: randomUUID() };

    for (const [name, args] of [
      ['sendNote', { text: 'Hi' }],
      ['captureLead', { name: 'Jane Doe', phone: '+1 555 123 4567' }],
      ['getBusinessHours', {}],
    ] as const) {
      const result = await tools.execute({ callId: `call_${name}`, name, arguments: JSON.stringify(args) }, stale);
      expect(result, name).toMatchObject({ ok: false, errorCode: 'unavailable', toolRunId: null });
      expect(modelError(result.modelOutput), name).toBe('unavailable');
    }
    expect(handled).toEqual([]);
    expect(await runsOf(context.conversationId)).toEqual([]);
    expect(await t.db.query('select id from public.leads where conversation_id = $1', [context.conversationId])).toEqual([]);

    // The owner runs normally.
    const owned = await tools.execute(call('Hi'), { ...context, lockToken: current! });
    expect(owned).toMatchObject({ ok: true });
  });

  it('records refusals (e.g. a per-turn limit) as rejected runs without executing', async () => {
    const context = await newContext();
    handled.length = 0;
    const result = await executor().refuse(call('Hi'), context, {
      code: 'limit_reached',
      message: 'Limit reached.',
      retryable: false,
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'limit_reached', label: 'Sending your note' });
    expect(handled).toEqual([]);
    expect(await runsOf(context.conversationId)).toEqual([
      { status: 'rejected', error_code: 'limit_reached', replayed: false, idempotency_key: null },
    ]);
  });
});
