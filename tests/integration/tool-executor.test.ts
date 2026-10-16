import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { phase1Tools } from '@/server/agent/tools/definitions';
import { createToolExecutor, type ToolExecutionContext, type ToolExecutor } from '@/server/agent/tools/executor';
import { createToolRegistry } from '@/server/agent/tools/registry';
import type { RetrievalBudget, ToolDefinition } from '@/server/agent/tools/types';
import type { Embedder, EmbedOutcome } from '@/server/ai/embedder';
import type { ModelToolCall } from '@/server/ai/types';
import type { Database } from '@/server/db/types';
import { getAgent } from '@/server/domain/agents/repository';
import { ingestTextSource } from '@/server/domain/knowledge/ingestion';
import { DomainError } from '@/server/domain/types';
import type { LogFields, Logger } from '@/server/observability/logger';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { FakeEmbeddingProvider } from '../support/fake-embeddings';
import { createConversation, createTenant, type TenantFixture } from '../support/fixtures';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.close();
});

const anyString: unknown = expect.any(String);
const anyDate: unknown = expect.any(Date);
const NOW = new Date('2026-10-06T18:05:00Z');
const RETRIEVAL: RetrievalBudget = { maxChunks: 5, maxTokens: 1800, minSimilarity: 0.3 };
const KNOWLEDGE = [
  '# Emergency service',
  'We offer 24/7 emergency boiler repair across Springfield.',
  '',
  '# Pricing',
  'Our standard call-out fee is 89 dollars per visit.',
].join('\n');

interface LogEntry {
  level: string;
  event: string;
  fields: LogFields;
}

class RecordingLogger implements Logger {
  readonly entries: LogEntry[] = [];
  debug(event: string, fields: LogFields = {}) {
    this.entries.push({ level: 'debug', event, fields });
  }
  info(event: string, fields: LogFields = {}) {
    this.entries.push({ level: 'info', event, fields });
  }
  warn(event: string, fields: LogFields = {}) {
    this.entries.push({ level: 'warn', event, fields });
  }
  error(event: string, fields: LogFields = {}) {
    this.entries.push({ level: 'error', event, fields });
  }
  child(): Logger {
    return this;
  }
}

function fakeEmbedder(): Embedder {
  const provider = new FakeEmbeddingProvider();
  const model = 'fake-embedding-model';
  return {
    model,
    async embed(texts): Promise<EmbedOutcome> {
      const result = await provider.embed({ model, input: [...texts], dimensions: 1536 });
      return { vectors: result.vectors, model: result.model };
    },
  };
}

/** Test-only tools exercising the executor's failure handling. */
let countedRuns = 0;
const SECRET = 'db-internal.example rejected jane@example.com';
const realCaptureLead = phase1Tools.find((tool) => tool.name === 'captureLead')!;
function testTool(name: string, handler: ToolDefinition['handler'], extra: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name,
    description: `Test tool ${name}.`,
    input: z.object({}),
    channels: ['web_chat'],
    requires: [],
    sideEffects: 'none',
    idempotency: 'none',
    label: `Running ${name}`,
    handler,
    ...extra,
  };
}
const testTools: ToolDefinition[] = [
  testTool('explodingTool', () => Promise.reject(new Error(SECRET))),
  testTool('slowTool', () => new Promise(() => undefined), { timeoutMs: 50 }),
  testTool('strictTool', () => Promise.reject(new DomainError('invalid', 'Choose a date in the future.'))),
  testTool('lookupTool', () => Promise.reject(new DomainError('not_found', 'Order 123 not found.'))),
  testTool('hugeTool', () => Promise.resolve({ ok: true, data: { blob: 'x'.repeat(13_000) } })),
  testTool('countingTool', () => {
    countedRuns += 1;
    return Promise.resolve({ ok: true, data: { count: countedRuns } });
  }),
  testTool('pickyTool', () =>
    Promise.resolve({
      ok: false,
      error: { code: 'missing_information', message: 'Ask for the order number.', retryable: true, details: { missing: ['order'] } },
    }),
  ),
  // The real captureLead behind a slow start (e.g. waiting for a pool connection): it commits after its time limit.
  testTool(
    'slowCaptureLead',
    async (input, ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return realCaptureLead.handler(input, ctx);
    },
    { input: realCaptureLead.input, sideEffects: 'writes', timeoutMs: 50 },
  ),
];

