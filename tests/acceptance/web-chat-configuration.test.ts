import type * as nextServer from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ProviderError,
  type TextGenerationRequest,
  type TextGenerationResult,
  type TextModelProvider,
  type TextStreamEvent,
} from '@/server/ai/types';
import { reindexKnowledgeSource } from '@/server/domain/knowledge/ingestion';
import {
  FAKE_MODEL_PRICING,
  createAppHarness,
  type AppHarness,
  type ProvisionedTenant,
  type UsageRow,
} from '../support/app-harness';
import { FakeReceptionistModel, NO_INFORMATION_REPLY } from '../support/receptionist-model';
import { ScriptedTextProvider } from '../support/scripted-text-provider';
import { CAPITAL_CITY, CAPITAL_CITY_FACT, QUESTIONS, SPRINGFIELD, SPRINGFIELD_FACTS, eventTypes } from './tenants';

/**
 * Phase 1 acceptance scenario 6: "provider/model can be changed through configuration". Each "deployment"
 * is a harness built from AI_* environment variables (the production Zod loader and composition root) over
 * the SAME database: switching needs no data migration, and every model call is metered under the
 * provider/model that actually served it.
 */

vi.mock('@/server/app-services', async () => (await import('../support/app-harness')).mockedAppServices);
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof nextServer>()),
  ...(await import('../support/app-harness')).mockedNextServer,
}));

const anyString: unknown = expect.any(String);

let h: AppHarness;
let springfield: ProvisionedTenant;
let organizationId: string;

beforeAll(async () => {
  h = await createAppHarness();
  springfield = await h.provisionTenant(SPRINGFIELD);
  organizationId = springfield.organization.id;
});

afterEach(() => {
  // Provider outages are warnings for operators: a test takes the ones it causes (logger.take), any other
  // warning or error fails it.
  const unexpected = h.logger.eventsAtLeast('warn');
  h.logger.clear();
  expect(unexpected).toEqual([]);
});

afterAll(async () => {
  await h.close();
});

/** A text provider that is down until `down` is cleared, then answers like the receptionist stand-in. */
class FlakyModel implements TextModelProvider {
  readonly id: string;
  readonly requests: TextGenerationRequest[] = [];
  down = true;
  private readonly healthy: FakeReceptionistModel;

  constructor(id: string) {
    this.id = id;
    this.healthy = new FakeReceptionistModel(id);
  }

  async generate(request: TextGenerationRequest): Promise<TextGenerationResult> {
    this.attempt(request);
    return this.healthy.generate(request);
  }

  async *stream(request: TextGenerationRequest): AsyncGenerator<TextStreamEvent, void, undefined> {
    this.attempt(request);
    yield* this.healthy.stream(request);
  }

  private attempt(request: TextGenerationRequest): void {
    this.requests.push(request);
    if (this.down) {
      throw new ProviderError({ provider: this.id, code: 'unavailable', retryable: true, message: `${this.id}: unavailable` });
    }
  }
}

const chatRows = (rows: readonly UsageRow[]) => rows.filter((row) => row.purpose === 'chat_response');

/** Usage rows priced from AI_MODEL_PRICING_JSON (the fake providers report no cached tokens). */
function expectPricedAs(rows: readonly UsageRow[], model: string): void {
  const price = FAKE_MODEL_PRICING[model];
  if (!price) throw new Error(`No fake price for ${model}`);
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row).toMatchObject({ model, pricingKnown: true, cachedInputTokens: 0, cacheWriteTokens: 0 });
    expect(row.costUsd).toBeGreaterThan(0);
    expect(row.costUsd).toBeCloseTo((row.inputTokens * price.inputPerMTok + row.outputTokens * price.outputPerMTok) / 1e6, 8);
  }
}

