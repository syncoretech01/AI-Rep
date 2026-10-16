import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TextUsageReport } from '@/server/domain/usage/types';
import { createCostEstimator } from '@/server/domain/usage/cost';
import { createUsageRecorder } from '@/server/domain/usage/service';
import { createLogger, type LogFields, type Logger } from '@/server/observability/logger';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { createConversation, createTenant, type TenantFixture } from '../support/fixtures';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.close();
});

interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  event: string;
  fields: LogFields;
}

class RecordingLogger implements Logger {
  readonly entries: LogEntry[] = [];

  debug(event: string, fields: LogFields = {}): void {
    this.entries.push({ level: 'debug', event, fields });
  }
  info(event: string, fields: LogFields = {}): void {
    this.entries.push({ level: 'info', event, fields });
  }
  warn(event: string, fields: LogFields = {}): void {
    this.entries.push({ level: 'warn', event, fields });
  }
  error(event: string, fields: LogFields = {}): void {
    this.entries.push({ level: 'error', event, fields });
  }
  child(): Logger {
    return this;
  }

  events(event: string): LogEntry[] {
    return this.entries.filter((entry) => entry.event === event);
  }
}

const chatReport: TextUsageReport = {
  provider: 'openai',
  model: 'gpt-6-luna-2026-09-15',
  usage: { inputTokens: 10_000, cachedInputTokens: 4_000, cacheWriteTokens: 0, outputTokens: 500, reasoningTokens: 120 },
  toolCalls: 2,
  durationMs: 1234.4,
  metadata: { tier: 'default', round: 1 },
};

/** The counters a failed write of `chatReport` logs for reconciliation. */
const loggedCounts = {
  inputTokens: 10_000,
  cachedInputTokens: 4_000,
  cacheWriteTokens: 0,
  outputTokens: 500,
  reasoningTokens: 120,
  toolCalls: 2,
  durationMs: 1234,
};

interface UsageRow {
  agent_id: string | null;
  conversation_id: string | null;
  kind: string;
  purpose: string;
  provider: string;
  model: string;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  tool_calls: number;
  duration_ms: number | null;
  cost: string;
  pricing_known: boolean;
  metadata: Record<string, unknown>;
}

function usageRows(organizationId: string): Promise<UsageRow[]> {
  return t.db.query<UsageRow>(
    `select agent_id, conversation_id, kind, purpose, provider, model, input_tokens, cached_input_tokens,
            cache_write_tokens, output_tokens, reasoning_tokens, tool_calls, duration_ms,
            estimated_cost_usd::text as cost, pricing_known, metadata
     from public.usage_records where organization_id = $1 order by created_at, kind, id`,
    [organizationId],
  );
}

function newTenant(): Promise<TenantFixture> {
  return t.service.run((sql) => createTenant(sql));
}

