import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql, SqlParam } from '@/server/db/types';
import { ensureWebChatChannel } from '@/server/domain/agents/repository';
import { closeConversation, getOrCreateVisitorConversation } from '@/server/domain/conversations/service';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { createAgent, createConversation, createTenant, createWebChatChannel } from '../support/fixtures';

/**
 * PGlite runs transactions one at a time, so Promise.all'd requests never race and the get-or-create
 * conflict branches would never run. A concurrent request is simulated deterministically instead: each
 * step runs through the same transaction right before the next statement matching its pattern, as if
 * another transaction had committed between the function's lookup and its insert.
 */
interface Step {
  before: RegExp;
  run: (sql: Sql) => Promise<void>;
}

function interleave(sql: Sql, steps: readonly Step[]): Sql {
  const pending = [...steps];
  return {
    async query<T extends object>(text: string, params?: readonly SqlParam[]): Promise<T[]> {
      const next = pending[0];
      if (next?.before.test(text)) {
        pending.shift();
        await next.run(sql);
      }
      return sql.query<T>(text, params);
    },
  };
}

const CONVERSATION_INSERT = /insert into public\.conversations/;
const CONVERSATION_LOOKUP = /from public\.conversations/;
const CHANNEL_INSERT = /insert into public\.agent_channels/;

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.close();
});

/** A visitor whose first message from another tab creates the conversation first (`otherTab`). */
async function visitorRace() {
  const tenant = await t.service.run((sql) => createTenant(sql));
  const visitorId = randomUUID();
  const params = { organizationId: tenant.org.id, agentId: tenant.agent.id, channel: 'web_chat' as const, visitorId };
  const competing = { id: '' };
  const otherTab: Step = {
    before: CONVERSATION_INSERT,
    run: async (sql) => {
      competing.id = (await createConversation(sql, tenant.org.id, tenant.agent.id, { visitorId })).id;
    },
  };
  return { tenant, params, competing, otherTab };
}

function visitorConversations(visitorId: string) {
  return t.db.query('select id, status from public.conversations where visitor_id = $1 order by status', [visitorId]);
}

describe('getOrCreateVisitorConversation racing a first message from another tab', () => {
  it('converges to the conversation the other request created first', async () => {
    const { tenant, params, competing, otherTab } = await visitorRace();
    const conversation = await t.service.run((sql) => getOrCreateVisitorConversation(interleave(sql, [otherTab]), params));

    expect(conversation).toMatchObject({
      id: competing.id,
      organizationId: tenant.org.id,
      agentId: tenant.agent.id,
      visitorId: params.visitorId,
      status: 'active',
    });
    expect(await visitorConversations(params.visitorId)).toEqual([{ id: competing.id, status: 'active' }]);
  });

  it('starts a new conversation when the other request closed its own before the re-check', async () => {
    const { tenant, params, competing, otherTab } = await visitorRace();
    const closesIt: Step = { before: CONVERSATION_LOOKUP, run: (sql) => closeConversation(sql, tenant.org.id, competing.id) };
    const conversation = await t.service.run((sql) =>
      getOrCreateVisitorConversation(interleave(sql, [otherTab, closesIt]), params),
    );

    expect(conversation).toMatchObject({ organizationId: tenant.org.id, visitorId: params.visitorId, status: 'active' });
    expect(conversation.id).not.toBe(competing.id);
    expect(await visitorConversations(params.visitorId)).toEqual([
      { id: conversation.id, status: 'active' },
      { id: competing.id, status: 'closed' },
    ]);
  });
});

// Widget channels are created by the server only (service scope, after the owner/admin check).
describe('ensureWebChatChannel racing a concurrent publish (service scope)', () => {
  it('converges to the channel the other request created first', async () => {
    const tenant = await t.service.run((sql) => createTenant(sql));
    const agent = await t.service.run((sql) => createAgent(sql, tenant.org.id, { name: 'Sales' }));
    let competing = { id: '', publicKey: '' };
    const otherPublish: Step = {
      before: CHANNEL_INSERT,
      run: async (sql) => {
        competing = await createWebChatChannel(sql, tenant.org.id, agent.id, { enabled: false });
      },
    };
    const channel = await t.service.run((sql) => ensureWebChatChannel(interleave(sql, [otherPublish]), tenant.org.id, agent.id));

    // The stored row, including its widget key, not the key this call generated for its own insert.
    expect(channel).toMatchObject({
      id: competing.id,
      organizationId: tenant.org.id,
      agentId: agent.id,
      channel: 'web_chat',
      enabled: false,
      publicKey: competing.publicKey,
    });
    expect(await t.db.query('select id from public.agent_channels where agent_id = $1', [agent.id])).toEqual([
      { id: competing.id },
    ]);
  });

  it("never converges to another organization's channel", async () => {
    const a = await t.service.run((sql) => createTenant(sql));
    const b = await t.service.run((sql) => createTenant(sql));
    const agentB = await t.service.run((sql) => createAgent(sql, b.org.id, { name: 'Sales' }));
    let competingId = '';
    const publishInB: Step = {
      before: CHANNEL_INSERT,
      run: async (sql) => {
        competingId = (await createWebChatChannel(sql, b.org.id, agentB.id)).id;
      },
    };

    await expect(
      t.service.run((sql) => ensureWebChatChannel(interleave(sql, [publishInB]), a.org.id, agentB.id)),
    ).rejects.toMatchObject({ name: 'DomainError', code: 'not_found' });
    // The race happened: organization B's channel existed when the call looked again.
    expect(competingId).not.toBe('');
  });
});
