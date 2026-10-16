import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '@/server/db/types';
import {
  appendMessage,
  closeConversation,
  getActiveVisitorConversation,
  getConversation,
  getConversationDetail,
  getOrCreateVisitorConversation,
  listConversations,
  listMessages,
  listRecentTextMessages,
  releaseTurnLock,
  tryAcquireTurnLock,
  updateSummary,
} from '@/server/domain/conversations/service';
import type { NewMessage } from '@/server/domain/conversations/types';
import { captureLead } from '@/server/domain/contacts/service';
import { DomainError } from '@/server/domain/types';
import { createTestDatabase, type TestDatabase } from '../support/db';
import {
  addMember,
  createAgent,
  createAuthUser,
  createConversation,
  createTenant,
  type TenantFixture,
} from '../support/fixtures';

// `expect.any` returns `any`; typed as unknown for the strict lint rules.
const anyString: unknown = expect.any(String);
const anyNumber: unknown = expect.any(Number);
const anyDate: unknown = expect.any(Date);

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.close();
});

function newTenant(): Promise<TenantFixture> {
  return t.service.run((sql) => createTenant(sql));
}

function newConversation(tenant: TenantFixture): Promise<string> {
  return t.service.run(async (sql) => (await createConversation(sql, tenant.org.id, tenant.agent.id)).id);
}

function append(tenant: TenantFixture, conversationId: string, message: NewMessage) {
  return t.service.run((sql) => appendMessage(sql, tenant.org.id, conversationId, message));
}

function visitorParams(tenant: TenantFixture, visitorId: string = randomUUID()) {
  return { organizationId: tenant.org.id, agentId: tenant.agent.id, channel: 'web_chat' as const, visitorId };
}

async function insertToolRun(sql: Sql, tenant: TenantFixture, conversationId: string): Promise<string> {
  const rows = await sql.query<{ id: string }>(
    `insert into public.tool_runs
       (organization_id, agent_id, conversation_id, channel, tool_name, provider_call_id, status, input, output,
        finished_at, duration_ms)
     values ($1, $2, $3, 'web_chat', 'searchKnowledge', 'call_1', 'succeeded', $4::jsonb, $5::jsonb, now(), 42)
     returning id`,
    [tenant.org.id, tenant.agent.id, conversationId, JSON.stringify({ query: 'opening hours' }), JSON.stringify({ results: [] })],
  );
  return rows[0]!.id;
}

