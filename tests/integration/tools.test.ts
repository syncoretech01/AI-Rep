import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { captureLead, getBusinessHours, getBusinessInfo, searchKnowledge } from '@/server/agent/tools/definitions';
import type { RetrievalBudget, ToolContext, ToolDefinition } from '@/server/agent/tools/types';
import type { Embedder, EmbedOutcome } from '@/server/ai/embedder';
import { ProviderError } from '@/server/ai/types';
import { getAgent } from '@/server/domain/agents/repository';
import type { LeadField } from '@/server/domain/agents/types';
import { replaceBusinessHours, upsertBusinessProfile } from '@/server/domain/business/repository';
import type { BusinessProfileInput } from '@/server/domain/business/schemas';
import { ingestTextSource } from '@/server/domain/knowledge/ingestion';
import { DomainError } from '@/server/domain/types';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { FakeEmbeddingProvider } from '../support/fake-embeddings';
import { createConversation, createTenant, type TenantFixture } from '../support/fixtures';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.close();
});

// October 2026: Tuesday the 6th, 14:05 in New York (EDT).
const NOW = new Date('2026-10-06T18:05:00Z');
const BUDGET: RetrievalBudget = { maxChunks: 5, maxTokens: 1800, minSimilarity: 0.3 };
const EMPTY_PROFILE: BusinessProfileInput = {
  businessName: null,
  description: null,
  phone: null,
  email: null,
  website: null,
  address: null,
  serviceArea: null,
};
const KNOWLEDGE = [
  '# Emergency service',
  'We offer 24/7 emergency boiler repair across Springfield.',
  '',
  '# Pricing',
  'Our standard call-out fee is 89 dollars per visit.',
].join('\n');

function fakeEmbedder(model = 'fake-embedding-model'): Embedder {
  const provider = new FakeEmbeddingProvider();
  return {
    model,
    async embed(texts): Promise<EmbedOutcome> {
      const result = await provider.embed({ model, input: [...texts], dimensions: 1536 });
      return { vectors: result.vectors, model: result.model };
    },
  };
}

const newTenant = () => t.service.run((sql) => createTenant(sql));

async function setAgent(tenant: TenantFixture, changes: { timezone?: string; requiredFields?: LeadField[] }) {
  if (changes.timezone) {
    await t.db.query('update public.agents set timezone = $2 where id = $1', [tenant.agent.id, changes.timezone]);
  }
  if (changes.requiredFields) {
    await t.db.query('update public.agents set lead_capture = $2::jsonb where id = $1', [
      tenant.agent.id,
      JSON.stringify({ enabled: true, requiredFields: changes.requiredFields }),
    ]);
  }
}

/** The ToolContext the executor builds: service scope, ids resolved server-side. */
async function contextFor(tenant: TenantFixture, overrides: Partial<ToolContext> = {}): Promise<ToolContext> {
  const agent = await t.service.run((sql) => getAgent(sql, tenant.org.id, tenant.agent.id));
  const conversation = await t.service.run((sql) => createConversation(sql, tenant.org.id, tenant.agent.id));
  return {
    organizationId: tenant.org.id,
    agent: agent!,
    conversationId: conversation.id,
    channel: 'web_chat',
    now: NOW,
    db: t.service,
    embedder: fakeEmbedder(),
    retrieval: BUDGET,
    ...overrides,
  };
}

/** Validates like the executor does, then runs the handler. */
function invoke<TSchema extends z.ZodType, TData>(tool: ToolDefinition<TSchema, TData>, args: unknown, ctx: ToolContext) {
  return tool.handler(tool.input.parse(args), ctx);
}

async function ingest(tenant: TenantFixture, text: string, title = 'Knowledge') {
  const source = await ingestTextSource(t.service, fakeEmbedder(), {
    organizationId: tenant.org.id,
    agentId: null,
    kind: 'text',
    title,
    text,
    createdBy: tenant.owner.id,
  });
  expect(source.status).toBe('ready');
  return source;
}

