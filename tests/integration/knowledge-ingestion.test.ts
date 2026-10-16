import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Embedder, EmbedOutcome } from '@/server/ai/embedder';
import { ProviderError } from '@/server/ai/types';
import {
  deleteKnowledgeSource,
  getKnowledgeSource,
  ingestTextSource,
  listKnowledgeSources,
  reindexKnowledgeSource,
  type IngestTextInput,
} from '@/server/domain/knowledge/ingestion';
import { normalizeKnowledgeText } from '@/server/domain/knowledge/normalize';
import { DomainError } from '@/server/domain/types';
import type { EmbeddingUsagePurpose, UsageContext } from '@/server/domain/usage/types';
import { silentLogger, type LogFields, type Logger } from '@/server/observability/logger';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { FakeEmbeddingProvider } from '../support/fake-embeddings';
import { addMember, createAuthUser, createTenant, type TenantFixture } from '../support/fixtures';

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
  return { embedder, provider, calls };
}

/** Logger that records warnings and errors (failure details must reach operators, not admins). */
function recordingLogger() {
  const events: Array<{ event: string; fields: LogFields | undefined }> = [];
  const record = (event: string, fields?: LogFields) => events.push({ event, fields });
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: record,
    error: record,
    child: () => logger,
  };
  return { logger, events };
}

const GUIDE = [
  '# Emergency service',
  'We offer 24/7 emergency boiler repair across Springfield.',
  '',
  '# Pricing',
  'Our standard call-out fee is 89 dollars per visit.',
].join('\n');

function textInput(tenant: TenantFixture, overrides: Partial<IngestTextInput> = {}): IngestTextInput {
  return {
    organizationId: tenant.org.id,
    agentId: tenant.agent.id,
    kind: 'text',
    title: 'Boiler guide',
    text: GUIDE,
    createdBy: tenant.owner.id,
    ...overrides,
  };
}

interface ChunkRow {
  id: string;
  organization_id: string;
  chunk_index: number;
  content: string;
  token_count: number;
  embedding_model: string;
  metadata: { heading: string | null };
  dims: number;
}

function chunkRows(sourceId: string): Promise<ChunkRow[]> {
  return t.db.query<ChunkRow>(
    `select id, organization_id, chunk_index, content, token_count, embedding_model, metadata,
            extensions.vector_dims(embedding) as dims
     from public.knowledge_chunks where source_id = $1 order by chunk_index`,
    [sourceId],
  );
}

async function countRows(table: 'knowledge_sources' | 'knowledge_documents' | 'knowledge_chunks', organizationId: string) {
  const rows = await t.db.query<{ n: number }>(`select count(*)::int as n from public.${table} where organization_id = $1`, [
    organizationId,
  ]);
  return rows[0]!.n;
}

const newTenant = () => t.service.run((sql) => createTenant(sql));

