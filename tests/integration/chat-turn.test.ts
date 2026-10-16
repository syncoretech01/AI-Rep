import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@/server/agent/runtime/events';
import { TURN_DEADLINE_MS, runChatTurn, type ChatRuntimeDeps, type ChatTurnInput } from '@/server/agent/runtime/chat-turn';
import { updateRollingSummary } from '@/server/agent/runtime/summary';
import { phase1Tools } from '@/server/agent/tools/definitions';
import { createToolExecutor, type ToolExecutor } from '@/server/agent/tools/executor';
import { createToolRegistry } from '@/server/agent/tools/registry';
import { EmbeddingService } from '@/server/ai/embedding-service';
import { createProviderRegistry } from '@/server/ai/registry';
import { ModelRouter } from '@/server/ai/router';
import {
  ProviderError,
  type FinishReason,
  type ProviderErrorCode,
  type TextGenerationRequest,
  type TextModelProvider,
  type TextStreamEvent,
} from '@/server/ai/types';
import { loadAiConfig } from '@/server/config/env';
import { getAgent } from '@/server/domain/agents/repository';
import type { Agent } from '@/server/domain/agents/types';
import { replaceBusinessHours, upsertBusinessProfile } from '@/server/domain/business/repository';
import { getConversation, listMessages } from '@/server/domain/conversations/service';
import { ingestTextSource } from '@/server/domain/knowledge/ingestion';
import { DomainError } from '@/server/domain/types';
import { createCostEstimator } from '@/server/domain/usage/cost';
import { createUsageRecorder } from '@/server/domain/usage/service';
import type { LogFields, Logger } from '@/server/observability/logger';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { FakeEmbeddingProvider } from '../support/fake-embeddings';
import { createConversation, createTenant, type TenantFixture } from '../support/fixtures';
import {
  FAILURE_REPLY,
  FakeReceptionistModel,
  GREETING_REPLY,
  NO_INFORMATION_REPLY,
  NO_LEAD_CAPTURE_REPLY,
} from '../support/receptionist-model';
import { ScriptedTextProvider } from '../support/scripted-text-provider';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.close();
});

const anyString: unknown = expect.any(String);
const NOW = new Date('2026-10-06T18:05:00Z');
const KNOWLEDGE = [
  '# Emergency service',
  'We offer 24/7 emergency boiler repair across Springfield.',
  '',
  '# Pricing',
  'Our standard call-out fee is 89 dollars per visit.',
].join('\n');
const GROUNDED_QUESTION = 'Do you offer emergency boiler repair?';
const GROUNDED_FACT = 'We offer 24/7 emergency boiler repair across Springfield.';
const LEAD_MESSAGE = "I'm Jane Doe, my number is (555) 123-4567 — please call me about a quote";

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
  events(event: string): LogEntry[] {
    return this.entries.filter((entry) => entry.event === event);
  }
}

const TRANSIENT: readonly ProviderErrorCode[] = ['unavailable', 'timeout', 'rate_limited'];
/** A provider failure as the adapters report it: only outages, timeouts and rate limits are retryable. */
const outage = (code: ProviderErrorCode = 'unavailable', provider = 'cheap', extra: { status?: number; retryable?: boolean } = {}) =>
  new ProviderError({
    provider,
    code,
    retryable: extra.retryable ?? TRANSIENT.includes(code),
    status: extra.status,
    message: `${provider}: ${code}`,
  });

/** Streams like the scripted provider, except that the given calls (0-based) end with another finish reason. */
function finishingWith(inner: ScriptedTextProvider, reasons: Partial<Record<number, FinishReason>>): TextModelProvider {
  return {
    id: inner.id,
    generate: (request) => inner.generate(request),
    async *stream(request) {
      const finishReason = reasons[inner.requests.length];
      for await (const event of inner.stream(request)) {
        yield event.type === 'completed' && finishReason ? { ...event, result: { ...event.result, finishReason } } : event;
      }
    },
  };
}

const FALLBACK_REPLY =
  "Sorry, I couldn't come up with an answer to that. Could you rephrase it, or would you like me to take your details so someone can follow up?";

interface HarnessOptions {
  cheap?: TextModelProvider;
  strong?: TextModelProvider;
  env?: Record<string, string>;
  leadCapture?: boolean;
  executor?: ToolExecutor;
}