describe('getBusinessHours', () => {
  it("reports the weekly hours and whether the business is open now, in the agent's time zone", async () => {
    const tenant = await newTenant();
    await setAgent(tenant, { timezone: 'America/New_York' });
    const weekdays = [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, opensAt: '09:00', closesAt: '17:00' }));
    await t.service.run((sql) => replaceBusinessHours(sql, tenant.org.id, tenant.agent.id, weekdays));

    const outcome = await invoke(getBusinessHours, {}, await contextFor(tenant));

    expect(outcome).toEqual({
      ok: true,
      data: {
        timezone: 'America/New_York',
        localTime: 'Tuesday 14:05',
        isOpenNow: true,
        weekly: [
          { day: 'Sunday', hours: [] },
          { day: 'Monday', hours: ['09:00-17:00'] },
          { day: 'Tuesday', hours: ['09:00-17:00'] },
          { day: 'Wednesday', hours: ['09:00-17:00'] },
          { day: 'Thursday', hours: ['09:00-17:00'] },
          { day: 'Friday', hours: ['09:00-17:00'] },
          { day: 'Saturday', hours: [] },
        ],
        nextChange: { kind: 'closes', at: 'Tuesday 17:00' },
      },
    });
    const evening = await invoke(getBusinessHours, {}, await contextFor(tenant, { now: new Date('2026-10-06T23:30:00Z') }));
    expect(evening).toMatchObject({ ok: true, data: { isOpenNow: false, nextChange: { kind: 'opens', at: 'Wednesday 09:00' } } });
  });

  it('says so when no hours are configured', async () => {
    const tenant = await newTenant();
    expect(await invoke(getBusinessHours, {}, await contextFor(tenant))).toEqual({
      ok: true,
      data: { configured: false, note: 'Business hours are not configured.' },
    });
  });

  it("never reads another organization's hours", async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    const allWeek = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, opensAt: '00:00', closesAt: '24:00' }));
    await t.service.run((sql) => replaceBusinessHours(sql, tenantB.org.id, tenantB.agent.id, allWeek));

    const ctxA = await contextFor(tenantA);
    expect(await invoke(getBusinessHours, {}, ctxA)).toMatchObject({ ok: true, data: { configured: false } });
    // A mismatched organization/agent pair resolves nothing either.
    const ctxB = await contextFor(tenantB);
    expect(await invoke(getBusinessHours, {}, { ...ctxB, organizationId: tenantA.org.id })).toMatchObject({
      data: { configured: false },
    });
    expect(await invoke(getBusinessHours, {}, ctxB)).toMatchObject({ data: { isOpenNow: true } });
  });
});

describe('getBusinessInfo', () => {
  it('returns only the configured fields', async () => {
    const tenant = await newTenant();
    await t.service.run((sql) =>
      upsertBusinessProfile(sql, tenant.org.id, tenant.agent.id, {
        ...EMPTY_PROFILE,
        businessName: 'Springfield Heating',
        phone: '+1 555 010 0100',
        address: '12 Evergreen Terrace, Springfield',
        serviceArea: 'Springfield and Shelbyville',
      }),
    );

    expect(await invoke(getBusinessInfo, {}, await contextFor(tenant))).toEqual({
      ok: true,
      data: {
        businessName: 'Springfield Heating',
        phone: '+1 555 010 0100',
        address: '12 Evergreen Terrace, Springfield',
        serviceArea: 'Springfield and Shelbyville',
      },
    });
  });

  it('says so when nothing is configured', async () => {
    const tenant = await newTenant();
    const expected = { ok: true, data: { note: 'No business details are configured.' } };
    expect(await invoke(getBusinessInfo, {}, await contextFor(tenant))).toEqual(expected);
    await t.service.run((sql) => upsertBusinessProfile(sql, tenant.org.id, tenant.agent.id, EMPTY_PROFILE));
    expect(await invoke(getBusinessInfo, {}, await contextFor(tenant))).toEqual(expected);
  });

  it("never reads another organization's profile", async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    await t.service.run((sql) =>
      upsertBusinessProfile(sql, tenantB.org.id, tenantB.agent.id, { ...EMPTY_PROFILE, businessName: 'Tenant B Pinball' }),
    );
    const ctxB = await contextFor(tenantB);

    expect(await invoke(getBusinessInfo, {}, await contextFor(tenantA))).toMatchObject({ data: { note: expect.any(String) as unknown } });
    expect(await invoke(getBusinessInfo, {}, { ...ctxB, organizationId: tenantA.org.id })).toMatchObject({
      data: { note: 'No business details are configured.' },
    });
    expect(await invoke(getBusinessInfo, {}, ctxB)).toEqual({ ok: true, data: { businessName: 'Tenant B Pinball' } });
  });
});

