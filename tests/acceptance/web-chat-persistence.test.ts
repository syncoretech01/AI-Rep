import type * as nextServer from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TextGenerationRequest, TextGenerationResult, TextModelProvider, TextStreamEvent } from '@/server/ai/types';
import { ensureWebChatChannel, insertAgent, setWebChatEnabled } from '@/server/domain/agents/repository';
import { DEFAULT_AGENT_SETTINGS } from '@/server/domain/agents/schemas';
import { getConversationDetail, listConversations } from '@/server/domain/conversations/service';
import { HARNESS_START, createAppHarness, type AppHarness, type ProvisionedTenant, type TurnResult } from '../support/app-harness';
import { FakeReceptionistModel } from '../support/receptionist-model';
import { QUESTIONS, SPRINGFIELD, SPRINGFIELD_FACTS } from './tenants';

/**
 * Phase 1 acceptance scenario 4: "refresh/reopen preserves conversation as designed". The browser keeps only
 * the signed session token (localStorage); the server restores the visitor's active conversation from the
 * database for a genuine, unexpired token of the same agent, and nothing for anything else.
 */

vi.mock('@/server/app-services', async () => (await import('../support/app-harness')).mockedAppServices);
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof nextServer>()),
  ...(await import('../support/app-harness')).mockedNextServer,
}));

const anyString: unknown = expect.any(String);
const like = (expected: Record<string, unknown>): unknown => expect.objectContaining(expected);
const DAY_MS = 24 * 60 * 60 * 1000;

let h: AppHarness;
let tenant: ProvisionedTenant;
let organizationId: string;

beforeAll(async () => {
  h = await createAppHarness();
  tenant = await h.provisionTenant(SPRINGFIELD);
  organizationId = tenant.organization.id;
});

afterEach(() => {
  // Anything logged at warn level or above (e.g. a failed rolling summary) is a failure nobody would see.
  const unexpected = h.logger.eventsAtLeast('warn');
  h.logger.clear();
  expect(unexpected).toEqual([]);
});

afterAll(async () => {
  await h.close();
});

function visitorOf(harness: AppHarness, token: string): string {
  const claims = harness.decodeSession(token);
  if (!claims) throw new Error('The session token does not verify');
  return claims.visitorId;
}

async function conversationIds(): Promise<string[]> {
  const rows = await h.t.db.query<{ id: string }>('select id from public.conversations where organization_id = $1 order by id', [
    organizationId,
  ]);
  return rows.map((row) => row.id);
}

/** The receptionist stand-in, except that while held every model call waits: a reply that is still being written. */
class GatedModel implements TextModelProvider {
  readonly id: string;
  readonly requests: TextGenerationRequest[] = [];
  private readonly inner: FakeReceptionistModel;
  private gate: Promise<void> = Promise.resolve();
  private open: () => void = () => undefined;

  constructor(id: string) {
    this.id = id;
    this.inner = new FakeReceptionistModel(id);
  }

  hold(): void {
    this.gate = new Promise((resolve) => {
      this.open = resolve;
    });
  }

  release(): void {
    this.open();
  }

  async generate(request: TextGenerationRequest): Promise<TextGenerationResult> {
    this.requests.push(request);
    await this.gate;
    return this.inner.generate(request);
  }

  async *stream(request: TextGenerationRequest): AsyncGenerator<TextStreamEvent, void, undefined> {
    this.requests.push(request);
    await this.gate;
    yield* this.inner.stream(request);
  }
}

