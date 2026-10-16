import type * as nextServer from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TextGenerationRequest } from '@/server/ai/types';
import { setWebChatEnabled } from '@/server/domain/agents/repository';
import { listLeads } from '@/server/domain/contacts/service';
import { getConversationDetail, listConversations } from '@/server/domain/conversations/service';
import { listKnowledgeSources } from '@/server/domain/knowledge/ingestion';
import { listMemberships } from '@/server/domain/organizations/service';
import {
  FAKE_MODEL_PRICING,
  createAppHarness,
  type AppHarness,
  type ProvisionedTenant,
  type TurnResult,
  type UsageRow,
} from '../support/app-harness';
import { cosineSimilarity, fakeEmbed } from '../support/fake-embeddings';
import { GREETING_REPLY, NO_INFORMATION_REPLY, NO_LEAD_CAPTURE_REPLY } from '../support/receptionist-model';
import { ScriptedTextProvider } from '../support/scripted-text-provider';
import {
  LEAD_MESSAGE,
  OGDENVILLE,
  QUESTIONS,
  SHELBYVILLE,
  SHELBYVILLE_MARKERS,
  SPRINGFIELD,
  SPRINGFIELD_FACTS,
  SPRINGFIELD_MARKERS,
  eventTypes,
} from './tenants';

/**
 * Phase 1 acceptance (IMPLEMENTATION_PLAN.md): the web chat vertical slice end to end — visitors through the
 * public route handlers, owners through the domain services under their RLS scope — with the rule-based
 * FakeReceptionistModel standing in for the LLM. Assertions target the persisted records and the wire
 * protocol. Scenarios 4-6 live in the sibling files.
 */

// The route handlers take their services from `@/server/app-services` and post-response work goes to `after()`:
// both are wired to the app harness (vi.mock is hoisted above the imports).
vi.mock('@/server/app-services', async () => (await import('../support/app-harness')).mockedAppServices);
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof nextServer>()),
  ...(await import('../support/app-harness')).mockedNextServer,
}));

// `expect.any` / `expect.objectContaining` return `any`; typed as unknown for the strict lint rules.
const anyString: unknown = expect.any(String);
const like = (expected: Record<string, unknown>): unknown => expect.objectContaining(expected);

let h: AppHarness;
let springfield: ProvisionedTenant;

beforeAll(async () => {
  h = await createAppHarness();
  springfield = await h.provisionTenant(SPRINGFIELD);
  // A second tenant in the same database, so every scenario runs multi-tenant.
  await h.provisionTenant(SHELBYVILLE);
});

afterEach(() => {
  // Failures the visitor never sees (metering, audit, summary, tool or turn errors, unpriced models) are logged
  // at warn level or above: a test takes the warnings it expects (logger.take), anything else fails it.
  const unexpected = h.logger.eventsAtLeast('warn');
  h.logger.clear();
  expect(unexpected).toEqual([]);
});

afterAll(async () => {
  await h.close();
});

const toolNames = (turn: TurnResult): string[] => turn.toolCalls.map((call) => call.name);

function messageIdOf(turn: TurnResult): string {
  if (turn.terminal.type !== 'turn.done') throw new Error(`The turn failed: ${turn.terminal.message}`);
  return turn.terminal.messageId;
}

/** The tool result a model request ends with: what the model was told, parsed. */
function lastToolResult(request: TextGenerationRequest | undefined): { callId: string; output: unknown } {
  const item = request?.input.at(-1);
  if (item?.type !== 'tool_result') throw new Error('The model request does not end with a tool result');
  return { callId: item.callId, output: JSON.parse(item.output) };
}

/** `kind/purpose/provider/model` of each usage row, sorted. */
function usageKinds(rows: readonly UsageRow[]): string[] {
  return rows.map(({ kind, purpose, provider, model }) => `${kind}/${purpose}/${provider}/${model}`).sort();
}

