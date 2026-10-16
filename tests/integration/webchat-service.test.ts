import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatTurnInput, ChatTurnOutcome } from '@/server/agent/runtime/chat-turn';
import type { AgentEventSink } from '@/server/agent/runtime/events';
import {
  WebChatError,
  createWebChatService,
  type ClientInfo,
  type WebChatService,
  type WebChatServiceDeps,
} from '@/server/channels/webchat/service';
import { signWidgetSession, verifyWidgetSession, type WidgetSessionClaims } from '@/server/channels/webchat/session-token';
import type { WidgetConfig } from '@/server/config/env';
import type { Database, Row, Sql, SqlParam } from '@/server/db/types';
import { appendMessage, tryAcquireTurnLock } from '@/server/domain/conversations/service';
import type { LogFields, Logger } from '@/server/observability/logger';
import {
  createSseParser,
  resetResponseSchema,
  sessionResponseSchema,
  widgetEventSchema,
  type WidgetEvent,
} from '@/shared/widget-protocol';
import { createTestDatabase, type TestDatabase } from '../support/db';
import {
  createAgent,
  createConversation,
  createTenant,
  createWebChatChannel,
  type TenantFixture,
} from '../support/fixtures';

const SECRET = 'webchat-service-test-secret-0123456789abcdef';
const TTL_SECONDS = 3600;
// Mid-window, so every request of a test falls into the same rate-limit window.
const T0 = new Date('2026-10-08T12:00:30.000Z');
const REPLY = 'Thanks for asking! We can help with that.';
// `expect.any` returns `any`; typed as unknown for the strict lint rules.
const anyString: unknown = expect.any(String);

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.close();
});

// ── test doubles ─────────────────────────────────────────────────────────────

interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  event: string;
  fields: LogFields;
}