describe('usage recorder', () => {
  it('records a text generation with its tokens and estimated cost', async () => {
    const tenant = await newTenant();
    const conversation = await t.service.run((sql) => createConversation(sql, tenant.org.id, tenant.agent.id));
    const logger = new RecordingLogger();
    const recorder = createUsageRecorder({ db: t.db, costs: createCostEstimator(), logger });

    await recorder.recordTextGeneration(
      { organizationId: tenant.org.id, agentId: tenant.agent.id, conversationId: conversation.id },
      'chat_response',
      chatReport,
    );

    expect(await usageRows(tenant.org.id)).toEqual([
      {
        agent_id: tenant.agent.id,
        conversation_id: conversation.id,
        kind: 'text_generation',
        purpose: 'chat_response',
        provider: 'openai',
        model: 'gpt-6-luna-2026-09-15',
        input_tokens: 10_000,
        cached_input_tokens: 4_000,
        cache_write_tokens: 0,
        output_tokens: 500,
        reasoning_tokens: 120,
        tool_calls: 2,
        duration_ms: 1234,
        // 6,000 × $0.10 + 4,000 × $0.01 + 500 × $0.50 per 1M tokens (dated snapshot priced as its model).
        cost: '0.00089000',
        pricing_known: true,
        metadata: { tier: 'default', round: 1 },
      },
    ]);
    expect(logger.entries).toEqual([]);
  });

  it('records embeddings and summary generations with their purpose', async () => {
    const tenant = await newTenant();
    const recorder = createUsageRecorder({ db: t.db, costs: createCostEstimator(), logger: new RecordingLogger() });

    await recorder.recordEmbedding({ organizationId: tenant.org.id }, 'knowledge_ingestion', {
      provider: 'openai',
      model: 'text-embedding-3-small',
      inputTokens: 1_234,
      durationMs: 50,
    });
    await recorder.recordTextGeneration({ organizationId: tenant.org.id, agentId: tenant.agent.id }, 'conversation_summary', {
      ...chatReport,
      model: 'gpt-6-luna',
      usage: { inputTokens: 2_000, cachedInputTokens: 0, cacheWriteTokens: 1_000, outputTokens: 100, reasoningTokens: 0 },
      toolCalls: 0,
      metadata: undefined,
    });

    expect(await usageRows(tenant.org.id)).toEqual([
      expect.objectContaining({
        agent_id: null,
        conversation_id: null,
        kind: 'embedding',
        purpose: 'knowledge_ingestion',
        model: 'text-embedding-3-small',
        input_tokens: 1_234,
        cached_input_tokens: 0,
        output_tokens: 0,
        tool_calls: 0,
        duration_ms: 50,
        cost: '0.00002468',
        pricing_known: true,
        metadata: {},
      }),
      expect.objectContaining({
        agent_id: tenant.agent.id,
        kind: 'text_generation',
        purpose: 'conversation_summary',
        cache_write_tokens: 1_000,
        // 1,000 × $0.10 + 1,000 written × $0.125 + 100 × $0.50 per 1M tokens.
        cost: '0.00027500',
        metadata: {},
      }),
    ]);
  });

  it('marks unpriced models, warns once per model, and honours price overrides', async () => {
    const tenant = await newTenant();
    const logger = new RecordingLogger();
    const recorder = createUsageRecorder({ db: t.db, costs: createCostEstimator(), logger });
    const context = { organizationId: tenant.org.id };

    await recorder.recordTextGeneration(context, 'chat_response', { ...chatReport, provider: 'alt', model: 'alt-mini' });
    await recorder.recordTextGeneration(context, 'chat_response', { ...chatReport, provider: 'alt', model: 'alt-mini' });
    expect((await usageRows(tenant.org.id)).map((row) => [row.model, row.cost, row.pricing_known])).toEqual([
      ['alt-mini', '0.00000000', false],
      ['alt-mini', '0.00000000', false],
    ]);
    const warnings = logger.events('usage.pricing_unknown');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ level: 'warn', fields: { provider: 'alt', model: 'alt-mini' } });

    const priced = createUsageRecorder({
      db: t.db,
      costs: createCostEstimator({ 'alt-mini': { inputPerMTok: 1, outputPerMTok: 2 } }),
      logger,
    });
    await priced.recordTextGeneration(context, 'chat_response', { ...chatReport, provider: 'alt', model: 'alt-mini' });
    // 10,000 × $1 (no cached rate: falls back to input) + 500 × $2 per 1M tokens.
    const pricedRows = (await usageRows(tenant.org.id)).filter((row) => row.pricing_known);
    expect(pricedRows).toEqual([expect.objectContaining({ model: 'alt-mini', cost: '0.01100000' })]);
  });

  it('stores sane values when an adapter reports odd numbers or labels', async () => {
    const tenant = await newTenant();
    const recorder = createUsageRecorder({ db: t.db, costs: createCostEstimator(), logger: new RecordingLogger() });

    await recorder.recordTextGeneration({ organizationId: tenant.org.id }, 'chat_response', {
      provider: ' ',
      model: 'm'.repeat(200),
      usage: { inputTokens: -1, cachedInputTokens: Number.NaN, cacheWriteTokens: 0.4, outputTokens: 10.6, reasoningTokens: 3 },
      toolCalls: -2,
      durationMs: Number.POSITIVE_INFINITY,
    });

    expect(await usageRows(tenant.org.id)).toEqual([
      expect.objectContaining({
        provider: 'unknown',
        model: 'm'.repeat(128),
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_write_tokens: 0,
        output_tokens: 11,
        reasoning_tokens: 3,
        tool_calls: 0,
        duration_ms: 0,
        pricing_known: false,
      }),
    ]);
  });

  it("shows users only their own organization's usage and never lets them write it (RLS)", async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    const recorder = createUsageRecorder({ db: t.db, costs: createCostEstimator(), logger: new RecordingLogger() });
    await recorder.recordTextGeneration({ organizationId: tenantA.org.id }, 'chat_response', chatReport);
    await recorder.recordTextGeneration({ organizationId: tenantB.org.id }, 'chat_response', chatReport);
    const ownerA = t.asUser(tenantA.owner.id);

    const visible = await ownerA.run((sql) => sql.query<{ organization_id: string }>('select organization_id from public.usage_records'));
    expect(visible.map((row) => row.organization_id)).toEqual([tenantA.org.id]);

    const denied = { code: '42501' };
    await expect(
      ownerA.run((sql) =>
        sql.query(
          `insert into public.usage_records (organization_id, kind, purpose, provider, model)
           values ($1, 'embedding', 'knowledge_query', 'openai', 'text-embedding-3-small')`,
          [tenantA.org.id],
        ),
      ),
    ).rejects.toMatchObject(denied);
    await expect(
      ownerA.run((sql) => sql.query('update public.usage_records set estimated_cost_usd = 0 where organization_id = $1', [tenantA.org.id])),
    ).rejects.toMatchObject(denied);
  });

  it('never throws when the row cannot be written, and logs the numbers to reconcile', async () => {
    const logger = new RecordingLogger();
    const recorder = createUsageRecorder({ db: t.db, costs: createCostEstimator(), logger });
    const missingOrganization = randomUUID();

    await expect(
      recorder.recordTextGeneration({ organizationId: missingOrganization, agentId: null }, 'chat_response', chatReport),
    ).resolves.toBeUndefined();
    await expect(
      recorder.recordEmbedding({ organizationId: 'not-a-uuid' }, 'knowledge_query', {
        provider: 'openai',
        model: 'text-embedding-3-small',
        inputTokens: 12,
        durationMs: 3,
      }),
    ).resolves.toBeUndefined();

    const failures = logger.events('usage.record_failed');
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatchObject({
      level: 'error',
      fields: {
        organizationId: missingOrganization,
        agentId: null,
        conversationId: null,
        kind: 'text_generation',
        purpose: 'chat_response',
        provider: 'openai',
        model: 'gpt-6-luna-2026-09-15',
        ...loggedCounts,
        costUsd: 0.00089,
        pricingKnown: true,
        metadata: { tier: 'default', round: 1 },
      },
    });
    expect(failures[0]?.fields.error).toBeInstanceOf(Error);
    expect(failures[1]).toMatchObject({
      fields: { kind: 'embedding', purpose: 'knowledge_query', inputTokens: 12, outputTokens: 0, durationMs: 3 },
    });
    expect(await t.db.query('select id from public.usage_records where organization_id = $1', [missingOrganization])).toEqual([]);
  });

  // Boots a second PGlite instance just to close it.
  it('never throws when the database is unavailable', { timeout: 90_000 }, async () => {
    const closed = await createTestDatabase();
    await closed.close();
    const logger = new RecordingLogger();
    const recorder = createUsageRecorder({ db: closed.db, costs: createCostEstimator(), logger });

    await expect(
      recorder.recordTextGeneration({ organizationId: randomUUID() }, 'chat_response', chatReport),
    ).resolves.toBeUndefined();
    expect(logger.events('usage.record_failed')).toHaveLength(1);
  });

  it('keeps the token counts readable through the redacting production logger', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      if (typeof line === 'string') lines.push(line);
    });
    const recorder = createUsageRecorder({ db: t.db, costs: createCostEstimator(), logger: createLogger({ level: 'error' }) });

    await recorder.recordTextGeneration({ organizationId: randomUUID() }, 'chat_response', chatReport);

    const logged = lines.map((line): unknown => JSON.parse(line));
    expect(logged).toEqual([expect.objectContaining({ event: 'usage.record_failed', ...loggedCounts, costUsd: 0.00089 })]);
  });
});