describe('Phase 1 web chat slice', () => {
  // Tenant A's configuration with knowledge of its own (chunk content identifies the tenant it belongs to).
  const WEST_FACT = 'We offer 24/7 emergency boiler repair across West Springfield.';
  const WEST = {
    ...SPRINGFIELD,
    name: 'West Springfield Heating',
    knowledge: [
      { title: 'Emergency service', text: `# Emergency service\n${WEST_FACT}` },
      { title: 'Prices', text: '# Pricing\nOur standard call-out fee is $95 per visit.' },
    ],
    publish: false,
  };

  it('organization -> agent configuration -> knowledge -> web chat -> tools -> lead capture -> persisted conversation -> usage', async () => {
    // ── Organization (onboarding) and agent configuration (the owner, under RLS). Not published yet.
    const tenant = await h.provisionTenant(WEST);
    const { organization, agent, asOwner } = tenant;
    expect(await listMemberships(asOwner, tenant.owner.id)).toEqual([{ organization, role: 'owner' }]);
    expect(agent).toMatchObject({ ...SPRINGFIELD.agent, organizationId: organization.id });
    expect(tenant.hours).toEqual(SPRINGFIELD.hours);

    // ── Knowledge: each source chunked and embedded with the configured embedding model.
    const sources = await listKnowledgeSources(asOwner, organization.id);
    expect(
      sources.map(({ title, status, chunkCount }) => ({ title, status, chunkCount })).sort((a, b) => a.title.localeCompare(b.title)),
    ).toEqual([
      { title: 'Emergency service', status: 'ready', chunkCount: 1 },
      { title: 'Prices', status: 'ready', chunkCount: 1 },
    ]);
    const chunks = await h.t.db.query<{ source_id: string; embedding_model: string }>(
      'select source_id, embedding_model from public.knowledge_chunks where organization_id = $1',
      [organization.id],
    );
    expect(chunks.map((chunk) => chunk.embedding_model)).toEqual(['fake-embed-v1', 'fake-embed-v1']);
    expect(new Set(chunks.map((chunk) => chunk.source_id))).toEqual(new Set(tenant.sources.map((source) => source.id)));

    // ── Until the owner publishes it, the widget does not exist for visitors.
    expect(await h.readError(await h.post('/api/widget/session', { widgetKey: tenant.widgetKey }))).toMatchObject({
      status: 404,
      code: 'widget_unavailable',
    });
    const channel = await asOwner.run((sql) => setWebChatEnabled(sql, organization.id, agent.id, true));
    expect(channel).toMatchObject({ enabled: true, publicKey: tenant.widgetKey });

    // ── A visitor opens the widget: the configured public details only; opening it creates no conversation.
    const session = await h.openSession(tenant.widgetKey);
    expect(session).toEqual({
      sessionToken: anyString,
      agent: { name: SPRINGFIELD.agent.name, greeting: SPRINGFIELD.agent.greeting, language: SPRINGFIELD.agent.language },
      conversation: null,
    });
    const visitor = h.decodeSession(session.sessionToken);
    expect(visitor).toMatchObject({ agentId: agent.id, visitorId: anyString });
    expect(await h.t.db.query('select id from public.conversations where organization_id = $1', [organization.id])).toEqual([]);

    // ── The conversation: small talk, a knowledge question, both business tools, then the visitor's details.
    const requestsBefore = h.requestsTo('receptionist').length;
    const token = session.sessionToken;
    const hello = await h.sendMessage(tenant.widgetKey, token, 'Hello');
    const grounded = await h.sendMessage(tenant.widgetKey, token, QUESTIONS.emergency);
    const hours = await h.sendMessage(tenant.widgetKey, token, QUESTIONS.hours);
    const details = await h.sendMessage(tenant.widgetKey, token, QUESTIONS.phone);
    const lead = await h.sendMessage(tenant.widgetKey, token, LEAD_MESSAGE);
    const turns = [hello, grounded, hours, details, lead];

    expect(hello.response.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(hello.response.headers.get('x-accel-buffering')).toBe('no');
    expect(turns.map(toolNames)).toEqual([[], ['searchKnowledge'], ['getBusinessHours'], ['getBusinessInfo'], ['captureLead']]);
    expect(turns.flatMap((turn) => turn.toolResults.map((result) => result.ok))).toEqual([true, true, true, true]);
    expect(turns.map((turn) => turn.terminal.type)).toEqual(Array<string>(5).fill('turn.done'));
    const conversationId = hello.conversationId;
    expect(turns.map((turn) => turn.conversationId)).toEqual(Array<string>(5).fill(conversationId));
    expect(new Set(turns.map((turn) => turn.turnId)).size).toBe(5);
    for (const turn of turns) expect(turn.streamedText).toBe(turn.reply);
    expect(hello.reply).toBe(GREETING_REPLY);
    expect(grounded.reply).toContain(WEST_FACT);

    // The configured agent drives the model: its model, the owner's instructions, the business facts and its tools.
    const requests = h.requestsTo('receptionist').slice(requestsBefore);
    expect(requests.map((request) => request.model)).toEqual(Array<string>(9).fill('receptionist-mini'));
    const [helloRequest] = requests;
    expect(helloRequest?.instructions).toContain(SPRINGFIELD.agent.instructions);
    expect(helloRequest?.instructions).toContain(SPRINGFIELD.profile.description);
    // "Now" in the agent's time zone (the harness clock: Tuesday 14:05 UTC).
    expect(helloRequest?.instructions).toContain('Tuesday 09:05 (America/Chicago)');
    expect(helloRequest?.tools.map((tool) => tool.name)).toEqual(['searchKnowledge', 'getBusinessInfo', 'getBusinessHours', 'captureLead']);
    expect(helloRequest?.input).toEqual([{ type: 'message', role: 'user', content: 'Hello' }]);

    // ── The persisted conversation: the database, not the browser, is the record.
    const messages = await h.messages(organization.id, conversationId);
    const toolExchange = ['user', 'tool_call', 'tool_result', 'assistant'];
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      ...toolExchange,
      ...toolExchange,
      ...toolExchange,
      ...toolExchange,
    ]);
    expect(messages.filter((message) => message.role === 'user').map((message) => message.content)).toEqual([
      'Hello',
      QUESTIONS.emergency,
      QUESTIONS.hours,
      QUESTIONS.phone,
      LEAD_MESSAGE,
    ]);
    expect(
      messages.filter((message) => message.role === 'assistant').map(({ id, content }) => ({ id, content })),
    ).toEqual(turns.map((turn) => ({ id: messageIdOf(turn), content: turn.reply })));

    // Every tool call is a server-side run, tied to its wire event and its transcript rows.
    const runs = await h.toolRuns(organization.id, conversationId);
    expect(runs.map(({ toolName, status }) => ({ toolName, status }))).toEqual([
      { toolName: 'searchKnowledge', status: 'succeeded' },
      { toolName: 'getBusinessHours', status: 'succeeded' },
      { toolName: 'getBusinessInfo', status: 'succeeded' },
      { toolName: 'captureLead', status: 'succeeded' },
    ]);
    const wireCalls = turns.flatMap((turn) => turn.toolCalls);
    expect(runs.map((run) => run.providerCallId)).toEqual(wireCalls.map((call) => call.callId));
    expect(messages.filter((message) => message.role === 'tool_call').map((message) => message.toolCallId)).toEqual(
      wireCalls.map((call) => call.callId),
    );
    expect(messages.filter((message) => message.role === 'tool_result').map((message) => message.toolRunId)).toEqual(
      runs.map((run) => run.id),
    );
    for (const run of runs) expect(run).toMatchObject({ organizationId: organization.id, agentId: agent.id, channel: 'web_chat' });

    const [searchRun, hoursRun, infoRun, leadRun] = runs;
    expect(searchRun?.output).toEqual({ results: [{ source: 'Emergency service', content: `Emergency service\n\n${WEST_FACT}` }] });
    // Opening hours in the agent's time zone at the harness's fixed time (Tuesday 14:05 UTC = 09:05 in Chicago).
    expect(hoursRun?.output).toEqual({
      timezone: 'America/Chicago',
      localTime: 'Tuesday 09:05',
      isOpenNow: true,
      weekly: [
        { day: 'Sunday', hours: [] },
        { day: 'Monday', hours: ['08:00-18:00'] },
        { day: 'Tuesday', hours: ['08:00-18:00'] },
        { day: 'Wednesday', hours: ['08:00-18:00'] },
        { day: 'Thursday', hours: ['08:00-18:00'] },
        { day: 'Friday', hours: ['08:00-18:00'] },
        { day: 'Saturday', hours: ['09:00-13:00'] },
      ],
      nextChange: { kind: 'closes', at: 'Tuesday 18:00' },
    });
    // Contact details exactly as the owner configured them.
    const { organizationId: _organizationId, agentId: _agentId, updatedAt: _updatedAt, ...configuredProfile } = tenant.profile;
    expect(infoRun?.output).toEqual(configuredProfile);
    expect(leadRun).toMatchObject({
      input: { name: 'Jane Doe', phone: '(555) 123-4567', email: null, summary: LEAD_MESSAGE },
      output: { saved: true, fields: ['name', 'phone', 'summary'], updatedExistingLead: false },
      replayed: false,
    });

    // ── Lead capture upgraded the anonymous visitor to a contact.
    const contacts = await h.t.db.query<{ id: string }>(
      `select id, name, phone, phone_normalized, email from public.contacts where organization_id = $1`,
      [organization.id],
    );
    expect(contacts).toEqual([
      { id: anyString, name: 'Jane Doe', phone: '(555) 123-4567', phone_normalized: '5551234567', email: null },
    ]);
    const contactId = contacts[0]!.id;
    expect(await h.conversation(organization.id, conversationId)).toMatchObject({
      agentId: agent.id,
      channel: 'web_chat',
      status: 'active',
      visitorId: visitor!.visitorId,
      contactId,
      messageCount: messages.length,
      turnLockedUntil: null,
      closedAt: null,
    });

    // ── The owner reviews it in the admin views (user scope, RLS).
    expect(await listConversations(asOwner, organization.id)).toEqual([
      like({ id: conversationId, agentName: 'Sky', status: 'active', contactName: 'Jane Doe', messageCount: 18, preview: lead.reply }),
    ]);
    const detail = await getConversationDetail(asOwner, organization.id, conversationId);
    expect(detail?.contact).toMatchObject({ id: contactId, name: 'Jane Doe', phone: '(555) 123-4567' });
    expect(detail?.messages.map((message) => message.id)).toEqual(messages.map((message) => message.id));
    expect(detail?.toolRuns.map((run) => ({ id: run.id, status: run.status }))).toEqual(
      runs.map((run) => ({ id: run.id, status: 'succeeded' })),
    );
    expect(await listLeads(asOwner, organization.id)).toEqual([
      like({
        conversationId,
        agentId: agent.id,
        agentName: 'Sky',
        channel: 'web_chat',
        status: 'new',
        summary: LEAD_MESSAGE,
        // What the visitor said in this conversation, kept on the lead itself.
        capturedName: 'Jane Doe',
        capturedPhone: '(555) 123-4567',
        capturedEmail: null,
        contact: like({ id: contactId, name: 'Jane Doe', phone: '(555) 123-4567' }),
      }),
    ]);

    // ── Usage metering: every model round and every embedding, with tokens and an estimated cost.
    const usage = await h.usage(organization.id, conversationId);
    expect(usageKinds(usage)).toEqual([
      'embedding/knowledge_query/fake/fake-embed-v1',
      ...Array<string>(9).fill('text_generation/chat_response/receptionist/receptionist-mini'),
    ]);
    for (const row of usage) {
      expect(row).toMatchObject({ organizationId: organization.id, agentId: agent.id, pricingKnown: true });
      expect(row.inputTokens).toBeGreaterThan(0);
      expect(row.costUsd).toBeGreaterThan(0);
    }
    const chatRows = usage.filter((row) => row.purpose === 'chat_response');
    expect(chatRows.reduce((sum, row) => sum + row.toolCalls, 0)).toBe(4);
    const textPrice = FAKE_MODEL_PRICING['receptionist-mini']!;
    for (const row of chatRows) {
      expect(row).toMatchObject({ cachedInputTokens: 0, cacheWriteTokens: 0, metadata: like({ tier: 'default' }) });
      expect(row.outputTokens).toBeGreaterThan(0);
      expect(row.costUsd).toBeCloseTo((row.inputTokens * textPrice.inputPerMTok + row.outputTokens * textPrice.outputPerMTok) / 1e6, 8);
    }
    const embeddingPrice = FAKE_MODEL_PRICING['fake-embed-v1']!;
    const embeddingRows = (await h.usage(organization.id)).filter((row) => row.kind === 'embedding');
    // Knowledge ingestion: one row per source, billed to the organization (shared sources: no agent, no conversation).
    expect(
      embeddingRows.filter((row) => row.purpose === 'knowledge_ingestion').map(({ agentId, conversationId: id }) => ({ agentId, id })),
    ).toEqual([
      { agentId: null, id: null },
      { agentId: null, id: null },
    ]);
    for (const row of embeddingRows) {
      expect(row).toMatchObject({ provider: 'fake', model: 'fake-embed-v1', pricingKnown: true, outputTokens: 0 });
      expect(row.costUsd).toBeGreaterThan(0);
      expect(row.costUsd).toBeCloseTo((row.inputTokens * embeddingPrice.inputPerMTok) / 1e6, 8);
    }
    expect(h.logger.entries.filter((entry) => entry.event === 'usage.pricing_unknown')).toEqual([]);
  });
});

