import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RetrievalBudget } from '@/server/agent/tools/types';
import type { Embedder, EmbedOutcome } from '@/server/ai/embedder';
import { ProviderError } from '@/server/ai/types';
import { pgTextArray } from '@/server/db/sql';
import { ingestTextSource, reindexKnowledgeSource } from '@/server/domain/knowledge/ingestion';
import { retrieveChunks, searchKnowledge } from '@/server/domain/knowledge/retrieval';
import type { KnowledgeSource } from '@/server/domain/knowledge/types';
import type { EmbeddingUsagePurpose, UsageContext } from '@/server/domain/usage/types';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { FakeEmbeddingProvider, fakeEmbed } from '../support/fake-embeddings';
import { createAgent, createConversation, createTenant, type TenantFixture } from '../support/fixtures';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.close();
});

type EmbedContext = UsageContext & { purpose: EmbeddingUsagePurpose };

/** Embedder over the deterministic fake provider that records every call. */
function recordingEmbedder(model = 'fake-embedding-model') {
  const provider = new FakeEmbeddingProvider();
  const calls: Array<{ texts: string[]; context: EmbedContext }> = [];
  const embedder: Embedder = {
    model,
    async embed(texts, context): Promise<EmbedOutcome> {
      calls.push({ texts: [...texts], context: { ...context } });
      const result = await provider.embed({ model, input: [...texts], dimensions: 1536 });
      return { vectors: result.vectors, model: result.model };
    },
  };
  return { embedder, calls };
}

const BUDGET: RetrievalBudget = { maxChunks: 5, maxTokens: 1800, minSimilarity: 0.3 };

const HOME_SERVICES = [
  '# Emergency service',
  'We offer 24/7 emergency boiler repair across Springfield.',
  '',
  '# Pricing',
  'Our standard call-out fee is 89 dollars per visit.',
  '',
  '# Payment methods',
  'We accept cash, cheques and all major credit cards.',
].join('\n');

const EMERGENCY_QUESTION = 'Do you offer emergency boiler repair?';

const newTenant = () => t.service.run((sql) => createTenant(sql));

async function ingest(
  tenant: TenantFixture,
  text: string,
  options: { agentId?: string | null; embedder?: Embedder; title?: string } = {},
): Promise<KnowledgeSource> {
  const source = await ingestTextSource(t.service, options.embedder ?? recordingEmbedder().embedder, {
    organizationId: tenant.org.id,
    agentId: options.agentId === undefined ? null : options.agentId,
    kind: 'text',
    title: options.title ?? 'Knowledge',
    text,
    createdBy: tenant.owner.id,
  });
  expect(source.status).toBe('ready');
  return source;
}

function search(tenant: TenantFixture, query: string, overrides: { agentId?: string; budget?: Partial<RetrievalBudget> } = {}) {
  return searchKnowledge(t.service, recordingEmbedder().embedder, {
    organizationId: tenant.org.id,
    agentId: overrides.agentId ?? tenant.agent.id,
    query,
    budget: { ...BUDGET, ...overrides.budget },
  });
}

describe('searchKnowledge relevance', () => {
  it('retrieves the chunk that answers the question', async () => {
    const tenant = await newTenant();
    const source = await ingest(tenant, HOME_SERVICES, { title: 'Home services' });

    const results = await search(tenant, EMERGENCY_QUESTION);

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]).toMatchObject({
      sourceId: source.id,
      sourceTitle: 'Home services',
      content: 'Emergency service\n\nWe offer 24/7 emergency boiler repair across Springfield.',
    });
    expect(results[0]!.similarity).toBeGreaterThanOrEqual(BUDGET.minSimilarity);
    expect(results[0]!.tokenCount).toBeGreaterThan(0);
    expect(results.every((result) => !result.content.includes('credit cards'))).toBe(true);
  });

  it('returns nothing for an unrelated question (relevance threshold)', async () => {
    const tenant = await newTenant();
    await ingest(tenant, HOME_SERVICES);

    expect(await search(tenant, 'What is the capital of Mongolia?')).toEqual([]);
    // Without a threshold the same question would have produced candidates.
    expect((await search(tenant, 'What is the capital of Mongolia?', { budget: { minSimilarity: -1 } })).length).toBe(3);
  });

  it('caps the number of chunks and the total tokens, in similarity order', async () => {
    const tenant = await newTenant();
    await ingest(
      tenant,
      [
        '# Boiler servicing',
        'Annual boiler servicing keeps your boiler safe.',
        '# Boiler installation',
        'New boiler installation includes a boiler warranty.',
        '# Boiler repair',
        'Fast boiler repair for every boiler brand.',
        '# Boiler parts',
        'We stock boiler parts for older boiler models.',
      ].join('\n'),
    );

    const all = await search(tenant, 'boiler', { budget: { maxChunks: 10 } });
    expect(all).toHaveLength(4);
    const similarities = all.map((result) => result.similarity);
    expect(similarities).toEqual([...similarities].sort((a, b) => b - a));

    const topTwo = await search(tenant, 'boiler', { budget: { maxChunks: 2 } });
    expect(topTwo.map((result) => result.chunkId)).toEqual(all.slice(0, 2).map((result) => result.chunkId));

    const first = all[0]!;
    const second = all[1]!;
    const oneByTokens = await search(tenant, 'boiler', { budget: { maxTokens: first.tokenCount + second.tokenCount - 1 } });
    expect(oneByTokens.map((result) => result.chunkId)).toEqual([first.chunkId]);
    const twoByTokens = await search(tenant, 'boiler', { budget: { maxTokens: first.tokenCount + second.tokenCount } });
    expect(twoByTokens).toHaveLength(2);
    expect(await search(tenant, 'boiler', { budget: { maxTokens: first.tokenCount - 1 } })).toEqual([]);
  });
});