class RecordingLogger implements Logger {
  readonly entries: LogEntry[] = [];
  debug(event: string, fields: LogFields = {}): void {
    this.entries.push({ level: 'debug', event, fields });
  }
  info(event: string, fields: LogFields = {}): void {
    this.entries.push({ level: 'info', event, fields });
  }
  warn(event: string, fields: LogFields = {}): void {
    this.entries.push({ level: 'warn', event, fields });
  }
  error(event: string, fields: LogFields = {}): void {
    this.entries.push({ level: 'error', event, fields });
  }
  child(): Logger {
    return this;
  }
  events(event: string): LogEntry[] {
    return this.entries.filter((entry) => entry.event === event);
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type TurnScript = 'complete' | 'fail' | 'throw' | 'crash' | 'silent';

/**
 * Stands in for the channel-neutral runtime: persists messages like the real one (user,
 * a tool call + result, assistant) and emits AgentEvents, optionally pausing at `gate`.
 */
class FakeRuntime {
  readonly inputs: ChatTurnInput[] = [];
  script: TurnScript = 'complete';
  gate: Promise<void> | null = null;

  readonly runTurn = async (input: ChatTurnInput, emit: AgentEventSink): Promise<ChatTurnOutcome> => {
    this.inputs.push(input);
    if (this.script === 'crash') throw new Error('runtime crashed before starting');
    const { organizationId, conversationId } = input;
    const append = (message: Parameters<typeof appendMessage>[3]) =>
      t.service.run((sql) => appendMessage(sql, organizationId, conversationId, message));

    const turnId = randomUUID();
    emit({ type: 'turn.start', turnId, conversationId });
    const user = await append({ role: 'user', content: input.userText });
    if (this.gate) await this.gate;

    if (this.script === 'throw') throw new Error('runtime exploded');
    if (this.script === 'silent') {
      return { status: 'completed', turnId, userMessageId: user.id, assistantMessageId: null, errorCode: null };
    }
    if (this.script === 'fail') {
      emit({
        type: 'turn.error',
        turnId,
        code: 'provider_unavailable',
        message: "I'm having trouble responding right now. Please try again in a moment.",
        recoverable: true,
      });
      return { status: 'failed', turnId, userMessageId: user.id, assistantMessageId: null, errorCode: 'provider_unavailable' };
    }

    const callId = `call_${turnId.slice(0, 8)}`;
    emit({ type: 'tool.call', turnId, callId, toolName: 'searchKnowledge', label: 'Searching our information' });
    await append({ role: 'tool_call', toolName: 'searchKnowledge', toolCallId: callId, data: { arguments: {} } });
    await append({ role: 'tool_result', toolName: 'searchKnowledge', toolCallId: callId, data: { ok: false } });
    emit({ type: 'tool.result', turnId, callId, toolName: 'searchKnowledge', ok: false, errorCode: 'unavailable' });
    emit({ type: 'text.delta', turnId, delta: 'Thanks for asking! ' });
    emit({ type: 'text.delta', turnId, delta: 'We can help with that.' });
    const assistant = await append({ role: 'assistant', content: REPLY });
    emit({ type: 'turn.done', turnId, messageId: assistant.id, text: REPLY });
    return { status: 'completed', turnId, userMessageId: user.id, assistantMessageId: assistant.id, errorCode: null };
  };
}

type AfterTurnParams = Parameters<WebChatServiceDeps['afterTurn']>[0];

interface Harness {
  service: WebChatService;
  runtime: FakeRuntime;
  afterTurns: AfterTurnParams[];
  logger: RecordingLogger;
  clock: { now: Date };
}

function harness(
  options: {
    rateLimits?: Partial<WidgetConfig['rateLimits']>;
    afterTurn?: (params: AfterTurnParams) => Promise<void>;
    db?: Database;
  } = {},
): Harness {
  const runtime = new FakeRuntime();
  const afterTurns: AfterTurnParams[] = [];
  const logger = new RecordingLogger();
  const clock = { now: T0 };
  const service = createWebChatService({
    db: options.db ?? t.db,
    logger,
    widget: {
      sessionSecret: SECRET,
      sessionTtlSeconds: TTL_SECONDS,
      rateLimits: { ipPerMinute: 100, widgetPerMinute: 1000, organizationPerMinute: 1000, ...options.rateLimits },
    },
    runTurn: runtime.runTurn,
    afterTurn: async (params) => {
      afterTurns.push(params);
      await options.afterTurn?.(params);
    },
    now: () => clock.now,
  });
  return { service, runtime, afterTurns, logger, clock };
}

// ── helpers ──────────────────────────────────────────────────────────────────

const newTenant = (): Promise<TenantFixture> => t.service.run((sql) => createTenant(sql));

let clients = 0;
/** A distinct client IP per call (rate limits are per IP; every test shares one rate-limit window). */
const newClient = (): ClientInfo => {
  clients += 1;
  return { ip: `10.0.${Math.floor(clients / 256)}.${clients % 256}` };
};

let networks = 0;
/** A distinct IPv6 /64 per call, as its first four groups: append the interface part ("::1", ":0:0:0:2"). */
const newNetwork = (): string => {
  networks += 1;
  return `2001:db8:${networks.toString(16)}:0`;
};

/**
 * `t.db`, except that the turn-lock release statement first awaits `beforeRelease` (to slow it down
 * or make it fail) and calls `onReleased` once it has run.
 */
function probeLockRelease(beforeRelease: () => Promise<void>, onReleased: () => void = () => undefined): Database {
  return {
    query: t.db.query,
    close: t.db.close,
    transaction: (fn) =>
      t.db.transaction((tx) =>
        fn({
          query: async <T extends object = Row>(text: string, params?: readonly SqlParam[]): Promise<T[]> => {
            const releasing = text.includes('set turn_locked_until = null');
            if (releasing) await beforeRelease();
            const rows = await tx.query<T>(text, params);
            if (releasing) onReleased();
            return rows;
          },
        }),
      ),
  };
}

/**
 * `t.db`, except that `step` runs once, in the same transaction, right before the first statement matching
 * `before`: as if a concurrent request had committed just then (PGlite runs transactions one at a time).
 */
function interleaved(before: RegExp, step: (sql: Sql) => Promise<void>): Database {
  let pending = true;
  return {
    query: t.db.query,
    close: t.db.close,
    transaction: (fn) =>
      t.db.transaction((tx) =>
        fn({
          query: async <T extends object = Row>(text: string, params?: readonly SqlParam[]): Promise<T[]> => {
            if (pending && before.test(text)) {
              pending = false;
              await step(tx);
            }
            return tx.query<T>(text, params);
          },
        }),
      ),
  };
}

function claimsOf(token: string, now: Date = T0): WidgetSessionClaims {
  const claims = verifyWidgetSession(token, { secret: SECRET, now });
  if (!claims) throw new Error('expected a valid session token');
  return claims;
}

/**
 * Reads a whole SSE stream with the widget's own parser; every frame must be a valid WidgetEvent.
 * The parser drops unknown keys, so the raw frames are compared too: nothing else may reach the browser.
 */
async function readEvents(stream: ReadableStream<Uint8Array>): Promise<WidgetEvent[]> {
  const events: WidgetEvent[] = [];
  const invalid: string[] = [];
  const parser = createSseParser(
    (event) => events.push(event),
    (raw) => invalid.push(raw),
  );
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    raw += text;
    parser.push(text);
  }
  parser.push(decoder.decode());
  parser.flush();
  expect(invalid).toEqual([]);

  const frames = raw
    .split('\n\n')
    .filter((frame) => frame !== '')
    .map((frame) => {
      const [eventLine, dataLine, ...rest] = frame.split('\n');
      expect(rest).toEqual([]);
      const data: unknown = JSON.parse(dataLine?.replace(/^data: /, '') ?? '');
      expect(eventLine).toBe(`event: ${(data as { type?: unknown }).type as string}`);
      return data;
    });
  expect(frames).toEqual(events);
  return events;
}

async function send(h: Harness, tenant: TenantFixture, sessionToken: string, text: string, client: ClientInfo) {
  const { stream, done } = await h.service.openMessageStream({ widgetKey: tenant.widgetKey, sessionToken, text }, client);
  const events = await readEvents(stream);
  await done;
  return events;
}

async function conversationRows(organizationId: string) {
  return t.db.query<{ id: string; status: string; visitor_id: string; turn_locked_until: Date | null }>(
    'select id, status, visitor_id, turn_locked_until from public.conversations where organization_id = $1 order by created_at, id',
    [organizationId],
  );
}

async function messageRoles(conversationId: string): Promise<string[]> {
  const rows = await t.db.query<{ role: string }>(
    'select role from public.messages where conversation_id = $1 order by seq',
    [conversationId],
  );
  return rows.map((row) => row.role);
}

const typesOf = (events: readonly WidgetEvent[]) => events.map((event) => event.type);

// ── describeWidget ──────────────────────────────────────────────────────────

describe('describeWidget', () => {
  it("returns the published agent's public name and greeting", async () => {
    const tenant = await newTenant();
    expect(await harness().service.describeWidget(tenant.widgetKey)).toEqual({
      name: 'Front Desk',
      greeting: 'Hi! How can I help you today?',
      language: 'en',
    });
  });

  it('returns null for unknown, malformed, unpublished and paused widgets', async () => {
    const { service } = harness();
    const tenant = await newTenant();
    const unpublished = await t.service.run(async (sql) => {
      const agent = await createAgent(sql, tenant.org.id, { name: 'Sales' });
      return createWebChatChannel(sql, tenant.org.id, agent.id, { enabled: false });
    });
    const paused = await t.service.run(async (sql) => {
      const agent = await createAgent(sql, tenant.org.id, { name: 'Night desk', status: 'paused' });
      return createWebChatChannel(sql, tenant.org.id, agent.id, { enabled: true });
    });

    expect(await service.describeWidget(`wk_${'Q'.repeat(32)}`)).toBeNull();
    expect(await service.describeWidget('not-a-widget-key')).toBeNull();
    expect(await service.describeWidget(`${tenant.widgetKey}'; drop table agents; --`)).toBeNull();
    expect(await service.describeWidget(unpublished.publicKey)).toBeNull();
    expect(await service.describeWidget(paused.publicKey)).toBeNull();
  });
});

// ── startSession ────────────────────────────────────────────────────────────

describe('startSession', () => {
  it('issues a token for a new visitor without creating any conversation', async () => {
    const h = harness();
    const tenant = await newTenant();

    const session = sessionResponseSchema.parse(await h.service.startSession({ widgetKey: tenant.widgetKey }, newClient()));

    expect(session.agent).toEqual({ name: 'Front Desk', greeting: 'Hi! How can I help you today?', language: 'en' });
    expect(session.conversation).toBeNull();
    const claims = claimsOf(session.sessionToken);
    expect(claims).toMatchObject({ v: 1, agentId: tenant.agent.id, exp: claims.iat + TTL_SECONDS });
    expect(claims.visitorId).toMatch(/^[0-9a-f-]{36}$/);
    // Page views never create rows.
    expect(await conversationRows(tenant.org.id)).toEqual([]);
  });

  it('restores the visitor conversation (user/assistant messages only) and slides the expiry', async () => {
    const h = harness();
    const tenant = await newTenant();
    const client = newClient();
    const first = await h.service.startSession({ widgetKey: tenant.widgetKey }, client);
    const events = await send(h, tenant, first.sessionToken, 'Do you fix boilers?', client);
    const conversationId = (events[0] as Extract<WidgetEvent, { type: 'turn.start' }>).conversationId;

    h.clock.now = new Date(T0.getTime() + 600_000);
    const again = sessionResponseSchema.parse(
      await h.service.startSession({ widgetKey: tenant.widgetKey, sessionToken: first.sessionToken }, client),
    );

    expect(again.conversation?.id).toBe(conversationId);
    expect(again.conversation?.messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: 'user', content: 'Do you fix boilers?' },
      { role: 'assistant', content: REPLY },
    ]);
    for (const message of again.conversation?.messages ?? []) {
      expect(new Date(message.createdAt).toISOString()).toBe(message.createdAt);
    }
    const before = claimsOf(first.sessionToken);
    const after = claimsOf(again.sessionToken, h.clock.now);
    expect(after.visitorId).toBe(before.visitorId);
    expect(after.exp).toBe(before.exp + 600);
  });