function makeExecutor(options: { db?: Database; logger?: Logger } = {}): ToolExecutor {
  return createToolExecutor({
    db: options.db ?? t.db,
    registry: createToolRegistry([...phase1Tools, ...testTools]),
    embedder: fakeEmbedder(),
    retrieval: RETRIEVAL,
    logger: options.logger ?? new RecordingLogger(),
  });
}

function toolCall(name: string, args: unknown, callId = 'call_1'): ModelToolCall {
  return { callId, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) };
}

async function setup(options: { leadCapture?: boolean } = {}) {
  const tenant = await t.service.run((sql) => createTenant(sql));
  if (options.leadCapture === false) {
    await t.db.query(`update public.agents set lead_capture = '{"enabled": false, "requiredFields": []}' where id = $1`, [
      tenant.agent.id,
    ]);
  }
  return { tenant, context: await contextFor(tenant) };
}

async function contextFor(tenant: TenantFixture, conversationId?: string): Promise<ToolExecutionContext> {
  const agent = await t.service.run((sql) => getAgent(sql, tenant.org.id, tenant.agent.id));
  const id = conversationId ?? (await t.service.run((sql) => createConversation(sql, tenant.org.id, tenant.agent.id))).id;
  return { organizationId: tenant.org.id, agent: agent!, conversationId: id, channel: 'web_chat', now: NOW };
}

interface RunRow {
  organization_id: string;
  agent_id: string;
  conversation_id: string;
  tool_name: string;
  provider_call_id: string | null;
  status: string;
  input: unknown;
  output: unknown;
  error_code: string | null;
  error_message: string | null;
  idempotency_key: string | null;
  replayed: boolean;
  finished_at: Date | null;
  duration_ms: number | null;
}