describe('searchKnowledge scoping', () => {
  it('shows agent-scoped knowledge only to its agent and shared knowledge to every agent', async () => {
    const tenant = await newTenant();
    const poolAgent = await t.service.run((sql) => createAgent(sql, tenant.org.id, { name: 'Pool desk' }));
    const shared = await ingest(tenant, HOME_SERVICES, { agentId: null });
    const scoped = await ingest(tenant, '# Pool cleaning\nAgent two handles swimming pool cleaning in Shelbyville.', {
      agentId: poolAgent.id,
    });

    const poolQuestion = 'Do you clean swimming pools?';
    expect(await search(tenant, poolQuestion)).toEqual([]);
    const forPoolAgent = await search(tenant, poolQuestion, { agentId: poolAgent.id });
    expect(forPoolAgent.map((result) => result.sourceId)).toEqual([scoped.id]);

    for (const agentId of [tenant.agent.id, poolAgent.id]) {
      const results = await search(tenant, EMERGENCY_QUESTION, { agentId });
      expect(results[0]?.sourceId).toBe(shared.id);
    }
  });

  it('ignores chunks embedded by a different model until the source is reindexed', async () => {
    const tenant = await newTenant();
    const legacy = recordingEmbedder('legacy-embedding-model');
    const source = await ingest(tenant, HOME_SERVICES, { embedder: legacy.embedder });

    expect(await search(tenant, EMERGENCY_QUESTION)).toEqual([]);

    await reindexKnowledgeSource(t.service, recordingEmbedder().embedder, tenant.org.id, source.id);
    expect((await search(tenant, EMERGENCY_QUESTION))[0]?.sourceId).toBe(source.id);
  });

  it('ignores sources that are not ready', async () => {
    const tenant = await newTenant();
    const source = await ingest(tenant, HOME_SERVICES);
    const setStatus = (status: string) =>
      t.db.query('update public.knowledge_sources set status = $2 where id = $1', [source.id, status]);

    for (const status of ['processing', 'failed', 'pending']) {
      await setStatus(status);
      expect(await search(tenant, EMERGENCY_QUESTION)).toEqual([]);
    }
    await setStatus('ready');
    expect(await search(tenant, EMERGENCY_QUESTION)).toHaveLength(1);
  });
});