  it('restores at most the latest 50 messages, in order', async () => {
    const h = harness();
    const tenant = await newTenant();
    const first = await h.service.startSession({ widgetKey: tenant.widgetKey }, newClient());
    const { visitorId } = claimsOf(first.sessionToken);
    const conversation = await t.service.run((sql) => createConversation(sql, tenant.org.id, tenant.agent.id, { visitorId }));
    for (let i = 1; i <= 60; i += 1) {
      await t.service.run((sql) =>
        appendMessage(sql, tenant.org.id, conversation.id, { role: i % 2 ? 'user' : 'assistant', content: `message ${i}` }),
      );
    }

    const session = await h.service.startSession({ widgetKey: tenant.widgetKey, sessionToken: first.sessionToken }, newClient());
    const contents = session.conversation?.messages.map((message) => message.content);
    expect(contents).toHaveLength(50);
    expect(contents?.[0]).toBe('message 11');
    expect(contents?.at(-1)).toBe('message 60');
  });

  it('gives a new visitor to tokens that are invalid, expired or bound to another agent', async () => {
    const h = harness();
    const tenant = await newTenant();
    const otherAgent = await t.service.run(async (sql) => {
      const agent = await createAgent(sql, tenant.org.id, { name: 'Sales' });
      const channel = await createWebChatChannel(sql, tenant.org.id, agent.id);
      return { ...agent, widgetKey: channel.publicKey };
    });
    const client = newClient();
    const original = await h.service.startSession({ widgetKey: tenant.widgetKey }, client);
    await send(h, tenant, original.sessionToken, 'Hello', client);
    const { visitorId } = claimsOf(original.sessionToken);

    const otherAgentSession = await h.service.startSession(
      { widgetKey: otherAgent.widgetKey, sessionToken: original.sessionToken },
      client,
    );
    expect(otherAgentSession.conversation).toBeNull();
    expect(claimsOf(otherAgentSession.sessionToken)).toMatchObject({ agentId: otherAgent.id });
    expect(claimsOf(otherAgentSession.sessionToken).visitorId).not.toBe(visitorId);

    const garbage = await h.service.startSession({ widgetKey: tenant.widgetKey, sessionToken: 'garbage.token' }, client);
    expect(garbage.conversation).toBeNull();
    expect(claimsOf(garbage.sessionToken).visitorId).not.toBe(visitorId);

    h.clock.now = new Date(T0.getTime() + TTL_SECONDS * 1000);
    const expired = await h.service.startSession({ widgetKey: tenant.widgetKey, sessionToken: original.sessionToken }, client);
    expect(expired.conversation).toBeNull();
    expect(claimsOf(expired.sessionToken, h.clock.now).visitorId).not.toBe(visitorId);
  });

  it('rejects unknown widgets with 404 and invalid requests with 400', async () => {
    const { service } = harness();
    const unknown = service.startSession({ widgetKey: `wk_${'Z'.repeat(32)}` }, newClient());
    await expect(unknown).rejects.toBeInstanceOf(WebChatError);
    await expect(unknown).rejects.toMatchObject({ code: 'widget_unavailable', status: 404 });
    await expect(service.startSession({ widgetKey: 'nope' }, newClient())).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
    });
  });
});

// ── openMessageStream ───────────────────────────────────────────────────────