async function runRow(id: string | null): Promise<RunRow> {
  const rows = await t.db.query<RunRow>(
    `select organization_id, agent_id, conversation_id, tool_name, provider_call_id, status, input, output, error_code,
            error_message, idempotency_key, replayed, finished_at, duration_ms
     from public.tool_runs where id = $1`,
    [id],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

const parse = (modelOutput: string): unknown => JSON.parse(modelOutput);

describe('rejections', () => {
  it('rejects an unknown tool with a rejected tool_run', async () => {
    const { tenant, context } = await setup();
    const result = await makeExecutor().execute(toolCall('bookAppointment', { when: 'tomorrow' }, 'call_x'), context);

    expect(result).toEqual({
      toolRunId: anyString,
      toolName: 'bookAppointment',
      ok: false,
      modelOutput: anyString,
      errorCode: 'unknown_tool',
      label: 'Working on it',
      replayed: false,
    });
    expect(parse(result.modelOutput)).toEqual({
      ok: false,
      error: { code: 'unknown_tool', message: 'Unknown tool "bookAppointment". Use only the tools you were given.' },
    });
    expect(await runRow(result.toolRunId)).toEqual({
      organization_id: tenant.org.id,
      agent_id: tenant.agent.id,
      conversation_id: context.conversationId,
      tool_name: 'bookAppointment',
      provider_call_id: 'call_x',
      status: 'rejected',
      input: { when: 'tomorrow' },
      output: null,
      error_code: 'unknown_tool',
      error_message: 'Unknown tool "bookAppointment". Use only the tools you were given.',
      idempotency_key: null,
      replayed: false,
      finished_at: anyDate,
      duration_ms: expect.any(Number) as unknown,
    });
  });

  it('stores model-controlled names and arguments bounded', async () => {
    const { context } = await setup();
    const executor = makeExecutor();

    const unnamed = await executor.execute(toolCall('', '{}'), context);
    expect((await runRow(unnamed.toolRunId)).tool_name).toBe('(unnamed)');

    const longName = await executor.execute(toolCall('x'.repeat(500), 'y'.repeat(10_000), 'c'.repeat(300)), context);
    const row = await runRow(longName.toolRunId);
    expect(row.tool_name).toBe('x'.repeat(64));
    expect(row.provider_call_id).toBe('c'.repeat(128));
    expect(row.input).toEqual({ raw: `${'y'.repeat(1999)}…` });
    expect(longName.toolName).toBe('x'.repeat(64));
  });

  it('rejects a tool the agent may not use (lead capture disabled)', async () => {
    const { tenant, context } = await setup({ leadCapture: false });
    const result = await makeExecutor().execute(toolCall('captureLead', { name: 'Jane', phone: '+15551234567' }), context);

    expect(result).toMatchObject({ ok: false, errorCode: 'not_permitted', label: 'Saving your details', replayed: false });
    expect(parse(result.modelOutput)).toMatchObject({ ok: false, error: { code: 'not_permitted' } });
    expect(await runRow(result.toolRunId)).toMatchObject({ status: 'rejected', error_code: 'not_permitted' });
    expect(await t.db.query('select id from public.leads where organization_id = $1', [tenant.org.id])).toEqual([]);
  });

  it('rejects malformed JSON arguments', async () => {
    const { context } = await setup();
    const result = await makeExecutor().execute(toolCall('searchKnowledge', '{"query": "boiler'), context);

    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_arguments', label: 'Searching our information' });
    expect(parse(result.modelOutput)).toEqual({
      ok: false,
      error: { code: 'invalid_arguments', message: 'Invalid arguments: send a JSON object.' },
    });
    expect(await runRow(result.toolRunId)).toMatchObject({
      status: 'rejected',
      error_code: 'invalid_arguments',
      input: { raw: '{"query": "boiler' },
    });
  });

  it('rejects arguments that fail validation with a path: message list the model can act on', async () => {
    const { context } = await setup();
    const executor = makeExecutor();

    const tooShort = await executor.execute(toolCall('searchKnowledge', { query: ' a ' }), context);
    expect(tooShort).toMatchObject({ ok: false, errorCode: 'invalid_arguments' });
    expect(parse(tooShort.modelOutput)).toEqual({
      ok: false,
      error: { code: 'invalid_arguments', message: 'Invalid arguments: query: Too small: expected string to have >=2 characters' },
    });
    expect(await runRow(tooShort.toolRunId)).toMatchObject({ status: 'rejected', input: { query: ' a ' } });

    const badLead = await executor.execute(toolCall('captureLead', { phone: 'call me', email: 42 }), context);
    const message = (parse(badLead.modelOutput) as { error: { message: string } }).error.message;
    expect(message).toContain('phone: Not a valid phone number.');
    expect(message).toContain('email: Invalid input: expected string, received number');

    const notAnObject = await executor.execute(toolCall('searchKnowledge', '["boiler"]'), context);
    expect((parse(notAnObject.modelOutput) as { error: { message: string } }).error.message).toBe(
      'Invalid arguments: arguments: Invalid input: expected object, received array',
    );
  });
});

describe('execution', () => {
  it('runs a tool and records its validated input, output and timing', async () => {
    const { tenant, context } = await setup();
    await ingestTextSource(t.service, fakeEmbedder(), {
      organizationId: tenant.org.id,
      agentId: null,
      kind: 'text',
      title: 'Home services',
      text: KNOWLEDGE,
      createdBy: tenant.owner.id,
    });

    const result = await makeExecutor().execute(
      toolCall('searchKnowledge', { query: '  Do you offer emergency boiler repair? ' }, 'call_7'),
      context,
    );

    const content = 'Emergency service\n\nWe offer 24/7 emergency boiler repair across Springfield.';
    expect(result).toEqual({
      toolRunId: anyString,
      toolName: 'searchKnowledge',
      ok: true,
      modelOutput: JSON.stringify({ ok: true, results: [{ source: 'Home services', content }] }),
      errorCode: null,
      label: 'Searching our information',
      replayed: false,
    });
    expect(await runRow(result.toolRunId)).toEqual({
      organization_id: tenant.org.id,
      agent_id: tenant.agent.id,
      conversation_id: context.conversationId,
      tool_name: 'searchKnowledge',
      provider_call_id: 'call_7',
      status: 'succeeded',
      input: { query: 'Do you offer emergency boiler repair?' },
      output: { results: [{ source: 'Home services', content }] },
      error_code: null,
      error_message: null,
      idempotency_key: null,
      replayed: false,
      finished_at: anyDate,
      duration_ms: expect.any(Number) as unknown,
    });
  });

  it('treats blank arguments of a tool without parameters as an empty object', async () => {
    const { context } = await setup();
    const result = await makeExecutor().execute(toolCall('getBusinessInfo', ''), context);
    expect(result).toMatchObject({ ok: true, errorCode: null });
    expect(parse(result.modelOutput)).toEqual({ ok: true, note: 'No business details are configured.' });
  });

  it('passes a handler-reported failure (with details) to the model', async () => {
    const { context } = await setup();
    const result = await makeExecutor().execute(toolCall('pickyTool', {}), context);
    expect(result).toMatchObject({ ok: false, errorCode: 'missing_information' });
    expect(parse(result.modelOutput)).toEqual({
      ok: false,
      error: { code: 'missing_information', message: 'Ask for the order number.', details: { missing: ['order'] } },
    });
    expect(await runRow(result.toolRunId)).toMatchObject({
      status: 'failed',
      output: null,
      error_code: 'missing_information',
      error_message: 'Ask for the order number.',
      finished_at: anyDate,
    });
  });

  it('turns a handler exception into a safe failure and logs only identifiers', async () => {
    const { context } = await setup();
    const logger = new RecordingLogger();
    const result = await makeExecutor({ logger }).execute(toolCall('explodingTool', {}), context);

    expect(result).toMatchObject({ ok: false, errorCode: 'failed' });
    expect(parse(result.modelOutput)).toEqual({
      ok: false,
      error: { code: 'failed', message: 'This action failed because of a technical problem.' },
    });
    expect(result.modelOutput).not.toContain('jane@example.com');
    const row = await runRow(result.toolRunId);
    expect(row).toMatchObject({ status: 'failed', error_code: 'failed', error_message: 'This action failed because of a technical problem.' });
    expect(JSON.stringify(row)).not.toContain('db-internal');

    const logged = logger.entries.filter((entry) => entry.event === 'agent.tool.failed');
    expect(logged).toHaveLength(1);
    expect(Object.keys(logged[0]!.fields).sort()).toEqual(['error', 'toolName', 'toolRunId']);
    expect(logged[0]!.fields).toMatchObject({ toolName: 'explodingTool', toolRunId: result.toolRunId });
  });

  it('maps DomainErrors: invalid -> invalid_arguments with its message, others -> failed', async () => {
    const { context } = await setup();
    const executor = makeExecutor();

    const invalid = await executor.execute(toolCall('strictTool', {}), context);
    expect(invalid).toMatchObject({ ok: false, errorCode: 'invalid_arguments' });
    expect(parse(invalid.modelOutput)).toEqual({
      ok: false,
      error: { code: 'invalid_arguments', message: 'Choose a date in the future.' },
    });
    expect(await runRow(invalid.toolRunId)).toMatchObject({ status: 'failed', error_code: 'invalid_arguments' });

    const missing = await executor.execute(toolCall('lookupTool', {}), context);
    expect(missing).toMatchObject({ ok: false, errorCode: 'failed' });
    expect(missing.modelOutput).not.toContain('Order 123');
  });

  it('fails a read-only run that times out', async () => {
    const { context } = await setup();
    const startedAt = Date.now();
    const result = await makeExecutor().execute(toolCall('slowTool', {}), context);

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(result).toMatchObject({ ok: false, errorCode: 'unavailable' });
    expect(parse(result.modelOutput)).toEqual({
      ok: false,
      error: { code: 'unavailable', message: 'The action took too long to complete.' },
    });
    expect(await runRow(result.toolRunId)).toMatchObject({ status: 'failed', error_code: 'unavailable', finished_at: anyDate });
  });

  it('does not run a handler once the turn has been cancelled', async () => {
    const { context } = await setup();
    const before = countedRuns;
    const controller = new AbortController();
    controller.abort();

    const result = await makeExecutor().execute(toolCall('countingTool', {}), { ...context, signal: controller.signal });

    expect(countedRuns).toBe(before);
    expect(result).toMatchObject({ ok: false, errorCode: 'unavailable' });
    expect(parse(result.modelOutput)).toMatchObject({ error: { message: 'The action was cancelled.' } });
  });

  it('fails a run whose output would be too large for the model context', async () => {
    const { context } = await setup();
    const logger = new RecordingLogger();
    const result = await makeExecutor({ logger }).execute(toolCall('hugeTool', {}), context);

    expect(result).toMatchObject({ ok: false, errorCode: 'failed' });
    expect(result.modelOutput.length).toBeLessThan(200);
    expect(await runRow(result.toolRunId)).toMatchObject({ status: 'failed', output: null, error_code: 'failed' });
    expect(logger.entries.map((entry) => entry.event)).toContain('agent.tool.output_rejected');
  });
});

describe('side effects', () => {
  const leadArgs = { name: 'Jane Doe', phone: '(555) 123-4567', summary: 'Boiler quote' };

  it('audits successful write tools', async () => {
    const { tenant, context } = await setup();
    const result = await makeExecutor().execute(toolCall('captureLead', leadArgs), context);

    expect(result).toMatchObject({ ok: true, errorCode: null, label: 'Saving your details', replayed: false });
    const audits = await t.db.query<Record<string, unknown>>(
      `select actor_type, actor_id, action, target_type, target_id, metadata
       from public.audit_logs where organization_id = $1`,
      [tenant.org.id],
    );
    expect(audits).toEqual([
      {
        actor_type: 'agent',
        actor_id: tenant.agent.id,
        action: 'tool.captureLead',
        target_type: 'conversation',
        target_id: context.conversationId,
        metadata: { toolRunId: result.toolRunId },
      },
    ]);

    // Read-only tools and failed writes are not audited.
    await makeExecutor().execute(toolCall('getBusinessHours', {}), context);
    await makeExecutor().execute(toolCall('captureLead', { name: 'No Contact' }), context);
    expect(await t.db.query('select id from public.audit_logs where organization_id = $1', [tenant.org.id])).toHaveLength(1);
  });

  it('replays an identical successful call in the same conversation instead of running it again', async () => {
    const { tenant, context } = await setup();
    const executor = makeExecutor();

    const first = await executor.execute(toolCall('captureLead', leadArgs, 'call_1'), context);
    // Same arguments in a different key order and with extra whitespace normalize to the same input.
    const repeated = toolCall('captureLead', '{"summary":"Boiler quote","phone":" (555) 123-4567 ","name":"Jane Doe"}', 'call_2');
    const second = await executor.execute(repeated, context);

    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(second).toMatchObject({ ok: true, replayed: true, errorCode: null });
    expect(parse(second.modelOutput)).toEqual(parse(first.modelOutput));
    expect(parse(second.modelOutput)).toEqual({
      ok: true,
      saved: true,
      fields: ['name', 'phone', 'summary'],
      updatedExistingLead: false,
    });
    expect(second.toolRunId).not.toBe(first.toolRunId);

    const firstRow = await runRow(first.toolRunId);
    const secondRow = await runRow(second.toolRunId);
    expect(firstRow).toMatchObject({ status: 'succeeded', replayed: false, idempotency_key: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown });
    expect(secondRow).toMatchObject({
      status: 'succeeded',
      replayed: true,
      provider_call_id: 'call_2',
      idempotency_key: firstRow.idempotency_key,
      output: firstRow.output,
      finished_at: anyDate,
    });
    expect(await t.db.query('select id from public.leads where organization_id = $1', [tenant.org.id])).toHaveLength(1);
    expect(await t.db.query('select id from public.contacts where organization_id = $1', [tenant.org.id])).toHaveLength(1);
    // The side effect ran (and was audited) once.
    expect(await t.db.query('select id from public.audit_logs where organization_id = $1', [tenant.org.id])).toHaveLength(1);

    // Different arguments, or another conversation, run again.
    const changed = await executor.execute(toolCall('captureLead', { ...leadArgs, email: 'jane@example.com' }), context);
    expect(changed).toMatchObject({ ok: true, replayed: false });
    const otherConversation = await contextFor(tenant);
    expect(await executor.execute(toolCall('captureLead', leadArgs), otherConversation)).toMatchObject({ ok: true, replayed: false });
    expect(await t.db.query('select id from public.leads where organization_id = $1', [tenant.org.id])).toHaveLength(2);
  });

  it('replays only a repeat of the latest successful call: after a different one, an earlier call runs again (A, B, A)', async () => {
    const { tenant, context } = await setup();
    const executor = makeExecutor();
    const original = { ...leadArgs, phone: '555-201-0001' };
    const correction = { ...leadArgs, phone: '555-201-0002' };
    const lead = async () =>
      (
        await t.db.query<{ contact_id: string; captured_phone: string | null }>(
          'select contact_id, captured_phone from public.leads where organization_id = $1 and conversation_id = $2',
          [tenant.org.id, context.conversationId],
        )
      )[0];

    expect(await executor.execute(toolCall('captureLead', original, 'call_1'), context)).toMatchObject({ ok: true, replayed: false });
    const asOriginal = await lead();
    expect(await executor.execute(toolCall('captureLead', correction, 'call_2'), context)).toMatchObject({ ok: true, replayed: false });
    expect(await lead()).not.toEqual(asOriginal);

    // "Sorry, the first number was right": the original details must be saved again, not replayed as saved.
    const reverted = await executor.execute(toolCall('captureLead', original, 'call_3'), context);
    expect(reverted).toMatchObject({ ok: true, replayed: false });
    expect(await runRow(reverted.toolRunId)).toMatchObject({ status: 'succeeded', replayed: false });
    expect(await lead()).toEqual(asOriginal);
    // A repeat of the latest call is still replayed, also after another tool ran; every change ran (and was audited) once.
    expect(await executor.execute(toolCall('getBusinessHours', {}, 'call_4'), context)).toMatchObject({ ok: true });
    expect(await executor.execute(toolCall('captureLead', original, 'call_5'), context)).toMatchObject({ ok: true, replayed: true });
    expect(await t.db.query('select id from public.audit_logs where organization_id = $1', [tenant.org.id])).toHaveLength(3);
  });

  it('awaits a started write past its time limit and records what really happened, audited', async () => {
    const { tenant, context } = await setup();
    const logger = new RecordingLogger();
    // The turn is cancelled while the write runs, too: a started write is still never abandoned.
    const cancelled = AbortSignal.timeout(20);

    const result = await makeExecutor({ logger }).execute(toolCall('slowCaptureLead', leadArgs), { ...context, signal: cancelled });

    expect(result).toMatchObject({ ok: true, errorCode: null, replayed: false });
    expect(parse(result.modelOutput)).toMatchObject({ ok: true, saved: true });
    expect(await runRow(result.toolRunId)).toMatchObject({ status: 'succeeded', error_code: null, finished_at: anyDate });
    expect(await t.db.query('select id from public.leads where organization_id = $1', [tenant.org.id])).toHaveLength(1);
    expect(
      await t.db.query('select action, metadata from public.audit_logs where organization_id = $1', [tenant.org.id]),
    ).toEqual([{ action: 'tool.slowCaptureLead', metadata: { toolRunId: result.toolRunId } }]);
    expect(logger.entries.map((entry) => entry.event)).toEqual(['agent.tool.slow']);
  });

  it('never starts a write once the turn has been cancelled', async () => {
    const { tenant, context } = await setup();
    const cancelled = new AbortController();
    cancelled.abort();

    const result = await makeExecutor().execute(toolCall('captureLead', leadArgs), { ...context, signal: cancelled.signal });

    expect(result).toMatchObject({ ok: false, errorCode: 'unavailable', replayed: false });
    expect(parse(result.modelOutput)).toMatchObject({ error: { message: 'The action was cancelled.' } });
    expect(await runRow(result.toolRunId)).toMatchObject({ status: 'failed', error_code: 'unavailable' });
    expect(await t.db.query('select id from public.contacts where organization_id = $1', [tenant.org.id])).toEqual([]);
    expect(await t.db.query('select id from public.leads where organization_id = $1', [tenant.org.id])).toEqual([]);
    expect(await t.db.query('select id from public.audit_logs where organization_id = $1', [tenant.org.id])).toEqual([]);
  });

  it('runs again after an earlier identical call failed', async () => {
    const { tenant, context } = await setup();
    const executor = makeExecutor();
    const requireEmail: ToolExecutionContext = {
      ...context,
      agent: { ...context.agent, leadCapture: { enabled: true, requiredFields: ['email'] } },
    };

    const missing = await executor.execute(toolCall('captureLead', leadArgs), requireEmail);
    expect(missing).toMatchObject({ ok: false, errorCode: 'missing_information', replayed: false });
    const retried = await executor.execute(toolCall('captureLead', leadArgs), context);
    expect(retried).toMatchObject({ ok: true, replayed: false });
    expect(await t.db.query('select id from public.leads where organization_id = $1', [tenant.org.id])).toHaveLength(1);
  });
});

describe('tenant isolation', () => {
  it("never returns another organization's chunks, even when it has identical content", async () => {
    const a = await setup();
    const b = await setup();
    for (const [tenant, title] of [
      [a.tenant, 'Tenant A handbook'],
      [b.tenant, 'Tenant B handbook'],
    ] as const) {
      await ingestTextSource(t.service, fakeEmbedder(), {
        organizationId: tenant.org.id,
        agentId: null,
        kind: 'text',
        title,
        text: KNOWLEDGE,
        createdBy: tenant.owner.id,
      });
    }

    const result = await makeExecutor().execute(toolCall('searchKnowledge', { query: 'emergency boiler repair' }), a.context);

    const output = parse(result.modelOutput) as { ok: boolean; results: Array<{ source: string; content: string }> };
    expect(output.ok).toBe(true);
    expect(output.results.length).toBeGreaterThan(0);
    expect(output.results.every((entry) => entry.source === 'Tenant A handbook')).toBe(true);
    expect(result.modelOutput).not.toContain('Tenant B');
    expect(await runRow(result.toolRunId)).toMatchObject({ organization_id: a.tenant.org.id });
    expect(await t.db.query('select id from public.tool_runs where organization_id = $1', [b.tenant.org.id])).toEqual([]);
  });

  it("refuses to run with another organization's agent or conversation (nothing executes unrecorded)", async () => {
    const a = await setup();
    const b = await setup();
    const executor = makeExecutor();

    const foreignConversation = await executor.execute(toolCall('captureLead', { name: 'Eve', phone: '+15550009999' }), {
      ...a.context,
      conversationId: b.context.conversationId,
    });
    expect(foreignConversation).toMatchObject({ toolRunId: null, ok: false, errorCode: 'unavailable' });

    const foreignAgent = await executor.execute(toolCall('countingTool', {}), { ...a.context, agent: b.context.agent });
    expect(foreignAgent).toMatchObject({ toolRunId: null, ok: false, errorCode: 'unavailable' });

    for (const tenant of [a.tenant, b.tenant]) {
      expect(await t.db.query('select id from public.leads where organization_id = $1', [tenant.org.id])).toEqual([]);
      expect(await t.db.query('select id from public.tool_runs where organization_id = $1', [tenant.org.id])).toEqual([]);
    }
  });
});

describe('database unavailable', () => {
  it('reports the failure without executing anything (toolRunId null)', async () => {
    const { context } = await setup();
    const down: Database = {
      query: () => Promise.reject(new Error('connection refused')),
      transaction: () => Promise.reject(new Error('connection refused')),
      close: () => Promise.resolve(),
    };
    const before = countedRuns;
    const logger = new RecordingLogger();
    const executor = makeExecutor({ db: down, logger });

    const run = await executor.execute(toolCall('countingTool', {}), context);
    expect(run).toMatchObject({ toolRunId: null, ok: false, errorCode: 'unavailable' });
    expect(parse(run.modelOutput)).toEqual({
      ok: false,
      error: { code: 'unavailable', message: 'This action is temporarily unavailable.' },
    });
    expect(countedRuns).toBe(before);

    const rejected = await executor.execute(toolCall('noSuchTool', {}), context);
    expect(rejected).toMatchObject({ toolRunId: null, ok: false, errorCode: 'unknown_tool' });
    expect(logger.entries.filter((entry) => entry.event === 'agent.tool.record_failed')).toHaveLength(2);
  });
});
