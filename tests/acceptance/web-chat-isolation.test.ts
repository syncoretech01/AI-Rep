import type * as nextServer from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { listLeads } from '@/server/domain/contacts/service';
import { getConversationDetail, listConversations } from '@/server/domain/conversations/service';
import {
  deleteKnowledgeSource,
  getKnowledgeSource,
  ingestTextSource,
  listKnowledgeSources,
  reindexKnowledgeSource,
} from '@/server/domain/knowledge/ingestion';
import { createAppHarness, type AppHarness, type ProvisionedTenant, type ToolRunRow, type TurnResult } from '../support/app-harness';
import { cosineSimilarity, fakeEmbed } from '../support/fake-embeddings';
import { NO_INFORMATION_REPLY } from '../support/receptionist-model';
import {
  LEAD_MESSAGE,
  QUESTIONS,
  SHELBYVILLE,
  SHELBYVILLE_FACTS,
  SHELBYVILLE_MARKERS,
  SPRINGFIELD,
  SPRINGFIELD_FACTS,
  SPRINGFIELD_MARKERS,
} from './tenants';

/**
 * Phase 1 acceptance scenario 5: "one tenant cannot retrieve another tenant's knowledge" — through the public
 * widget (the tenant comes from the widget key only, retrieval is scoped to it, session tokens are bound to
 * one agent) and through the admin domain services under the owner's RLS scope.
 */

vi.mock('@/server/app-services', async () => (await import('../support/app-harness')).mockedAppServices);
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof nextServer>()),
  ...(await import('../support/app-harness')).mockedNextServer,
}));

const anyString: unknown = expect.any(String);

let h: AppHarness;
let springfield: ProvisionedTenant;
let shelbyville: ProvisionedTenant;

beforeAll(async () => {
  h = await createAppHarness();
  springfield = await h.provisionTenant(SPRINGFIELD);
  shelbyville = await h.provisionTenant(SHELBYVILLE);
});

afterEach(() => {
  // Anything logged at warn level or above is a failure nobody would see.
  const unexpected = h.logger.eventsAtLeast('warn');
  h.logger.clear();
  expect(unexpected).toEqual([]);
});

afterAll(async () => {
  await h.close();
});

/** One question from a new visitor of the tenant's widget, with the run of the searchKnowledge call it caused. */
async function ask(tenant: ProvisionedTenant, question: string): Promise<{ turn: TurnResult; run: ToolRunRow }> {
  const session = await h.openSession(tenant.widgetKey);
  const turn = await h.sendMessage(tenant.widgetKey, session.sessionToken, question);
  const runs = await h.toolRuns(tenant.organization.id, turn.conversationId);
  const [run] = runs;
  if (runs.length !== 1 || run?.toolName !== 'searchKnowledge') {
    throw new Error(`Expected one searchKnowledge run, got ${JSON.stringify(runs.map((item) => item.toolName))}`);
  }
  return { turn, run };
}