/** A real ModelRouter over fake providers, the real tool registry/executor, usage recorder and PGlite. */
async function createHarness(options: HarnessOptions = {}) {
  const ai = loadAiConfig({
    AI_TEXT_PROVIDER: 'cheap',
    AI_TEXT_MODEL: 'cheap-model',
    AI_ESCALATION_PROVIDER: 'strong',
    AI_ESCALATION_MODEL: 'strong-model',
    AI_EMBEDDING_PROVIDER: 'fake',
    AI_EMBEDDING_MODEL: 'fake-embed',
    ...options.env,
  });
  const cheap = options.cheap ?? new FakeReceptionistModel('cheap');
  const strong = options.strong ?? new FakeReceptionistModel('strong');
  const registry = createProviderRegistry({
    text: { cheap: () => cheap, strong: () => strong },
    embedding: { fake: () => new FakeEmbeddingProvider('fake') },
  });
  const router = new ModelRouter(ai, registry);
  const logger = new RecordingLogger();
  const usage = createUsageRecorder({ db: t.db, costs: createCostEstimator(ai.pricingOverrides), logger });
  const embedder = new EmbeddingService({ router, usage, logger });
  const tools = createToolRegistry(phase1Tools);
  const executor =
    options.executor ??
    createToolExecutor({
      db: t.db,
      registry: tools,
      embedder,
      retrieval: {
        maxChunks: ai.budgets.maxRetrievedChunks,
        maxTokens: ai.budgets.maxRetrievedTokens,
        minSimilarity: ai.budgets.minRetrievalSimilarity,
      },
      logger,
    });
  const deps: ChatRuntimeDeps = { db: t.db, router, tools, executor, usage, ai, logger, now: () => NOW };

  const tenant: TenantFixture = await t.service.run((sql) => createTenant(sql));
  if (options.leadCapture === false) {
    await t.db.query(`update public.agents set lead_capture = '{"enabled": false, "requiredFields": []}' where id = $1`, [
      tenant.agent.id,
    ]);
  }
  const agent = (await t.service.run((sql) => getAgent(sql, tenant.org.id, tenant.agent.id)))!;
  const conversationId = (await t.service.run((sql) => createConversation(sql, tenant.org.id, tenant.agent.id))).id;
  const events: AgentEvent[] = [];

  return {
    ai,
    deps,
    tenant,
    agent,
    conversationId,
    events,
    logger,
    cheap,
    strong,
    ingest: (text = KNOWLEDGE, title = 'Home services') =>
      ingestTextSource(t.service, embedder, {
        organizationId: tenant.org.id,
        agentId: null,
        kind: 'text',
        title,
        text,
        createdBy: tenant.owner.id,
      }),
    run: (userText: string, overrides: Partial<ChatTurnInput> = {}, emit = (event: AgentEvent) => void events.push(event)) =>
      runChatTurn(
        deps,
        { organizationId: tenant.org.id, agent, conversationId, channel: 'web_chat', userText, endUserId: 'visitor-hash', ...overrides },
        emit,
      ),
    transcript: () => t.service.run((sql) => listMessages(sql, tenant.org.id, conversationId)),
    usageRows: () =>
      t.db.query<{
        kind: string;
        purpose: string;
        provider: string;
        model: string;
        tool_calls: number;
        conversation_id: string | null;
        metadata: Record<string, unknown>;
      }>(
        `select kind, purpose, provider, model, tool_calls, conversation_id, metadata
         from public.usage_records where organization_id = $1 order by created_at, id`,
        [tenant.org.id],
      ),
  };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

/** Event types with consecutive text deltas collapsed into one entry. */
function eventTypes(events: readonly AgentEvent[]): string[] {
  return events.map((event) => event.type).filter((type, i, all) => type !== 'text.delta' || all[i - 1] !== 'text.delta');
}

function streamedText(events: readonly AgentEvent[]): string {
  return events.flatMap((event) => (event.type === 'text.delta' ? [event.delta] : [])).join('');
}

function doneEvent(events: readonly AgentEvent[]) {
  const done = events.find((event) => event.type === 'turn.done');
  if (done?.type !== 'turn.done') throw new Error('no turn.done event');
  return done;
}

const chatRows = async (h: Harness) =>
  (await h.usageRows())
    .filter((row) => row.purpose === 'chat_response')
    .sort((a, b) => Number(a.metadata.round) - Number(b.metadata.round));

const toolNames = (request: TextGenerationRequest | undefined) => request?.tools.map((tool) => tool.name);

describe('a grounded answer', () => {
  it('persists user -> tool_call -> tool_result -> assistant and emits the events in order', async () => {
    const h = await createHarness();
    await h.ingest();

    const outcome = await h.run(GROUNDED_QUESTION);

    expect(outcome).toEqual({
      status: 'completed',
      turnId: anyString,
      userMessageId: anyString,
      assistantMessageId: anyString,
      errorCode: null,
    });
    expect(eventTypes(h.events)).toEqual(['turn.start', 'tool.call', 'tool.result', 'text.delta', 'turn.done']);
    expect(h.events.every((event) => event.turnId === outcome.turnId)).toBe(true);
    expect(h.events[0]).toEqual({ type: 'turn.start', turnId: outcome.turnId, conversationId: h.conversationId });
    const [, call, result] = h.events;
    expect(call).toEqual({
      type: 'tool.call',
      turnId: outcome.turnId,
      callId: anyString,
      toolName: 'searchKnowledge',
      label: 'Searching our information',
    });
    expect(result).toEqual({
      type: 'tool.result',
      turnId: outcome.turnId,
      callId: call?.type === 'tool.call' ? call.callId : null,
      toolName: 'searchKnowledge',
      ok: true,
    });
    const done = doneEvent(h.events);
    expect(done.messageId).toBe(outcome.assistantMessageId);
    expect(done.text).toContain(GROUNDED_FACT);
    expect(streamedText(h.events)).toBe(done.text);

    const messages = await h.transcript();
    expect(messages.map((message) => message.role)).toEqual(['user', 'tool_call', 'tool_result', 'assistant']);
    const [user, toolCall, toolResult, assistant] = messages;
    expect(user).toMatchObject({ id: outcome.userMessageId, content: GROUNDED_QUESTION });
    expect(toolCall).toMatchObject({
      toolName: 'searchKnowledge',
      toolCallId: call?.type === 'tool.call' ? call.callId : null,
      data: { arguments: { query: GROUNDED_QUESTION } },
    });
    const runs = await t.db.query<{ id: string; status: string; output: unknown }>(
      'select id, status, output from public.tool_runs where conversation_id = $1',
      [h.conversationId],
    );
    expect(runs).toEqual([
      {
        id: toolResult!.toolRunId,
        status: 'succeeded',
        output: { results: [{ source: 'Home services', content: `Emergency service\n\n${GROUNDED_FACT}` }] },
      },
    ]);
    expect(toolResult).toMatchObject({ toolName: 'searchKnowledge', data: { ok: true, errorCode: null, replayed: false } });
    expect(assistant).toMatchObject({
      id: outcome.assistantMessageId,
      content: done.text,
      data: { model: 'cheap-model', tier: 'default', rounds: 2 },
    });
  });

  it('meters one usage row per model round on the default tier, plus the query embedding', async () => {
    const h = await createHarness();
    await h.ingest();
    await h.run(GROUNDED_QUESTION);

    expect(await chatRows(h)).toEqual([
      {
        kind: 'text_generation',
        purpose: 'chat_response',
        provider: 'cheap',
        model: 'cheap-model',
        tool_calls: 1,
        conversation_id: h.conversationId,
        metadata: { tier: 'default', round: 1 },
      },
      {
        kind: 'text_generation',
        purpose: 'chat_response',
        provider: 'cheap',
        model: 'cheap-model',
        tool_calls: 0,
        conversation_id: h.conversationId,
        metadata: { tier: 'default', round: 2 },
      },
    ]);
    const queries = (await h.usageRows()).filter((row) => row.purpose === 'knowledge_query');
    expect(queries).toEqual([expect.objectContaining({ kind: 'embedding', model: 'fake-embed', conversation_id: h.conversationId })]);
    expect((h.strong as FakeReceptionistModel).requests).toHaveLength(0);
  });

  it('sends a bounded, cache-friendly request with the routed settings', async () => {
    const h = await createHarness();
    await h.ingest();
    await h.run(GROUNDED_QUESTION);

    const requests = (h.cheap as FakeReceptionistModel).requests;
    expect(requests).toHaveLength(2);
    const [first, second] = requests;
    const expectedCacheKey = createHash('sha256').update(`${h.tenant.org.id}:${h.agent.id}`).digest('base64url');
    expect(first).toMatchObject({
      model: 'cheap-model',
      toolChoice: 'auto',
      maxOutputTokens: h.ai.budgets.maxOutputTokens,
      reasoningEffort: 'low',
      cacheKey: expectedCacheKey,
      endUserId: 'visitor-hash',
    });
    expect(first!.cacheKey!.length).toBeLessThanOrEqual(64);
    expect(first!.signal).toBeInstanceOf(AbortSignal);
    expect(first!.signal!.aborted).toBe(false);
    expect(toolNames(first)).toEqual(['searchKnowledge', 'getBusinessInfo', 'getBusinessHours', 'captureLead']);
    expect(first!.input).toEqual([{ type: 'message', role: 'user', content: GROUNDED_QUESTION }]);
    expect(second!.instructions).toBe(first!.instructions);
    expect(second!.input.map((item) => item.type)).toEqual(['message', 'tool_call', 'tool_result']);
    for (const name of [h.ai.text.model, h.ai.escalation.model, h.ai.embedding.model]) {
      expect(first!.instructions).not.toContain(name);
    }
    expect(TURN_DEADLINE_MS).toBe(50_000);
  });
});

describe('an unknown question', () => {
  it('gets no evidence and the reply does not invent facts', async () => {
    const h = await createHarness();
    await h.ingest();

    await h.run('Do you repair spaceships?');

    const done = doneEvent(h.events);
    expect(done.text).toBe(NO_INFORMATION_REPLY);
    for (const fact of ['24/7', '89', 'Springfield', 'boiler']) expect(done.text).not.toContain(fact);
    const [run] = await t.db.query<{ output: unknown }>('select output from public.tool_runs where conversation_id = $1', [
      h.conversationId,
    ]);
    expect(run!.output).toMatchObject({ results: [] });
    const toolResult = (h.cheap as FakeReceptionistModel).requests[1]!.input.at(-1);
    expect(toolResult).toMatchObject({ type: 'tool_result' });
    expect(toolResult?.type === 'tool_result' ? toolResult.output : '').toContain('Do not guess');
  });
});

describe('lead capture', () => {
  it('captures the lead through the tool and links the conversation to the contact', async () => {
    const h = await createHarness();

    const outcome = await h.run(LEAD_MESSAGE);

    expect(outcome.status).toBe('completed');
    expect(h.events.find((event) => event.type === 'tool.call')).toMatchObject({
      toolName: 'captureLead',
      label: 'Saving your details',
    });
    expect(doneEvent(h.events).text).toBe("Thanks Jane Doe! I've saved your details and someone will be in touch.");
    const [contact] = await t.db.query<{ id: string; name: string; phone_normalized: string }>(
      'select id, name, phone_normalized from public.contacts where organization_id = $1',
      [h.tenant.org.id],
    );
    expect(contact).toMatchObject({ name: 'Jane Doe', phone_normalized: '5551234567' });
    expect(
      await t.db.query('select contact_id, conversation_id from public.leads where organization_id = $1', [h.tenant.org.id]),
    ).toEqual([{ contact_id: contact!.id, conversation_id: h.conversationId }]);
    const [conversation] = await t.db.query<{ contact_id: string }>('select contact_id from public.conversations where id = $1', [
      h.conversationId,
    ]);
    expect(conversation!.contact_id).toBe(contact!.id);
    expect(
      await t.db.query('select action from public.audit_logs where organization_id = $1', [h.tenant.org.id]),
    ).toEqual([{ action: 'tool.captureLead' }]);

    // The same message again: the tool call is replayed, so there is still exactly one lead.
    h.events.length = 0;
    await h.run(LEAD_MESSAGE);
    expect(doneEvent(h.events).text).toContain("I've saved your details");
    const toolResults = (await h.transcript()).filter((message) => message.role === 'tool_result');
    expect(toolResults.map((message) => message.data.replayed)).toEqual([false, true]);
    expect(await t.db.query('select id from public.leads where organization_id = $1', [h.tenant.org.id])).toHaveLength(1);
  });

  it('is never offered when lead capture is disabled', async () => {
    const h = await createHarness({ leadCapture: false });

    await h.run(LEAD_MESSAGE);

    const [request] = (h.cheap as FakeReceptionistModel).requests;
    expect(toolNames(request)).toEqual(['searchKnowledge', 'getBusinessInfo', 'getBusinessHours']);
    expect(request!.instructions).not.toContain('captureLead');
    expect(doneEvent(h.events).text).toBe(NO_LEAD_CAPTURE_REPLY);
    expect(await t.db.query('select id from public.contacts where organization_id = $1', [h.tenant.org.id])).toEqual([]);
    expect(await t.db.query('select id from public.leads where organization_id = $1', [h.tenant.org.id])).toEqual([]);
  });

  it('refuses a captureLead call that was not offered, without announcing "Saving your details"', async () => {
    const cheap = new ScriptedTextProvider('cheap', [
      { toolCalls: [{ name: 'captureLead', arguments: { name: 'Jane Doe', phone: '+15551234567' } }] },
      { text: 'Please contact the business directly.' },
    ]);
    const h = await createHarness({ cheap, leadCapture: false });

    const outcome = await h.run(LEAD_MESSAGE);

    expect(outcome.status).toBe('completed');
    expect(toolNames(cheap.requests[0])).not.toContain('captureLead');
    expect(h.events.find((event) => event.type === 'tool.call')).toMatchObject({ toolName: 'captureLead', label: 'Working on it' });
    expect(h.events.find((event) => event.type === 'tool.result')).toMatchObject({ ok: false, errorCode: 'not_permitted' });
    expect(await t.db.query('select id from public.contacts where organization_id = $1', [h.tenant.org.id])).toEqual([]);
    expect(await t.db.query('select id from public.leads where organization_id = $1', [h.tenant.org.id])).toEqual([]);
  });
});

describe('business facts and follow-ups', () => {
  it('answers opening-hours questions from getBusinessHours', async () => {
    const h = await createHarness();
    await t.db.query(`update public.agents set timezone = 'America/New_York' where id = $1`, [h.agent.id]);
    const agent = (await t.service.run((sql) => getAgent(sql, h.tenant.org.id, h.agent.id)))!;
    const weekdays = [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, opensAt: '09:00', closesAt: '17:00' }));
    await t.service.run((sql) => replaceBusinessHours(sql, h.tenant.org.id, h.agent.id, weekdays));

    await h.run('Are you open right now?', { agent });

    expect(h.events.find((event) => event.type === 'tool.call')).toMatchObject({ toolName: 'getBusinessHours' });
    expect(doneEvent(h.events).text).toBe(
      "We're open right now. Our hours: Monday 09:00-17:00; Tuesday 09:00-17:00; Wednesday 09:00-17:00; Thursday 09:00-17:00; Friday 09:00-17:00.",
    );
    expect((h.cheap as FakeReceptionistModel).requests[0]!.instructions).toContain('Tuesday 14:05 (America/New_York)');
  });

  it('answers contact questions from getBusinessInfo', async () => {
    const h = await createHarness();
    await t.service.run((sql) =>
      upsertBusinessProfile(sql, h.tenant.org.id, h.agent.id, {
        businessName: 'Springfield Heating',
        description: null,
        phone: '+1 555 010 0100',
        email: null,
        website: null,
        address: null,
        serviceArea: null,
      }),
    );

    await h.run("What's your phone number?");

    expect(h.events.find((event) => event.type === 'tool.call')).toMatchObject({ toolName: 'getBusinessInfo' });
    expect(doneEvent(h.events).text).toBe('Here are our details: businessName: Springfield Heating, phone: +1 555 010 0100.');
    expect((h.cheap as FakeReceptionistModel).requests[0]!.instructions).toContain('Name: Springfield Heating');
  });

  it('asks for the missing lead details instead of claiming they were saved', async () => {
    const h = await createHarness();

    await h.run('You can email me at jane@example.com');

    expect(h.events.find((event) => event.type === 'tool.result')).toMatchObject({
      toolName: 'captureLead',
      ok: false,
      errorCode: 'missing_information',
    });
    const text = doneEvent(h.events).text;
    expect(text).toBe('Could you please share your name and phone number?');
    expect(text).not.toContain('saved');
    expect(await t.db.query('select id from public.leads where organization_id = $1', [h.tenant.org.id])).toEqual([]);
  });
});