describe('openMessageStream', () => {
  it('streams the turn as widget events and hands the runtime a server-resolved input', async () => {
    const h = harness();
    const tenant = await newTenant();
    const client = newClient();
    const session = await h.service.startSession({ widgetKey: tenant.widgetKey }, client);

    const events = await send(h, tenant, session.sessionToken, '  Do you fix boilers?  ', client);

    expect(typesOf(events)).toEqual(['turn.start', 'tool.call', 'tool.result', 'text.delta', 'text.delta', 'turn.done']);
    const [start, call, result] = events as [
      Extract<WidgetEvent, { type: 'turn.start' }>,
      WidgetEvent,
      WidgetEvent,
    ];
    const { turnId, conversationId } = start;
    expect(call).toEqual({ type: 'tool.call', turnId, callId: anyString, name: 'searchKnowledge', label: 'Searching our information' });
    // The runtime's internal error code never reaches the browser.
    expect(result).toEqual({ type: 'tool.result', turnId, callId: anyString, name: 'searchKnowledge', ok: false });
    expect(events.at(-1)).toEqual({ type: 'turn.done', turnId, messageId: anyString, text: REPLY });
    for (const event of events) expect(widgetEventSchema.parse(event)).toEqual(event);

    const [input] = h.runtime.inputs;
    const { visitorId } = claimsOf(session.sessionToken);
    expect(input).toEqual({
      organizationId: tenant.org.id,
      agent: expect.objectContaining({ id: tenant.agent.id, organizationId: tenant.org.id }) as unknown,
      conversationId,
      channel: 'web_chat',
      userText: 'Do you fix boilers?',
      endUserId: createHash('sha256').update(visitorId).digest('hex').slice(0, 32),
    });
    expect(input?.endUserId).not.toContain(visitorId);

    const [row] = await conversationRows(tenant.org.id);
    expect(row).toMatchObject({ id: conversationId, status: 'active', visitor_id: visitorId, turn_locked_until: null });
    expect(await messageRoles(conversationId)).toEqual(['user', 'tool_call', 'tool_result', 'assistant']);
    expect(h.afterTurns).toEqual([
      {
        organizationId: tenant.org.id,
        agentId: tenant.agent.id,
        conversationId,
        channel: 'web_chat',
        signal: expect.any(AbortSignal) as unknown,
      },
    ]);
    expect(h.afterTurns[0]?.signal.aborted).toBe(false);
  });

  it('reuses the visitor conversation across messages and keeps visitors apart', async () => {
    const h = harness();
    const tenant = await newTenant();
    const client = newClient();
    const visitor = await h.service.startSession({ widgetKey: tenant.widgetKey }, client);
    const other = await h.service.startSession({ widgetKey: tenant.widgetKey }, newClient());

    const first = await send(h, tenant, visitor.sessionToken, 'First question', client);
    const second = await send(h, tenant, visitor.sessionToken, 'Second question', client);
    const third = await send(h, tenant, other.sessionToken, 'Another visitor', newClient());

    const conversationOf = (events: WidgetEvent[]) => (events[0] as Extract<WidgetEvent, { type: 'turn.start' }>).conversationId;
    expect(conversationOf(second)).toBe(conversationOf(first));
    expect(conversationOf(third)).not.toBe(conversationOf(first));
    expect(await conversationRows(tenant.org.id)).toHaveLength(2);
    expect(await messageRoles(conversationOf(first))).toEqual([
      'user', 'tool_call', 'tool_result', 'assistant',
      'user', 'tool_call', 'tool_result', 'assistant',
    ]);
  });

  it('releases the lock and ends the stream with turn.error when the runtime throws', async () => {
    const h = harness();
    const tenant = await newTenant();
    const client = newClient();
    const session = await h.service.startSession({ widgetKey: tenant.widgetKey }, client);

    h.runtime.script = 'throw';
    const events = await send(h, tenant, session.sessionToken, 'Hello?', client);

    const turnId = (events[0] as Extract<WidgetEvent, { type: 'turn.start' }>).turnId;
    expect(events).toEqual([
      expect.objectContaining({ type: 'turn.start', turnId }),
      { type: 'turn.error', turnId, code: 'internal', message: 'Something went wrong. Please try again.', recoverable: true },
    ]);
    expect((await conversationRows(tenant.org.id))[0]?.turn_locked_until).toBeNull();
    expect(h.afterTurns).toEqual([]);
    expect(h.logger.events('webchat.turn_crashed')).toHaveLength(1);

    // The conversation is usable again right away.
    h.runtime.script = 'complete';
    expect(typesOf(await send(h, tenant, session.sessionToken, 'Hello again', client)).at(-1)).toBe('turn.done');
  });

  it('reports a crash before the turn started with a null turn id', async () => {
    const h = harness();
    const tenant = await newTenant();
    const client = newClient();
    const session = await h.service.startSession({ widgetKey: tenant.widgetKey }, client);

    h.runtime.script = 'crash';
    expect(await send(h, tenant, session.sessionToken, 'Hello?', client)).toEqual([
      { type: 'turn.error', turnId: null, code: 'internal', message: 'Something went wrong. Please try again.', recoverable: true },
    ]);
    expect((await conversationRows(tenant.org.id))[0]?.turn_locked_until).toBeNull();
  });

  it("passes the runtime's own failure through and skips post-turn work", async () => {
    const h = harness();
    const tenant = await newTenant();
    const client = newClient();
    const session = await h.service.startSession({ widgetKey: tenant.widgetKey }, client);

    h.runtime.script = 'fail';
    const events = await send(h, tenant, session.sessionToken, 'Hello?', client);

    expect(typesOf(events)).toEqual(['turn.start', 'turn.error']);
    expect(events[1]).toMatchObject({ code: 'provider_unavailable', recoverable: true });
    expect(h.afterTurns).toEqual([]);
    expect((await conversationRows(tenant.org.id))[0]?.turn_locked_until).toBeNull();
  });

  it('always ends the stream, even when the runtime returns without a final event', async () => {
    const h = harness();
    const tenant = await newTenant();
    const client = newClient();
    const session = await h.service.startSession({ widgetKey: tenant.widgetKey }, client);

    h.runtime.script = 'silent';
    const events = await send(h, tenant, session.sessionToken, 'Hello?', client);

    expect(typesOf(events)).toEqual(['turn.start', 'turn.error']);
    expect(events[1]).toMatchObject({ turnId: (events[0] as { turnId: string }).turnId, code: 'internal' });
  });

  it('rejects a second message while a turn is running (409) and accepts it afterwards', async () => {
    const h = harness();
    const tenant = await newTenant();
    const client = newClient();
    const session = await h.service.startSession({ widgetKey: tenant.widgetKey }, client);
    const gate = deferred();
    h.runtime.gate = gate.promise;

    const first = await h.service.openMessageStream({ widgetKey: tenant.widgetKey, sessionToken: session.sessionToken, text: 'One' }, client);
    const firstEvents = readEvents(first.stream);
    const busy = h.service.openMessageStream({ widgetKey: tenant.widgetKey, sessionToken: session.sessionToken, text: 'Two' }, client);
    await expect(busy).rejects.toMatchObject({ code: 'conversation_busy', status: 409 });

    gate.resolve();
    expect(typesOf(await firstEvents).at(-1)).toBe('turn.done');
    await first.done;
    h.runtime.gate = null;
    expect(typesOf(await send(h, tenant, session.sessionToken, 'Two', client)).at(-1)).toBe('turn.done');
    expect(h.runtime.inputs.map((input) => input.userText)).toEqual(['One', 'Two']);
  });

  it('keeps running and persisting the turn after the visitor disconnects', async () => {
    const h = harness();
    const tenant = await newTenant();
    const client = newClient();
    const session = await h.service.startSession({ widgetKey: tenant.widgetKey }, client);
    const gate = deferred();
    h.runtime.gate = gate.promise;

    const { stream, done } = await h.service.openMessageStream(
      { widgetKey: tenant.widgetKey, sessionToken: session.sessionToken, text: 'Are you open on Sunday?' },
      client,
    );
    const reader = stream.getReader();
    expect((await reader.read()).done).toBe(false); // turn.start
    await reader.cancel();
    gate.resolve();
    await done;

    const [conversation] = await conversationRows(tenant.org.id);
    expect(await messageRoles(conversation!.id)).toEqual(['user', 'tool_call', 'tool_result', 'assistant']);
    expect(conversation?.turn_locked_until).toBeNull();
    expect(h.afterTurns).toHaveLength(1);
  });

  it('skips post-turn work when the request budget is nearly spent', async () => {
    const h = harness();
    const tenant = await newTenant();
    const client = newClient();
    const session = await h.service.startSession({ widgetKey: tenant.widgetKey }, client);

    // The turn ends 54 s after the request started: less than the 2 s minimum is left of the 55 s budget.
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(1_000).mockReturnValue(55_000);
    const { stream, done } = await h.service.openMessageStream(
      { widgetKey: tenant.widgetKey, sessionToken: session.sessionToken, text: 'Hi' },
      client,
    );
    expect(typesOf(await readEvents(stream)).at(-1)).toBe('turn.done');
    await done;
    clock.mockRestore();

    expect(h.afterTurns).toEqual([]);
    expect(h.logger.events('webchat.after_turn_skipped')).toHaveLength(1);
    expect((await conversationRows(tenant.org.id))[0]?.turn_locked_until).toBeNull();
  });

  it('releases the lock before the stream ends and resolves `done` only after the post-turn work', async () => {
    const afterGate = deferred();
    const h = harness({ afterTurn: () => afterGate.promise });
    const tenant = await newTenant();
    const client = newClient();
    const session = await h.service.startSession({ widgetKey: tenant.widgetKey }, client);

    const { stream, done } = await h.service.openMessageStream(
      { widgetKey: tenant.widgetKey, sessionToken: session.sessionToken, text: 'Hi' },
      client,
    );
    let settled = false;
    void done.then(() => {
      settled = true;
    });

    expect(typesOf(await readEvents(stream)).at(-1)).toBe('turn.done');
    expect((await conversationRows(tenant.org.id))[0]?.turn_locked_until).toBeNull();
    await vi.waitFor(() => {
      expect(h.afterTurns).toHaveLength(1);
    });
    expect(settled).toBe(false);

    afterGate.resolve();
    await done;
    expect(settled).toBe(true);
  });

  it('sends the final event only once the lock is released, so the next message is accepted at once', async () => {
    const timeline: string[] = [];
    const slowRelease = probeLockRelease(
      () => new Promise((resolve) => setTimeout(resolve, 50)),
      () => timeline.push('lock released'),
    );
    const h = harness({ db: slowRelease });
    const tenant = await newTenant();
    const client = newClient();
    const session = await h.service.startSession({ widgetKey: tenant.widgetKey }, client);

    // Like the widget: read until turn.done, stop reading, and send the next message right away.
    const first = await h.service.openMessageStream(
      { widgetKey: tenant.widgetKey, sessionToken: session.sessionToken, text: 'One' },
      client,
    );
    const events: WidgetEvent[] = [];
    const parser = createSseParser((event) => {
      events.push(event);
      timeline.push(event.type);
    });
    const reader = first.stream.getReader();
    const decoder = new TextDecoder();
    while (events.at(-1)?.type !== 'turn.done') {
      const chunk = await reader.read();
      if (chunk.done) break;
      parser.push(decoder.decode(chunk.value, { stream: true }));
    }
    await reader.cancel();
    expect(timeline.slice(-2)).toEqual(['lock released', 'turn.done']);

    expect(typesOf(await send(h, tenant, session.sessionToken, 'Two', client)).at(-1)).toBe('turn.done');
    await first.done;
    expect(h.runtime.inputs.map((input) => input.userText)).toEqual(['One', 'Two']);
  });

  it('still ends the reply when the lock cannot be released (it then expires on its own)', async () => {
    const h = harness({ db: probeLockRelease(() => Promise.reject(new Error('connection lost'))) });
    const tenant = await newTenant();
    const client = newClient();
    const session = await h.service.startSession({ widgetKey: tenant.widgetKey }, client);

    const events = await send(h, tenant, session.sessionToken, 'Hello', client);

    expect(typesOf(events).at(-1)).toBe('turn.done');
    expect(h.logger.events('webchat.turn_lock_release_failed')).toHaveLength(1);
    expect(h.afterTurns).toHaveLength(1);
    expect((await conversationRows(tenant.org.id))[0]?.turn_locked_until).toBeInstanceOf(Date);
    await expect(
      h.service.openMessageStream({ widgetKey: tenant.widgetKey, sessionToken: session.sessionToken, text: 'Again' }, client),
    ).rejects.toMatchObject({ code: 'conversation_busy', status: 409 });
  });

  it('logs a failed post-turn step without failing the turn', async () => {
    const h = harness({ afterTurn: () => Promise.reject(new Error('summary failed')) });
    const tenant = await newTenant();
    const client = newClient();
    const session = await h.service.startSession({ widgetKey: tenant.widgetKey }, client);

    // `send` awaits `done`, which never rejects.
    expect(typesOf(await send(h, tenant, session.sessionToken, 'Hello', client)).at(-1)).toBe('turn.done');
    expect(h.afterTurns).toHaveLength(1);
    expect(h.logger.events('webchat.after_turn_failed')).toHaveLength(1);
    expect((await conversationRows(tenant.org.id))[0]?.turn_locked_until).toBeNull();
  });

  it('rejects malformed, forged, expired and other-agent tokens with 401', async () => {
    const h = harness();
    const tenant = await newTenant();
    const client = newClient();
    const session = await h.service.startSession({ widgetKey: tenant.widgetKey }, client);
    const { visitorId } = claimsOf(session.sessionToken);
    const open = (sessionToken: string) =>
      h.service.openMessageStream({ widgetKey: tenant.widgetKey, sessionToken, text: 'Hello' }, client);
    const forged = signWidgetSession(
      { agentId: tenant.agent.id, visitorId },
      { secret: 'an-attacker-guessed-secret-0123456789abcdef', ttlSeconds: TTL_SECONDS, now: T0 },
    );
    const otherAgent = signWidgetSession(
      { agentId: randomUUID(), visitorId },
      { secret: SECRET, ttlSeconds: TTL_SECONDS, now: T0 },
    );

    for (const token of ['garbage', forged, otherAgent]) {
      await expect(open(token)).rejects.toMatchObject({ code: 'invalid_session', status: 401 });
    }
    h.clock.now = new Date(T0.getTime() + TTL_SECONDS * 1000 + 1000);
    await expect(open(session.sessionToken)).rejects.toMatchObject({ code: 'invalid_session', status: 401 });

    // Nothing was created or run for rejected requests.
    expect(await conversationRows(tenant.org.id)).toEqual([]);
    expect(h.runtime.inputs).toEqual([]);
  });

  it('rejects unknown widgets (404) and invalid messages (400)', async () => {
    const h = harness();
    const tenant = await newTenant();
    const client = newClient();
    const session = await h.service.startSession({ widgetKey: tenant.widgetKey }, client);

    await expect(
      h.service.openMessageStream({ widgetKey: `wk_${'Y'.repeat(32)}`, sessionToken: session.sessionToken, text: 'Hi' }, client),
    ).rejects.toMatchObject({ code: 'widget_unavailable', status: 404 });
    await expect(
      h.service.openMessageStream({ widgetKey: tenant.widgetKey, sessionToken: session.sessionToken, text: '   ' }, client),
    ).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    await expect(
      h.service.openMessageStream({ widgetKey: tenant.widgetKey, sessionToken: session.sessionToken, text: 'x'.repeat(2001) }, client),
    ).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    expect(h.runtime.inputs).toEqual([]);
  });
});

