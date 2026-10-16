import { describe, expect, it } from 'vitest';
import { EmbeddingService } from '@/server/ai/embedding-service';
import { createProviderRegistry } from '@/server/ai/registry';
import { ModelRouter } from '@/server/ai/router';
import { ProviderError, type EmbeddingProvider } from '@/server/ai/types';
import { EMBEDDING_DIMENSIONS, loadAiConfig } from '@/server/config/env';
import type {
  EmbeddingUsagePurpose,
  EmbeddingUsageReport,
  UsageContext,
  UsageRecorder,
} from '@/server/domain/usage/types';
import { FakeEmbeddingProvider, fakeEmbed } from '../support/fake-embeddings';
import { ScriptedTextProvider } from '../support/scripted-text-provider';

class RecordingUsage implements UsageRecorder {
  readonly embeddings: Array<{ context: UsageContext; purpose: EmbeddingUsagePurpose; report: EmbeddingUsageReport }> = [];

  async recordTextGeneration(): Promise<void> {}

  async recordEmbedding(context: UsageContext, purpose: EmbeddingUsagePurpose, report: EmbeddingUsageReport) {
    this.embeddings.push({ context, purpose, report });
  }
}

const CONTEXT = {
  organizationId: '00000000-0000-4000-8000-00000000000a',
  agentId: '00000000-0000-4000-8000-00000000000b',
  conversationId: null,
};

function setup(provider: EmbeddingProvider, options: { batchSize?: number; model?: string } = {}) {
  const config = loadAiConfig({
    AI_TEXT_PROVIDER: 'text',
    AI_ESCALATION_ENABLED: 'false',
    AI_EMBEDDING_PROVIDER: provider.id,
    AI_EMBEDDING_MODEL: options.model ?? 'fake-embed',
  });
  const registry = createProviderRegistry({
    text: { text: () => new ScriptedTextProvider('text', []) },
    embedding: { [provider.id]: () => provider },
  });
  const usage = new RecordingUsage();
  const service = new EmbeddingService({ router: new ModelRouter(config, registry), usage, batchSize: options.batchSize });
  return { service, usage };
}

const texts = (count: number) => Array.from({ length: count }, (_, i) => `knowledge passage number ${i} about topic ${i % 7}`);