describe('escalation', () => {
  it('retries a round on the escalation provider when the default provider fails before streaming', async () => {
    const cheap = new ScriptedTextProvider('cheap', () => ({ error: outage('unavailable') }));
    const h = await createHarness({ cheap });
    await h.ingest();

    const outcome = await h.run(GROUNDED_QUESTION);

    expect(outcome.status).toBe('completed');
    expect(doneEvent(h.events).text).toContain(GROUNDED_FACT);
    expect(cheap.requests).toHaveLength(1);
    const strongRequests = (h.strong as FakeReceptionistModel).requests;
    expect(strongRequests.map((request) => [request.model, request.reasoningEffort])).toEqual([
      ['strong-model', 'medium'],
      ['strong-model', 'medium'],
    ]);
    expect((await chatRows(h)).map((row) => [row.provider, row.model, row.metadata])).toEqual([
      ['strong', 'strong-model', { tier: 'escalation', round: 1 }],
      ['strong', 'strong-model', { tier: 'escalation', round: 2 }],
    ]);
    const assistant = (await h.transcript()).at(-1);
    expect(assistant).toMatchObject({ role: 'assistant', data: { model: 'strong-model', tier: 'escalation', rounds: 2 } });
    expect(h.logger.events('agent.turn.escalated')).toEqual([
      {
        level: 'warn',
        event: 'agent.turn.escalated',
        fields: { tier: 'escalation', reason: 'escalation:prior_failure', trigger: 'provider_error', errorCode: 'unavailable' },
      },
    ]);
  });

  it('escalates transient failures (timeouts and rate limits, like outages), never content filters or aborts', async () => {
    for (const code of ['timeout', 'rate_limited'] as const) {
      const h = await createHarness({ cheap: new ScriptedTextProvider('cheap', () => ({ error: outage(code) })) });
      expect((await h.run('Hello there')).status, code).toBe('completed');
      expect((h.strong as FakeReceptionistModel).requests, code).toHaveLength(1);
      expect(h.logger.events('agent.default_model.rejected'), code).toEqual([]);
    }
    for (const code of ['content_filter', 'aborted'] as const) {
      const h = await createHarness({ cheap: new ScriptedTextProvider('cheap', () => ({ error: outage(code) })) });
      const outcome = await h.run('Hello there');
      expect(outcome, code).toMatchObject({ status: 'failed', errorCode: 'provider_unavailable' });
      expect((h.strong as FakeReceptionistModel).requests, code).toHaveLength(0);
      expect((await h.transcript()).at(-1), code).toMatchObject({ role: 'system', data: { code } });
      expect(h.logger.events('agent.default_model.rejected'), code).toEqual([]);
    }
  });

  it('never escalates a request the default model rejects: the turn fails and the rejection is logged as an error', async () => {
    // A mistyped or retired model (404), an unsupported setting (400), credentials (401), an exhausted quota (429)
    // or an unexpected response: configuration to fix, not a reason to serve every turn from the premium model.
    const rejections = [
      outage('invalid_request', 'cheap', { status: 404 }),
      outage('invalid_request', 'cheap', { status: 400 }),
      outage('auth', 'cheap', { status: 401 }),
      outage('rate_limited', 'cheap', { status: 429, retryable: false }),
      outage('unknown', 'cheap', { status: 418 }),
    ];
    for (const rejection of rejections) {
      const label = `${rejection.code} ${String(rejection.status)}`;
      const h = await createHarness({ cheap: new ScriptedTextProvider('cheap', () => ({ error: rejection })) });

      const outcome = await h.run('Hello there');

      expect(outcome, label).toMatchObject({ status: 'failed', errorCode: 'provider_unavailable', assistantMessageId: null });
      expect(h.events.at(-1), label).toMatchObject({ type: 'turn.error', code: 'provider_unavailable', recoverable: true });
      expect((h.strong as FakeReceptionistModel).requests, label).toHaveLength(0);
      expect(h.logger.events('agent.turn.escalated'), label).toEqual([]);
      expect(h.logger.events('agent.default_model.rejected'), label).toEqual([
        {
          level: 'error',
          event: 'agent.default_model.rejected',
          fields: { provider: 'cheap', model: 'cheap-model', code: rejection.code, status: rejection.status },
        },
      ]);
      expect((await h.transcript()).at(-1), label).toMatchObject({ role: 'system', data: { code: rejection.code } });
    }
  });

  it('does not escalate when escalation is disabled', async () => {
    const h = await createHarness({
      cheap: new ScriptedTextProvider('cheap', () => ({ error: outage() })),
      env: { AI_ESCALATION_ENABLED: 'false' },
    });
    expect(await h.run('Hello there')).toMatchObject({ status: 'failed', errorCode: 'provider_unavailable' });
    expect((h.strong as FakeReceptionistModel).requests).toHaveLength(0);
  });

  it('does not retry a round whose text was already streamed to the visitor', async () => {
    const cheap: TextModelProvider = {
      id: 'cheap',
      generate: () => Promise.reject(new Error('not used')),
      async *stream(): AsyncGenerator<TextStreamEvent, void, undefined> {
        yield { type: 'text.delta', delta: 'Let me' };
        throw outage('unavailable');
      },
    };
    const h = await createHarness({ cheap });

    const outcome = await h.run('Hello there');

    expect(outcome).toMatchObject({ status: 'failed', errorCode: 'provider_unavailable' });
    expect((h.strong as FakeReceptionistModel).requests).toHaveLength(0);
    expect(eventTypes(h.events)).toEqual(['turn.start', 'text.delta', 'turn.error']);
  });

  it('switches later rounds to the escalation profile after two rejected tool calls', async () => {
    const cheap = new ScriptedTextProvider('cheap', [
      {
        toolCalls: [
          { name: 'captureLead', arguments: { phone: 'not a number' } },
          { name: 'captureLead', arguments: '{"email": ' },
        ],
      },
    ]);
    const h = await createHarness({ cheap });

    const outcome = await h.run('Please call me back');

    expect(outcome.status).toBe('completed');
    expect(h.events.filter((event) => event.type === 'tool.result')).toEqual([
      expect.objectContaining({ ok: false, errorCode: 'invalid_arguments' }),
      expect.objectContaining({ ok: false, errorCode: 'invalid_arguments' }),
    ]);
    expect(cheap.requests).toHaveLength(1);
    expect((h.strong as FakeReceptionistModel).requests).toHaveLength(1);
    expect(doneEvent(h.events).text).toBe(FAILURE_REPLY);
    expect((await chatRows(h)).map((row) => row.metadata)).toEqual([
      { tier: 'default', round: 1 },
      { tier: 'escalation', round: 2 },
    ]);
    expect(h.logger.events('agent.turn.escalated')[0]?.fields).toMatchObject({ trigger: 'invalid_arguments' });
  });
});