describe("5. one tenant cannot retrieve another tenant's knowledge", () => {
  it("never answers one tenant's visitors from the other tenant's knowledge", async () => {
    // Positive control: the restoration fact is retrievable — at its own tenant's widget.
    const atShelbyville = await ask(shelbyville, QUESTIONS.pinball);
    expect(atShelbyville.run.output).toEqual({
      results: [{ source: 'Restoration', content: `Restoration\n\n${SHELBYVILLE_FACTS.restoration}` }],
    });
    expect(atShelbyville.turn.reply).toContain(SHELBYVILLE_FACTS.restoration);

    // The same question at the other tenant's widget finds no evidence at all.
    const atSpringfield = await ask(springfield, QUESTIONS.pinball);
    expect(atSpringfield.run).toMatchObject({ status: 'succeeded', output: { results: [], note: anyString } });
    expect(atSpringfield.turn.reply).toBe(NO_INFORMATION_REPLY);
    // And the other way round.
    const emergencyAtShelbyville = await ask(shelbyville, QUESTIONS.emergency);
    expect(emergencyAtShelbyville.run.output).toMatchObject({ results: [] });
    expect(emergencyAtShelbyville.turn.reply).toBe(NO_INFORMATION_REPLY);

    // The query embedding is metered to the organization whose visitor asked.
    const conversationId = atSpringfield.turn.conversationId;
    expect((await h.usage(springfield.organization.id, conversationId)).map((row) => row.purpose).sort()).toEqual([
      'chat_response',
      'chat_response',
      'knowledge_query',
    ]);
    expect(await h.usage(shelbyville.organization.id, conversationId)).toEqual([]);
  });

  it("answers the same question from each tenant's own knowledge only", async () => {
    // Both tenants hold equally relevant evidence (same wording, different prices): only tenant scoping decides.
    const threshold = h.services.ai.budgets.minRetrievalSimilarity;
    for (const fact of [SPRINGFIELD_FACTS.fee, SHELBYVILLE_FACTS.fee]) {
      expect(cosineSimilarity(fakeEmbed(QUESTIONS.fee), fakeEmbed(`Pricing\n\n${fact}`))).toBeGreaterThan(threshold);
    }

    const atSpringfield = await ask(springfield, QUESTIONS.fee);
    const atShelbyville = await ask(shelbyville, QUESTIONS.fee);

    expect(atSpringfield.run.output).toEqual({ results: [{ source: 'Prices', content: `Pricing\n\n${SPRINGFIELD_FACTS.fee}` }] });
    expect(atShelbyville.run.output).toEqual({ results: [{ source: 'Prices', content: `Pricing\n\n${SHELBYVILLE_FACTS.fee}` }] });
    expect(atSpringfield.turn.reply).toContain('$89');
    expect(atSpringfield.turn.reply).not.toContain('$149');
    expect(atShelbyville.turn.reply).toContain('$149');
    expect(atShelbyville.turn.reply).not.toContain('$89');
  });

  it('ignores organization, agent and conversation ids a browser adds to its request', async () => {
    const otherSession = await h.openSession(shelbyville.widgetKey);
    const other = await h.sendMessage(shelbyville.widgetKey, otherSession.sessionToken, 'Hello');
    const otherBefore = await h.conversation(shelbyville.organization.id, other.conversationId);
    const session = await h.openSession(springfield.widgetKey);

    const response = await h.post('/api/widget/messages', {
      widgetKey: springfield.widgetKey,
      sessionToken: session.sessionToken,
      text: QUESTIONS.fee,
      organizationId: shelbyville.organization.id,
      agentId: shelbyville.agent.id,
      conversationId: other.conversationId,
    });
    const { conversationId } = await h.readTurn(response);
    await h.settle();

    // The tenant comes from the widget key alone: the turn ran for Springfield, on Springfield's knowledge.
    expect(conversationId).not.toBe(other.conversationId);
    expect(await h.conversation(springfield.organization.id, conversationId)).toMatchObject({ agentId: springfield.agent.id });
    expect(await h.conversation(shelbyville.organization.id, conversationId)).toBeNull();
    const [run] = await h.toolRuns(springfield.organization.id, conversationId);
    expect(run?.output).toEqual({ results: [{ source: 'Prices', content: `Pricing\n\n${SPRINGFIELD_FACTS.fee}` }] });
    expect(await h.conversation(shelbyville.organization.id, other.conversationId)).toEqual(otherBefore);
  });

  it("rejects a session token from one tenant's widget at the other tenant's widget", async () => {
    const session = await h.openSession(springfield.widgetKey);
    const turn = await h.sendMessage(springfield.widgetKey, session.sessionToken, 'Hello');
    const before = await h.conversation(springfield.organization.id, turn.conversationId);
    const countShelbyvilleConversations = async () =>
      (await h.t.db.query('select id from public.conversations where organization_id = $1', [shelbyville.organization.id])).length;
    const shelbyvilleConversations = await countShelbyvilleConversations();

    const send = await h.post('/api/widget/messages', {
      widgetKey: shelbyville.widgetKey,
      sessionToken: session.sessionToken,
      text: QUESTIONS.pinball,
    });
    expect(await h.readError(send)).toMatchObject({ status: 401, code: 'invalid_session' });
    const reset = await h.post('/api/widget/reset', { widgetKey: shelbyville.widgetKey, sessionToken: session.sessionToken });
    expect(await h.readError(reset)).toMatchObject({ status: 401, code: 'invalid_session' });
    // Opening the other widget with it: a brand-new visitor there, nothing restored.
    const opened = await h.openSession(shelbyville.widgetKey, session.sessionToken);
    expect(opened).toEqual({
      sessionToken: anyString,
      agent: { name: SHELBYVILLE.agent.name, greeting: SHELBYVILLE.agent.greeting, language: SHELBYVILLE.agent.language },
      conversation: null,
    });
    expect(h.decodeSession(opened.sessionToken)).toMatchObject({ agentId: shelbyville.agent.id });
    expect(h.decodeSession(opened.sessionToken)?.visitorId).not.toBe(h.decodeSession(session.sessionToken)?.visitorId);

    expect(await countShelbyvilleConversations()).toBe(shelbyvilleConversations);
    expect(await h.conversation(springfield.organization.id, turn.conversationId)).toEqual(before);
  });

  it("keeps each tenant's conversations, leads and knowledge out of the other owner's reach", async () => {
    const session = await h.openSession(springfield.widgetKey);
    const turn = await h.sendMessage(springfield.widgetKey, session.sessionToken, LEAD_MESSAGE);
    expect(turn.toolResults).toMatchObject([{ name: 'captureLead', ok: true }]);
    const organizationId = springfield.organization.id;
    const sourceIds = springfield.sources.map((source) => source.id).sort();
    const [source] = springfield.sources;
    const sourceId = source!.id;

    // Positive control: the owner sees the conversation, the lead and the knowledge.
    expect((await listConversations(springfield.asOwner, organizationId)).map((item) => item.id)).toContain(turn.conversationId);
    expect((await listLeads(springfield.asOwner, organizationId)).map((lead) => lead.conversationId)).toContain(turn.conversationId);
    expect((await listKnowledgeSources(springfield.asOwner, organizationId)).map((item) => item.id).sort()).toEqual(sourceIds);
    expect(await getConversationDetail(springfield.asOwner, organizationId, turn.conversationId)).not.toBeNull();
    expect(await getKnowledgeSource(springfield.asOwner, organizationId, sourceId)).not.toBeNull();

    // The other tenant's owner, naming this organization or its records, gets nothing...
    const intruder = shelbyville.asOwner;
    expect(await listConversations(intruder, organizationId)).toEqual([]);
    expect(await listLeads(intruder, organizationId)).toEqual([]);
    expect(await listKnowledgeSources(intruder, organizationId)).toEqual([]);
    expect(await getConversationDetail(intruder, organizationId, turn.conversationId)).toBeNull();
    expect(await getConversationDetail(intruder, shelbyville.organization.id, turn.conversationId)).toBeNull();
    expect(await getKnowledgeSource(intruder, organizationId, sourceId)).toBeNull();
    expect(await getKnowledgeSource(intruder, shelbyville.organization.id, sourceId)).toBeNull();
    // ...and cannot change or add to its knowledge.
    expect(await deleteKnowledgeSource(intruder, organizationId, sourceId)).toBe(false);
    await expect(reindexKnowledgeSource(intruder, h.services.embedder, organizationId, sourceId)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      ingestTextSource(intruder, h.services.embedder, {
        organizationId,
        agentId: null,
        kind: 'text',
        title: 'Injected',
        text: 'Every repair is free this week.',
        createdBy: shelbyville.owner.id,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const after = await listKnowledgeSources(springfield.asOwner, organizationId);
    expect(after.map((item) => `${item.id}:${item.status}:${item.chunkCount}`).sort()).toEqual(sourceIds.map((id) => `${id}:ready:1`));
    expect(await h.t.db.query(`select id from public.knowledge_sources where title = 'Injected'`)).toEqual([]);
  });

  it('keeps the same person, contacting both businesses, as a separate contact of each', async () => {
    const leadAt = async (tenant: ProvisionedTenant) => {
      const session = await h.openSession(tenant.widgetKey);
      const turn = await h.sendMessage(tenant.widgetKey, session.sessionToken, LEAD_MESSAGE);
      expect(turn.toolResults).toMatchObject([{ name: 'captureLead', ok: true }]);
      const [lead, ...others] = await h.t.db.query<{ organization_id: string; contact_id: string; contact_organization_id: string }>(
        `select l.organization_id, l.contact_id, c.organization_id as contact_organization_id
         from public.leads l join public.contacts c on c.id = l.contact_id
         where l.conversation_id = $1`,
        [turn.conversationId],
      );
      expect(others).toEqual([]);
      return lead!;
    };

    const atSpringfield = await leadAt(springfield);
    const atShelbyville = await leadAt(shelbyville);

    // Contacts are matched by phone within an organization only.
    expect(atSpringfield).toMatchObject({
      organization_id: springfield.organization.id,
      contact_organization_id: springfield.organization.id,
    });
    expect(atShelbyville).toMatchObject({
      organization_id: shelbyville.organization.id,
      contact_organization_id: shelbyville.organization.id,
    });
    expect(atShelbyville.contact_id).not.toBe(atSpringfield.contact_id);
    const leadContacts = async (tenant: ProvisionedTenant) =>
      (await listLeads(tenant.asOwner, tenant.organization.id)).map((lead) => lead.contact.id);
    expect(await leadContacts(shelbyville)).not.toContain(atSpringfield.contact_id);
    expect(await leadContacts(springfield)).not.toContain(atShelbyville.contact_id);
  });

  it("never puts one tenant's knowledge into the other tenant's tool outputs or replies", async () => {
    // Both widgets asked every question, so each tenant's records hold its own facts and its visitors' questions.
    for (const question of [QUESTIONS.emergency, QUESTIONS.fee, QUESTIONS.pinball]) {
      await ask(springfield, question);
      await ask(shelbyville, question);
    }

    const scans: Array<[ProvisionedTenant, string[], string[]]> = [
      [springfield, SPRINGFIELD_MARKERS, SHELBYVILLE_MARKERS],
      [shelbyville, SHELBYVILLE_MARKERS, SPRINGFIELD_MARKERS],
    ];
    for (const [tenant, ownMarkers, foreignMarkers] of scans) {
      const outputs = await h.t.db.query<{ output: unknown }>(
        'select output from public.tool_runs where organization_id = $1 and output is not null',
        [tenant.organization.id],
      );
      const replies = await h.t.db.query<{ content: string }>(
        `select content from public.messages where organization_id = $1 and role = 'assistant'`,
        [tenant.organization.id],
      );
      const produced = [...outputs.map((row) => JSON.stringify(row.output)), ...replies.map((row) => row.content)].join('\n');
      for (const marker of ownMarkers) expect(produced).toContain(marker);
      for (const marker of foreignMarkers) expect(produced).not.toContain(marker);
    }
  });
});