describe('visitor conversations', () => {
  it('returns the same active conversation on repeat calls', async () => {
    const tenant = await newTenant();
    const params = visitorParams(tenant);

    expect(await t.service.run((sql) => getActiveVisitorConversation(sql, params))).toBeNull();
    const first = await t.service.run((sql) => getOrCreateVisitorConversation(sql, params));
    expect(first).toEqual({
      id: anyString,
      organizationId: tenant.org.id,
      agentId: tenant.agent.id,
      channel: 'web_chat',
      status: 'active',
      visitorId: params.visitorId,
      contactId: null,
      summary: '',
      summaryThroughSeq: 0,
      messageCount: 0,
      lastMessageAt: null,
      createdAt: anyDate,
      closedAt: null,
    });

    const again = await t.service.run((sql) => getOrCreateVisitorConversation(sql, params));
    expect(again.id).toBe(first.id);
    expect((await t.service.run((sql) => getActiveVisitorConversation(sql, params)))?.id).toBe(first.id);
  });

  // PGlite runs transactions one at a time, so this only checks repeated first messages; the real race (a
  // competing insert between lookup and insert) is covered deterministically in conflict-branches.test.ts.
  it('returns one conversation for repeated first messages', async () => {
    const tenant = await newTenant();
    const params = visitorParams(tenant);

    const results = await Promise.all(
      [1, 2, 3].map(() => t.service.run((sql) => getOrCreateVisitorConversation(sql, params))),
    );

    expect(new Set(results.map((conversation) => conversation.id)).size).toBe(1);
    const rows = await t.db.query('select id from public.conversations where visitor_id = $1', [params.visitorId]);
    expect(rows).toHaveLength(1);
  });

  it('starts a new conversation once the active one is closed', async () => {
    const tenant = await newTenant();
    const params = visitorParams(tenant);
    const first = await t.service.run((sql) => getOrCreateVisitorConversation(sql, params));

    await t.service.run((sql) => closeConversation(sql, tenant.org.id, first.id));
    const closed = await t.service.run((sql) => getConversation(sql, tenant.org.id, first.id));
    expect(closed).toMatchObject({ status: 'closed', closedAt: anyDate });
    expect(await t.service.run((sql) => getActiveVisitorConversation(sql, params))).toBeNull();

    // Closing again is a no-op.
    await t.service.run((sql) => closeConversation(sql, tenant.org.id, first.id));
    expect((await t.service.run((sql) => getConversation(sql, tenant.org.id, first.id)))?.closedAt).toEqual(closed?.closedAt);

    const second = await t.service.run((sql) => getOrCreateVisitorConversation(sql, params));
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('active');
  });

  it('keeps one active conversation per visitor and agent', async () => {
    const tenant = await newTenant();
    const visitorId = randomUUID();
    const otherAgent = await t.service.run((sql) => createAgent(sql, tenant.org.id, { name: 'Sales' }));

    const withFrontDesk = await t.service.run((sql) => getOrCreateVisitorConversation(sql, visitorParams(tenant, visitorId)));
    const withSales = await t.service.run((sql) =>
      getOrCreateVisitorConversation(sql, { ...visitorParams(tenant, visitorId), agentId: otherAgent.id }),
    );
    const otherVisitor = await t.service.run((sql) => getOrCreateVisitorConversation(sql, visitorParams(tenant)));

    expect(new Set([withFrontDesk.id, withSales.id, otherVisitor.id]).size).toBe(3);
  });

  it("does not resolve another organization's conversations", async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    const params = visitorParams(tenantA);
    const conversation = await t.service.run((sql) => getOrCreateVisitorConversation(sql, params));

    expect(await t.service.run((sql) => getConversation(sql, tenantB.org.id, conversation.id))).toBeNull();
    expect(await t.service.run((sql) => getConversation(sql, tenantA.org.id, 'not-a-uuid'))).toBeNull();
    expect(
      await t.service.run((sql) => getActiveVisitorConversation(sql, { ...params, organizationId: tenantB.org.id })),
    ).toBeNull();

    // Closing through another organization changes nothing.
    await t.service.run((sql) => closeConversation(sql, tenantB.org.id, conversation.id));
    expect((await t.service.run((sql) => getConversation(sql, tenantA.org.id, conversation.id)))?.status).toBe('active');

    // A conversation can never pair one organization with another one's agent (composite foreign key).
    const crossTenant = { ...visitorParams(tenantA), agentId: tenantB.agent.id };
    await expect(t.service.run((sql) => getOrCreateVisitorConversation(sql, crossTenant))).rejects.toMatchObject({
      code: '23503',
    });
    expect(await t.db.query('select id from public.conversations where visitor_id = $1', [crossTenant.visitorId])).toEqual([]);
  });
});