// ── rate limits ─────────────────────────────────────────────────────────────

describe('rate limits', () => {
  it('limits messages per IP (429 with a retry delay) and logs only a hash of the IP', async () => {
    const h = harness({ rateLimits: { ipPerMinute: 2 } });
    const tenant = await newTenant();
    const client = newClient();
    const session = await h.service.startSession({ widgetKey: tenant.widgetKey }, client);

    await send(h, tenant, session.sessionToken, 'one', client);
    await send(h, tenant, session.sessionToken, 'two', client);
    const limited = h.service.openMessageStream(
      { widgetKey: tenant.widgetKey, sessionToken: session.sessionToken, text: 'three' },
      client,
    );
    // T0 is 12:00:30, so the window resets in 30 s.
    await expect(limited).rejects.toMatchObject({ code: 'rate_limited', status: 429, retryAfterSeconds: 30 });

    // Another IP (same visitor token) is not affected.
    expect(typesOf(await send(h, tenant, session.sessionToken, 'three', newClient())).at(-1)).toBe('turn.done');

    const [entry] = h.logger.events('webchat.rate_limited');
    expect(entry?.fields).toMatchObject({ scope: 'ip', ipHash: expect.stringMatching(/^[0-9a-f]{32}$/) as unknown });
    const logged = JSON.stringify(h.logger.entries);
    expect(logged).not.toContain(client.ip!);
    expect(logged).not.toContain('three');
  });

  it('limits messages per widget across IPs', async () => {
    const h = harness({ rateLimits: { widgetPerMinute: 2 } });
    const tenant = await newTenant();
    const session = await h.service.startSession({ widgetKey: tenant.widgetKey }, newClient());

    await send(h, tenant, session.sessionToken, 'one', newClient());
    await send(h, tenant, session.sessionToken, 'two', newClient());
    await expect(
      h.service.openMessageStream({ widgetKey: tenant.widgetKey, sessionToken: session.sessionToken, text: 'three' }, newClient()),
    ).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
    expect(h.logger.events('webchat.rate_limited')[0]?.fields).toMatchObject({ scope: 'widget', organizationId: tenant.org.id });
  });

  it('limits messages per organization across its widgets, without affecting other organizations', async () => {
    const h = harness({ rateLimits: { organizationPerMinute: 2 } });
    const tenant = await newTenant();
    const second = await t.service.run(async (sql) => {
      const agent = await createAgent(sql, tenant.org.id, { name: 'Sales' });
      const channel = await createWebChatChannel(sql, tenant.org.id, agent.id);
      return { ...tenant, agent, widgetKey: channel.publicKey };
    });
    const other = await newTenant();
    const sessionA = await h.service.startSession({ widgetKey: tenant.widgetKey }, newClient());
    const sessionB = await h.service.startSession({ widgetKey: second.widgetKey }, newClient());
    const sessionOther = await h.service.startSession({ widgetKey: other.widgetKey }, newClient());

    await send(h, tenant, sessionA.sessionToken, 'one', newClient());
    await send(h, second, sessionB.sessionToken, 'two', newClient());
    await expect(
      h.service.openMessageStream({ widgetKey: second.widgetKey, sessionToken: sessionB.sessionToken, text: 'three' }, newClient()),
    ).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
    expect(typesOf(await send(h, other, sessionOther.sessionToken, 'hello', newClient())).at(-1)).toBe('turn.done');
  });

  it('limits session starts and resets per IP at three times the message limit', async () => {
    const h = harness({ rateLimits: { ipPerMinute: 1 } });
    const tenant = await newTenant();
    const client = newClient();

    const session = await h.service.startSession({ widgetKey: tenant.widgetKey }, client);
    await h.service.startSession({ widgetKey: tenant.widgetKey, sessionToken: session.sessionToken }, client);
    await h.service.resetConversation({ widgetKey: tenant.widgetKey, sessionToken: session.sessionToken }, client);
    await expect(h.service.startSession({ widgetKey: tenant.widgetKey }, client)).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
    });
    await expect(h.service.startSession({ widgetKey: tenant.widgetKey }, newClient())).resolves.toBeDefined();
  });

  it('counts an IPv6 client by its /64 network, for messages and for session starts and resets', async () => {
    const h = harness({ rateLimits: { ipPerMinute: 1 } });
    const tenant = await newTenant();
    const session = await h.service.startSession({ widgetKey: tenant.widgetKey }, newClient());
    const message = (text: string, ip: string) =>
      h.service.openMessageStream({ widgetKey: tenant.widgetKey, sessionToken: session.sessionToken, text }, { ip });

    // One host owns its whole /64: a new source address per request is still the same client.
    const network = newNetwork();
    expect(typesOf(await send(h, tenant, session.sessionToken, 'one', { ip: `${network}::1` })).at(-1)).toBe('turn.done');
    await expect(message('two', `${network}:dead:beef:0:42`)).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
    await expect(message('two', `[${network}:ffff:ffff:ffff:ffff]:443`)).rejects.toMatchObject({ code: 'rate_limited' });
    // Another /64 is another client.
    expect(typesOf(await send(h, tenant, session.sessionToken, 'two', { ip: `${newNetwork()}::1` })).at(-1)).toBe('turn.done');

    const sessions = newNetwork();
    await h.service.startSession({ widgetKey: tenant.widgetKey }, { ip: `${sessions}::1` });
    await h.service.startSession({ widgetKey: tenant.widgetKey }, { ip: `${sessions}::2` });
    await h.service.resetConversation({ widgetKey: tenant.widgetKey, sessionToken: session.sessionToken }, { ip: `${sessions}::3` });
    await expect(h.service.startSession({ widgetKey: tenant.widgetKey }, { ip: `${sessions}:1:2:3:4` })).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
    });
    expect(h.logger.events('webchat.rate_limited').map((entry) => entry.fields.scope)).toEqual(['ip', 'ip', 'session']);
  });

  it('fails closed for requests without a usable client IP: they all share one bucket', async () => {
    const h = harness({ rateLimits: { ipPerMinute: 1 } });
    // A minute of its own: the 'unknown' bucket would otherwise be shared with other tests of this file.
    h.clock.now = new Date(T0.getTime() + 10 * 60_000);
    const tenant = await newTenant();
    const visitor = await h.service.startSession({ widgetKey: tenant.widgetKey }, newClient());
    const other = await h.service.startSession({ widgetKey: tenant.widgetKey }, newClient());
    const message = (sessionToken: string, ip: string | null) =>
      h.service.openMessageStream({ widgetKey: tenant.widgetKey, sessionToken, text: 'Hello' }, { ip });

    // Messages: one per minute for every such request together, whichever visitor sends it.
    expect(typesOf(await send(h, tenant, visitor.sessionToken, 'Hello', { ip: null })).at(-1)).toBe('turn.done');
    await expect(message(other.sessionToken, null)).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
    // An unusable address (e.g. a garbled header passed on as is) counts as unknown too.
    await expect(message(other.sessionToken, 'not-an-ip')).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
    // Clients with an address are not affected.
    expect(typesOf(await send(h, tenant, other.sessionToken, 'Hello', newClient())).at(-1)).toBe('turn.done');

    // Session starts and resets: 3 × ipPerMinute for all of them together.
    await h.service.startSession({ widgetKey: tenant.widgetKey }, { ip: null });
    await h.service.startSession({ widgetKey: tenant.widgetKey, sessionToken: visitor.sessionToken }, { ip: 'garbage' });
    await h.service.resetConversation({ widgetKey: tenant.widgetKey, sessionToken: other.sessionToken }, { ip: null });
    await expect(h.service.startSession({ widgetKey: tenant.widgetKey }, { ip: null })).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
    });
    await expect(
      h.service.resetConversation({ widgetKey: tenant.widgetKey, sessionToken: visitor.sessionToken }, { ip: null }),
    ).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
    await expect(h.service.startSession({ widgetKey: tenant.widgetKey }, newClient())).resolves.toBeDefined();

    expect(h.logger.events('webchat.rate_limited').map((entry) => [entry.fields.scope, entry.fields.ipHash])).toEqual([
      ['ip', 'unknown'],
      ['ip', 'unknown'],
      ['session', 'unknown'],
      ['session', 'unknown'],
    ]);
  });

  it("never charges the widget's and organization's budgets for messages to a busy conversation", async () => {
    const h = harness({ rateLimits: { widgetPerMinute: 2, organizationPerMinute: 2 } });
    const tenant = await newTenant();
    const session = await h.service.startSession({ widgetKey: tenant.widgetKey }, newClient());
    const message = (text: string) =>
      h.service.openMessageStream({ widgetKey: tenant.widgetKey, sessionToken: session.sessionToken, text }, newClient());
    const gate = deferred();
    h.runtime.gate = gate.promise;

    const first = await message('One');
    const firstEvents = readEvents(first.stream);
    // While that turn runs, a burst for the same conversation is refused as busy: the budgets all the tenant's
    // visitors share stay untouched.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(message('Busy')).rejects.toMatchObject({ code: 'conversation_busy', status: 409 });
    }
    gate.resolve();
    expect(typesOf(await firstEvents).at(-1)).toBe('turn.done');
    await first.done;
    h.runtime.gate = null;

    expect(typesOf(await send(h, tenant, session.sessionToken, 'Two', newClient())).at(-1)).toBe('turn.done');
    await expect(message('Three')).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
    expect(h.logger.events('webchat.rate_limited').map((entry) => entry.fields.scope)).toEqual(['widget']);
    expect(h.runtime.inputs.map((input) => input.userText)).toEqual(['One', 'Two']);
  });

  it('leaves the conversation free when a shared budget rejects the message', async () => {
    const h = harness({ rateLimits: { organizationPerMinute: 1 } });
    const tenant = await newTenant();
    const session = await h.service.startSession({ widgetKey: tenant.widgetKey }, newClient());
    await send(h, tenant, session.sessionToken, 'One', newClient());

    await expect(
      h.service.openMessageStream({ widgetKey: tenant.widgetKey, sessionToken: session.sessionToken, text: 'Two' }, newClient()),
    ).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
    expect((await conversationRows(tenant.org.id))[0]?.turn_locked_until).toBeNull();

    // In the next window the message goes through at once (a lock left behind would answer 409 for minutes).
    h.clock.now = new Date(T0.getTime() + 60_000);
    expect(typesOf(await send(h, tenant, session.sessionToken, 'Two', newClient())).at(-1)).toBe('turn.done');
    expect(h.runtime.inputs.map((input) => input.userText)).toEqual(['One', 'Two']);
  });

  it.each([
    ['widget', { widgetPerMinute: 1 }],
    ['organization', { organizationPerMinute: 1 }],
  ] as const)('creates no conversation for a new visitor whose message the %s budget rejects', async (scope, rateLimits) => {
    const h = harness({ rateLimits });
    const tenant = await newTenant();
    const first = await h.service.startSession({ widgetKey: tenant.widgetKey }, newClient());
    expect(typesOf(await send(h, tenant, first.sessionToken, 'One', newClient())).at(-1)).toBe('turn.done');

    // The budget is spent: further visitors (each from its own address) are refused and leave nothing behind.
    // Otherwise every refused first message would add an empty conversation, with no budget capping them.
    for (let visitor = 0; visitor < 3; visitor += 1) {
      const session = await h.service.startSession({ widgetKey: tenant.widgetKey }, newClient());
      await expect(
        h.service.openMessageStream({ widgetKey: tenant.widgetKey, sessionToken: session.sessionToken, text: 'Hi' }, newClient()),
      ).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
    }
    const rows = await conversationRows(tenant.org.id);
    expect(rows.map((row) => row.visitor_id)).toEqual([claimsOf(first.sessionToken).visitorId]);
    expect(h.logger.events('webchat.rate_limited').map((entry) => entry.fields.scope)).toEqual([scope, scope, scope]);
    expect(h.runtime.inputs.map((input) => input.userText)).toEqual(['One']);
  });

  it("refuses a visitor's first message as busy when another one (e.g. from a second tab) opened the conversation first", async () => {
    const tenant = await newTenant();
    const competing = { id: '' };
    let visitorId = '';
    // Between this request's lookup (no conversation yet) and its insert, the other tab's first message
    // creates the conversation and claims its turn.
    const h = harness({
      db: interleaved(/insert into public\.conversations/, async (sql) => {
        competing.id = (await createConversation(sql, tenant.org.id, tenant.agent.id, { visitorId })).id;
        expect(await tryAcquireTurnLock(sql, tenant.org.id, competing.id, 60)).toBe(true);
      }),
    });
    const session = await h.service.startSession({ widgetKey: tenant.widgetKey }, newClient());
    visitorId = claimsOf(session.sessionToken).visitorId;

    await expect(
      h.service.openMessageStream({ widgetKey: tenant.widgetKey, sessionToken: session.sessionToken, text: 'Hi' }, newClient()),
    ).rejects.toMatchObject({ code: 'conversation_busy', status: 409 });
    expect(competing.id).not.toBe('');
    expect((await conversationRows(tenant.org.id)).map((row) => row.id)).toEqual([competing.id]);
    expect(h.logger.events('webchat.conversation_busy').map((entry) => entry.fields.conversationId)).toEqual([competing.id]);
    expect(h.runtime.inputs).toEqual([]);
  });
});