describe('ingestTextSource', () => {
  it('stores a ready source with its normalized document and embedded chunks', async () => {
    const tenant = await newTenant();
    const { embedder, calls } = recordingEmbedder();
    const raw = `${GUIDE.replace(/\n/g, '\r\n')}  \r\n\r\n\r\n`;

    const source = await ingestTextSource(t.service, embedder, textInput(tenant, { title: '  Boiler   guide ', text: raw }));

    expect(source).toMatchObject({
      organizationId: tenant.org.id,
      agentId: tenant.agent.id,
      kind: 'text',
      title: 'Boiler guide',
      status: 'ready',
      error: null,
      fileName: null,
      mimeType: null,
      byteSize: null,
      chunkCount: 2,
    });
    expect(source.createdAt).toBeInstanceOf(Date);

    const documents = await t.db.query<{ title: string; content: string; content_sha256: string; char_count: number }>(
      'select title, content, content_sha256, char_count from public.knowledge_documents where source_id = $1',
      [source.id],
    );
    expect(documents).toHaveLength(1);
    const content = normalizeKnowledgeText(raw);
    expect(content).toBe(GUIDE);
    expect(documents[0]).toEqual({
      title: 'Boiler guide',
      content,
      content_sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
      char_count: content.length,
    });

    const chunks = await chunkRows(source.id);
    expect(chunks.map((chunk) => chunk.chunk_index)).toEqual([0, 1]);
    expect(chunks.map((chunk) => chunk.metadata)).toEqual([{ heading: 'Emergency service' }, { heading: 'Pricing' }]);
    expect(chunks[0]!.content).toBe('Emergency service\n\nWe offer 24/7 emergency boiler repair across Springfield.');
    for (const chunk of chunks) {
      expect(chunk).toMatchObject({ organization_id: tenant.org.id, embedding_model: 'fake-embedding-model', dims: 1536 });
      expect(chunk.token_count).toBeGreaterThan(0);
    }

    expect(calls).toEqual([
      {
        texts: chunks.map((chunk) => chunk.content),
        context: { organizationId: tenant.org.id, agentId: tenant.agent.id, purpose: 'knowledge_ingestion' },
      },
    ]);
  });

  it('stores file metadata and meters shared sources against the organization only', async () => {
    const tenant = await newTenant();
    const { embedder, calls } = recordingEmbedder();

    const source = await ingestTextSource(
      t.service,
      embedder,
      textInput(tenant, {
        agentId: null,
        kind: 'file',
        title: 'FAQ',
        file: { name: ' faq.md ', mimeType: 'text/markdown', byteSize: 1234 },
      }),
    );

    expect(source).toMatchObject({
      agentId: null,
      kind: 'file',
      status: 'ready',
      fileName: 'faq.md',
      mimeType: 'text/markdown',
      byteSize: 1234,
    });
    expect(calls[0]!.context).toEqual({ organizationId: tenant.org.id, agentId: null, purpose: 'knowledge_ingestion' });
  });

  it('tags chunks with the model that produced the vectors', async () => {
    const tenant = await newTenant();
    const snapshot = recordingEmbedder('fake-embedding-model-2026-10-01');
    const aliased: Embedder = { model: 'fake-embedding-model', embed: (texts, context) => snapshot.embedder.embed(texts, context) };

    const source = await ingestTextSource(t.service, aliased, textInput(tenant));

    const models = (await chunkRows(source.id)).map((chunk) => chunk.embedding_model);
    expect(models).toEqual(['fake-embedding-model-2026-10-01', 'fake-embedding-model-2026-10-01']);
  });

  it('embeds in batches of 64', async () => {
    const tenant = await newTenant();
    const { embedder, calls } = recordingEmbedder();
    const text = Array.from({ length: 70 }, (_, i) => `## Topic ${i}\n\nDetails about topic number ${i}.`).join('\n\n');

    const source = await ingestTextSource(t.service, embedder, textInput(tenant, { text }));

    expect(source).toMatchObject({ status: 'ready', chunkCount: 70 });
    expect(calls.map((call) => call.texts.length)).toEqual([64, 6]);
    const chunks = await chunkRows(source.id);
    expect(chunks.map((chunk) => chunk.chunk_index)).toEqual(Array.from({ length: 70 }, (_, i) => i));
    expect(chunks[69]!.content).toBe('Topic 69\n\nDetails about topic number 69.');
  });

  it('marks the source failed with a safe message and no chunks when the provider fails', async () => {
    const tenant = await newTenant();
    const { embedder, provider } = recordingEmbedder();
    const { logger, events } = recordingLogger();
    provider.failNext = new ProviderError({
      provider: 'fake',
      code: 'unavailable',
      message: 'upstream 503 at internal-host:8443',
      retryable: true,
    });

    const source = await ingestTextSource(t.service, embedder, textInput(tenant), { logger });

    expect(source).toMatchObject({
      status: 'failed',
      error: 'The embedding service is unavailable. Please try again later.',
      chunkCount: 0,
    });
    expect(await chunkRows(source.id)).toEqual([]);
    // Operators get the provider and error code, never the raw provider message.
    expect(events).toEqual([
      {
        event: 'knowledge.embedding_failed',
        fields: { organizationId: tenant.org.id, sourceId: source.id, provider: 'fake', code: 'unavailable' },
      },
    ]);
    // The document is kept so the source can be retried.
    expect(await countRows('knowledge_documents', tenant.org.id)).toBe(1);
  });

  it('reports invalid embedder output and unexpected errors with safe messages', async () => {
    const tenant = await newTenant();
    const shortVectors: Embedder = {
      model: 'broken-model',
      embed: async (texts) => ({ vectors: texts.map(() => [0.1, 0.2, 0.3]), model: 'broken-model' }),
    };
    const missingVector: Embedder = {
      model: 'broken-model',
      embed: async () => ({ vectors: [new Array<number>(1536).fill(0.1)], model: 'broken-model' }), // 2 chunks, 1 vector
    };
    const crashing: Embedder = {
      model: 'crashing-model',
      embed: async () => {
        throw new Error('socket hang up');
      },
    };

    for (const embedder of [shortVectors, missingVector]) {
      const invalid = await ingestTextSource(t.service, embedder, textInput(tenant), { logger: silentLogger });
      expect(invalid).toMatchObject({
        status: 'failed',
        error: 'The embedding service returned an invalid result. Please try again later.',
      });
    }
    const crashed = await ingestTextSource(t.service, crashing, textInput(tenant), { logger: silentLogger });
    expect(crashed).toMatchObject({ status: 'failed', error: 'Processing failed.' });
    expect(await countRows('knowledge_chunks', tenant.org.id)).toBe(0);
  });

  it('embeds outside any transaction and throws not_found when the source is deleted meanwhile', async () => {
    const tenant = await newTenant();
    const { embedder: inner, calls } = recordingEmbedder();
    // A root-handle query here would deadlock PGlite (a single session) if a transaction were still open.
    const deletingEmbedder: Embedder = {
      model: inner.model,
      async embed(texts, context) {
        await t.db.query('delete from public.knowledge_sources where organization_id = $1', [tenant.org.id]);
        return inner.embed(texts, context);
      },
    };

    await expect(ingestTextSource(t.service, deletingEmbedder, textInput(tenant))).rejects.toEqual(
      new DomainError('not_found', 'Knowledge source not found.'),
    );

    expect(calls).toHaveLength(1);
    expect(await countRows('knowledge_sources', tenant.org.id)).toBe(0);
    expect(await countRows('knowledge_chunks', tenant.org.id)).toBe(0);
  });

  it('fails without calling the embedder when no readable text remains', async () => {
    const tenant = await newTenant();
    const { embedder, calls } = recordingEmbedder();

    const controls = await ingestTextSource(t.service, embedder, textInput(tenant, { text: String.fromCharCode(1, 2, 3) }));
    const headingsOnly = await ingestTextSource(t.service, embedder, textInput(tenant, { text: '# Title\n\n## Subtitle' }));

    for (const source of [controls, headingsOnly]) {
      expect(source).toMatchObject({ status: 'failed', error: 'No readable text found.', chunkCount: 0 });
    }
    expect(calls).toEqual([]);
  });

  it('rejects invalid input before writing anything', async () => {
    const tenant = await newTenant();
    const { embedder, calls } = recordingEmbedder();
    const cases: Array<[Partial<IngestTextInput>, string]> = [
      [{ title: '   ' }, 'Enter a title.'],
      [{ text: ' \n ' }, 'Enter some text.'],
      [{ agentId: 'front-desk' }, 'Choose a valid agent.'],
      [{ kind: 'file' }, 'File details are required.'],
      [{ kind: 'file', file: { name: 'a.md', mimeType: 'text/markdown', byteSize: -1 } }, 'The file details are invalid.'],
      [{ organizationId: 'not-an-id' }, 'Invalid identifier.'],
    ];

    for (const [overrides, message] of cases) {
      await expect(ingestTextSource(t.service, embedder, textInput(tenant, overrides))).rejects.toEqual(
        new DomainError('invalid', message),
      );
    }
    expect(await countRows('knowledge_sources', tenant.org.id)).toBe(0);
    expect(calls).toEqual([]);
  });

  it("rejects another organization's agent (composite foreign key)", async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    const { embedder, calls } = recordingEmbedder();

    await expect(
      ingestTextSource(t.service, embedder, textInput(tenantA, { agentId: tenantB.agent.id })),
    ).rejects.toMatchObject({ name: 'DomainError', code: 'invalid', message: 'Choose a valid agent.' });

    expect(await countRows('knowledge_sources', tenantA.org.id)).toBe(0);
    expect(await countRows('knowledge_sources', tenantB.org.id)).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe('row level security (user scope)', () => {
  it('lets owners and admins ingest but rejects members', async () => {
    const tenant = await newTenant();
    const member = await t.service.run((sql) => createAuthUser(sql));
    const admin = await t.service.run((sql) => createAuthUser(sql));
    await t.service.run(async (sql) => {
      await addMember(sql, tenant.org.id, member.id, 'member');
      await addMember(sql, tenant.org.id, admin.id, 'admin');
    });
    const { embedder, calls } = recordingEmbedder();

    await expect(
      ingestTextSource(t.asUser(member.id), embedder, textInput(tenant, { createdBy: member.id })),
    ).rejects.toMatchObject({ name: 'DomainError', code: 'forbidden' });
    expect(calls).toEqual([]);
    expect(await countRows('knowledge_sources', tenant.org.id)).toBe(0);

    const byOwner = await ingestTextSource(t.asUser(tenant.owner.id), embedder, textInput(tenant));
    expect(byOwner).toMatchObject({ status: 'ready', chunkCount: 2 });
    const byAdmin = await ingestTextSource(t.asUser(admin.id), embedder, textInput(tenant, { createdBy: admin.id }));
    expect(byAdmin.status).toBe('ready');

    // Members can read knowledge but not change it.
    const visible = await listKnowledgeSources(t.asUser(member.id), tenant.org.id);
    expect(visible.map((source) => source.id).sort()).toEqual([byOwner.id, byAdmin.id].sort());
    expect(await deleteKnowledgeSource(t.asUser(member.id), tenant.org.id, byOwner.id)).toBe(false);
    await expect(reindexKnowledgeSource(t.asUser(member.id), embedder, tenant.org.id, byOwner.id)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect((await getKnowledgeSource(t.service, tenant.org.id, byOwner.id))?.status).toBe('ready');
  });

  it("rejects a user writing into an organization they don't belong to", async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    const { embedder } = recordingEmbedder();

    await expect(
      ingestTextSource(t.asUser(tenantB.owner.id), embedder, textInput(tenantA, { createdBy: tenantB.owner.id })),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(await countRows('knowledge_sources', tenantA.org.id)).toBe(0);
  });
});

describe('reindexKnowledgeSource', () => {
  it('replaces the chunks using the current embedding model', async () => {
    const tenant = await newTenant();
    const first = recordingEmbedder('fake-embedding-model');
    const source = await ingestTextSource(t.service, first.embedder, textInput(tenant));
    const before = await chunkRows(source.id);

    const next = recordingEmbedder('fake-embedding-model-v2');
    const reindexed = await reindexKnowledgeSource(t.service, next.embedder, tenant.org.id, source.id);

    expect(reindexed).toMatchObject({ id: source.id, status: 'ready', error: null, chunkCount: before.length });
    const after = await chunkRows(source.id);
    expect(after.map((chunk) => chunk.content)).toEqual(before.map((chunk) => chunk.content));
    expect(after.every((chunk) => chunk.embedding_model === 'fake-embedding-model-v2')).toBe(true);
    expect(after.some((chunk) => before.some((old) => old.id === chunk.id))).toBe(false);
    expect(next.calls.map((call) => call.context)).toEqual([
      { organizationId: tenant.org.id, agentId: tenant.agent.id, purpose: 'knowledge_ingestion' },
    ]);
  });

  it('retries a failed source', async () => {
    const tenant = await newTenant();
    const { embedder, provider } = recordingEmbedder();
    provider.failNext = new ProviderError({ provider: 'fake', code: 'rate_limited', message: 'slow down', retryable: true });
    const failed = await ingestTextSource(t.service, embedder, textInput(tenant), { logger: silentLogger });
    expect(failed.status).toBe('failed');

    const retried = await reindexKnowledgeSource(t.service, embedder, tenant.org.id, failed.id);

    expect(retried).toMatchObject({ status: 'ready', error: null, chunkCount: 2 });
    expect(await chunkRows(failed.id)).toHaveLength(2);
  });

  it("recovers a source left 'processing' by an interrupted request", async () => {
    const tenant = await newTenant();
    const { embedder } = recordingEmbedder();
    const source = await ingestTextSource(t.service, embedder, textInput(tenant));
    // State after a crash between tx1 and tx2: processing, document stored, no chunks.
    await t.db.query("update public.knowledge_sources set status = 'processing', chunk_count = 0 where id = $1", [source.id]);
    await t.db.query('delete from public.knowledge_chunks where source_id = $1', [source.id]);

    const recovered = await reindexKnowledgeSource(t.service, embedder, tenant.org.id, source.id);

    expect(recovered).toMatchObject({ status: 'ready', error: null, chunkCount: 2 });
    expect(await chunkRows(source.id)).toHaveLength(2);
  });

  it('only claims retryable sources when asked, so concurrent retries cannot both re-embed', async () => {
    const tenant = await newTenant();
    const { embedder, provider } = recordingEmbedder();
    const source = await ingestTextSource(t.service, embedder, textInput(tenant));
    const options = { onlyIfRetryable: { staleProcessingMs: 5 * 60_000 } };
    const retry = () => reindexKnowledgeSource(t.service, embedder, tenant.org.id, source.id, options);

    // A ready source does not need a retry.
    await expect(retry()).rejects.toMatchObject({ code: 'conflict' });

    // A source another request is processing right now is left alone (no second, billed embedding run).
    await t.db.query("update public.knowledge_sources set status = 'processing' where id = $1", [source.id]);
    const embedCalls = provider.requests.length;
    await expect(retry()).rejects.toMatchObject({ code: 'conflict' });
    expect(provider.requests).toHaveLength(embedCalls);

    // One stuck past the threshold (an interrupted request) is recovered. Backdating bypasses the touch trigger.
    await t.db.transaction(async (tx) => {
      await tx.query("set local session_replication_role = 'replica'");
      await tx.query("update public.knowledge_sources set updated_at = now() - interval '10 minutes' where id = $1", [source.id]);
    });
    expect(await retry()).toMatchObject({ status: 'ready', chunkCount: 2 });
    // The claim refreshed updated_at, so an immediate second retry is refused again.
    await t.db.query("update public.knowledge_sources set status = 'processing' where id = $1", [source.id]);
    await expect(retry()).rejects.toMatchObject({ code: 'conflict' });
  });

  it('marks the source failed and drops its chunks when re-embedding fails', async () => {
    const tenant = await newTenant();
    const { embedder, provider } = recordingEmbedder();
    const source = await ingestTextSource(t.service, embedder, textInput(tenant));
    provider.failNext = new ProviderError({ provider: 'fake', code: 'timeout', message: 'timed out', retryable: true });

    const result = await reindexKnowledgeSource(t.service, embedder, tenant.org.id, source.id, { logger: silentLogger });

    expect(result).toMatchObject({
      status: 'failed',
      error: 'The embedding service is unavailable. Please try again later.',
      chunkCount: 0,
    });
    expect(await chunkRows(source.id)).toEqual([]);
  });

  it("throws not_found for unknown ids and other organizations' sources", async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    const { embedder, calls } = recordingEmbedder();
    const sourceB = await ingestTextSource(t.service, embedder, textInput(tenantB));
    const chunksB = await chunkRows(sourceB.id);
    calls.length = 0;

    for (const sourceId of [randomUUID(), sourceB.id, 'not-an-id']) {
      await expect(reindexKnowledgeSource(t.service, embedder, tenantA.org.id, sourceId)).rejects.toEqual(
        new DomainError('not_found', 'Knowledge source not found.'),
      );
    }
    expect(calls).toEqual([]);
    expect(await getKnowledgeSource(t.service, tenantB.org.id, sourceB.id)).toMatchObject({ status: 'ready' });
    expect((await chunkRows(sourceB.id)).map((chunk) => chunk.id)).toEqual(chunksB.map((chunk) => chunk.id));
  });
});

describe('listing, reading and deleting sources', () => {
  it('lists newest first and maps every field', async () => {
    const tenant = await newTenant();
    const { embedder } = recordingEmbedder();
    const older = await ingestTextSource(t.service, embedder, textInput(tenant, { title: 'Older' }));
    const newer = await ingestTextSource(t.service, embedder, textInput(tenant, { title: 'Newer', agentId: null }));
    expect(await getKnowledgeSource(t.service, tenant.org.id, older.id)).toEqual(older);
    // Distinct creation times regardless of clock resolution.
    await t.db.query("update public.knowledge_sources set created_at = created_at - interval '1 minute' where id = $1", [
      older.id,
    ]);

    const sources = await listKnowledgeSources(t.service, tenant.org.id);

    expect(sources.map((source) => source.title)).toEqual(['Newer', 'Older']);
    expect(sources[0]).toEqual(newer);
    expect(sources[1]?.createdAt).toEqual(new Date(older.createdAt.getTime() - 60_000));
    expect(await getKnowledgeSource(t.service, tenant.org.id, randomUUID())).toBeNull();
    expect(await getKnowledgeSource(t.service, tenant.org.id, 'not-an-id')).toBeNull();
    expect(await listKnowledgeSources(t.service, 'not-an-id')).toEqual([]);
  });

  it('deletes a source with its document and chunks', async () => {
    const tenant = await newTenant();
    const { embedder } = recordingEmbedder();
    const source = await ingestTextSource(t.service, embedder, textInput(tenant));
    expect(await countRows('knowledge_chunks', tenant.org.id)).toBe(2);

    expect(await deleteKnowledgeSource(t.service, tenant.org.id, source.id)).toBe(true);

    expect(await getKnowledgeSource(t.service, tenant.org.id, source.id)).toBeNull();
    expect(await countRows('knowledge_documents', tenant.org.id)).toBe(0);
    expect(await countRows('knowledge_chunks', tenant.org.id)).toBe(0);
    expect(await deleteKnowledgeSource(t.service, tenant.org.id, source.id)).toBe(false);
  });

  it("never reads or deletes another tenant's sources", async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    const { embedder } = recordingEmbedder();
    const sourceA = await ingestTextSource(t.service, embedder, textInput(tenantA));
    const sourceB = await ingestTextSource(t.service, embedder, textInput(tenantB));
    const chunkIdsB = (await chunkRows(sourceB.id)).map((chunk) => chunk.id);
    const notFound = new DomainError('not_found', 'Knowledge source not found.');

    // Service scope: the organization filter alone isolates tenants.
    expect((await listKnowledgeSources(t.service, tenantA.org.id)).map((source) => source.id)).toEqual([sourceA.id]);
    expect(await getKnowledgeSource(t.service, tenantA.org.id, sourceB.id)).toBeNull();
    expect(await deleteKnowledgeSource(t.service, tenantA.org.id, sourceB.id)).toBe(false);

    // User scope: RLS also hides the other tenant even when its organization id is passed.
    const ownerA = t.asUser(tenantA.owner.id);
    expect(await listKnowledgeSources(ownerA, tenantB.org.id)).toEqual([]);
    expect(await getKnowledgeSource(ownerA, tenantB.org.id, sourceB.id)).toBeNull();
    expect(await deleteKnowledgeSource(ownerA, tenantB.org.id, sourceB.id)).toBe(false);
    await expect(reindexKnowledgeSource(ownerA, embedder, tenantB.org.id, sourceB.id)).rejects.toEqual(notFound);
    await expect(reindexKnowledgeSource(ownerA, embedder, tenantA.org.id, sourceB.id)).rejects.toEqual(notFound);

    expect(await getKnowledgeSource(t.service, tenantB.org.id, sourceB.id)).toMatchObject({ status: 'ready' });
    expect((await chunkRows(sourceB.id)).map((chunk) => chunk.id)).toEqual(chunkIdsB);
  });
});