/** Tokens a client could present instead of the genuine one. */
function tamperedVariants(token: string, claims: { agentId: string; visitorId: string }): string[] {
  const [payload = '', signature = ''] = token.split('.');
  const flipped = `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
  const iat = Math.floor(HARNESS_START.getTime() / 1000);
  // The same visitor and agent with a longer lifetime, "signed" with the genuine token's signature.
  const forged = Buffer.from(JSON.stringify({ v: 1, ...claims, iat, exp: iat + 365 * 24 * 3600 }), 'utf8').toString('base64url');
  return [`${payload}.${flipped}`, `${forged}.${signature}`, `${payload}.${signature}.${signature}`, 'not-a-session-token'];
}

describe('4. refresh / reopen preserves the conversation as designed', () => {
  it('restores the active conversation for the stored token: user and assistant messages, in order', async () => {
    const first = await h.openSession(tenant.widgetKey);
    const one = await h.sendMessage(tenant.widgetKey, first.sessionToken, QUESTIONS.emergency);
    const two = await h.sendMessage(tenant.widgetKey, first.sessionToken, QUESTIONS.fee);
    const conversationId = one.conversationId;
    expect(two.conversationId).toBe(conversationId);
    const before = await h.conversation(organizationId, conversationId);
    expect(before).toMatchObject({ status: 'active', messageCount: 8 });

    // Refresh (or reopening the site later): the widget sends the token it stored.
    const restored = await h.openSession(tenant.widgetKey, first.sessionToken);
    const visible = (await h.messages(organizationId, conversationId)).filter(
      (message) => message.role === 'user' || message.role === 'assistant',
    );
    expect(restored).toEqual({
      sessionToken: anyString,
      agent: { name: SPRINGFIELD.agent.name, greeting: SPRINGFIELD.agent.greeting, language: SPRINGFIELD.agent.language },
      conversation: {
        id: conversationId,
        messages: visible.map(({ id, role, content, createdAt }) => ({ id, role, content, createdAt: createdAt.toISOString() })),
      },
    });
    // Exactly the visible exchange: tool calls and results stay on the server.
    expect(restored.conversation?.messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: 'user', content: QUESTIONS.emergency },
      { role: 'assistant', content: one.reply },
      { role: 'user', content: QUESTIONS.fee },
      { role: 'assistant', content: two.reply },
    ]);
    // The token is re-issued for the same visitor and agent; restoring writes nothing.
    expect(h.decodeSession(restored.sessionToken)).toMatchObject({
      agentId: tenant.agent.id,
      visitorId: visitorOf(h, first.sessionToken),
    });
    expect(await h.conversation(organizationId, conversationId)).toEqual(before);

    // The visitor carries on in the same conversation.
    const three = await h.sendMessage(tenant.widgetKey, restored.sessionToken, 'Thanks, that helps');
    expect(three.conversationId).toBe(conversationId);
    expect((await h.openSession(tenant.widgetKey, restored.sessionToken)).conversation?.messages).toHaveLength(6);
  });

  it('keeps the reply when the visitor reloads the page while it is still streaming', async () => {
    const gated = new GatedModel('receptionist');
    const app = await createAppHarness({ database: h.t, logger: h.logger, textProviders: { receptionist: gated } });
    try {
      const session = await app.openSession(tenant.widgetKey);
      gated.hold();
      const tasksBefore = app.afterTaskCount();
      const response = await app.post('/api/widget/messages', {
        widgetKey: tenant.widgetKey,
        sessionToken: session.sessionToken,
        text: QUESTIONS.emergency,
      });
      // The running turn is handed to after(), so the platform keeps it alive without the response.
      expect(app.afterTaskCount()).toBe(tasksBefore + 1);
      // The page reloads mid-reply: the browser drops the stream.
      const stream = response.body;
      if (!stream) throw new Error('The messages route returned no stream');
      await stream.cancel();
      gated.release();
      await app.settle();

      // On reload the whole exchange is there, and the conversation is free again.
      const restored = await app.openSession(tenant.widgetKey, session.sessionToken);
      expect(restored.conversation?.messages.map(({ role }) => role)).toEqual(['user', 'assistant']);
      expect(restored.conversation?.messages[1]?.content).toContain(SPRINGFIELD_FACTS.emergency);
      expect(await app.conversation(organizationId, restored.conversation!.id)).toMatchObject({
        messageCount: 4,
        turnLockedUntil: null,
      });
    } finally {
      gated.release();
      await app.close();
    }
  });

  it('serializes the turns of a conversation open in two tabs, and frees it as soon as the reply ends', async () => {
    const gated = new GatedModel('receptionist');
    const app = await createAppHarness({ database: h.t, logger: h.logger, textProviders: { receptionist: gated } });
    try {
      const session = await app.openSession(tenant.widgetKey);
      const message = (text: string) =>
        app.post('/api/widget/messages', { widgetKey: tenant.widgetKey, sessionToken: session.sessionToken, text });
      gated.hold();
      const first = await message(QUESTIONS.emergency);

      // The second tab sends while the first reply is still being written: refused, nothing stored.
      expect(await app.readError(await message('Hello again'))).toMatchObject({ status: 409, code: 'conversation_busy' });
      gated.release();
      const { conversationId } = await app.readTurn(first);
      // Free once the reply has ended, before any post-turn work is awaited: the widget may send right away.
      expect((await app.conversation(organizationId, conversationId))?.turnLockedUntil).toBeNull();
      const second = await app.sendMessage(tenant.widgetKey, session.sessionToken, 'Hello again');
      expect(second.conversationId).toBe(conversationId);
      expect(
        (await app.messages(organizationId, conversationId)).filter((row) => row.role === 'user').map((row) => row.content),
      ).toEqual([QUESTIONS.emergency, 'Hello again']);
    } finally {
      gated.release();
      await app.settle();
      await app.close();
    }
  });

  it('starts a fresh visitor without a token or with a tampered one, and never exposes the existing conversation', async () => {
    const session = await h.openSession(tenant.widgetKey);
    const turn = await h.sendMessage(tenant.widgetKey, session.sessionToken, QUESTIONS.emergency);
    const claims = h.decodeSession(session.sessionToken)!;
    const before = await h.conversation(organizationId, turn.conversationId);
    const idsBefore = await conversationIds();

    // Another browser (nothing stored): a new visitor, and no conversation until they write.
    const elsewhere = await h.openSession(tenant.widgetKey);
    expect(elsewhere.conversation).toBeNull();
    expect(visitorOf(h, elsewhere.sessionToken)).not.toBe(claims.visitorId);

    for (const tampered of tamperedVariants(session.sessionToken, { agentId: claims.agentId, visitorId: claims.visitorId })) {
      // Never trusted: a fresh visitor with nothing restored...
      const reopened = await h.openSession(tenant.widgetKey, tampered);
      expect(reopened.conversation).toBeNull();
      expect(visitorOf(h, reopened.sessionToken)).not.toBe(claims.visitorId);
      // ...and no access to the conversation through messages or "New chat".
      const send = await h.post('/api/widget/messages', { widgetKey: tenant.widgetKey, sessionToken: tampered, text: 'Hello' });
      expect(await h.readError(send)).toMatchObject({ status: 401, code: 'invalid_session' });
      const reset = await h.post('/api/widget/reset', { widgetKey: tenant.widgetKey, sessionToken: tampered });
      expect(await h.readError(reset)).toMatchObject({ status: 401, code: 'invalid_session' });
    }

    expect(await h.conversation(organizationId, turn.conversationId)).toEqual(before);
    expect(await conversationIds()).toEqual(idsBefore);
    // The genuine token still restores it.
    expect((await h.openSession(tenant.widgetKey, session.sessionToken)).conversation?.id).toBe(turn.conversationId);
  });

  it("restores nothing with a token issued by another agent's widget, even in the same organization", async () => {
    // The owner adds a second agent; its widget channel (and key) is created server-side, as the admin UI does,
    // because API roles may never choose widget keys. The owner then publishes it.
    const nightAgent = await tenant.asOwner.run((sql) => insertAgent(sql, organizationId, { name: 'Night Desk' }));
    await h.t.service.run((sql) => ensureWebChatChannel(sql, organizationId, nightAgent.id));
    const night = await tenant.asOwner.run((sql) => setWebChatEnabled(sql, organizationId, nightAgent.id, true));
    const nightKey = night.publicKey!;
    const session = await h.openSession(tenant.widgetKey);
    const turn = await h.sendMessage(tenant.widgetKey, session.sessionToken, 'Hello');
    const before = await h.conversation(organizationId, turn.conversationId);

    const atNight = await h.openSession(nightKey, session.sessionToken);
    expect(atNight).toEqual({
      sessionToken: anyString,
      agent: { name: 'Night Desk', greeting: DEFAULT_AGENT_SETTINGS.greeting, language: DEFAULT_AGENT_SETTINGS.language },
      conversation: null,
    });
    expect(h.decodeSession(atNight.sessionToken)).toMatchObject({ agentId: night.agentId });
    expect(visitorOf(h, atNight.sessionToken)).not.toBe(visitorOf(h, session.sessionToken));
    const send = await h.post('/api/widget/messages', { widgetKey: nightKey, sessionToken: session.sessionToken, text: 'Hello' });
    expect(await h.readError(send)).toMatchObject({ status: 401, code: 'invalid_session' });
    const reset = await h.post('/api/widget/reset', { widgetKey: nightKey, sessionToken: session.sessionToken });
    expect(await h.readError(reset)).toMatchObject({ status: 401, code: 'invalid_session' });

    expect(await h.conversation(organizationId, turn.conversationId)).toEqual(before);
    expect(
      await h.t.db.query('select id from public.conversations where organization_id = $1 and agent_id = $2', [organizationId, night.agentId]),
    ).toEqual([]);
  });

  it('"New chat" closes the conversation for good: the next message starts a new one, and the owner keeps both', async () => {
    // A harness with its own clock: the token "New chat" issues differs from the one another tab still holds.
    const app = await createAppHarness({ database: h.t, logger: h.logger });
    try {
      const session = await app.openSession(tenant.widgetKey);
      const visitorId = visitorOf(app, session.sessionToken);
      const first = await app.sendMessage(tenant.widgetKey, session.sessionToken, QUESTIONS.emergency);

      app.clock.advance(60_000);
      const reset = await app.resetConversation(tenant.widgetKey, session.sessionToken);
      expect(reset).toEqual({ ok: true, sessionToken: anyString });
      expect(reset.sessionToken).not.toBe(session.sessionToken);
      expect(visitorOf(app, reset.sessionToken)).toBe(visitorId);
      expect(await app.conversation(organizationId, first.conversationId)).toMatchObject({
        status: 'closed',
        closedAt: expect.any(Date) as unknown,
        messageCount: 4,
      });
      // Reopening shows an empty chat; the next message starts a new conversation for the same visitor.
      expect((await app.openSession(tenant.widgetKey, reset.sessionToken)).conversation).toBeNull();
      const next = await app.sendMessage(tenant.widgetKey, reset.sessionToken, QUESTIONS.fee);
      expect(next.conversationId).not.toBe(first.conversationId);
      expect(await app.conversation(organizationId, next.conversationId)).toMatchObject({ status: 'active', visitorId, messageCount: 4 });
      // The older token (another tab) reaches the new conversation, never the closed one.
      expect((await app.openSession(tenant.widgetKey, session.sessionToken)).conversation?.id).toBe(next.conversationId);
      const viaOldToken = await app.sendMessage(tenant.widgetKey, session.sessionToken, 'One more thing');
      expect(viaOldToken.conversationId).toBe(next.conversationId);
      expect((await app.conversation(organizationId, first.conversationId))?.messageCount).toBe(4);

      // The owner still has the closed conversation, complete with its tool activity, next to the new one.
      const listed = await listConversations(tenant.asOwner, organizationId);
      expect(listed.filter((item) => item.id === first.conversationId || item.id === next.conversationId)).toEqual([
        like({ id: next.conversationId, status: 'active', messageCount: 6 }),
        like({ id: first.conversationId, status: 'closed', messageCount: 4 }),
      ]);
      const detail = await getConversationDetail(tenant.asOwner, organizationId, first.conversationId);
      expect(detail?.conversation).toMatchObject({ status: 'closed', visitorId });
      expect(detail?.messages.map((message) => message.role)).toEqual(['user', 'tool_call', 'tool_result', 'assistant']);
      expect(detail?.toolRuns.map(({ toolName, status }) => ({ toolName, status }))).toEqual([
        { toolName: 'searchKnowledge', status: 'succeeded' },
      ]);
    } finally {
      await app.close();
    }
  });

  it('restores a returning visitor while the sliding session is valid, and starts fresh once it has expired', async () => {
    // A harness with its own clock over the same database (the default 7-day session lifetime).
    const later = await createAppHarness({ database: h.t, logger: h.logger });
    try {
      expect(later.widget.sessionTtlSeconds).toBe(7 * 24 * 3600);
      const session = await later.openSession(tenant.widgetKey);
      const visitorId = visitorOf(later, session.sessionToken);
      const turn = await later.sendMessage(tenant.widgetKey, session.sessionToken, 'Hello');

      // Six days later: restored, and the visit renews the token.
      later.clock.advance(6 * DAY_MS);
      const back = await later.openSession(tenant.widgetKey, session.sessionToken);
      expect(back.conversation?.id).toBe(turn.conversationId);
      expect(back.sessionToken).not.toBe(session.sessionToken);
      expect(visitorOf(later, back.sessionToken)).toBe(visitorId);

      // Twelve days after the first visit: the renewed token still works, the original one has expired.
      later.clock.advance(6 * DAY_MS);
      expect((await later.openSession(tenant.widgetKey, back.sessionToken)).conversation?.id).toBe(turn.conversationId);
      expect(later.decodeSession(session.sessionToken)).toBeNull();
      const expired = await later.openSession(tenant.widgetKey, session.sessionToken);
      expect(expired.conversation).toBeNull();
      expect(visitorOf(later, expired.sessionToken)).not.toBe(visitorId);
      const send = await later.post('/api/widget/messages', {
        widgetKey: tenant.widgetKey,
        sessionToken: session.sessionToken,
        text: 'Hello',
      });
      expect(await later.readError(send)).toMatchObject({ status: 401, code: 'invalid_session' });
    } finally {
      await later.close();
    }
  });

  describe('a long conversation', () => {
    /** Statements, not questions: the stand-in model answers each with a greeting, so only the visitor's words carry facts. */
    const STORY = [
      'My boiler is making a banging noise',
      'It started yesterday evening',
      'The model is a Vaillant ecoTEC',
      'It keeps getting louder',
    ];
    const isSummaryRequest = (request: TextGenerationRequest): boolean =>
      request.input[0]?.type === 'message' && request.input[0].content.startsWith('Previous summary:');
    /** Everything a model request carried: the instructions (with any rolling summary) and the message texts. */
    const contentOf = (request: TextGenerationRequest | undefined): string => {
      if (!request) throw new Error('No such model request');
      return [request.instructions, ...request.input.map((item) => (item.type === 'message' ? item.content : ''))].join('\n');
    };
    /** A two-message recent window (AI_MAX_RECENT_MESSAGES) makes the summary start after the third exchange. */
    const shortWindow = () => createAppHarness({ database: h.t, logger: h.logger, ai: { AI_MAX_RECENT_MESSAGES: '2' } });

    it('folds older messages into a rolling summary after the turn, while the visitor keeps the full history', async () => {
      const short = await shortWindow();
      try {
        const session = await short.openSession(tenant.widgetKey);
        const turns: TurnResult[] = [];
        for (const text of STORY.slice(0, 3)) turns.push(await short.sendMessage(tenant.widgetKey, session.sessionToken, text));
        const conversationId = turns[0]!.conversationId;

        // The post-turn work (handed to after(), awaited by sendMessage) summarized: one request without tools,
        // metered like every model call, on the default model.
        const summaryRequests = short.requestsTo('receptionist').filter(isSummaryRequest);
        expect(summaryRequests).toHaveLength(1);
        expect(summaryRequests[0]?.tools).toEqual([]);
        const summaryUsage = (await short.usage(organizationId, conversationId)).filter((row) => row.purpose === 'conversation_summary');
        expect(summaryUsage).toEqual([
          like({ kind: 'text_generation', provider: 'receptionist', model: 'receptionist-mini', metadata: { tier: 'default' } }),
        ]);
        expect(summaryUsage[0]?.costUsd).toBeGreaterThan(0);
        // It folded the oldest messages, through summary_through_seq: every visitor message up to it, none after it.
        const conversation = await short.conversation(organizationId, conversationId);
        expect(conversation?.summary).not.toBe('');
        const summarized = contentOf(summaryRequests[0]);
        const visitorMessages = (await short.messages(organizationId, conversationId)).filter((message) => message.role === 'user');
        expect(visitorMessages.map((message) => summarized.includes(message.content))).toEqual(
          visitorMessages.map((message) => message.seq <= conversation!.summaryThroughSeq),
        );
        expect(summarized).toContain(STORY[1]);

        // The next turn sends the summary instead of the messages it folded: never the whole transcript.
        const requestsBefore = short.requestsTo('receptionist').length;
        const fourth = await short.sendMessage(tenant.widgetKey, session.sessionToken, STORY[3]!);
        const [request] = short.requestsTo('receptionist').slice(requestsBefore);
        expect(request?.instructions).toContain(conversation!.summary);
        expect(request?.input.at(-1)).toEqual({ type: 'message', role: 'user', content: STORY[3] });
        const resent = request?.input.flatMap((item) => (item.type === 'message' ? [item.content] : []));
        expect(resent).not.toContain(STORY[0]);
        expect(resent).not.toContain(STORY[1]);

        // The visitor's restored history is the full transcript: the summary is model context, not the record.
        const restored = await short.openSession(tenant.widgetKey, session.sessionToken);
        const replies = [...turns, fourth].map((turn) => turn.reply);
        expect(restored.conversation?.messages.map((message) => message.content)).toEqual(
          STORY.flatMap((message, index) => [message, replies[index]]),
        );
      } finally {
        await short.close();
      }
    });

    // Turns send every message after the summary cursor, and the summary folds what the next turn's window will not
    // hold: no message falls between the two. Here turn 4 gets the summary of visitor messages 1-3 (and replies 1-2)
    // plus [reply 3, message 4], so "The model is a Vaillant ecoTEC" is in the summary.
    it('gives the model every earlier visitor message, in the rolling summary or in the recent window', async () => {
      const short = await shortWindow();
      try {
        const session = await short.openSession(tenant.widgetKey);
        for (const text of STORY.slice(0, 3)) await short.sendMessage(tenant.widgetKey, session.sessionToken, text);
        const requestsBefore = short.requestsTo('receptionist').length;
        await short.sendMessage(tenant.widgetKey, session.sessionToken, STORY[3]!);

        const context = contentOf(short.requestsTo('receptionist')[requestsBefore]);
        expect(STORY.filter((text) => !context.includes(text))).toEqual([]);
      } finally {
        await short.close();
      }
    });
  });
});
