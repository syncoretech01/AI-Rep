import { describe, expect, it, vi } from 'vitest';
import { OpenAIEmbeddingProvider } from '@/server/ai/openai/embedding-provider';
import { OpenAITextProvider } from '@/server/ai/openai/text-provider';
import { createDefaultProviderFactories } from '@/server/ai/providers';
import { createProviderRegistry } from '@/server/ai/registry';
import { loadAiConfig } from '@/server/config/env';
import { FakeEmbeddingProvider } from '../support/fake-embeddings';
import { ScriptedTextProvider } from '../support/scripted-text-provider';

describe('createProviderRegistry', () => {
  it('creates each provider lazily, once per id', () => {
    const cheap = vi.fn(() => new ScriptedTextProvider('cheap', []));
    const strong = vi.fn(() => new ScriptedTextProvider('strong', []));
    const embed = vi.fn(() => new FakeEmbeddingProvider('embed'));
    const registry = createProviderRegistry({ text: { cheap, strong }, embedding: { embed } });

    expect(cheap).not.toHaveBeenCalled();
    expect(registry.hasText('cheap')).toBe(true);
    expect(cheap).not.toHaveBeenCalled();

    const first = registry.getText('cheap');
    const second = registry.getText('cheap');
    expect(first).toBe(second);
    expect(first.id).toBe('cheap');
    expect(cheap).toHaveBeenCalledTimes(1);
    expect(strong).not.toHaveBeenCalled();

    expect(registry.getEmbedding('embed')).toBe(registry.getEmbedding('embed'));
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('keeps text and embedding namespaces separate', () => {
    const registry = createProviderRegistry({
      text: { shared: () => new ScriptedTextProvider('shared', []) },
      embedding: { vectors: () => new FakeEmbeddingProvider('vectors') },
    });
    expect(registry.hasText('shared')).toBe(true);
    expect(registry.hasEmbedding('shared')).toBe(false);
    expect(registry.hasText('vectors')).toBe(false);
    expect(() => registry.getEmbedding('shared')).toThrow('Unknown embedding provider "shared". Registered: vectors');
  });

  it('rejects unknown ids with the registered alternatives', () => {
    const registry = createProviderRegistry({
      text: { a: () => new ScriptedTextProvider('a', []), b: () => new ScriptedTextProvider('b', []) },
      embedding: {},
    });
    expect(() => registry.getText('x')).toThrow('Unknown text provider "x". Registered: a, b');
    expect(() => registry.getEmbedding('x')).toThrow('Unknown embedding provider "x". Registered: (none)');
  });

  it('never resolves inherited object members as providers', () => {
    const registry = createProviderRegistry({ text: {}, embedding: {} });
    for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(registry.hasText(id)).toBe(false);
      expect(() => registry.getText(id)).toThrow(/Unknown text provider/);
    }
  });

  it('does not cache a factory failure', () => {
    let attempts = 0;
    const registry = createProviderRegistry({
      text: {
        flaky: () => {
          attempts += 1;
          if (attempts === 1) throw new Error('credential missing');
          return new ScriptedTextProvider('flaky', []);
        },
      },
      embedding: {},
    });
    expect(() => registry.getText('flaky')).toThrow('credential missing');
    expect(registry.getText('flaky').id).toBe('flaky');
    expect(attempts).toBe(2);
  });
});

describe('createDefaultProviderFactories', () => {
  const ai = loadAiConfig({});

  it('registers the OpenAI adapters under the default provider id', () => {
    const registry = createProviderRegistry(createDefaultProviderFactories({ openai: { apiKey: 'sk-test' }, ai }));
    expect(registry.hasText(ai.text.provider)).toBe(true);
    expect(registry.hasEmbedding(ai.embedding.provider)).toBe(true);
    const text = registry.getText('openai');
    const embedding = registry.getEmbedding('openai');
    expect(text).toBeInstanceOf(OpenAITextProvider);
    expect(text.id).toBe('openai');
    expect(embedding).toBeInstanceOf(OpenAIEmbeddingProvider);
    expect(embedding.id).toBe('openai');
  });

  it('fails on first use, not at registration, when OPENAI_API_KEY is missing', () => {
    const factories = createDefaultProviderFactories({ openai: { apiKey: undefined }, ai });
    const registry = createProviderRegistry(factories);
    expect(registry.hasText('openai')).toBe(true);
    expect(() => registry.getText('openai')).toThrow('OPENAI_API_KEY is not configured');
    expect(() => registry.getEmbedding('openai')).toThrow('OPENAI_API_KEY is not configured');
  });
});