describe('1. a visitor question answered by the knowledge base gets a grounded answer', () => {
  it('answers from the retrieved chunk through searchKnowledge and records the evidence', async () => {
    const organizationId = springfield.organization.id;
    const session = await h.openSession(springfield.widgetKey);
    const requestsBefore = h.requestsTo('receptionist').length;

    const turn = await h.sendMessage(springfield.widgetKey, session.sessionToken, QUESTIONS.emergency);

    // Wire: one tool round trip, then the answer streamed in deltas that add up to the final text.
    expect(eventTypes(turn.events)).toEqual(['turn.start', 'tool.call', 'tool.result', 'text.delta', 'turn.done']);
    expect(turn.events.every((event) => event.turnId === turn.turnId)).toBe(true);
    expect(turn.toolCalls).toEqual([
      { type: 'tool.call', turnId: turn.turnId, callId: anyString, name: 'searchKnowledge', label: 'Searching our information' },
    ]);
    const callId = turn.toolCalls[0]!.callId;
    expect(turn.toolResults).toEqual([{ type: 'tool.result', turnId: turn.turnId, callId, name: 'searchKnowledge', ok: true }]);
    expect(turn.reply).toContain(SPRINGFIELD_FACTS.emergency);
    expect(turn.streamedText).toBe(turn.reply);

    // The evidence: one succeeded run whose output holds the retrieved chunk...
    const chunkContent = `Emergency service\n\n${SPRINGFIELD_FACTS.emergency}`;
    const [run, ...otherRuns] = await h.toolRuns(organizationId, turn.conversationId);
    expect(otherRuns).toEqual([]);
    expect(run).toMatchObject({
      toolName: 'searchKnowledge',
      status: 'succeeded',
      agentId: springfield.agent.id,
      channel: 'web_chat',
      providerCallId: callId,
      input: { query: QUESTIONS.emergency },
      output: { results: [{ source: 'Emergency service', content: chunkContent }] },
    });
    // ...a chunk of THIS tenant's "Emergency service" source...
    const emergencySource = springfield.sources.find((source) => source.title === 'Emergency service');
    expect(
      await h.t.db.query('select organization_id, source_id from public.knowledge_chunks where content = $1', [chunkContent]),
    ).toEqual([{ organization_id: organizationId, source_id: emergencySource?.id }]);
    // ...and exactly that output is what the model answered from.
    const requests = h.requestsTo('receptionist').slice(requestsBefore);
    expect(requests).toHaveLength(2);
    expect(lastToolResult(requests[1])).toEqual({ callId, output: { ok: true, ...(run!.output as object) } });

    // The transcript: user -> tool_call -> tool_result -> assistant, cross-referenced.
    const messages = await h.messages(organizationId, turn.conversationId);
    expect(messages.map((message) => message.role)).toEqual(['user', 'tool_call', 'tool_result', 'assistant']);
    const [user, toolCall, toolResultMessage, assistant] = messages;
    expect(user).toMatchObject({ content: QUESTIONS.emergency, data: {} });
    expect(toolCall).toMatchObject({ toolName: 'searchKnowledge', toolCallId: callId, data: { arguments: { query: QUESTIONS.emergency } } });
    expect(toolResultMessage).toMatchObject({
      toolName: 'searchKnowledge',
      toolCallId: callId,
      toolRunId: run!.id,
      data: { ok: true, errorCode: null, replayed: false },
    });
    expect(assistant).toMatchObject({
      id: messageIdOf(turn),
      content: turn.reply,
      data: { model: 'receptionist-mini', tier: 'default', rounds: 2 },
    });
    expect(await h.conversation(organizationId, turn.conversationId)).toMatchObject({
      agentId: springfield.agent.id,
      visitorId: h.decodeSession(session.sessionToken)?.visitorId,
      status: 'active',
      turnLockedUntil: null,
    });
    expect(usageKinds(await h.usage(organizationId, turn.conversationId))).toEqual([
      'embedding/knowledge_query/fake/fake-embed-v1',
      'text_generation/chat_response/receptionist/receptionist-mini',
      'text_generation/chat_response/receptionist/receptionist-mini',
    ]);
  });
});

