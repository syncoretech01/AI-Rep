import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { updateRollingSummary, type SummaryDeps } from '@/server/agent/runtime/summary';
import { createProviderRegistry } from '@/server/ai/registry';
import { ModelRouter } from '@/server/ai/router';
import { ProviderError, type FinishReason, type TextModelProvider } from '@/server/ai/types';
import { loadAiConfig } from '@/server/config/env';
import type { Database } from '@/server/db/types';
import { appendMessage, getConversation } from '@/server/domain/conversations/service';
import type { Message, MessageRole } from '@/server/domain/conversations/types';
import { createCostEstimator } from '@/server/domain/usage/cost';
import { createUsageRecorder } from '@/server/domain/usage/service';
import type { LogFields, Logger } from '@/server/observability/logger';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { FakeEmbeddingProvider } from '../support/fake-embeddings';
import { createConversation, createTenant, type TenantFixture } from '../support/fixtures';
import { ScriptedTextProvider, type Script } from '../support/scripted-text-provider';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.close();
});

/**
 * Recent window of 4 user/assistant messages. The next turn adds the visitor's message to the newest 3, so the
 * overflow threshold (4) is reached at 7 messages.
 */
const WINDOW = 4;

class RecordingLogger implements Logger {
  readonly entries: Array<{ level: string; event: string; fields: LogFields }> = [];
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

/** Answers like the scripted provider, except that the given calls (0-based) end with another finish reason. */
function finishingWith(inner: ScriptedTextProvider, reasons: Partial<Record<number, FinishReason>>): TextModelProvider {
  return {
    id: inner.id,
    async generate(request) {
      const finishReason = reasons[inner.requests.length];
      const result = await inner.generate(request);
      return finishReason ? { ...result, finishReason } : result;
    },
    stream: (request) => inner.stream(request),
  };
}

async function createHarness(
  options: { script?: Script; db?: Database; finishReasons?: Partial<Record<number, FinishReason>>; window?: number } = {},
) {
  const ai = loadAiConfig({
    AI_TEXT_PROVIDER: 'cheap',
    AI_TEXT_MODEL: 'cheap-model',
    AI_ESCALATION_PROVIDER: 'strong',
    AI_ESCALATION_MODEL: 'strong-model',
    AI_EMBEDDING_PROVIDER: 'fake',
    AI_MAX_RECENT_MESSAGES: String(options.window ?? WINDOW),
  });
  const cheap = new ScriptedTextProvider('cheap', options.script ?? ((_request, index) => ({ text: `  Summary ${index + 1}.  ` })));
  const strong = new ScriptedTextProvider('strong', []);
  const served = finishingWith(cheap, options.finishReasons ?? {});
  const providers: Record<string, () => TextModelProvider> = { cheap: () => served, strong: () => strong };
  const router = new ModelRouter(
    ai,
    createProviderRegistry({ text: providers, embedding: { fake: () => new FakeEmbeddingProvider('fake') } }),
  );
  const logger = new RecordingLogger();
  const usage = createUsageRecorder({ db: t.db, costs: createCostEstimator(), logger });
  const deps: SummaryDeps = { db: options.db ?? t.db, router, usage, ai, logger };
  const tenant: TenantFixture = await t.service.run((sql) => createTenant(sql));
  const conversationId = (await t.service.run((sql) => createConversation(sql, tenant.org.id, tenant.agent.id))).id;
  const params = { organizationId: tenant.org.id, agentId: tenant.agent.id, conversationId, channel: 'web_chat' as const };

  return {
    deps,
    tenant,
    conversationId,
    params,
    cheap,
    strong,
    logger,
    update: (overrides: Partial<typeof params> & { signal?: AbortSignal } = {}) =>
      updateRollingSummary(deps, { ...params, ...overrides }),
    append: (role: MessageRole, content: string, extra: { toolName?: string } = {}) =>
      t.service.run((sql) => appendMessage(sql, tenant.org.id, conversationId, { role, content, ...extra })),
    /** Alternating visitor/assistant messages "message <n>". */
    async chat(from: number, to: number): Promise<Message[]> {
      const messages: Message[] = [];
      for (let n = from; n <= to; n += 1) messages.push(await this.append(n % 2 === 1 ? 'user' : 'assistant', `message ${n}`));
      return messages;
    },
    state: async () => {
      const conversation = await t.service.run((sql) => getConversation(sql, tenant.org.id, conversationId));
      return { summary: conversation?.summary, throughSeq: conversation?.summaryThroughSeq };
    },
    usageRows: () =>
      t.db.query<{ purpose: string; provider: string; model: string; metadata: unknown; conversation_id: string }>(
        `select purpose, provider, model, metadata, conversation_id from public.usage_records where organization_id = $1`,
        [tenant.org.id],
      ),
  };
}

const lastInput = (provider: ScriptedTextProvider) => {
  const item = provider.requests.at(-1)?.input[0];
  return item?.type === 'message' ? item.content : '';
};

describe('updateRollingSummary', () => {
  it("does nothing while fewer than 4 messages fall outside the next turn's window", async () => {
    const h = await createHarness();
    await h.chat(1, 6);

    expect(await h.update()).toEqual({ updated: false });
    expect(h.cheap.requests).toHaveLength(0);
    expect(await h.state()).toEqual({ summary: '', throughSeq: 0 });
  });

  it('skips the billed call when the caller budget has already run out', async () => {
    const h = await createHarness();
    await h.chat(1, 8);
    const budget = new AbortController();
    budget.abort();

    expect(await h.update({ signal: budget.signal })).toEqual({ updated: false });
    expect(h.cheap.requests).toHaveLength(0);
    expect(await h.usageRows()).toEqual([]);
    expect(await h.state()).toEqual({ summary: '', throughSeq: 0 });
  });

  it('bounds the provider call by the caller budget', async () => {
    const h = await createHarness();
    await h.chat(1, 8);
    const budget = new AbortController();

    expect(await h.update({ signal: budget.signal })).toEqual({ updated: true });
    const signal = h.cheap.requests[0]?.signal;
    expect(signal?.aborted).toBe(false);
    budget.abort();
    expect(signal?.aborted).toBe(true);
  });

  it('folds the overflow into the summary on the default tier and meters it', async () => {
    const h = await createHarness();
    const early = await h.chat(1, 2);
    await h.append('tool_call', '', { toolName: 'searchKnowledge' });
    await h.append('tool_result', '', { toolName: 'searchKnowledge' });
    await h.append('system', 'assistant_unavailable');
    const rest = await h.chat(3, 8);

    expect(await h.update()).toEqual({ updated: true });

    expect(h.cheap.requests).toHaveLength(1);
    expect(h.strong.requests).toHaveLength(0);
    const [request] = h.cheap.requests;
    // The cap leaves room for reasoning (counted in output tokens) next to a 120-word summary.
    expect(request).toMatchObject({ model: 'cheap-model', tools: [], maxOutputTokens: 800, reasoningEffort: 'low' });
    expect(request!.instructions).toContain('at most 120 words');
    expect(request!.instructions).toContain('no speculation');
    expect(lastInput(h.cheap)).toBe(
      'Previous summary:\n(none)\n\nNew messages:\nVisitor: message 1\nAssistant: message 2\nVisitor: message 3\nAssistant: message 4\nVisitor: message 5',
    );
    // Messages 6-8 stay unsummarized: the next turn sends them verbatim, with the visitor's new message (a window of 4).
    expect(await h.state()).toEqual({ summary: 'Summary 1.', throughSeq: rest[2]!.seq });
    expect(early).toHaveLength(2);
    expect(await h.usageRows()).toEqual([
      {
        purpose: 'conversation_summary',
        provider: 'cheap',
        model: 'cheap-model',
        metadata: { tier: 'default' },
        conversation_id: h.conversationId,
      },
    ]);
  });

  it('only moves forward: nothing new to fold is a no-op, new overflow builds on the previous summary', async () => {
    const h = await createHarness();
    const first = await h.chat(1, 8);
    await h.update();
    const afterFirst = await h.state();
    expect(afterFirst).toEqual({ summary: 'Summary 1.', throughSeq: first[4]!.seq });

    expect(await h.update()).toEqual({ updated: false });
    expect(h.cheap.requests).toHaveLength(1);

    const second = await h.chat(9, 12);
    expect(await h.update()).toEqual({ updated: true });
    expect(lastInput(h.cheap)).toBe(
      'Previous summary:\nSummary 1.\n\nNew messages:\nAssistant: message 6\nVisitor: message 7\nAssistant: message 8\nVisitor: message 9',
    );
    const afterSecond = await h.state();
    expect(afterSecond).toEqual({ summary: 'Summary 2.', throughSeq: second[0]!.seq });
    expect(afterSecond.throughSeq).toBeGreaterThan(afterFirst.throughSeq!);
    expect(second).toHaveLength(4);
  });

  it('folds a long backlog oldest first, in bounded batches', async () => {
    const h = await createHarness();
    const messages = await h.chat(1, 40);

    expect(await h.update()).toEqual({ updated: true });
    const firstBatch = lastInput(h.cheap);
    expect(firstBatch).toContain('Visitor: message 1\n');
    expect(firstBatch).toContain('Assistant: message 24');
    expect(firstBatch).not.toContain('message 25');
    expect((await h.state()).throughSeq).toBe(messages[23]!.seq);

    expect(await h.update()).toEqual({ updated: true });
    const secondBatch = lastInput(h.cheap);
    expect(secondBatch.startsWith('Previous summary:\nSummary 1.\n\nNew messages:\nVisitor: message 25\n')).toBe(true);
    expect(secondBatch.endsWith('Visitor: message 37')).toBe(true);
    expect((await h.state()).throughSeq).toBe(messages[36]!.seq);
  });

  it('folds long messages sooner: the next turn keeps only what fits its history token budget', async () => {
    const h = await createHarness({ window: 12 });
    // 500 tokens each as the model receives them (truncated to 2000 characters): the 3000-token history budget
    // holds 6 of them, fewer than the 11 the window would.
    const messages: Message[] = [];
    for (let n = 1; n <= 10; n += 1) {
      messages.push(await h.append(n % 2 === 1 ? 'user' : 'assistant', `message ${n} ${'x'.repeat(5000)}`));
    }

    expect(await h.update()).toEqual({ updated: true });
    const folded = lastInput(h.cheap)
      .split('\n')
      .filter((line) => line.startsWith('Visitor: ') || line.startsWith('Assistant: '));
    expect(folded).toHaveLength(4);
    expect((await h.state()).throughSeq).toBe(messages[3]!.seq);
  });

  it('does not store a summary that was cut off, and retries the batch on the next run', async () => {
    for (const finishReason of ['length', 'content_filter'] as const) {
      const h = await createHarness({
        script: (_request, index) => ({ text: index === 0 ? 'Jane asked to be called back at' : 'Jane asked for a callback.' }),
        finishReasons: { 0: finishReason },
      });
      const messages = await h.chat(1, 8);

      expect(await h.update(), finishReason).toEqual({ updated: false });
      expect(await h.state(), finishReason).toEqual({ summary: '', throughSeq: 0 });
      expect(await h.usageRows(), finishReason).toHaveLength(1);
      const { organizationId, agentId, conversationId } = h.params;
      expect(
        h.logger.entries.filter((entry) => entry.event.startsWith('agent.summary.')),
        finishReason,
      ).toEqual([
        { level: 'warn', event: 'agent.summary.unusable', fields: { organizationId, agentId, conversationId, finishReason } },
      ]);

      expect(await h.update(), finishReason).toEqual({ updated: true });
      expect(await h.state(), finishReason).toEqual({ summary: 'Jane asked for a callback.', throughSeq: messages[4]!.seq });
    }
  });

  it('bounds long messages in the summary request', async () => {
    const h = await createHarness();
    await h.append('user', `Long\n\n   question ${'x'.repeat(5000)}`);
    await h.chat(2, 8);

    await h.update();
    const line = lastInput(h.cheap).split('\n').find((entry) => entry.startsWith('Visitor: Long'));
    expect(line?.startsWith('Visitor: Long question xxx')).toBe(true);
    expect(line?.length).toBeLessThanOrEqual('Visitor: '.length + 800);
    expect(line?.endsWith('…')).toBe(true);
  });

  it('never throws: a provider failure leaves the summary unchanged', async () => {
    const h = await createHarness({
      script: () => ({ error: new ProviderError({ provider: 'cheap', code: 'unavailable', retryable: true, message: 'down' }) }),
    });
    await h.chat(1, 8);

    await expect(h.update()).resolves.toEqual({ updated: false });
    expect(await h.state()).toEqual({ summary: '', throughSeq: 0 });
    expect(h.strong.requests).toHaveLength(0);
    expect(h.logger.entries).toEqual([
      expect.objectContaining({ event: 'agent.summary.failed', fields: expect.objectContaining({ code: 'unavailable' }) as unknown }),
    ]);
  });

  it('does not store an empty summary, but still meters the call', async () => {
    const h = await createHarness({ script: () => ({ text: '   ' }) });
    await h.chat(1, 8);

    expect(await h.update()).toEqual({ updated: false });
    expect(await h.state()).toEqual({ summary: '', throughSeq: 0 });
    expect(await h.usageRows()).toHaveLength(1);
  });

  it('never throws when the database is unavailable', async () => {
    const down: Database = {
      query: () => Promise.reject(new Error('connection refused')),
      transaction: () => Promise.reject(new Error('connection refused')),
      close: () => Promise.resolve(),
    };
    const h = await createHarness({ db: down });
    await expect(h.update()).resolves.toEqual({ updated: false });
    expect(h.logger.entries.map((entry) => entry.event)).toEqual(['agent.summary.failed']);
  });

  it("never summarizes another organization's or agent's conversation", async () => {
    const h = await createHarness();
    const other = await createHarness();
    await h.chat(1, 8);

    expect(await h.update({ organizationId: other.tenant.org.id })).toEqual({ updated: false });
    expect(await h.update({ agentId: other.tenant.agent.id })).toEqual({ updated: false });
    expect(await h.update({ conversationId: 'not-a-uuid' })).toEqual({ updated: false });
    expect(h.cheap.requests).toHaveLength(0);
    expect(await h.state()).toEqual({ summary: '', throughSeq: 0 });
  });
});