describe('EmbeddingService', () => {
  it('batches inputs, keeps their order and meters every batch', async () => {
    const provider = new FakeEmbeddingProvider('fake');
    const { service, usage } = setup(provider);
    const input = texts(200);

    const outcome = await service.embed(input, { ...CONTEXT, purpose: 'knowledge_ingestion' });

    expect(provider.requests.map((request) => request.input.length)).toEqual([96, 96, 8]);
    for (const request of provider.requests) {
      expect(request.model).toBe('fake-embed');
      expect(request.dimensions).toBe(EMBEDDING_DIMENSIONS);
    }
    expect(provider.requests.flatMap((request) => request.input)).toEqual(input);
    expect(outcome.model).toBe('fake-embed');
    expect(outcome.vectors).toHaveLength(200);
    expect(outcome.vectors[0]).toEqual(fakeEmbed(input[0]!));
    expect(outcome.vectors[150]).toEqual(fakeEmbed(input[150]!));

    expect(usage.embeddings).toHaveLength(3);
    usage.embeddings.forEach((entry, batch) => {
      const batchInput = provider.requests[batch]!.input;
      expect(entry.context).toEqual(CONTEXT);
      expect(entry.purpose).toBe('knowledge_ingestion');
      expect(entry.report).toEqual({
        provider: 'fake',
        model: 'fake-embed',
        inputTokens: batchInput.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0),
        durationMs: 1,
      });
    });
  });

  it('honours a custom batch size and the query purpose', async () => {
    const provider = new FakeEmbeddingProvider('fake');
    const { service, usage } = setup(provider, { batchSize: 2 });
    await service.embed(['opening hours', 'emergency repair', 'call-out fee'], { ...CONTEXT, purpose: 'knowledge_query' });
    expect(provider.requests.map((request) => request.input)).toEqual([
      ['opening hours', 'emergency repair'],
      ['call-out fee'],
    ]);
    expect(usage.embeddings.map((entry) => entry.purpose)).toEqual(['knowledge_query', 'knowledge_query']);
  });

  it('returns no vectors for empty input without calling the provider', async () => {
    const provider = new FakeEmbeddingProvider('fake');
    const { service, usage } = setup(provider);
    await expect(service.embed([], { ...CONTEXT, purpose: 'knowledge_query' })).resolves.toEqual({
      vectors: [],
      model: 'fake-embed',
    });
    expect(provider.requests).toHaveLength(0);
    expect(usage.embeddings).toHaveLength(0);
  });

  it('rejects empty texts before calling the provider', async () => {
    const provider = new FakeEmbeddingProvider('fake');
    const { service } = setup(provider);
    await expect(service.embed(['valid', '  '], { ...CONTEXT, purpose: 'knowledge_ingestion' })).rejects.toThrow(
      'Cannot embed an empty text (input 1)',
    );
    expect(provider.requests).toHaveLength(0);
  });

  it('rejects vectors with the wrong number of dimensions', async () => {
    const wrongDimensions: EmbeddingProvider = {
      id: 'short',
      embed: async (request) => ({
        provider: 'short',
        model: request.model,
        vectors: request.input.map(() => [0.1, 0.2, 0.3]),
        usage: { inputTokens: 3 },
        durationMs: 1,
      }),
    };
    const { service, usage } = setup(wrongDimensions);
    const failure = service.embed(['hello world'], { ...CONTEXT, purpose: 'knowledge_query' });
    await expect(failure).rejects.toBeInstanceOf(ProviderError);
    await expect(failure).rejects.toMatchObject({ code: 'invalid_request', retryable: false, provider: 'short' });
    await expect(failure).rejects.toThrow(`vector 0 has 3 dimensions, expected ${EMBEDDING_DIMENSIONS}`);
    // The provider still billed the request.
    expect(usage.embeddings).toHaveLength(1);
  });

  it('rejects a response with a different number of vectors', async () => {
    const dropsOne: EmbeddingProvider = {
      id: 'lossy',
      embed: async (request) => ({
        provider: 'lossy',
        model: request.model,
        vectors: request.input.slice(1).map((text) => fakeEmbed(text)),
        usage: { inputTokens: 4 },
        durationMs: 1,
      }),
    };
    const { service } = setup(dropsOne);
    await expect(service.embed(['one', 'two'], { ...CONTEXT, purpose: 'knowledge_ingestion' })).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'Embedding provider returned an invalid response: expected 2 vectors, got 1',
    });
  });

  it('propagates provider errors unchanged and does not meter the failed batch', async () => {
    const provider = new FakeEmbeddingProvider('fake');
    const { service, usage } = setup(provider);
    const error = new ProviderError({ provider: 'fake', code: 'rate_limited', retryable: true, message: 'slow down' });
    provider.failNext = error;
    await expect(service.embed(['opening hours'], { ...CONTEXT, purpose: 'knowledge_query' })).rejects.toBe(error);
    expect(usage.embeddings).toHaveLength(0);
  });

  it('keeps the metering of batches that completed before a later batch failed', async () => {
    const fake = new FakeEmbeddingProvider('flaky');
    const outage = new ProviderError({ provider: 'flaky', code: 'unavailable', retryable: true, message: 'down' });
    const flaky: EmbeddingProvider = {
      id: 'flaky',
      embed: async (request) => {
        if (fake.requests.length === 1) throw outage;
        return fake.embed(request);
      },
    };
    const { service, usage } = setup(flaky, { batchSize: 2 });
    await expect(
      service.embed(['opening hours', 'emergency repair', 'call-out fee'], { ...CONTEXT, purpose: 'knowledge_ingestion' }),
    ).rejects.toBe(outage);
    // The first batch was billed by the provider, so it stays recorded.
    expect(usage.embeddings).toHaveLength(1);
    expect(usage.embeddings[0]!.report.inputTokens).toBeGreaterThan(0);
  });

  it('reports the configured model, not the provider-reported one, so stored chunks and queries always match', async () => {
    const fake = new FakeEmbeddingProvider('fake');
    // Providers may answer with a dated snapshot (or deployment name) instead of the requested model.
    const snapshot: EmbeddingProvider = {
      id: 'fake',
      embed: async (request) => ({ ...(await fake.embed(request)), model: 'embed-v2-2026-01-01' }),
    };
    const { service, usage } = setup(snapshot, { model: 'embed-v2', batchSize: 2 });
    expect(service.model).toBe('embed-v2');

    const outcome = await service.embed(['opening hours', 'emergency repair', 'call-out fee'], {
      ...CONTEXT,
      purpose: 'knowledge_ingestion',
    });
    expect(fake.requests.map((request) => request.model)).toEqual(['embed-v2', 'embed-v2']);
    expect(outcome.model).toBe('embed-v2');
    expect(outcome.vectors).toHaveLength(3);
    // Metering records what the provider says it billed, for every batch.
    expect(usage.embeddings.map((entry) => entry.report.model)).toEqual(['embed-v2-2026-01-01', 'embed-v2-2026-01-01']);
  });

  it('validates the batch size', () => {
    expect(() => setup(new FakeEmbeddingProvider('fake'), { batchSize: 0 })).toThrow(/batchSize/);
    expect(() => setup(new FakeEmbeddingProvider('fake'), { batchSize: 2.5 })).toThrow(/batchSize/);
  });
});