// ── resetConversation ───────────────────────────────────────────────────────

describe('resetConversation', () => {
  it('closes the active conversation; the next message starts a new one', async () => {
    const h = harness();
    const tenant = await newTenant();
    const client = newClient();
    const session = await h.service.startSession({ widgetKey: tenant.widgetKey }, client);
    const before = await send(h, tenant, session.sessionToken, 'Hello', client);
    const oldConversationId = (before[0] as Extract<WidgetEvent, { type: 'turn.start' }>).conversationId;

    const reset = resetResponseSchema.parse(
      await h.service.resetConversation({ widgetKey: tenant.widgetKey, sessionToken: session.sessionToken }, client),
    );
    expect(claimsOf(reset.sessionToken).visitorId).toBe(claimsOf(session.sessionToken).visitorId);
    expect((await conversationRows(tenant.org.id)).map((row) => row.status)).toEqual(['closed']);

    const restored = await h.service.startSession({ widgetKey: tenant.widgetKey, sessionToken: reset.sessionToken }, client);
    expect(restored.conversation).toBeNull();

    const after = await send(h, tenant, reset.sessionToken, 'Hello again', client);
    const newConversationId = (after[0] as Extract<WidgetEvent, { type: 'turn.start' }>).conversationId;
    expect(newConversationId).not.toBe(oldConversationId);
    expect((await conversationRows(tenant.org.id)).map((row) => [row.id, row.status])).toEqual([
      [oldConversationId, 'closed'],
      [newConversationId, 'active'],
    ]);
    // The old transcript stays for the admin.
    expect(await messageRoles(oldConversationId)).toEqual(['user', 'tool_call', 'tool_result', 'assistant']);
  });

  it('is a no-op without an active conversation and rejects bad tokens and unknown widgets', async () => {
    const h = harness();
    const tenant = await newTenant();
    const client = newClient();
    const session = await h.service.startSession({ widgetKey: tenant.widgetKey }, client);

    await expect(
      h.service.resetConversation({ widgetKey: tenant.widgetKey, sessionToken: session.sessionToken }, client),
    ).resolves.toMatchObject({ ok: true });
    expect(await conversationRows(tenant.org.id)).toEqual([]);

    await expect(h.service.resetConversation({ widgetKey: tenant.widgetKey, sessionToken: 'garbage' }, client)).rejects.toMatchObject({
      code: 'invalid_session',
      status: 401,
    });
    await expect(
      h.service.resetConversation({ widgetKey: `wk_${'X'.repeat(32)}`, sessionToken: session.sessionToken }, client),
    ).rejects.toMatchObject({ code: 'widget_unavailable', status: 404 });
  });
});