describe('2. a visitor question the knowledge base cannot answer: the agent does not invent', () => {
  it('finds no evidence above the relevance threshold and says it does not have the information', async () => {
    const organizationId = springfield.organization.id;
    // The knowledge base does hold a loosely related chunk (it shares the word "repair"): retrieval's relevance
    // threshold, not an empty knowledge base, is what keeps it out.
    const similarity = cosineSimilarity(fakeEmbed(QUESTIONS.unknown), fakeEmbed(`Emergency service\n\n${SPRINGFIELD_FACTS.emergency}`));
    expect(similarity).toBeGreaterThan(0);
    expect(similarity).toBeLessThan(h.services.ai.budgets.minRetrievalSimilarity);
    const session = await h.openSession(springfield.widgetKey);
    const requestsBefore = h.requestsTo('receptionist').length;

    const turn = await h.sendMessage(springfield.widgetKey, session.sessionToken, QUESTIONS.unknown);

    expect(eventTypes(turn.events)).toEqual(['turn.start', 'tool.call', 'tool.result', 'text.delta', 'turn.done']);
    expect(turn.toolResults).toMatchObject([{ name: 'searchKnowledge', ok: true }]);
    // The search itself worked and returned nothing, with an explicit instruction not to guess.
    const [run] = await h.toolRuns(organizationId, turn.conversationId);
    expect(run).toMatchObject({ toolName: 'searchKnowledge', status: 'succeeded', input: { query: QUESTIONS.unknown } });
    expect(run?.output).toEqual({ results: [], note: expect.stringContaining('Do not guess') as unknown });
    const [question, answer] = h.requestsTo('receptionist').slice(requestsBefore);
    expect(lastToolResult(answer).output).toEqual({ ok: true, ...(run!.output as object) });
    // What keeps a real model from inventing is the product's part: these rules, and that empty result.
    expect(question?.instructions).toContain('Never guess or invent services, prices, policies, hours, contact details or other facts.');
    expect(question?.instructions).toContain("If you don't have the information, say so plainly");

    // The reply admits it does not know and states no fact from any tenant's knowledge.
    expect(turn.reply).toBe(NO_INFORMATION_REPLY);
    for (const marker of [...SPRINGFIELD_MARKERS, ...SHELBYVILLE_MARKERS, 'Springfield', '$']) {
      expect(turn.reply).not.toContain(marker);
    }
    const messages = await h.messages(organizationId, turn.conversationId);
    expect(messages.map((message) => message.role)).toEqual(['user', 'tool_call', 'tool_result', 'assistant']);
    expect(messages.at(-1)).toMatchObject({ id: messageIdOf(turn), content: NO_INFORMATION_REPLY });
  });
});

