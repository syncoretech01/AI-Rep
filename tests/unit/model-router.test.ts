import { describe, expect, it } from 'vitest';
import { createProviderRegistry, type ProviderRegistry } from '@/server/ai/registry';
import { ModelRouter } from '@/server/ai/router';
import { ProviderError, type TextGenerationRequest, type TextStreamEvent } from '@/server/ai/types';
import { loadAiConfig } from '@/server/config/env';
import { FakeEmbeddingProvider } from '../support/fake-embeddings';
import { ScriptedTextProvider } from '../support/scripted-text-provider';

/** Everything comes from the same Zod env loader production uses. */
const ENV = {
  AI_TEXT_PROVIDER: 'cheap',
  AI_TEXT_MODEL: 'cheap-model',
  AI_TEXT_REASONING_EFFORT: 'low',
  AI_ESCALATION_PROVIDER: 'strong',
  AI_ESCALATION_MODEL: 'strong-model',
  AI_ESCALATION_REASONING_EFFORT: 'high',
  AI_EMBEDDING_PROVIDER: 'vectors',
  AI_EMBEDDING_MODEL: 'vector-model',
};

function fakeRegistry(textIds = ['cheap', 'strong'], embeddingIds = ['vectors']): ProviderRegistry {
  return createProviderRegistry({
    text: Object.fromEntries(textIds.map((id) => [id, () => new ScriptedTextProvider(id, [])])),
    embedding: Object.fromEntries(embeddingIds.map((id) => [id, () => new FakeEmbeddingProvider(id)])),
  });
}

describe('ModelRouter text routing', () => {
  const registry = fakeRegistry();
  const router = new ModelRouter(loadAiConfig(ENV), registry);

  it('routes routine chat to the cheap default profile', () => {
    const route = router.selectText({ task: 'chat_response', channel: 'web_chat' });
    expect(route).toEqual({
      tier: 'default',
      providerId: 'cheap',
      provider: registry.getText('cheap'),
      model: 'cheap-model',
      reasoningEffort: 'low',
      reason: 'default',
    });
    expect(router.selectText({ task: 'chat_response', channel: 'web_chat', complexity: 'routine' }).tier).toBe('default');
  });

  it('escalates a chat response after a failed default attempt', () => {
    const route = router.selectText({ task: 'chat_response', channel: 'web_chat', priorFailure: true });
    expect(route).toMatchObject({
      tier: 'escalation',
      providerId: 'strong',
      model: 'strong-model',
      reasoningEffort: 'high',
      reason: 'escalation:prior_failure',
    });
    expect(route.provider).toBe(registry.getText('strong'));
  });

  it("sends no reasoning setting for a profile configured as 'default' (models without reasoning support)", () => {
    const plain = new ModelRouter(
      loadAiConfig({ ...ENV, AI_TEXT_REASONING_EFFORT: 'default', AI_ESCALATION_REASONING_EFFORT: 'default' }),
      fakeRegistry(),
    );
    expect(plain.selectText({ task: 'chat_response', channel: 'web_chat' }).reasoningEffort).toBeUndefined();
    expect(
      plain.selectText({ task: 'chat_response', channel: 'web_chat', priorFailure: true }).reasoningEffort,
    ).toBeUndefined();
  });

  it('escalates a chat response classified as complex', () => {
    const route = router.selectText({ task: 'chat_response', channel: 'web_chat', complexity: 'complex' });
    expect(route).toMatchObject({ tier: 'escalation', model: 'strong-model', reason: 'escalation:complex' });
  });

  it('reports a prior failure as the escalation reason when both reasons apply', () => {
    const route = router.selectText({ task: 'chat_response', channel: 'web_chat', complexity: 'complex', priorFailure: true });
    expect(route).toMatchObject({ tier: 'escalation', model: 'strong-model', reason: 'escalation:prior_failure' });
  });

  it('never escalates summaries', () => {
    for (const request of [{}, { priorFailure: true }, { complexity: 'complex' as const, priorFailure: true }]) {
      const route = router.selectText({ task: 'conversation_summary', channel: 'web_chat', ...request });
      expect(route).toMatchObject({ tier: 'default', providerId: 'cheap', model: 'cheap-model', reason: 'default' });
    }
    expect(router.canEscalate('conversation_summary')).toBe(false);
    expect(router.canEscalate('chat_response')).toBe(true);
  });

  it('stays on the default profile when escalation is disabled', () => {
    const disabled = new ModelRouter(loadAiConfig({ ...ENV, AI_ESCALATION_ENABLED: 'false' }), fakeRegistry());
    expect(disabled.canEscalate('chat_response')).toBe(false);
    for (const request of [{ priorFailure: true }, { complexity: 'complex' as const }]) {
      expect(disabled.selectText({ task: 'chat_response', channel: 'web_chat', ...request })).toMatchObject({
        tier: 'default',
        model: 'cheap-model',
      });
    }
  });
});