describe('provider failure', () => {
  it('reports the failure, leaves a system marker and lets a retry reuse the unanswered message', async () => {
    let down = true;
    const failing = (provider: string) =>
      new ScriptedTextProvider(provider, () => (down ? { error: outage('unavailable', provider) } : { text: 'Back online!' }));
    const h = await createHarness({ cheap: failing('cheap'), strong: failing('strong') });

    const failed = await h.run('Hello there');

    expect(failed).toEqual({
      status: 'failed',
      turnId: anyString,
      userMessageId: anyString,
      assistantMessageId: null,
      errorCode: 'provider_unavailable',
    });
    expect(h.events).toEqual([
      { type: 'turn.start', turnId: failed.turnId, conversationId: h.conversationId },
      {
        type: 'turn.error',
        turnId: failed.turnId,
        code: 'provider_unavailable',
        message: "I'm having trouble responding right now. Please try again in a moment.",
        recoverable: true,
      },
    ]);
    expect((await h.transcript()).map((message) => [message.role, message.content, message.data])).toEqual([
      ['user', 'Hello there', {}],
      ['system', 'assistant_unavailable', { code: 'unavailable' }],
    ]);
    expect(await chatRows(h)).toEqual([]);
    expect(h.logger.events('agent.turn.provider_failed')).toHaveLength(1);

    // The widget's Retry resends the same text: the unanswered message is reused, not duplicated.
    down = false;
    const retried = await h.run('Hello there');
    expect(retried).toMatchObject({ status: 'completed', userMessageId: failed.userMessageId });
    expect((await h.transcript()).map((message) => message.role)).toEqual(['user', 'system', 'assistant']);

    // Once answered, the same text again is a new message.
    const again = await h.run('Hello there');
    expect(again.userMessageId).not.toBe(failed.userMessageId);
    expect((await h.transcript()).map((message) => message.role)).toEqual(['user', 'system', 'assistant', 'user', 'assistant']);
  });

  it('treats a server-side cancellation as a provider failure', async () => {
    const h = await createHarness();
    const controller = new AbortController();
    controller.abort();

    const outcome = await h.run('Hello there', { signal: controller.signal });

    expect(outcome).toMatchObject({ status: 'failed', errorCode: 'provider_unavailable' });
    expect((h.cheap as FakeReceptionistModel).requests[0]?.signal?.aborted).toBe(true);
    expect((h.strong as FakeReceptionistModel).requests).toHaveLength(0);
    expect((await h.transcript()).at(-1)).toMatchObject({ role: 'system', data: { code: 'cancelled' } });
  });

  it('ends the turn as a provider failure once the turn deadline passes, without escalating', async () => {
    // Stands in for AbortSignal.timeout(TURN_DEADLINE_MS) so the test decides when the deadline passes.
    const deadline = new AbortController();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((ms) => (ms === TURN_DEADLINE_MS ? deadline.signal : timeout(ms)));
    try {
      // The deadline passes while the model is working; the call then fails with a code that would otherwise escalate.
      const cheap = new ScriptedTextProvider('cheap', () => {
        deadline.abort(new DOMException('The operation timed out.', 'TimeoutError'));
        return { error: outage('timeout') };
      });
      const h = await createHarness({ cheap });

      const outcome = await h.run('Hello there');

      expect(outcome).toMatchObject({ status: 'failed', errorCode: 'provider_unavailable', assistantMessageId: null });
      expect(cheap.requests).toHaveLength(1);
      expect(cheap.requests[0]!.signal?.aborted).toBe(true);
      expect((h.strong as FakeReceptionistModel).requests).toHaveLength(0);
      expect(h.logger.events('agent.turn.escalated')).toEqual([]);
      expect(eventTypes(h.events)).toEqual(['turn.start', 'turn.error']);
      expect(h.events.at(-1)).toMatchObject({ type: 'turn.error', code: 'provider_unavailable', recoverable: true });
      expect((await h.transcript()).map((message) => [message.role, message.data])).toEqual([
        ['user', {}],
        ['system', { code: 'deadline' }],
      ]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('model rounds', () => {
  it('caps tool rounds: the final round keeps the tools but forces a text answer', async () => {
    const cheap = new ScriptedTextProvider('cheap', (request) => ({
      text: request.toolChoice === 'none' ? 'Here is what I know.' : '',
      // A model that ignores the cap keeps asking for tools.
      toolCalls: [{ name: 'getBusinessHours', arguments: {} }],
    }));
    const h = await createHarness({ cheap, env: { AI_MAX_TOOL_ROUNDS: '2' } });

    const outcome = await h.run('When are you open?');

    expect(outcome.status).toBe('completed');
    expect(cheap.requests.map((request) => request.toolChoice)).toEqual(['auto', 'none']);
    expect(toolNames(cheap.requests[1])).toEqual(toolNames(cheap.requests[0]));
    expect(cheap.requests[1]!.input.map((item) => item.type)).toEqual(['message', 'tool_call', 'tool_result']);
    // Only the first round's call ran.
    expect(await t.db.query('select id from public.tool_runs where conversation_id = $1', [h.conversationId])).toHaveLength(1);
    expect(doneEvent(h.events).text).toBe('Here is what I know.');
    expect((await h.transcript()).at(-1)).toMatchObject({ data: { rounds: 2 } });
  });

  it('falls back to a safe reply when the model produces no text', async () => {
    const cheap = new ScriptedTextProvider('cheap', () => ({ text: '  ', toolCalls: [{ name: 'getBusinessHours', arguments: {} }] }));
    const h = await createHarness({ cheap, env: { AI_MAX_TOOL_ROUNDS: '1' } });

    await h.run('When are you open?');

    expect(cheap.requests.map((request) => request.toolChoice)).toEqual(['none']);
    expect(doneEvent(h.events).text).toBe(FALLBACK_REPLY);
    expect((await h.transcript()).at(-1)).toMatchObject({
      role: 'assistant',
      content: FALLBACK_REPLY,
      data: { fallback: true, rounds: 1 },
    });
  });

  it('completes a preamble whose final round wrote nothing with the fallback', async () => {
    const cheap = new ScriptedTextProvider('cheap', [
      { text: 'Let me check our hours.', toolCalls: [{ name: 'getBusinessHours', arguments: {} }] },
      { text: '' },
    ]);
    const h = await createHarness({ cheap });

    await h.run('When are you open?');

    const text = `Let me check our hours.\n\n${FALLBACK_REPLY}`;
    expect(doneEvent(h.events).text).toBe(text);
    expect((await h.transcript()).at(-1)).toMatchObject({ role: 'assistant', content: text, data: { fallback: true, rounds: 2 } });
  });

  it('completes a final answer cut off by the output cap or a content filter with the fallback', async () => {
    for (const finishReason of ['length', 'content_filter'] as const) {
      const scripted = new ScriptedTextProvider('cheap', [
        { text: 'Let me check.', toolCalls: [{ name: 'getBusinessHours', arguments: {} }] },
        { text: 'We are open from' },
      ]);
      const h = await createHarness({ cheap: finishingWith(scripted, { 1: finishReason }) });

      await h.run('When are you open?');

      const text = `Let me check.\n\nWe are open from\n\n${FALLBACK_REPLY}`;
      expect(doneEvent(h.events).text, finishReason).toBe(text);
      expect((await h.transcript()).at(-1), finishReason).toMatchObject({ content: text, data: { fallback: true, rounds: 2 } });
    }
  });

  it('never offers to take the details in the fallback when lead capture is off', async () => {
    const h = await createHarness({ cheap: new ScriptedTextProvider('cheap', [{ text: '' }]), leadCapture: false });

    await h.run('Hello there');

    const text = doneEvent(h.events).text;
    expect(text).toBe("Sorry, I couldn't come up with an answer to that. Could you rephrase it? You can also contact the business directly.");
    expect(text).not.toContain('details');
    expect((await h.transcript()).at(-1)).toMatchObject({ content: text, data: { fallback: true } });
  });

  it('acknowledges the details saved in this turn when the model does not, instead of offering to take them again', async () => {
    const cheap = new ScriptedTextProvider('cheap', [
      { toolCalls: [{ name: 'captureLead', arguments: { name: 'Jane Doe', phone: '(555) 123-4567', summary: 'Boiler quote' } }] },
      { text: '' },
    ]);
    const h = await createHarness({ cheap });

    await h.run(LEAD_MESSAGE);

    expect(h.events.find((event) => event.type === 'tool.result')).toMatchObject({ toolName: 'captureLead', ok: true });
    const text = doneEvent(h.events).text;
    expect(text).toBe('Thanks, your details have been saved and someone will follow up with you.');
    expect((await h.transcript()).at(-1)).toMatchObject({ content: text, data: { fallback: true, rounds: 2 } });
    expect(await t.db.query('select id from public.leads where organization_id = $1', [h.tenant.org.id])).toHaveLength(1);
  });

  it('leaves text written next to a write tool call out of the reply: only text after the outcome reports it', async () => {
    // The model claims success before captureLead has run, and the call then fails (no phone number).
    const claim = "Thanks Jane, I've saved your details!";
    const cheap = new ScriptedTextProvider('cheap', [
      { text: claim, toolCalls: [{ name: 'captureLead', arguments: { name: 'Jane' } }] },
      { text: 'Could I have your phone number?' },
    ]);
    const h = await createHarness({ cheap });

    await h.run("I'm Jane, please call me back");

    expect(h.events.find((event) => event.type === 'tool.result')).toMatchObject({ ok: false, errorCode: 'missing_information' });
    // Streamed while the tool ran, then replaced by the final reply (the widget shows turn.done's text).
    expect(streamedText(h.events)).toContain(claim);
    expect(doneEvent(h.events).text).toBe('Could I have your phone number?');
    const assistant = (await h.transcript()).at(-1);
    expect(assistant).toMatchObject({ role: 'assistant', content: 'Could I have your phone number?', data: { rounds: 2 } });
    expect(assistant?.data.fallback).toBeUndefined();
    expect(await t.db.query('select id from public.leads where organization_id = $1', [h.tenant.org.id])).toEqual([]);
  });

  it('joins the text of several rounds and separates them in the stream', async () => {
    const cheap = new ScriptedTextProvider('cheap', [
      { text: 'Let me check.', toolCalls: [{ name: 'getBusinessHours', arguments: {} }] },
      { text: 'We are open 9 to 5.' },
    ]);
    const h = await createHarness({ cheap });

    await h.run('When are you open?');

    expect(streamedText(h.events)).toBe('Let me check.\n\nWe are open 9 to 5.');
    expect(doneEvent(h.events).text).toBe('Let me check.\n\nWe are open 9 to 5.');
    expect(eventTypes(h.events)).toEqual(['turn.start', 'text.delta', 'tool.call', 'tool.result', 'text.delta', 'turn.done']);
  });

  it('never sends earlier tool payloads into later turns', async () => {
    const h = await createHarness();
    await h.ingest();
    await h.run(GROUNDED_QUESTION);
    const firstAnswer = doneEvent(h.events).text;

    await h.run('Thanks, that helps!');

    const requests = (h.cheap as FakeReceptionistModel).requests;
    expect(requests.at(-1)!.input).toEqual([
      { type: 'message', role: 'user', content: GROUNDED_QUESTION },
      { type: 'message', role: 'assistant', content: firstAnswer },
      { type: 'message', role: 'user', content: 'Thanks, that helps!' },
    ]);
    expect(doneEvent(h.events.slice(h.events.findIndex((event, i) => i > 0 && event.type === 'turn.start'))).text).toBe(
      GREETING_REPLY,
    );
  });
});

describe('conversation memory', () => {
  const isSummaryRequest = (request: TextGenerationRequest): boolean =>
    request.input[0]?.type === 'message' && request.input[0].content.startsWith('Previous summary:');

  /**
   * One visitor message per turn, each turn followed by the post-turn rolling summary as the web chat channel runs
   * it (unless `skipSummaryAfter(turn)`). Checks that every turn's model request carries each earlier message
   * verbatim or folded into the summary it carries. Returns the window and the most messages one request carried.
   */
  async function converse(
    turns: number,
    options: { env?: Record<string, string>; skipSummaryAfter?: (turn: number) => boolean } = {},
  ): Promise<{ window: number; most: number }> {
    // A distinct reply to every message, and a distinct summary per summary request.
    const cheap = new ScriptedTextProvider('cheap', (request, index) => {
      if (isSummaryRequest(request)) return { text: `Summary number ${index}.` };
      const last = request.input.at(-1);
      return { text: `Reply to "${last?.type === 'message' ? last.content : ''}"` };
    });
    const h = await createHarness({ cheap, env: options.env });
    const { db, router, usage, ai, logger } = h.deps;
    const ids = { organizationId: h.tenant.org.id, agentId: h.agent.id, conversationId: h.conversationId };
    /** Messages the summarizer was given, i.e. covered by the summary once summary_through_seq reaches them. */
    const folded = new Set<string>();
    let most = 0;

    for (let turn = 1; turn <= turns; turn += 1) {
      const conversation = await t.service.run((sql) => getConversation(sql, ids.organizationId, ids.conversationId));
      const { summary, summaryThroughSeq } = conversation!;
      const sent = cheap.requests.length;

      await h.run(`Visitor message ${turn}`);

      const request = cheap.requests[sent]!;
      const verbatim = request.input.flatMap((item) => (item.type === 'message' ? [item.content] : []));
      const earlier = (await h.transcript()).filter((m) => m.role === 'user' || m.role === 'assistant').slice(0, -2);
      const missing = earlier.filter(
        (message) => !verbatim.includes(message.content) && !(message.seq <= summaryThroughSeq && folded.has(message.content)),
      );
      expect(missing.map((message) => message.content), `turn ${turn}`).toEqual([]);
      if (summaryThroughSeq > 0) expect(request.instructions, `turn ${turn}`).toContain(summary);
      expect(verbatim.at(-1), `turn ${turn}`).toBe(`Visitor message ${turn}`);
      most = Math.max(most, verbatim.length);
      if (options.skipSummaryAfter?.(turn)) continue;

      // The post-turn rolling summary, as the web chat channel runs it.
      const before = cheap.requests.length;
      await updateRollingSummary({ db, router, usage, ai, logger }, { ...ids, channel: 'web_chat' });
      for (const summaryRequest of cheap.requests.slice(before).filter(isSummaryRequest)) {
        const input = summaryRequest.input[0];
        for (const line of (input?.type === 'message' ? input.content : '').split('\n')) {
          const speaker = ['Visitor: ', 'Assistant: '].find((prefix) => line.startsWith(prefix));
          if (speaker) folded.add(line.slice(speaker.length));
        }
      }
    }
    expect(folded.size).toBeGreaterThan(0);
    expect(h.logger.events('agent.summary.failed')).toEqual([]);
    expect(h.logger.events('agent.summary.unusable')).toEqual([]);
    return { window: h.ai.budgets.maxRecentMessages, most };
  }

  it('gives the model every earlier message, verbatim or in the rolling summary, at the default window', async () => {
    const { window, most } = await converse(24);
    expect(window).toBe(12);
    // Never the whole transcript: the recent window plus less than one summary batch.
    expect(most).toBeLessThanOrEqual(window + 3);
  });

  it('still does when a post-turn summary is skipped: a turn loads enough history to bridge one missed run', async () => {
    // The web chat channel skips post-turn work late in the request budget, and the next run catches up. A turn
    // loads the window plus MIN_OVERFLOW_MESSAGES (4) unsummarized messages, and the summary folds against the next
    // turn's window (window - 1): together they bridge one missed run, at an even or an odd window.
    const everyOther = (turn: number) => turn % 2 === 0;
    // At 12, turn 9 follows a skipped run that had a fold due: it carries the whole cap and the visitor's message.
    expect(await converse(24, { skipSummaryAfter: everyOther })).toEqual({ window: 12, most: 12 + 4 + 1 });
    const odd = await converse(24, { env: { AI_MAX_RECENT_MESSAGES: '11' }, skipSummaryAfter: everyOther });
    expect(odd.window).toBe(11);
    expect(odd.most).toBeLessThanOrEqual(11 + 4 + 1);
  });
});

describe('robustness', () => {
  it('completes and persists the turn even when the event sink throws (client gone)', async () => {
    const h = await createHarness();
    const outcome = await h.run('Hello there', {}, () => {
      throw new Error('stream closed');
    });
    expect(outcome.status).toBe('completed');
    expect((await h.transcript()).map((message) => [message.role, message.content])).toEqual([
      ['user', 'Hello there'],
      ['assistant', GREETING_REPLY],
    ]);
  });

  it('reports an internal error without throwing after the turn started', async () => {
    const executor: ToolExecutor = { execute: () => Promise.reject(new Error('executor bug')) };
    const cheap = new ScriptedTextProvider('cheap', [{ toolCalls: [{ name: 'getBusinessHours', arguments: {} }] }]);
    const h = await createHarness({ cheap, executor });

    const outcome = await h.run('When are you open?');

    expect(outcome).toMatchObject({ status: 'failed', errorCode: 'internal', assistantMessageId: null });
    expect(h.events.at(-1)).toEqual({
      type: 'turn.error',
      turnId: outcome.turnId,
      code: 'internal',
      message: 'Something went wrong. Please try again.',
      recoverable: true,
    });
    expect((await h.transcript()).at(-1)).toMatchObject({ role: 'system', data: { code: 'internal' } });
    expect(h.logger.events('agent.turn.failed')).toHaveLength(1);
  });

  it('refuses conversations that are not active for this organization and agent, before anything happens', async () => {
    const h = await createHarness();
    const other = await createHarness();
    const closed = (await t.service.run((sql) => createConversation(sql, h.tenant.org.id, h.tenant.agent.id, { status: 'closed' }))).id;
    const foreignAgent: Agent = other.agent;

    const attempts: Array<Partial<ChatTurnInput>> = [
      { conversationId: other.conversationId },
      { conversationId: closed },
      { conversationId: 'not-a-uuid' },
      { agent: foreignAgent },
      { agent: { ...foreignAgent, organizationId: h.tenant.org.id }, conversationId: h.conversationId },
    ];
    for (const overrides of attempts) {
      const attempt = h.run('Hello there', overrides);
      await expect(attempt).rejects.toBeInstanceOf(DomainError);
      await expect(attempt).rejects.toMatchObject({ code: 'not_found' });
    }
    await expect(h.run('   ')).rejects.toMatchObject({ code: 'invalid' });

    expect(h.events).toEqual([]);
    expect(await h.transcript()).toEqual([]);
    expect(await other.transcript()).toEqual([]);
    expect(await t.service.run((sql) => listMessages(sql, h.tenant.org.id, closed))).toEqual([]);
  });
});