describe('captureLead', () => {
  const countRows = async (organizationId: string) => {
    const [contacts] = await t.db.query<{ count: string }>('select count(*) from public.contacts where organization_id = $1', [
      organizationId,
    ]);
    const [leads] = await t.db.query<{ count: string }>('select count(*) from public.leads where organization_id = $1', [
      organizationId,
    ]);
    return { contacts: Number(contacts!.count), leads: Number(leads!.count) };
  };
  const leadDetailsOf = async (conversationId: string) => {
    const rows = await t.db.query(
      'select captured_name, captured_phone, captured_email, summary from public.leads where conversation_id = $1',
      [conversationId],
    );
    expect(rows).toHaveLength(1);
    return rows[0];
  };

  it("asks for the agent's required fields before saving anything", async () => {
    const tenant = await newTenant();
    const ctx = await contextFor(tenant);

    expect(await invoke(captureLead, {}, ctx)).toEqual({
      ok: false,
      error: {
        code: 'missing_information',
        message: 'Ask the visitor for: their name and a phone number.',
        retryable: true,
        details: { missing: ['name', 'phone'] },
      },
    });
    expect(await invoke(captureLead, { name: 'Jane', email: 'jane@example.com' }, ctx)).toMatchObject({
      ok: false,
      error: { code: 'missing_information', details: { missing: ['phone'] } },
    });
    expect(await countRows(tenant.org.id)).toEqual({ contacts: 0, leads: 0 });
  });

  it('always requires a phone number or an email address', async () => {
    const tenant = await newTenant();
    await setAgent(tenant, { requiredFields: ['name'] });
    const ctx = await contextFor(tenant);

    expect(await invoke(captureLead, { name: 'Jane', phone: '', email: null }, ctx)).toEqual({
      ok: false,
      error: {
        code: 'missing_information',
        message: 'Ask the visitor for: a phone number or email address.',
        retryable: true,
        details: { missing: ['phone or email'] },
      },
    });

    await setAgent(tenant, { requiredFields: [] });
    const noRequirements = await contextFor(tenant);
    expect(await invoke(captureLead, {}, noRequirements)).toMatchObject({ error: { details: { missing: ['phone or email'] } } });
    expect(await invoke(captureLead, { email: 'jane@example.com' }, noRequirements)).toMatchObject({ ok: true });
  });

  it('saves the contact and lead, links the conversation and reveals no ids', async () => {
    const tenant = await newTenant();
    const ctx = await contextFor(tenant);

    const first = await invoke(captureLead, { name: 'Jane Doe', phone: '(555) 123-4567', summary: 'Wants a boiler quote.' }, ctx);
    expect(first).toEqual({ ok: true, data: { saved: true, fields: ['name', 'phone', 'summary'], updatedExistingLead: false } });

    const [contact] = await t.db.query<{ id: string; name: string; phone: string; phone_normalized: string }>(
      'select id, name, phone, phone_normalized from public.contacts where organization_id = $1',
      [tenant.org.id],
    );
    expect(contact).toMatchObject({ name: 'Jane Doe', phone: '(555) 123-4567', phone_normalized: '5551234567' });
    const leads = await t.db.query<{ id: string; conversation_id: string; contact_id: string; summary: string }>(
      'select id, conversation_id, contact_id, summary from public.leads where organization_id = $1',
      [tenant.org.id],
    );
    expect(leads).toEqual([
      { id: expect.any(String) as unknown, conversation_id: ctx.conversationId, contact_id: contact!.id, summary: 'Wants a boiler quote.' },
    ]);
    const [conversation] = await t.db.query<{ contact_id: string }>('select contact_id from public.conversations where id = $1', [
      ctx.conversationId,
    ]);
    expect(conversation!.contact_id).toBe(contact!.id);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain(contact!.id);
    expect(serialized).not.toContain(leads[0]!.id);

    // A second capture in the same conversation updates its lead; the fields are everything it now holds.
    const second = await invoke(captureLead, { name: 'Jane Doe', phone: '555-123-4567', email: 'jane@example.com' }, ctx);
    expect(second).toEqual({
      ok: true,
      data: { saved: true, fields: ['name', 'phone', 'email', 'summary'], updatedExistingLead: true },
    });
    expect(await countRows(tenant.org.id)).toEqual({ contacts: 1, leads: 1 });
    expect(await leadDetailsOf(ctx.conversationId)).toEqual({
      captured_name: 'Jane Doe',
      captured_phone: '555-123-4567',
      captured_email: 'jane@example.com',
      summary: 'Wants a boiler quote.',
    });
  });

  it("reports saved only for details the lead really holds: a returning visitor's new phone number", async () => {
    const tenant = await newTenant();
    const first = await invoke(captureLead, { name: 'Cara Dee', phone: '555-401-0001', email: 'cara@example.com' }, await contextFor(tenant));
    expect(first).toMatchObject({ ok: true, data: { fields: ['name', 'phone', 'email'] } });

    // Back in a new chat with a new number: it matches the existing contact by email, and the new number is saved
    // on the lead (the contact itself never changes on what a visitor says).
    const returning = await contextFor(tenant);
    const second = await invoke(captureLead, { name: 'Cara Dee', phone: '555-401-0002', email: 'cara@example.com' }, returning);
    expect(second).toEqual({ ok: true, data: { saved: true, fields: ['name', 'phone', 'email'], updatedExistingLead: false } });
    expect(await leadDetailsOf(returning.conversationId)).toMatchObject({ captured_phone: '555-401-0002' });
    expect(await countRows(tenant.org.id)).toEqual({ contacts: 1, leads: 2 });
  });

  it('keeps the earlier phone number when a follow-up capture only adds an email address', async () => {
    const tenant = await newTenant();
    await setAgent(tenant, { requiredFields: ['name'] });
    const ctx = await contextFor(tenant);

    await invoke(captureLead, { name: 'Bob Ray', phone: '555-301-0001', summary: 'Needs a callback' }, ctx);
    const followUp = await invoke(captureLead, { name: 'Bob Ray', email: 'bob@example.com' }, ctx);

    expect(followUp).toEqual({
      ok: true,
      data: { saved: true, fields: ['name', 'phone', 'email', 'summary'], updatedExistingLead: true },
    });
    expect(await leadDetailsOf(ctx.conversationId)).toEqual({
      captured_name: 'Bob Ray',
      captured_phone: '555-301-0001',
      captured_email: 'bob@example.com',
      summary: 'Needs a callback',
    });
    // Still the contact the phone number created: no email-only contact took the lead over.
    const [lead] = await t.db.query<{ contact_id: string }>('select contact_id from public.leads where conversation_id = $1', [
      ctx.conversationId,
    ]);
    const contacts = await t.db.query<{ id: string; phone_normalized: string | null }>(
      'select id, phone_normalized from public.contacts where organization_id = $1',
      [tenant.org.id],
    );
    expect(contacts).toEqual([{ id: lead!.contact_id, phone_normalized: '5553010001' }]);
  });

  it('maps a domain validation failure to invalid_arguments with its safe message', async () => {
    const tenant = await newTenant();
    const ctx = await contextFor(tenant);
    // Bypasses the schema (which rejects this phone) to exercise the handler's own mapping.
    const outcome = await captureLead.handler({ name: 'Jane', phone: 'not a phone', email: null, summary: null }, ctx);
    expect(outcome).toEqual({
      ok: false,
      error: { code: 'invalid_arguments', message: 'A valid phone number or email address is required.', retryable: true },
    });
    expect(await countRows(tenant.org.id)).toEqual({ contacts: 0, leads: 0 });
  });

  it("cannot attach a lead to another organization's conversation", async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    const ctxB = await contextFor(tenantB);
    const ctxA = await contextFor(tenantA, { conversationId: ctxB.conversationId });

    const attempt = invoke(captureLead, { name: 'Mallory', phone: '+15550001111' }, ctxA);
    await expect(attempt).rejects.toBeInstanceOf(DomainError);
    await expect(attempt).rejects.toMatchObject({ code: 'not_found' });
    expect(await countRows(tenantA.org.id)).toEqual({ contacts: 0, leads: 0 });
    expect(await countRows(tenantB.org.id)).toEqual({ contacts: 0, leads: 0 });
  });
});