describe('tenant isolation', () => {
  it("never returns another organization's chunks, even for identical text", async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    const sourceA = await ingest(tenantA, HOME_SERVICES, { agentId: null });
    const sourceB = await ingest(tenantB, HOME_SERVICES, { agentId: null });

    const resultsA = await search(tenantA, EMERGENCY_QUESTION, { budget: { minSimilarity: -1 } });
    const resultsB = await search(tenantB, EMERGENCY_QUESTION, { budget: { minSimilarity: -1 } });

    expect(resultsA).toHaveLength(3);
    expect(resultsA.every((result) => result.sourceId === sourceA.id)).toBe(true);
    expect(resultsB.every((result) => result.sourceId === sourceB.id)).toBe(true);
    const chunkOrgs = await t.db.query<{ organization_id: string }>(
      'select distinct organization_id from public.knowledge_chunks where id = any($1::uuid[])',
      [pgTextArray(resultsA.map((result) => result.chunkId))],
    );
    expect(chunkOrgs).toEqual([{ organization_id: tenantA.org.id }]);
    const idsB = new Set(resultsB.map((result) => result.chunkId));
    expect(resultsA.some((result) => idsB.has(result.chunkId))).toBe(false);
  });

  it("returns nothing when the agent belongs to another organization", async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    await ingest(tenantA, HOME_SERVICES, { agentId: null });
    await ingest(tenantB, HOME_SERVICES, { agentId: null });
    const embedding = fakeEmbed(EMERGENCY_QUESTION);
    const query = { embedding, embeddingModel: 'fake-embedding-model', maxChunks: 5, maxTokens: 1800, minSimilarity: -1 };

    const mixed = await t.service.run(async (sql) => ({
      orgAWithAgentB: await retrieveChunks(sql, { ...query, organizationId: tenantA.org.id, agentId: tenantB.agent.id }),
      orgBWithAgentA: await retrieveChunks(sql, { ...query, organizationId: tenantB.org.id, agentId: tenantA.agent.id }),
      own: await retrieveChunks(sql, { ...query, organizationId: tenantA.org.id, agentId: tenantA.agent.id }),
    }));

    expect(mixed.orgAWithAgentB).toEqual([]);
    expect(mixed.orgBWithAgentA).toEqual([]);
    expect(mixed.own).toHaveLength(3);
  });

  it("does not let a user scope read another organization's knowledge (RLS)", async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    await ingest(tenantA, HOME_SERVICES, { agentId: null });

    const results = await searchKnowledge(t.asUser(tenantB.owner.id), recordingEmbedder().embedder, {
      organizationId: tenantA.org.id,
      agentId: tenantA.agent.id,
      query: EMERGENCY_QUESTION,
      budget: BUDGET,
    });
    expect(results).toEqual([]);

    const own = await searchKnowledge(t.asUser(tenantA.owner.id), recordingEmbedder().embedder, {
      organizationId: tenantA.org.id,
      agentId: tenantA.agent.id,
      query: EMERGENCY_QUESTION,
      budget: BUDGET,
    });
    expect(own).toHaveLength(1);
  });
});

describe('searchKnowledge embedding', () => {
  it('embeds the normalized query once with the usage context', async () => {
    const tenant = await newTenant();
    await ingest(tenant, HOME_SERVICES);
    const conversation = await t.service.run((sql) => createConversation(sql, tenant.org.id, tenant.agent.id));
    const { embedder, calls } = recordingEmbedder();

    const results = await searchKnowledge(t.service, embedder, {
      organizationId: tenant.org.id,
      agentId: tenant.agent.id,
      conversationId: conversation.id,
      query: `  Do you offer\n emergency   boiler repair?  `,
      budget: BUDGET,
    });

    expect(results).toHaveLength(1);
    expect(calls).toEqual([
      {
        texts: [EMERGENCY_QUESTION],
        context: {
          organizationId: tenant.org.id,
          agentId: tenant.agent.id,
          conversationId: conversation.id,
          purpose: 'knowledge_query',
        },
      },
    ]);
  });

  it('skips the embedder for blank queries', async () => {
    const tenant = await newTenant();
    const { embedder, calls } = recordingEmbedder();

    const results = await searchKnowledge(t.service, embedder, {
      organizationId: tenant.org.id,
      agentId: tenant.agent.id,
      query: ' \n\t ',
      budget: BUDGET,
    });

    expect(results).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('propagates embedding failures instead of reporting that nothing was found', async () => {
    const tenant = await newTenant();
    const failing: Embedder = {
      model: 'fake-embedding-model',
      embed: async () => {
        throw new ProviderError({ provider: 'fake', code: 'unavailable', message: 'down', retryable: true });
      },
    };

    await expect(
      searchKnowledge(t.service, failing, {
        organizationId: tenant.org.id,
        agentId: tenant.agent.id,
        query: EMERGENCY_QUESTION,
        budget: BUDGET,
      }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('never returns chunks for a zero query vector (undefined cosine similarity)', async () => {
    const tenant = await newTenant();
    await ingest(tenant, HOME_SERVICES);

    const results = await t.service.run((sql) =>
      retrieveChunks(sql, {
        organizationId: tenant.org.id,
        agentId: tenant.agent.id,
        embedding: new Array<number>(1536).fill(0),
        embeddingModel: 'fake-embedding-model',
        ...BUDGET,
        minSimilarity: -1,
      }),
    );
    expect(results).toEqual([]);
  });

  it('rejects query embeddings with the wrong dimension', async () => {
    const tenant = await newTenant();
    await expect(
      t.service.run((sql) =>
        retrieveChunks(sql, {
          organizationId: tenant.org.id,
          agentId: tenant.agent.id,
          embedding: [0.1, 0.2],
          embeddingModel: 'fake-embedding-model',
          ...BUDGET,
        }),
      ),
    ).rejects.toThrow(/dimensions/);
  });
});