describe('messages', () => {
  it('appends messages in order and keeps the conversation counters in step', async () => {
    const tenant = await newTenant();
    const conversationId = await newConversation(tenant);

    const user = await append(tenant, conversationId, { role: 'user', content: 'When are you open?' });
    const call = await append(tenant, conversationId, {
      role: 'tool_call',
      toolName: 'getBusinessHours',
      toolCallId: 'call_1',
      data: { arguments: {} },
    });
    const result = await append(tenant, conversationId, {
      role: 'tool_result',
      toolName: 'getBusinessHours',
      toolCallId: 'call_1',
      data: { ok: true, errorCode: null, replayed: false },
    });
    const reply = await append(tenant, conversationId, { role: 'assistant', content: 'We are open 9 to 5.' });

    expect(user).toEqual({
      id: anyString,
      seq: anyNumber,
      organizationId: tenant.org.id,
      conversationId,
      role: 'user',
      content: 'When are you open?',
      toolName: null,
      toolCallId: null,
      toolRunId: null,
      data: {},
      createdAt: anyDate,
    });
    expect(call).toMatchObject({ role: 'tool_call', content: '', toolName: 'getBusinessHours', toolCallId: 'call_1', data: { arguments: {} } });
    expect(result.data).toEqual({ ok: true, errorCode: null, replayed: false });
    expect(user.seq < call.seq && call.seq < result.seq && result.seq < reply.seq).toBe(true);

    const conversation = await t.service.run((sql) => getConversation(sql, tenant.org.id, conversationId));
    expect(conversation?.messageCount).toBe(4);
    expect(conversation?.lastMessageAt).toEqual(reply.createdAt);
    const stored = await t.service.run((sql) => listMessages(sql, tenant.org.id, conversationId));
    expect(stored.map((message) => message.id)).toEqual([user.id, call.id, result.id, reply.id]);
  });

  it('links tool rows to their tool run', async () => {
    const tenant = await newTenant();
    const conversationId = await newConversation(tenant);
    const toolRunId = await t.service.run((sql) => insertToolRun(sql, tenant, conversationId));

    const message = await append(tenant, conversationId, {
      role: 'tool_result',
      toolName: 'searchKnowledge',
      toolCallId: 'call_1',
      toolRunId,
      data: { ok: true },
    });
    expect(message.toolRunId).toBe(toolRunId);
  });

  it('requires a tool name exactly on tool rows', async () => {
    const tenant = await newTenant();
    const conversationId = await newConversation(tenant);

    await expect(append(tenant, conversationId, { role: 'tool_call' })).rejects.toThrow(/requires a toolName/);
    await expect(append(tenant, conversationId, { role: 'user', content: 'hi', toolName: 'searchKnowledge' })).rejects.toThrow(
      /must not have a toolName/,
    );
    expect((await t.service.run((sql) => getConversation(sql, tenant.org.id, conversationId)))?.messageCount).toBe(0);
  });

  it('truncates oversized content and stores text Postgres would reject', async () => {
    const tenant = await newTenant();
    const conversationId = await newConversation(tenant);

    const long = await append(tenant, conversationId, { role: 'user', content: 'x'.repeat(25_000) });
    expect(long.content).toHaveLength(20_000);
    // Truncation never splits a surrogate pair.
    const emoji = await append(tenant, conversationId, { role: 'user', content: `${'x'.repeat(19_999)}😀` });
    expect(emoji.content).toBe('x'.repeat(19_999));

    const nul = await append(tenant, conversationId, {
      role: 'tool_call',
      toolName: 'searchKnowledge',
      toolCallId: 'call_\u00002',
      content: 'a\u0000b',
      data: { arguments: { query: 'c\u0000d' }, path: 'C:\\u0000', 'k\u0000ey': 1 },
    });
    expect(nul).toMatchObject({ content: 'ab', toolCallId: 'call_2' });
    // Only real NUL characters are dropped; a literal backslash followed by "u0000" survives.
    expect(nul.data).toEqual({ arguments: { query: 'cd' }, path: 'C:\\u0000', key: 1 });

    // Parsed model arguments can hold lone surrogates (a cut emoji, a "\ud83d" escape): jsonb rejects them.
    const lone = await append(tenant, conversationId, {
      role: 'tool_call',
      toolName: 'searchKnowledge',
      data: { arguments: { query: 'x\ud83d', tail: '\ude00y' }, emoji: '😀', literal: '\\ud83d' },
    });
    expect(lone.data).toEqual({ arguments: { query: 'x\ufffd', tail: '\ufffdy' }, emoji: '😀', literal: '\\ud83d' });
  });

  it("refuses to append to another organization's conversation", async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    const conversationB = await newConversation(tenantB);

    const attempt = append(tenantA, conversationB, { role: 'user', content: 'hello' });
    await expect(attempt).rejects.toBeInstanceOf(DomainError);
    await expect(attempt).rejects.toMatchObject({ code: 'not_found' });
    await expect(append(tenantA, 'not-a-uuid', { role: 'user', content: 'hello' })).rejects.toMatchObject({ code: 'not_found' });

    expect((await t.service.run((sql) => getConversation(sql, tenantB.org.id, conversationB)))?.messageCount).toBe(0);
    expect(await t.db.query('select id from public.messages where conversation_id = $1', [conversationB])).toEqual([]);
  });

  it("rejects a tool run that belongs to another organization (composite foreign key)", async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    const conversationA = await newConversation(tenantA);
    const conversationB = await newConversation(tenantB);
    const foreignRun = await t.service.run((sql) => insertToolRun(sql, tenantB, conversationB));

    await expect(
      append(tenantA, conversationA, { role: 'tool_result', toolName: 'searchKnowledge', toolRunId: foreignRun }),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('filters by role and sequence and keeps the last n chronologically', async () => {
    const tenant = await newTenant();
    const conversationId = await newConversation(tenant);
    const user1 = await append(tenant, conversationId, { role: 'user', content: 'u1' });
    const assistant1 = await append(tenant, conversationId, { role: 'assistant', content: 'a1' });
    await append(tenant, conversationId, { role: 'tool_call', toolName: 'searchKnowledge', data: { arguments: { query: 'q' } } });
    await append(tenant, conversationId, { role: 'tool_result', toolName: 'searchKnowledge', data: { ok: true } });
    const user2 = await append(tenant, conversationId, { role: 'user', content: 'u2' });
    const assistant2 = await append(tenant, conversationId, { role: 'assistant', content: 'a2' });
    const system = await append(tenant, conversationId, { role: 'system', content: 'assistant_unavailable' });
    const user3 = await append(tenant, conversationId, { role: 'user', content: 'u3' });

    const list = (options?: Parameters<typeof listMessages>[3]) =>
      t.service.run(async (sql) => (await listMessages(sql, tenant.org.id, conversationId, options)).map((m) => m.content || m.role));

    expect(await list({ roles: ['user'] })).toEqual(['u1', 'u2', 'u3']);
    expect(await list({ afterSeq: user2.seq })).toEqual(['a2', 'assistant_unavailable', 'u3']);
    expect(await list({ limit: 2 })).toEqual([system.content, 'u3']);
    expect(await list({ roles: ['user', 'assistant'], afterSeq: assistant1.seq, limit: 2 })).toEqual(['a2', 'u3']);
    expect(await list({ limit: 0 })).toEqual([]);
    expect(await list({ roles: [] })).toEqual([]);
    expect(await list()).toHaveLength(8);
    // Out-of-range numbers are clamped instead of failing the bigint cast (which would abort the transaction).
    expect(await list({ afterSeq: 1e21 })).toEqual([]);
    expect(await list({ limit: 1e21 })).toHaveLength(8);

    const recent = await t.service.run((sql) => listRecentTextMessages(sql, tenant.org.id, conversationId, 3));
    expect(recent.map((message) => message.id)).toEqual([user2.id, assistant2.id, user3.id]);
    const all = await t.service.run((sql) => listRecentTextMessages(sql, tenant.org.id, conversationId, 50));
    expect(all.map((message) => message.id)).toEqual([user1.id, assistant1.id, user2.id, assistant2.id, user3.id]);

    const otherTenant = await newTenant();
    expect(await t.service.run((sql) => listMessages(sql, otherTenant.org.id, conversationId))).toEqual([]);
  });
});

describe('turn lock', () => {
  it('lets one turn hold the conversation at a time', async () => {
    const tenant = await newTenant();
    const conversationId = await newConversation(tenant);
    const acquire = () => t.service.run((sql) => tryAcquireTurnLock(sql, tenant.org.id, conversationId, 120));
    const release = () => t.service.run((sql) => releaseTurnLock(sql, tenant.org.id, conversationId));

    expect(await acquire()).toBe(true);
    const lock = await t.db.query<{ held: boolean }>(
      `select turn_locked_until > now() + interval '100 seconds' as held from public.conversations where id = $1`,
      [conversationId],
    );
    expect(lock[0]?.held).toBe(true);
    expect(await acquire()).toBe(false);

    await release();
    expect(await acquire()).toBe(true);

    // A lock left behind by a crashed turn expires.
    await t.db.query(`update public.conversations set turn_locked_until = now() - interval '1 second' where id = $1`, [
      conversationId,
    ]);
    expect(await acquire()).toBe(true);
    expect(await acquire()).toBe(false);
  });

  it('cannot be taken or released through another organization', async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    const conversationId = await newConversation(tenantA);

    expect(await t.service.run((sql) => tryAcquireTurnLock(sql, tenantB.org.id, conversationId, 120))).toBe(false);
    expect(await t.service.run((sql) => tryAcquireTurnLock(sql, tenantA.org.id, conversationId, 120))).toBe(true);
    await t.service.run((sql) => releaseTurnLock(sql, tenantB.org.id, conversationId));
    expect(await t.service.run((sql) => tryAcquireTurnLock(sql, tenantA.org.id, conversationId, 120))).toBe(false);
  });

  it('rejects a non-positive ttl', async () => {
    const tenant = await newTenant();
    const conversationId = await newConversation(tenant);
    await expect(t.service.run((sql) => tryAcquireTurnLock(sql, tenant.org.id, conversationId, 0))).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});

describe('rolling summary', () => {
  it('only moves the summary forward', async () => {
    const tenant = await newTenant();
    const otherTenant = await newTenant();
    const conversationId = await newConversation(tenant);
    const update = (organizationId: string, summary: string, throughSeq: number) =>
      t.service.run((sql) => updateSummary(sql, organizationId, conversationId, summary, throughSeq));
    const current = async () => {
      const conversation = await t.service.run((sql) => getConversation(sql, tenant.org.id, conversationId));
      return { summary: conversation?.summary, throughSeq: conversation?.summaryThroughSeq };
    };

    await update(tenant.org.id, ' Visitor asked about prices. ', 5);
    expect(await current()).toEqual({ summary: 'Visitor asked about prices.', throughSeq: 5 });

    await update(tenant.org.id, 'stale', 3);
    await update(tenant.org.id, 'same point', 5);
    await update(otherTenant.org.id, 'foreign', 50);
    expect(await current()).toEqual({ summary: 'Visitor asked about prices.', throughSeq: 5 });

    await update(tenant.org.id, 'y'.repeat(9000), 9);
    expect(await current()).toEqual({ summary: 'y'.repeat(8000), throughSeq: 9 });
  });
});

describe('admin views', () => {
  it("labels a conversation with what its visitor gave, never with a matched contact's name", async () => {
    const tenant = await newTenant();
    const alice = await t.service.run((sql) => createConversation(sql, tenant.org.id, tenant.agent.id));
    const mallory = await t.service.run((sql) => createConversation(sql, tenant.org.id, tenant.agent.id));
    const anonymous = await t.service.run((sql) => createConversation(sql, tenant.org.id, tenant.agent.id));
    const capture = (conversationId: string, name: string, phone: string) =>
      t.service.run((sql) =>
        captureLead(sql, {
          organizationId: tenant.org.id,
          agentId: tenant.agent.id,
          conversationId,
          channel: 'web_chat',
          name,
          phone,
        }),
      );
    await capture(alice.id, 'Alice Smith', '+1 555 010 0100');
    // Mallory gives Alice's number: the conversation links to Alice's contact but must not be listed as Alice.
    await capture(mallory.id, 'Mallory', '(555) 010-0100');

    const names = new Map(
      (await listConversations(t.asUser(tenant.owner.id), tenant.org.id)).map((item) => [item.id, item.contactName]),
    );
    expect(names.get(alice.id)).toBe('Alice Smith');
    expect(names.get(mallory.id)).toBe('Mallory');
    expect(names.get(anonymous.id)).toBeNull();
  });

  it('lists conversations by latest activity with a one-line preview', async () => {
    const tenant = await newTenant();
    const older = await newConversation(tenant);
    const newer = await newConversation(tenant);
    const empty = await newConversation(tenant);
    const longReply = `Sure!\n\nWe service boilers ${'and radiators '.repeat(20)}`.trim();

    await append(tenant, older, { role: 'user', content: 'Do you fix boilers?' });
    await append(tenant, older, { role: 'assistant', content: longReply });
    await append(tenant, older, { role: 'tool_call', toolName: 'searchKnowledge', data: {} });
    await append(tenant, newer, { role: 'user', content: '  Second   visitor here ' });
    await t.db.query(`update public.conversations set last_message_at = now() - interval '1 hour' where id = $1`, [older]);
    await t.db.query(
      `with contact as (
         insert into public.contacts (organization_id, name, phone, phone_normalized)
         values ($1, 'Jane Doe', '5551230000', '5551230000') returning id
       )
       update public.conversations set contact_id = (select id from contact) where id = $2`,
      [tenant.org.id, newer],
    );

    const items = await listConversations(t.asUser(tenant.owner.id), tenant.org.id);
    expect(items.map((item) => item.id)).toEqual([newer, older, empty]);
    expect(items[0]).toEqual({
      id: newer,
      agentId: tenant.agent.id,
      agentName: tenant.agent.name,
      channel: 'web_chat',
      status: 'active',
      contactName: 'Jane Doe',
      messageCount: 1,
      lastMessageAt: anyDate,
      createdAt: anyDate,
      preview: 'Second visitor here',
    });
    // The preview is the latest user/assistant text (not the tool row), flattened and capped at 140 characters.
    const preview = items[1]!.preview!;
    expect(preview).toHaveLength(140);
    expect(preview.startsWith('Sure! We service boilers and radiators')).toBe(true);
    expect(preview.endsWith('…')).toBe(true);
    expect(items[1]!.messageCount).toBe(3);
    expect(items[2]).toMatchObject({ messageCount: 0, lastMessageAt: null, preview: null, contactName: null });

    expect((await listConversations(t.service, tenant.org.id, { limit: 1 })).map((item) => item.id)).toEqual([newer]);
  });

  it('returns the transcript, contact and tool audit trail', async () => {
    const tenant = await newTenant();
    const member = await t.service.run((sql) => createAuthUser(sql));
    await t.service.run((sql) => addMember(sql, tenant.org.id, member.id, 'member'));
    const conversationId = await newConversation(tenant);
    const toolRunId = await t.service.run((sql) => insertToolRun(sql, tenant, conversationId));
    const contactId = (
      await t.db.query<{ id: string }>(
        `insert into public.contacts (organization_id, name, email, email_normalized)
         values ($1, 'Jo', 'jo@example.com', 'jo@example.com') returning id`,
        [tenant.org.id],
      )
    )[0]!.id;
    await t.db.query('update public.conversations set contact_id = $1 where id = $2', [contactId, conversationId]);

    await append(tenant, conversationId, { role: 'user', content: 'When are you open?' });
    await append(tenant, conversationId, { role: 'tool_call', toolName: 'searchKnowledge', toolCallId: 'call_1' });
    await append(tenant, conversationId, { role: 'tool_result', toolName: 'searchKnowledge', toolCallId: 'call_1', toolRunId });
    await append(tenant, conversationId, { role: 'assistant', content: "I don't have that information." });

    const detail = await getConversationDetail(t.asUser(member.id), tenant.org.id, conversationId);
    expect(detail?.conversation).toMatchObject({ id: conversationId, agentName: tenant.agent.name, contactId, messageCount: 4 });
    expect(detail?.contact).toMatchObject({ id: contactId, name: 'Jo', email: 'jo@example.com' });
    expect(detail?.messages.map((message) => message.role)).toEqual(['user', 'tool_call', 'tool_result', 'assistant']);
    expect(detail?.toolRuns).toEqual([
      {
        id: toolRunId,
        toolName: 'searchKnowledge',
        status: 'succeeded',
        input: { query: 'opening hours' },
        output: { results: [] },
        errorCode: null,
        errorMessage: null,
        startedAt: anyDate,
        durationMs: 42,
      },
    ]);
  });

  it('scopes conversation views to the organization', async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    const outsider = await t.service.run((sql) => createAuthUser(sql));
    const conversationA = await newConversation(tenantA);
    const conversationB = await newConversation(tenantB);
    await append(tenantA, conversationA, { role: 'user', content: 'Tenant A secret' });

    expect((await listConversations(t.service, tenantB.org.id)).map((item) => item.id)).toEqual([conversationB]);
    expect(await listConversations(t.asUser(tenantB.owner.id), tenantA.org.id)).toEqual([]);
    expect(await listConversations(t.asUser(outsider.id), tenantA.org.id)).toEqual([]);
    expect(await listConversations(t.service, 'not-a-uuid')).toEqual([]);

    expect(await getConversationDetail(t.service, tenantB.org.id, conversationA)).toBeNull();
    expect(await getConversationDetail(t.asUser(tenantB.owner.id), tenantA.org.id, conversationA)).toBeNull();
    expect(await getConversationDetail(t.asUser(outsider.id), tenantA.org.id, conversationA)).toBeNull();
    expect(await getConversationDetail(t.service, tenantA.org.id, 'not-a-uuid')).toBeNull();
    expect((await getConversationDetail(t.asUser(tenantA.owner.id), tenantA.org.id, conversationA))?.messages).toHaveLength(1);
  });

  it('gives users read-only access to conversation records (RLS)', async () => {
    const tenant = await newTenant();
    const member = await t.service.run((sql) => createAuthUser(sql));
    await t.service.run((sql) => addMember(sql, tenant.org.id, member.id, 'member'));
    const conversationId = await newConversation(tenant);
    const denied = { code: '42501' };

    for (const actor of [t.asUser(member.id), t.asUser(tenant.owner.id)]) {
      await expect(
        actor.run((sql) => appendMessage(sql, tenant.org.id, conversationId, { role: 'user', content: 'forged' })),
      ).rejects.toMatchObject(denied);
      await expect(actor.run((sql) => getOrCreateVisitorConversation(sql, visitorParams(tenant)))).rejects.toMatchObject(denied);
      await expect(actor.run((sql) => tryAcquireTurnLock(sql, tenant.org.id, conversationId, 120))).rejects.toMatchObject(denied);
      await expect(actor.run((sql) => closeConversation(sql, tenant.org.id, conversationId))).rejects.toMatchObject(denied);
      await expect(
        actor.run((sql) => sql.query('delete from public.messages where conversation_id = $1', [conversationId])),
      ).rejects.toMatchObject(denied);
    }

    const conversation = await t.asUser(member.id).run((sql) => getConversation(sql, tenant.org.id, conversationId));
    expect(conversation).toMatchObject({ status: 'active', messageCount: 0 });
  });
});