describe('searchKnowledge', () => {
  it('returns the relevant chunks as { source, content } only', async () => {
    const tenant = await newTenant();
    await ingest(tenant, KNOWLEDGE, 'Home services');

    const outcome = await invoke(searchKnowledge, { query: 'Do you offer emergency boiler repair?' }, await contextFor(tenant));

    expect(outcome).toEqual({
      ok: true,
      data: {
        results: [{ source: 'Home services', content: 'Emergency service\n\nWe offer 24/7 emergency boiler repair across Springfield.' }],
      },
    });
  });

  it('tells the model not to guess when nothing relevant is found', async () => {
    const tenant = await newTenant();
    await ingest(tenant, KNOWLEDGE);
    expect(await invoke(searchKnowledge, { query: 'Do you repair spaceships?' }, await contextFor(tenant))).toEqual({
      ok: true,
      data: {
        results: [],
        note: 'No relevant information found. Do not guess: tell the visitor you do not have that information and offer to take their details.',
      },
    });
  });

  it('reports an embedding outage as unavailable, never as "no results"', async () => {
    const tenant = await newTenant();
    await ingest(tenant, KNOWLEDGE);
    const failing: Embedder = {
      model: 'fake-embedding-model',
      embed: () => Promise.reject(new ProviderError({ provider: 'fake', code: 'unavailable', message: 'down', retryable: true })),
    };

    const outcome = await invoke(searchKnowledge, { query: 'emergency boiler repair' }, await contextFor(tenant, { embedder: failing }));
    expect(outcome).toEqual({
      ok: false,
      error: { code: 'unavailable', message: 'The knowledge base is temporarily unavailable.', retryable: true },
    });

    // Anything else is a real failure for the executor to handle.
    const broken: Embedder = { model: 'fake-embedding-model', embed: () => Promise.reject(new Error('bug')) };
    await expect(
      invoke(searchKnowledge, { query: 'emergency boiler repair' }, await contextFor(tenant, { embedder: broken })),
    ).rejects.toThrow('bug');
  });

  it('keeps its output small even with a generous retrieval budget', async () => {
    const tenant = await newTenant();
    const sections = Array.from(
      { length: 24 },
      (_, i) => `# Boiler topic ${i}\n${`Boiler service detail number ${i} for every boiler model. `.repeat(22)}`,
    );
    await ingest(tenant, sections.join('\n\n'));
    const ctx = await contextFor(tenant, { retrieval: { maxChunks: 20, maxTokens: 8000, minSimilarity: -1 } });

    const outcome = await invoke(searchKnowledge, { query: 'boiler service detail' }, ctx);

    expect(outcome.ok).toBe(true);
    const data = outcome.ok ? outcome.data : null;
    expect(data!.results.length).toBeGreaterThan(1);
    expect(data!.results.length).toBeLessThan(20);
    expect(JSON.stringify(data).length).toBeLessThanOrEqual(9_000 + 50);
  });

  it("never returns another organization's chunks, even for identical text", async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    await ingest(tenantA, KNOWLEDGE, 'Tenant A handbook');
    await ingest(tenantB, KNOWLEDGE, 'Tenant B handbook');
    const ctx = await contextFor(tenantA, { retrieval: { ...BUDGET, minSimilarity: -1 } });

    const outcome = await invoke(searchKnowledge, { query: 'emergency boiler repair price' }, ctx);
    expect(outcome.ok).toBe(true);
    const sources = outcome.ok ? outcome.data.results.map((result) => result.source) : [];
    expect(sources.length).toBe(2);
    expect(new Set(sources)).toEqual(new Set(['Tenant A handbook']));
  });
});