describe('ModelRouter embedding routing', () => {
  it('returns the configured embedding provider, model and dimensions', () => {
    const registry = fakeRegistry();
    const config = loadAiConfig(ENV);
    const route = new ModelRouter(config, registry).selectEmbedding();
    expect(route).toEqual({
      providerId: 'vectors',
      provider: registry.getEmbedding('vectors'),
      model: 'vector-model',
      dimensions: config.embedding.dimensions,
    });
  });
});

describe('ModelRouter configuration validation', () => {
  it('fails fast when a configured provider is not registered', () => {
    expect(() => new ModelRouter(loadAiConfig(ENV), fakeRegistry(['strong']))).toThrow(
      'text provider "cheap" (AI_TEXT_PROVIDER)',
    );
    expect(() => new ModelRouter(loadAiConfig(ENV), fakeRegistry(['cheap']))).toThrow(
      'escalation provider "strong" (AI_ESCALATION_PROVIDER)',
    );
    expect(() => new ModelRouter(loadAiConfig(ENV), fakeRegistry(['cheap', 'strong'], []))).toThrow(
      'embedding provider "vectors" (AI_EMBEDDING_PROVIDER)',
    );
  });

  it('does not require the provider of a disabled escalation profile', () => {
    const router = new ModelRouter(loadAiConfig({ ...ENV, AI_ESCALATION_ENABLED: 'false' }), fakeRegistry(['cheap']));
    expect(router.selectText({ task: 'chat_response', channel: 'web_chat', priorFailure: true }).providerId).toBe('cheap');
  });

  it('does not instantiate providers while validating', () => {
    let created = 0;
    const registry = createProviderRegistry({
      text: {
        cheap: () => {
          created += 1;
          return new ScriptedTextProvider('cheap', []);
        },
        strong: () => new ScriptedTextProvider('strong', []),
      },
      embedding: { vectors: () => new FakeEmbeddingProvider('vectors') },
    });
    const router = new ModelRouter(loadAiConfig(ENV), registry);
    expect(created).toBe(0);
    router.selectText({ task: 'chat_response', channel: 'web_chat' });
    expect(created).toBe(1);
  });
});

describe('provider/model switch through configuration (acceptance scenario 6)', () => {
  it('routes to whatever provider and models the environment names', () => {
    const registry = fakeRegistry(['alt', 'alt-strong'], ['alt-vectors']);
    const router = new ModelRouter(
      loadAiConfig({
        AI_TEXT_PROVIDER: 'alt',
        AI_TEXT_MODEL: 'alt-mini',
        AI_ESCALATION_PROVIDER: 'alt-strong',
        AI_ESCALATION_MODEL: 'alt-max',
        AI_EMBEDDING_PROVIDER: 'alt-vectors',
        AI_EMBEDDING_MODEL: 'alt-embed',
      }),
      registry,
    );

    const chat = router.selectText({ task: 'chat_response', channel: 'web_chat' });
    expect(chat.providerId).toBe('alt');
    expect(chat.model).toBe('alt-mini');
    expect(chat.provider.id).toBe('alt');
    expect(router.selectText({ task: 'chat_response', channel: 'web_chat', priorFailure: true }).model).toBe('alt-max');
    expect(router.selectEmbedding()).toMatchObject({ providerId: 'alt-vectors', model: 'alt-embed' });
  });

  it('uses the documented defaults when nothing is configured', () => {
    const config = loadAiConfig({});
    const router = new ModelRouter(config, fakeRegistry(['openai'], ['openai']));
    expect(router.selectText({ task: 'chat_response', channel: 'web_chat' })).toMatchObject({
      providerId: 'openai',
      model: config.text.model,
      reasoningEffort: config.text.reasoningEffort,
    });
    expect(router.selectText({ task: 'chat_response', channel: 'web_chat', priorFailure: true }).model).toBe(
      config.escalation.model,
    );
    expect(config.escalation.model).not.toBe(config.text.model);
    expect(router.selectEmbedding().model).toBe(config.embedding.model);
  });
});