describe('3. a visitor who gives their name and phone number becomes a lead through captureLead', () => {
  const PHONE_NORMALIZED = '5551234567';

  it('saves the contact and the lead, links them to the conversation, audits the tool and never saves twice', async () => {
    const organizationId = springfield.organization.id;
    const session = await h.openSession(springfield.widgetKey);

    const turn = await h.sendMessage(springfield.widgetKey, session.sessionToken, LEAD_MESSAGE);

    expect(eventTypes(turn.events)).toEqual(['turn.start', 'tool.call', 'tool.result', 'text.delta', 'turn.done']);
    expect(turn.toolCalls).toEqual([
      { type: 'tool.call', turnId: turn.turnId, callId: anyString, name: 'captureLead', label: 'Saving your details' },
    ]);
    expect(turn.toolResults).toMatchObject([{ name: 'captureLead', ok: true }]);
    // The reply confirms the save only after the tool reported success.
    expect(turn.reply).toContain("I've saved your details");

    const conversationId = turn.conversationId;
    const [run] = await h.toolRuns(organizationId, conversationId);
    expect(run).toMatchObject({
      toolName: 'captureLead',
      status: 'succeeded',
      input: { name: 'Jane Doe', phone: '(555) 123-4567', email: null, summary: LEAD_MESSAGE },
      output: { saved: true, fields: ['name', 'phone', 'summary'], updatedExistingLead: false },
      replayed: false,
      idempotencyKey: anyString,
    });
    const leadsOf = () =>
      h.t.db.query<{ id: string; contact_id: string }>(
        `select id, contact_id, agent_id, channel, status, summary, captured_name, captured_phone, captured_email
         from public.leads where organization_id = $1 and conversation_id = $2`,
        [organizationId, conversationId],
      );
    const leads = await leadsOf();
    expect(leads).toEqual([
      {
        id: anyString,
        contact_id: anyString,
        agent_id: springfield.agent.id,
        channel: 'web_chat',
        status: 'new',
        summary: LEAD_MESSAGE,
        captured_name: 'Jane Doe',
        captured_phone: '(555) 123-4567',
        captured_email: null,
      },
    ]);
    const contactsWithPhone = () =>
      h.t.db.query<{ id: string }>(
        'select id, name, phone, email from public.contacts where organization_id = $1 and phone_normalized = $2',
        [organizationId, PHONE_NORMALIZED],
      );
    expect(await contactsWithPhone()).toEqual([{ id: leads[0]!.contact_id, name: 'Jane Doe', phone: '(555) 123-4567', email: null }]);
    expect((await h.conversation(organizationId, conversationId))?.contactId).toBe(leads[0]!.contact_id);
    // A side effect of a tool: audited as the agent's action on this conversation.
    const auditOf = () =>
      h.t.db.query(
        `select actor_type, actor_id, action, target_type, metadata from public.audit_logs
         where organization_id = $1 and action = 'tool.captureLead' and target_id = $2`,
        [organizationId, conversationId],
      );
    expect(await auditOf()).toEqual([
      { actor_type: 'agent', actor_id: springfield.agent.id, action: 'tool.captureLead', target_type: 'conversation', metadata: { toolRunId: run!.id } },
    ]);

    // The same details again (a double submit or a repeated message): the earlier result is replayed.
    const again = await h.sendMessage(springfield.widgetKey, session.sessionToken, LEAD_MESSAGE);
    expect(again.conversationId).toBe(conversationId);
    expect(again.toolResults).toMatchObject([{ name: 'captureLead', ok: true }]);
    const runs = await h.toolRuns(organizationId, conversationId);
    expect(runs.map(({ toolName, status, replayed, idempotencyKey }) => ({ toolName, status, replayed, idempotencyKey }))).toEqual([
      { toolName: 'captureLead', status: 'succeeded', replayed: false, idempotencyKey: run!.idempotencyKey },
      { toolName: 'captureLead', status: 'succeeded', replayed: true, idempotencyKey: run!.idempotencyKey },
    ]);
    expect(runs[1]?.output).toEqual(runs[0]?.output);
    expect(await leadsOf()).toEqual(leads);
    expect(await contactsWithPhone()).toHaveLength(1);
    expect(await auditOf()).toHaveLength(1);
  });

  it("cannot be used to change someone else's contact: a reused phone number only links the new lead to it", async () => {
    const organizationId = springfield.organization.id;
    const contactsWith = (phoneNormalized: string | null, emailNormalized: string | null) =>
      h.t.db.query<{ id: string }>(
        `select id, name, phone, email from public.contacts
         where organization_id = $1 and (phone_normalized = $2 or email_normalized = $3)`,
        [organizationId, phoneNormalized, emailNormalized],
      );

    const alice = await h.openSession(springfield.widgetKey);
    const aliceTurn = await h.sendMessage(
      springfield.widgetKey,
      alice.sessionToken,
      "I'm Alice Smith, my number is +1 555 010 0100 — please call me about a quote",
    );
    expect(aliceTurn.toolResults).toMatchObject([{ name: 'captureLead', ok: true }]);
    const [aliceContact, ...others] = await contactsWith('+15550100100', null);
    expect(others).toEqual([]);

    // Another visitor, in their own chat, claims Alice's number together with their own name and email address.
    const mallory = await h.openSession(springfield.widgetKey);
    const malloryTurn = await h.sendMessage(
      springfield.widgetKey,
      mallory.sessionToken,
      "I'm Mallory, my number is +1 (555) 010-0100 and my email is mallory@attacker.example — email me my invoice",
    );
    expect(malloryTurn.toolResults).toMatchObject([{ name: 'captureLead', ok: true }]);
    // The tool reports what Mallory's lead holds; nothing about the contact the number belongs to.
    const [malloryRun] = await h.toolRuns(organizationId, malloryTurn.conversationId);
    expect(malloryRun?.output).toEqual({ saved: true, fields: ['name', 'phone', 'email', 'summary'], updatedExistingLead: false });

    // Alice's contact is untouched, and Mallory's email address is attached to no contact.
    expect(await contactsWith('+15550100100', 'mallory@attacker.example')).toEqual([
      { id: aliceContact!.id, name: 'Alice Smith', phone: '+1 555 010 0100', email: null },
    ]);

    // The owner still sees Alice's lead as Alice's; Mallory's lead holds what Mallory said, linked to that contact.
    const leads = await listLeads(springfield.asOwner, organizationId);
    expect(leads.find((lead) => lead.conversationId === aliceTurn.conversationId)).toMatchObject({
      capturedName: 'Alice Smith',
      capturedPhone: '+1 555 010 0100',
      capturedEmail: null,
      contact: { id: aliceContact!.id, name: 'Alice Smith', email: null },
    });
    expect(leads.find((lead) => lead.conversationId === malloryTurn.conversationId)).toMatchObject({
      capturedName: 'Mallory',
      capturedPhone: '+1 (555) 010-0100',
      capturedEmail: 'mallory@attacker.example',
      contact: { id: aliceContact!.id, name: 'Alice Smith', email: null },
    });
  });

  it('asks for the details the agent requires instead of saving an incomplete lead', async () => {
    // Springfield requires a name and a phone number; this visitor only gives the number.
    expect(springfield.agent.leadCapture.requiredFields).toEqual(['name', 'phone']);
    const organizationId = springfield.organization.id;
    const session = await h.openSession(springfield.widgetKey);
    const requestsBefore = h.requestsTo('receptionist').length;

    const turn = await h.sendMessage(springfield.widgetKey, session.sessionToken, 'You can reach me at (555) 987-6543');

    // The server refuses the save. The wire only says the tool did not succeed (no error code reaches the browser)...
    const callId = turn.toolCalls[0]?.callId;
    expect(turn.toolCalls).toEqual([
      { type: 'tool.call', turnId: turn.turnId, callId, name: 'captureLead', label: 'Saving your details' },
    ]);
    expect(turn.toolResults).toEqual([{ type: 'tool.result', turnId: turn.turnId, callId, name: 'captureLead', ok: false }]);
    // ...the model is told what is missing, and the reply asks for it rather than claiming a save.
    expect(lastToolResult(h.requestsTo('receptionist').slice(requestsBefore)[1]).output).toEqual({
      ok: false,
      error: { code: 'missing_information', message: 'Ask the visitor for: their name.', details: { missing: ['name'] } },
    });
    expect(turn.reply).toBe('Could you please share your name?');

    const conversationId = turn.conversationId;
    const runs = await h.toolRuns(organizationId, conversationId);
    expect(runs).toMatchObject([{ toolName: 'captureLead', status: 'failed', errorCode: 'missing_information', output: null }]);
    const toolResultMessage = (await h.messages(organizationId, conversationId)).find((message) => message.role === 'tool_result');
    expect(toolResultMessage).toMatchObject({
      toolRunId: runs[0]?.id,
      data: { ok: false, errorCode: 'missing_information', replayed: false },
    });
    // Nothing saved, linked or audited.
    const rows = (query: string) => h.t.db.query(query, [organizationId, conversationId]);
    expect(await rows('select id from public.leads where organization_id = $1 and conversation_id = $2')).toEqual([]);
    expect(await rows('select id from public.audit_logs where organization_id = $1 and target_id = $2')).toEqual([]);
    expect(
      await h.t.db.query(`select id from public.contacts where organization_id = $1 and phone_normalized = '5559876543'`, [organizationId]),
    ).toEqual([]);
    expect(await h.conversation(organizationId, conversationId)).toMatchObject({ contactId: null });
  });

  it('is not offered when the agent does not capture leads, is refused if a model calls it anyway, and nothing is saved', async () => {
    const ogdenville = await h.provisionTenant(OGDENVILLE);
    const organizationId = ogdenville.organization.id;
    expect(ogdenville.agent.leadCapture).toEqual({ enabled: false, requiredFields: [] });
    const session = await h.openSession(ogdenville.widgetKey);
    const requestsBefore = h.requestsTo('receptionist').length;

    const turn = await h.sendMessage(ogdenville.widgetKey, session.sessionToken, LEAD_MESSAGE);

    // The model is never offered captureLead (nor told about it)...
    const [request, ...moreRequests] = h.requestsTo('receptionist').slice(requestsBefore);
    expect(moreRequests).toEqual([]);
    expect(request?.tools.map((tool) => tool.name)).toEqual(['searchKnowledge', 'getBusinessInfo', 'getBusinessHours']);
    expect(request?.instructions).not.toContain('captureLead');
    expect(eventTypes(turn.events)).toEqual(['turn.start', 'text.delta', 'turn.done']);
    expect(turn.reply).toBe(NO_LEAD_CAPTURE_REPLY);
    expect(await h.toolRuns(organizationId, turn.conversationId)).toEqual([]);
    expect(await h.conversation(organizationId, turn.conversationId)).toMatchObject({ contactId: null, messageCount: 2 });

    // ...and a model that calls it anyway is refused by the server: availability is enforced, not just advertised.
    const details = { name: 'Jane Doe', phone: '(555) 123-4567', email: null, summary: LEAD_MESSAGE };
    const rogue = new ScriptedTextProvider('receptionist', [
      { toolCalls: [{ name: 'captureLead', arguments: details }] },
      { text: "Sorry, I can't take contact details in this chat." },
    ]);
    const app = await createAppHarness({ database: h.t, logger: h.logger, textProviders: { receptionist: rogue } });
    try {
      const visitor = await app.openSession(ogdenville.widgetKey);
      const refused = await app.sendMessage(ogdenville.widgetKey, visitor.sessionToken, LEAD_MESSAGE);

      expect(rogue.requests[0]?.tools.map((tool) => tool.name)).not.toContain('captureLead');
      // Not "Saving your details": a tool the agent was not given never shows its label.
      expect(refused.toolCalls).toMatchObject([{ name: 'captureLead', label: 'Working on it' }]);
      expect(refused.toolResults).toMatchObject([{ name: 'captureLead', ok: false }]);
      expect(lastToolResult(rogue.requests[1]).output).toEqual({
        ok: false,
        error: { code: 'not_permitted', message: 'This tool is not available in this conversation.' },
      });
      expect(await h.toolRuns(organizationId, refused.conversationId)).toMatchObject([
        { toolName: 'captureLead', status: 'rejected', errorCode: 'not_permitted', output: null, replayed: false },
      ]);
      expect(await h.conversation(organizationId, refused.conversationId)).toMatchObject({ contactId: null });
    } finally {
      await app.close();
    }

    // Neither visitor's details were saved or audited.
    expect(await h.t.db.query('select id from public.contacts where organization_id = $1', [organizationId])).toEqual([]);
    expect(await h.t.db.query('select id from public.leads where organization_id = $1', [organizationId])).toEqual([]);
    expect(
      await h.t.db.query(`select action from public.audit_logs where organization_id = $1 and actor_type = 'agent'`, [organizationId]),
    ).toEqual([]);
  });
});
