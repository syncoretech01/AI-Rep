import { describe, expect, it } from 'vitest';
import { findStaleSources, reembedStaleSources } from '../../scripts/reembed-knowledge';
import type { Embedder } from '@/server/ai/embedder';
import { ProviderError } from '@/server/ai/types';
import { ingestTextSource } from '@/server/domain/knowledge/ingestion';
import { searchKnowledge } from '@/server/domain/knowledge/retrieval';
import { silentLogger } from '@/server/observability/logger';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { FakeEmbeddingProvider } from '../support/fake-embeddings';
import { createTenant, type TenantFixture } from '../support/fixtures';

// The re-embed command scans every organization, so each test gets its own database.
async function withDatabase(run: (t: TestDatabase) => Promise<void>): Promise<void> {
  const t = await createTestDatabase();
  try {
    await run(t);
  } finally {
    await t.close();
  }
}

function embedderFor(model: string): { embedder: Embedder; provider: FakeEmbeddingProvider } {
  const provider = new FakeEmbeddingProvider('fake');
  const embedder: Embedder = {
    model,
    async embed(texts) {
      const result = await provider.embed({ model, input: [...texts] });
      return { vectors: result.vectors, model };
    },
  };
  return { embedder, provider };
}

function ingest(t: TestDatabase, tenant: TenantFixture, embedder: Embedder, title: string, text: string) {
  return ingestTextSource(
    t.service,
    embedder,
    { organizationId: tenant.org.id, agentId: null, kind: 'text', title, text, createdBy: null },
    { logger: silentLogger },
  );
}

function ask(t: TestDatabase, tenant: TenantFixture, embedder: Embedder, query: string) {
  return searchKnowledge(t.service, embedder, {
    organizationId: tenant.org.id,
    agentId: tenant.agent.id,
    query,
    budget: { maxChunks: 3, maxTokens: 1800, minSimilarity: 0.3 },
  });
}

describe('re-embedding knowledge after an embedding-model change', () => {
  it('makes old-model knowledge searchable again under the new model', () =>
    withDatabase(async (t) => {
      const tenant = await t.service.run((sql) => createTenant(sql));
      const source = await ingest(t, tenant, embedderFor('model-v1').embedder, 'Emergency service', 'We offer 24/7 emergency boiler repair.');
      const v2 = embedderFor('model-v2');

      // After the switch the source is still "ready" but invisible to retrieval.
      expect(await ask(t, tenant, v2.embedder, 'emergency boiler repair')).toEqual([]);
      expect(await findStaleSources(t.db, 'model-v2')).toEqual([
        { organizationId: tenant.org.id, sourceId: source.id, title: 'Emergency service', status: 'ready', models: ['model-v1'] },
      ]);

      const lines: string[] = [];
      const embedCallsBefore = v2.provider.requests.length;
      const dryRun = await reembedStaleSources(
        { db: t.db, embedder: v2.embedder, logger: silentLogger },
        { dryRun: true, print: (line) => lines.push(line) },
      );
      expect(dryRun).toEqual({ found: 1, reembedded: 0, failed: 0, remaining: 0 });
      // A dry run embeds nothing.
      expect(v2.provider.requests).toHaveLength(embedCallsBefore);
      expect(lines.some((line) => line.includes('[dry run]') && line.includes('Emergency service'))).toBe(true);

      expect(
        await reembedStaleSources(
          { db: t.db, embedder: v2.embedder, logger: silentLogger },
          { dryRun: false, print: () => undefined },
        ),
      ).toEqual({ found: 1, reembedded: 1, failed: 0, remaining: 0 });

      const models = await t.db.query<{ embedding_model: string }>(
        'select distinct embedding_model from public.knowledge_chunks where source_id = $1',
        [source.id],
      );
      expect(models).toEqual([{ embedding_model: 'model-v2' }]);
      expect((await ask(t, tenant, v2.embedder, 'emergency boiler repair')).map((chunk) => chunk.sourceId)).toEqual([
        source.id,
      ]);
      expect(await findStaleSources(t.db, 'model-v2')).toEqual([]);
    }));

  it('stops on a provider outage and resumes on the next run', () =>
    withDatabase(async (t) => {
      const tenant = await t.service.run((sql) => createTenant(sql));
      const old = embedderFor('model-old').embedder;
      const sources = [
        await ingest(t, tenant, old, 'Hours', 'We open at 8am on weekdays.'),
        await ingest(t, tenant, old, 'Pricing', 'Our call-out fee is $89.'),
        await ingest(t, tenant, old, 'Area', 'We serve Springfield and Shelbyville.'),
      ];
      const next = embedderFor('model-new');
      // The provider goes down after the first source and stays down for this run.
      let calls = 0;
      const flaky: Embedder = {
        model: 'model-new',
        async embed(texts, context) {
          calls += 1;
          if (calls >= 2) throw new ProviderError({ provider: 'fake', code: 'unavailable', message: 'down', retryable: true });
          return next.embedder.embed(texts, context);
        },
      };

      const first = await reembedStaleSources({ db: t.db, embedder: flaky, logger: silentLogger }, { dryRun: false, print: () => undefined });
      // One done, one failed, and the third never attempted (no cascade of failures).
      expect(first).toEqual({ found: 3, reembedded: 1, failed: 1, remaining: 1 });
      expect(calls).toBe(2);

      // The failed source and the untouched one are both picked up again once the provider recovers.
      expect((await findStaleSources(t.db, 'model-new')).map((source) => source.status).sort()).toEqual(['failed', 'ready']);
      const second = await reembedStaleSources(
        { db: t.db, embedder: next.embedder, logger: silentLogger },
        { dryRun: false, print: () => undefined },
      );
      expect(second).toEqual({ found: 2, reembedded: 2, failed: 0, remaining: 0 });
      const models = await t.db.query<{ source_id: string; embedding_model: string }>(
        'select distinct source_id, embedding_model from public.knowledge_chunks where organization_id = $1',
        [tenant.org.id],
      );
      expect(models).toHaveLength(sources.length);
      expect(new Set(models.map((row) => row.embedding_model))).toEqual(new Set(['model-new']));
    }));

  it('reports failures and leaves sources already on the current model alone', () =>
    withDatabase(async (t) => {
      const tenant = await t.service.run((sql) => createTenant(sql));
      const v3 = embedderFor('model-v3');
      const current = await ingest(t, tenant, v3.embedder, 'Hours', 'We open at 8am on weekdays.');
      const old = await ingest(t, tenant, embedderFor('model-old').embedder, 'Pricing', 'Our call-out fee is $89.');

      v3.provider.failNext = new ProviderError({ provider: 'fake', code: 'unavailable', message: 'down', retryable: true });
      expect(
        await reembedStaleSources(
          { db: t.db, embedder: v3.embedder, logger: silentLogger },
          { dryRun: false, print: () => undefined },
        ),
      ).toEqual({ found: 1, reembedded: 0, failed: 1, remaining: 0 });

      const statuses = await t.db.query<{ id: string; status: string }>(
        'select id, status from public.knowledge_sources where organization_id = $1 order by title',
        [tenant.org.id],
      );
      // The failed re-embed is visible to admins (they can retry it); the current-model source was never touched.
      expect(statuses).toEqual([
        { id: current.id, status: 'ready' },
        { id: old.id, status: 'failed' },
      ]);
    }));
});
