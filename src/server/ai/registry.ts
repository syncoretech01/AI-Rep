import type { EmbeddingProvider, TextModelProvider } from './types';

/**
 * Provider factories keyed by the provider ids used in configuration
 * (AI_TEXT_PROVIDER, AI_ESCALATION_PROVIDER, AI_EMBEDDING_PROVIDER).
 * Adding a provider means one adapter plus one entry here — no business code changes.
 */
export interface ProviderFactories {
  text: Readonly<Record<string, () => TextModelProvider>>;
  embedding: Readonly<Record<string, () => EmbeddingProvider>>;
}

export interface ProviderRegistry {
  /** Lazily created once per id; throws for an unregistered id. */
  getText(id: string): TextModelProvider;
  getEmbedding(id: string): EmbeddingProvider;
  hasText(id: string): boolean;
  hasEmbedding(id: string): boolean;
}

/**
 * Providers are created on first use so a missing credential only fails the
 * code path that needs it (e.g. `next build` or a script never touches them).
 */
export function createProviderRegistry(factories: ProviderFactories): ProviderRegistry {
  const text = lazyProviders('text', factories.text);
  const embedding = lazyProviders('embedding', factories.embedding);
  return {
    getText: text.get,
    getEmbedding: embedding.get,
    hasText: text.has,
    hasEmbedding: embedding.has,
  };
}

function lazyProviders<T>(kind: string, factories: Readonly<Record<string, () => T>>) {
  const instances = new Map<string, T>();
  // Own keys only: an id like "constructor" must not resolve to Object.prototype members.
  const has = (id: string): boolean => Object.hasOwn(factories, id);

  const get = (id: string): T => {
    const existing = instances.get(id);
    if (existing !== undefined) return existing;
    const factory = has(id) ? factories[id] : undefined;
    if (!factory) {
      const registered = Object.keys(factories).join(', ') || '(none)';
      throw new Error(`Unknown ${kind} provider "${id}". Registered: ${registered}`);
    }
    const instance = factory();
    instances.set(id, instance);
    return instance;
  };

  return { has, get };
}