describe('ScriptedTextProvider (routed test double shared by agent tests)', () => {
  const baseRequest = (model: string): TextGenerationRequest => ({
    model,
    instructions: 'Be brief.',
    input: [{ type: 'message', role: 'user', content: 'Hello?' }],
    tools: [],
  });

  it('serves the routed model and streams scripted text in a few deltas', async () => {
    const scripted = new ScriptedTextProvider('alt', [{ text: 'Hello from the scripted model' }]);
    const router = new ModelRouter(
      loadAiConfig({
        AI_TEXT_PROVIDER: 'alt',
        AI_TEXT_MODEL: 'alt-mini',
        AI_ESCALATION_ENABLED: 'false',
        AI_EMBEDDING_PROVIDER: 'vectors',
      }),
      createProviderRegistry({
        text: { alt: () => scripted },
        embedding: { vectors: () => new FakeEmbeddingProvider('vectors') },
      }),
    );
    const route = router.selectText({ task: 'chat_response', channel: 'web_chat' });

    const events: TextStreamEvent[] = [];
    for await (const event of route.provider.stream(baseRequest(route.model))) events.push(event);

    const deltas = events.flatMap((event) => (event.type === 'text.delta' ? [event.delta] : []));
    expect(deltas).toHaveLength(3);
    expect(deltas.join('')).toBe('Hello from the scripted model');
    expect(events.at(-1)).toEqual({
      type: 'completed',
      result: {
        provider: 'alt',
        model: 'alt-mini',
        text: 'Hello from the scripted model',
        toolCalls: [],
        outputItems: [{ type: 'message', role: 'assistant', content: 'Hello from the scripted model' }],
        finishReason: 'stop',
        usage: { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 20, reasoningTokens: 0 },
        durationMs: 1,
      },
    });
    expect(scripted.requests.map((request) => request.model)).toEqual(['alt-mini']);
  });

  it('returns tool calls, throws scripted errors, and refuses to run past its script', async () => {
    const outage = new ProviderError({ provider: 'p', code: 'unavailable', retryable: true, message: 'down' });
    const scripted = new ScriptedTextProvider('p', [
      {
        toolCalls: [
          { name: 'searchKnowledge', arguments: { query: 'hours' } },
          { name: 'captureLead', arguments: '{not json', callId: 'fixed-id' },
        ],
        usage: { inputTokens: 5 },
      },
      { error: outage },
    ]);

    const first = await scripted.generate(baseRequest('m'));
    expect(first.toolCalls).toEqual([
      { callId: 'call_p_1', name: 'searchKnowledge', arguments: '{"query":"hours"}' },
      { callId: 'fixed-id', name: 'captureLead', arguments: '{not json' },
    ]);
    expect(first.outputItems).toEqual(first.toolCalls.map((call) => ({ type: 'tool_call', call })));
    expect(first.finishReason).toBe('tool_calls');
    expect(first.usage).toMatchObject({ inputTokens: 5, outputTokens: 20 });

    await expect(scripted.generate(baseRequest('m'))).rejects.toBe(outage);
    await expect(scripted.generate(baseRequest('m'))).rejects.toThrow('received request #3 but its script has only 2 turn(s)');
    expect(scripted.requests).toHaveLength(3);
  });

  it('accepts a function script and records a snapshot of each request', async () => {
    const scripted = new ScriptedTextProvider('fn', (request, index) => ({ text: `turn ${index}: ${request.input.length} items` }));
    const request = baseRequest('m');
    expect((await scripted.generate(request)).text).toBe('turn 0: 1 items');
    request.input.push({ type: 'message', role: 'assistant', content: 'later' });
    expect((await scripted.generate(request)).text).toBe('turn 1: 2 items');
    expect(scripted.requests.map((recorded) => recorded.input.length)).toEqual([1, 2]);
  });
});