// ── tenant isolation ────────────────────────────────────────────────────────

describe('tenant isolation', () => {
  it("rejects a token issued by organization A's widget at organization B's widget", async () => {
    const h = harness();
    const a = await newTenant();
    const b = await newTenant();
    const client = newClient();
    const sessionA = await h.service.startSession({ widgetKey: a.widgetKey }, client);
    const eventsA = await send(h, a, sessionA.sessionToken, 'Hello A', client);
    const conversationA = (eventsA[0] as Extract<WidgetEvent, { type: 'turn.start' }>).conversationId;

    await expect(
      h.service.openMessageStream({ widgetKey: b.widgetKey, sessionToken: sessionA.sessionToken, text: 'Hello B' }, client),
    ).rejects.toMatchObject({ code: 'invalid_session', status: 401 });
    await expect(
      h.service.resetConversation({ widgetKey: b.widgetKey, sessionToken: sessionA.sessionToken }, client),
    ).rejects.toMatchObject({ code: 'invalid_session', status: 401 });

    const sessionB = await h.service.startSession({ widgetKey: b.widgetKey, sessionToken: sessionA.sessionToken }, client);
    expect(sessionB.conversation).toBeNull();
    expect(claimsOf(sessionB.sessionToken).agentId).toBe(b.agent.id);
    expect(claimsOf(sessionB.sessionToken).visitorId).not.toBe(claimsOf(sessionA.sessionToken).visitorId);

    // A's conversation is untouched and B has none.
    expect(await conversationRows(b.org.id)).toEqual([]);
    expect(await conversationRows(a.org.id)).toEqual([expect.objectContaining({ id: conversationA, status: 'active' })]);
  });

  it("never shows organization A's conversation to a visitor of organization B, even with the same visitor id", async () => {
    const h = harness();
    const a = await newTenant();
    const b = await newTenant();
    const client = newClient();
    const sessionA = await h.service.startSession({ widgetKey: a.widgetKey }, client);
    const eventsA = await send(h, a, sessionA.sessionToken, 'My boiler is broken', client);
    const conversationA = (eventsA[0] as Extract<WidgetEvent, { type: 'turn.start' }>).conversationId;

    // A genuine token for B's agent carrying A's visitor id (e.g. a leaked id): lookups stay inside B.
    const { visitorId } = claimsOf(sessionA.sessionToken);
    const tokenB = signWidgetSession({ agentId: b.agent.id, visitorId }, { secret: SECRET, ttlSeconds: TTL_SECONDS, now: T0 });

    const sessionB = await h.service.startSession({ widgetKey: b.widgetKey, sessionToken: tokenB }, client);
    expect(sessionB.conversation).toBeNull();
    const eventsB = await send(h, b, tokenB, 'Hello B', client);
    const conversationB = (eventsB[0] as Extract<WidgetEvent, { type: 'turn.start' }>).conversationId;
    expect(conversationB).not.toBe(conversationA);
    expect(h.runtime.inputs.at(-1)).toMatchObject({ organizationId: b.org.id, conversationId: conversationB });
    expect(h.runtime.inputs.at(-1)?.agent.id).toBe(b.agent.id);

    const restoredB = await h.service.startSession({ widgetKey: b.widgetKey, sessionToken: tokenB }, client);
    expect(restoredB.conversation?.id).toBe(conversationB);
    expect(restoredB.conversation?.messages.map((message) => message.content)).not.toContain('My boiler is broken');
    expect(await messageRoles(conversationA)).toEqual(['user', 'tool_call', 'tool_result', 'assistant']);
  });
});