describe('6. provider and model are chosen by configuration', () => {
  it('AI_TEXT_PROVIDER / AI_TEXT_MODEL route the next turn to another provider and model, mid-conversation', async () => {
    const session = await h.openSession(springfield.widgetKey);
    const first = await h.sendMessage(springfield.widgetKey, session.sessionToken, QUESTIONS.emergency);
    const conversationId = first.conversationId;

    // A redeploy with another text provider and model: same database, same widget secret.
    const redeployed = await createAppHarness({
      database: h.t,
      logger: h.logger,
      // 'default': this model takes no reasoning setting at all.
      ai: { AI_TEXT_PROVIDER: 'alt', AI_TEXT_MODEL: 'alt-mini', AI_TEXT_REASONING_EFFORT: 'default' },
    });
    try {
      expect(redeployed.services.ai.text).toMatchObject({ provider: 'alt', model: 'alt-mini' });
      const second = await redeployed.sendMessage(springfield.widgetKey, session.sessionToken, QUESTIONS.fee);
      expect(second.conversationId).toBe(conversationId);
      expect(second.reply).toContain(SPRINGFIELD_FACTS.fee);

      // Only the configured provider served the turn, with the configured model and reasoning setting.
      expect(redeployed.requestsTo('alt').map(({ model, reasoningEffort }) => ({ model, reasoningEffort }))).toStrictEqual([
        { model: 'alt-mini', reasoningEffort: undefined },
        { model: 'alt-mini', reasoningEffort: undefined },
      ]);
      expect(redeployed.requestsTo('receptionist')).toEqual([]);
      expect(redeployed.requestsTo('escalation')).toEqual([]);
      // The transcript and the meter record which model wrote what.
      const assistants = (await h.messages(organizationId, conversationId)).filter((message) => message.role === 'assistant');
      expect(assistants.map((message) => message.data)).toEqual([
        { model: 'receptionist-mini', tier: 'default', rounds: 2 },
        { model: 'alt-mini', tier: 'default', rounds: 2 },
      ]);
      const chat = chatRows(await h.usage(organizationId, conversationId));
      expect(chat.map((row) => `${row.provider}/${row.model}`).sort()).toEqual([
        'alt/alt-mini',
        'alt/alt-mini',
        'receptionist/receptionist-mini',
        'receptionist/receptionist-mini',
      ]);
      expectPricedAs(
        chat.filter((row) => row.provider === 'alt'),
        'alt-mini',
      );
      expectPricedAs(
        chat.filter((row) => row.provider === 'receptionist'),
        'receptionist-mini',
      );
    } finally {
      await redeployed.close();
    }
  });

  it('serves the turn from the configured escalation model while the default provider is down', async () => {
    const down = new ScriptedTextProvider('receptionist', () => ({
      error: new ProviderError({ provider: 'receptionist', code: 'unavailable', retryable: true, message: 'receptionist: unavailable' }),
    }));
    const failover = await createAppHarness({
      database: h.t,
      logger: h.logger,
      textProviders: { receptionist: down },
      ai: { AI_ESCALATION_REASONING_EFFORT: 'high' },
    });
    try {
      expect(failover.services.ai.escalation).toMatchObject({ enabled: true, provider: 'escalation', model: 'escalation-max' });
      const session = await failover.openSession(springfield.widgetKey);

      const turn = await failover.sendMessage(springfield.widgetKey, session.sessionToken, QUESTIONS.emergency);

      // The failed attempt streamed nothing, so the visitor just gets the answer.
      expect(eventTypes(turn.events)).toEqual(['turn.start', 'tool.call', 'tool.result', 'text.delta', 'turn.done']);
      expect(turn.reply).toContain(SPRINGFIELD_FACTS.emergency);
      expect(down.requests).toHaveLength(1);
      const escalated = failover.requestsTo('escalation');
      expect(escalated.map(({ model, reasoningEffort }) => ({ model, reasoningEffort }))).toEqual([
        { model: 'escalation-max', reasoningEffort: 'high' },
        { model: 'escalation-max', reasoningEffort: 'high' },
      ]);
      // Metered on the escalation model and marked as escalated; nothing is billed for the failed attempt.
      const chat = chatRows(await h.usage(organizationId, turn.conversationId));
      expect(chat.map(({ provider, metadata }) => ({ provider, tier: metadata.tier }))).toEqual([
        { provider: 'escalation', tier: 'escalation' },
        { provider: 'escalation', tier: 'escalation' },
      ]);
      expectPricedAs(chat, 'escalation-max');
      const assistant = (await h.messages(organizationId, turn.conversationId)).at(-1);
      expect(assistant).toMatchObject({ role: 'assistant', data: { model: 'escalation-max', tier: 'escalation', rounds: 2 } });
      expect(h.logger.take('agent.turn.escalated')).toEqual([
        { level: 'warn', event: 'agent.turn.escalated', fields: expect.objectContaining({ trigger: 'provider_error', errorCode: 'unavailable' }) as unknown },
      ]);
    } finally {
      await failover.close();
    }
  });

  it('with escalation disabled, an outage ends the turn with a recoverable error and a retry reuses the unanswered message', async () => {
    const flaky = new FlakyModel('receptionist');
    const noEscalation = await createAppHarness({
      database: h.t,
      logger: h.logger,
      textProviders: { receptionist: flaky },
      ai: { AI_ESCALATION_ENABLED: 'false' },
    });
    try {
      const session = await noEscalation.openSession(springfield.widgetKey);

      const failed = await noEscalation.sendMessage(springfield.widgetKey, session.sessionToken, QUESTIONS.emergency);

      expect(failed.events).toEqual([
        { type: 'turn.start', turnId: failed.turnId, conversationId: failed.conversationId },
        { type: 'turn.error', turnId: failed.turnId, code: 'provider_unavailable', message: anyString, recoverable: true },
      ]);
      expect(noEscalation.requestsTo('escalation')).toEqual([]);
      const conversationId = failed.conversationId;
      expect((await h.messages(organizationId, conversationId)).map(({ role, content, data }) => ({ role, content, data }))).toEqual([
        { role: 'user', content: QUESTIONS.emergency, data: {} },
        { role: 'system', content: 'assistant_unavailable', data: { code: 'unavailable' } },
      ]);
      expect(await h.usage(organizationId, conversationId)).toEqual([]);
      expect(await h.conversation(organizationId, conversationId)).toMatchObject({ status: 'active', turnLockedUntil: null });
      // Operators see the outage as warnings.
      expect(h.logger.take('agent.turn.provider_failed')).toMatchObject([
        { level: 'warn', fields: { provider: 'receptionist', code: 'unavailable' } },
      ]);
      expect(h.logger.take('webchat.turn_failed')).toMatchObject([{ level: 'warn', fields: { errorCode: 'provider_unavailable' } }]);

      // The provider recovers and the visitor presses Retry: the same text is answered, not duplicated.
      flaky.down = false;
      const retried = await noEscalation.sendMessage(springfield.widgetKey, session.sessionToken, QUESTIONS.emergency);
      expect(retried.conversationId).toBe(conversationId);
      expect(retried.reply).toContain(SPRINGFIELD_FACTS.emergency);
      expect((await h.messages(organizationId, conversationId)).map((message) => message.role)).toEqual([
        'user',
        'system',
        'tool_call',
        'tool_result',
        'assistant',
      ]);
      expectPricedAs(chatRows(await h.usage(organizationId, conversationId)), 'receptionist-mini');
    } finally {
      await noEscalation.close();
    }
  });

  it('a default model the provider rejects (e.g. a mistyped AI_TEXT_MODEL) fails visibly instead of escalating every turn', async () => {
    const rejecting = new ScriptedTextProvider('receptionist', () => ({
      error: new ProviderError({
        provider: 'receptionist',
        code: 'invalid_request',
        retryable: false,
        status: 404,
        message: 'receptionist: request rejected (HTTP 404, model_not_found)',
      }),
    }));
    const misconfigured = await createAppHarness({
      database: h.t,
      logger: h.logger,
      textProviders: { receptionist: rejecting },
      ai: { AI_TEXT_MODEL: 'receptionist-mni' },
    });
    try {
      expect(misconfigured.services.ai.escalation).toMatchObject({ enabled: true, provider: 'escalation' });
      const session = await misconfigured.openSession(springfield.widgetKey);

      const failed = await misconfigured.sendMessage(springfield.widgetKey, session.sessionToken, QUESTIONS.emergency);

      expect(failed.events).toEqual([
        { type: 'turn.start', turnId: failed.turnId, conversationId: failed.conversationId },
        { type: 'turn.error', turnId: failed.turnId, code: 'provider_unavailable', message: anyString, recoverable: true },
      ]);
      // The premium model never served (or billed) the turn.
      expect(rejecting.requests.map(({ model }) => model)).toEqual(['receptionist-mni']);
      expect(misconfigured.requestsTo('escalation')).toEqual([]);
      expect(await h.usage(organizationId, failed.conversationId)).toEqual([]);
      // Operators get an error naming the rejected model.
      expect(h.logger.take('agent.default_model.rejected')).toEqual([
        {
          level: 'error',
          event: 'agent.default_model.rejected',
          fields: expect.objectContaining({ provider: 'receptionist', model: 'receptionist-mni', code: 'invalid_request', status: 404 }) as unknown,
        },
      ]);
      expect(h.logger.take('agent.turn.escalated')).toEqual([]);
      expect(h.logger.take('agent.turn.provider_failed')).toMatchObject([{ level: 'warn', fields: { code: 'invalid_request' } }]);
      expect(h.logger.take('webchat.turn_failed')).toMatchObject([{ level: 'warn', fields: { errorCode: 'provider_unavailable' } }]);
    } finally {
      await misconfigured.close();
    }
  });

  it('AI_EMBEDDING_MODEL: knowledge embedded with another model is not retrieved until it is re-embedded', async () => {
    const capital = await h.provisionTenant(CAPITAL_CITY);
    const capitalId = capital.organization.id;
    const [source] = capital.sources;
    const chunkModels = async () =>
      (
        await h.t.db.query<{ embedding_model: string }>('select embedding_model from public.knowledge_chunks where organization_id = $1', [
          capitalId,
        ])
      ).map((row) => row.embedding_model);
    expect(await chunkModels()).toEqual(['fake-embed-v1']);

    const v2 = await createAppHarness({ database: h.t, logger: h.logger, ai: { AI_EMBEDDING_MODEL: 'fake-embed-v2' } });
    try {
      // Vectors of different models are not comparable: until re-embedded, the knowledge is not found.
      const session = await v2.openSession(capital.widgetKey);
      const blind = await v2.sendMessage(capital.widgetKey, session.sessionToken, QUESTIONS.gutters);
      expect((await h.toolRuns(capitalId, blind.conversationId))[0]?.output).toMatchObject({ results: [] });
      expect(blind.reply).toBe(NO_INFORMATION_REPLY);
      expect(
        (await h.usage(capitalId, blind.conversationId)).filter((row) => row.kind === 'embedding').map((row) => row.model),
      ).toEqual(['fake-embed-v2']);

      // The owner re-embeds the source with the configured model.
      const reindexed = await reindexKnowledgeSource(capital.asOwner, v2.services.embedder, capitalId, source!.id, {
        logger: v2.logger,
      });
      expect(reindexed).toMatchObject({ id: source!.id, status: 'ready', chunkCount: 1 });
      expect(await chunkModels()).toEqual(['fake-embed-v2']);
      expect(
        (await h.usage(capitalId))
          .filter((row) => row.purpose === 'knowledge_ingestion')
          .map((row) => row.model)
          .sort(),
      ).toEqual(['fake-embed-v1', 'fake-embed-v2']);

      const grounded = await v2.sendMessage(capital.widgetKey, session.sessionToken, QUESTIONS.gutters);
      expect(grounded.reply).toContain(CAPITAL_CITY_FACT);
      // A deployment still configured with the old model no longer finds it: retrieval compares like with like.
      const stale = await h.sendMessage(capital.widgetKey, (await h.openSession(capital.widgetKey)).sessionToken, QUESTIONS.gutters);
      expect(stale.reply).toBe(NO_INFORMATION_REPLY);
    } finally {
      await v2.close();
    }
  });

  it('refuses to start with a provider that is configured but not registered', async () => {
    await expect(createAppHarness({ database: h.t, logger: h.logger, ai: { AI_TEXT_PROVIDER: 'missing' } })).rejects.toThrow(
      'text provider "missing" (AI_TEXT_PROVIDER)',
    );
    await expect(
      createAppHarness({ database: h.t, logger: h.logger, ai: { AI_EMBEDDING_PROVIDER: 'missing' } }),
    ).rejects.toThrow('embedding provider "missing" (AI_EMBEDDING_PROVIDER)');
  });
});
