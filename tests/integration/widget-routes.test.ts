import type * as nextServer from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { POST as postMessages } from '@/app/api/widget/messages/route';
import { POST as postReset } from '@/app/api/widget/reset/route';
import { POST as postSession } from '@/app/api/widget/session/route';
import WidgetUnavailable from '@/app/widget/[widgetKey]/not-found';
import WidgetPage from '@/app/widget/[widgetKey]/page';
import { ChatWidget } from '@/components/widget/ChatWidget';
import type { TextGenerationRequest } from '@/server/ai/types';
import { loadAiConfig, loadWidgetConfig } from '@/server/config/env';
import { tryAcquireTurnLock } from '@/server/domain/conversations/service';
import { silentLogger } from '@/server/observability/logger';
import { createServices, type AppServices } from '@/server/services';
import {
  SSE_CONTENT_TYPE,
  apiErrorSchema,
  createSseParser,
  resetResponseSchema,
  sessionResponseSchema,
  type ApiErrorCode,
  type WidgetEvent,
} from '@/shared/widget-protocol';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { FakeEmbeddingProvider } from '../support/fake-embeddings';
import { createTenant, type TenantFixture } from '../support/fixtures';
import { ScriptedTextProvider, type ScriptedTurn } from '../support/scripted-text-provider';

// The route modules read their services from `@/server/app-services`; here they are built over PGlite.
// (vi.mock and vi.hoisted are hoisted above the imports.)
const state = vi.hoisted(() => ({
  services: undefined as AppServices | undefined,
  /** Work handed to `after()`: tests await it before asserting post-turn state. */
  pending: [] as Promise<unknown>[],
}));

vi.mock('@/server/app-services', () => ({
  getAppServices: (): AppServices => {
    if (!state.services) throw new Error('Invalid widget configuration: WIDGET_SESSION_SECRET is missing');
    return state.services;
  },
}));

// Outside a Next.js request scope `after` and `connection` throw: run `after` tasks right away and
// remember them; `connection` (the page's "render per request" marker) has nothing to wait for here.
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof nextServer>()),
  after: (task: unknown) => {
    state.pending.push(Promise.resolve(typeof task === 'function' ? (task as () => unknown)() : task));
  },
  connection: () => Promise.resolve(),
}));

const APP_ORIGIN = 'http://localhost:3000';
const HOURS_REPLY = 'We do not have opening hours listed yet, but I can take your details.';
const GREETING_REPLY = 'Hello! How can I help you today?';

let t: TestDatabase;
let services: AppServices;
const model = new ScriptedTextProvider('scripted', scriptedReply);

/** A tiny stand-in LLM: hours questions go through getBusinessHours, anything else gets a greeting. */
function scriptedReply(request: TextGenerationRequest): ScriptedTurn {
  const last = request.input.at(-1);
  if (last?.type === 'tool_result') return { text: HOURS_REPLY };
  let question = '';
  for (const item of request.input) {
    if (item.type === 'message' && item.role === 'user') question = item.content;
  }
  if (/hours/i.test(question) && request.tools.some((tool) => tool.name === 'getBusinessHours')) {
    return { toolCalls: [{ name: 'getBusinessHours', arguments: {} }] };
  }
  return { text: GREETING_REPLY };
}

function buildServices(options: { widgetEnv?: Record<string, string>; now?: () => Date } = {}): AppServices {
  return createServices({
    db: t.db,
    logger: silentLogger,
    ai: loadAiConfig({
      AI_TEXT_PROVIDER: 'scripted',
      AI_TEXT_MODEL: 'scripted-mini',
      AI_ESCALATION_ENABLED: 'false',
      AI_EMBEDDING_PROVIDER: 'fake',
      AI_EMBEDDING_MODEL: 'fake-embed',
      AI_MODEL_PRICING_JSON: JSON.stringify({ 'scripted-mini': { inputPerMTok: 0.1, outputPerMTok: 0.5 } }),
    }),
    providers: {
      text: { scripted: () => model },
      embedding: { fake: () => new FakeEmbeddingProvider('fake') },
    },
    widget: loadWidgetConfig({ WIDGET_SESSION_SECRET: 'route-test-widget-session-secret-0123456789', ...options.widgetEnv }),
    now: options.now,
  });
}

beforeAll(async () => {
  t = await createTestDatabase();
  services = buildServices();
  state.services = services;
});

afterAll(async () => {
  await t.close();
});

// ── helpers ──────────────────────────────────────────────────────────────────

const newTenant = (): Promise<TenantFixture> => t.service.run((sql) => createTenant(sql));

let ips = 0;
/** A distinct client per request: rate limits are per IP. */
const newIp = () => {
  ips += 1;
  return `198.51.${Math.floor(ips / 256)}.${ips % 256}`;
};

/** A browser-like same-origin request from the widget iframe. */
function request(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${APP_ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      host: 'localhost:3000',
      origin: APP_ORIGIN,
      'x-forwarded-for': newIp(),
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function expectApiError(response: Response, status: number, code: ApiErrorCode): Promise<string> {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = apiErrorSchema.parse(await response.json());
  expect(body.error.code).toBe(code);
  return body.error.message;
}

/** Parses the SSE body with the widget's parser and checks the raw frames carry nothing beyond the protocol. */
async function readEvents(response: Response): Promise<WidgetEvent[]> {
  const events: WidgetEvent[] = [];
  const invalid: string[] = [];
  const parser = createSseParser(
    (event) => events.push(event),
    (raw) => invalid.push(raw),
  );
  const reader = response.body!.getReader();
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
    .map((frame): unknown => JSON.parse(frame.split('\n')[1]?.replace(/^data: /, '') ?? ''));
  expect(frames).toEqual(events);
  return events;
}

async function settleAfterWork(): Promise<void> {
  await Promise.all(state.pending.splice(0));
}

async function openSession(tenant: TenantFixture, sessionToken?: string, ip = newIp()) {
  const response = await postSession(
    request('/api/widget/session', sessionToken ? { widgetKey: tenant.widgetKey, sessionToken } : { widgetKey: tenant.widgetKey }, {
      'x-forwarded-for': ip,
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return sessionResponseSchema.parse(await response.json());
}

async function sendMessage(tenant: TenantFixture, sessionToken: string, text: string) {
  const response = await postMessages(request('/api/widget/messages', { widgetKey: tenant.widgetKey, sessionToken, text }));
  expect(response.status).toBe(200);
  const events = await readEvents(response);
  await settleAfterWork();
  return { response, events };
}

const conversationIdOf = (events: readonly WidgetEvent[]) => {
  const start = events[0];
  if (start?.type !== 'turn.start') throw new Error('expected turn.start first');
  return start.conversationId;
};

// ── the visitor flow ────────────────────────────────────────────────────────

describe('widget API routes', () => {
  it('starts a session, streams a full tool-using turn, restores it and resets it', async () => {
    const tenant = await newTenant();
    const session = await openSession(tenant);
    expect(session.agent).toEqual({ name: 'Front Desk', greeting: 'Hi! How can I help you today?', language: 'en' });
    expect(session.conversation).toBeNull();

    const { response, events } = await sendMessage(tenant, session.sessionToken, 'What are your hours?');
    expect(response.headers.get('content-type')).toBe(SSE_CONTENT_TYPE);
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(response.headers.get('x-accel-buffering')).toBe('no');

    const types = events.map((event) => event.type);
    expect(types[0]).toBe('turn.start');
    expect(types.slice(1, 3)).toEqual(['tool.call', 'tool.result']);
    expect(types.at(-1)).toBe('turn.done');
    expect(new Set(types.slice(3, -1))).toEqual(new Set(['text.delta']));
    const label = services.tools.get('getBusinessHours')?.label;
    expect(events[1]).toMatchObject({ type: 'tool.call', name: 'getBusinessHours', label });
    expect(events[2]).toMatchObject({ type: 'tool.result', name: 'getBusinessHours', ok: true });
    expect(events.at(-1)).toMatchObject({ type: 'turn.done', text: HOURS_REPLY });
    const streamed = events.flatMap((event) => (event.type === 'text.delta' ? [event.delta] : [])).join('');
    expect(streamed).toBe(HOURS_REPLY);

    // Persisted by the runtime; the turn lock was released by the post-turn work.
    const conversationId = conversationIdOf(events);
    const messages = await t.db.query<{ role: string; content: string }>(
      'select role, content from public.messages where organization_id = $1 and conversation_id = $2 order by seq',
      [tenant.org.id, conversationId],
    );
    expect(messages.map((message) => message.role)).toEqual(['user', 'tool_call', 'tool_result', 'assistant']);
    const [conversation] = await t.db.query<{ turn_locked_until: Date | null }>(
      'select turn_locked_until from public.conversations where id = $1',
      [conversationId],
    );
    expect(conversation?.turn_locked_until).toBeNull();
    const usage = await t.db.query<{ provider: string; model: string; purpose: string }>(
      'select provider, model, purpose from public.usage_records where organization_id = $1 and conversation_id = $2',
      [tenant.org.id, conversationId],
    );
    expect(usage).toEqual([
      { provider: 'scripted', model: 'scripted-mini', purpose: 'chat_response' },
      { provider: 'scripted', model: 'scripted-mini', purpose: 'chat_response' },
    ]);

    // Refresh: the same conversation comes back, without tool rows.
    const restored = await openSession(tenant, session.sessionToken);
    expect(restored.conversation?.id).toBe(conversationId);
    expect(restored.conversation?.messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: 'user', content: 'What are your hours?' },
      { role: 'assistant', content: HOURS_REPLY },
    ]);

    // "New chat": the conversation is closed and the next message starts another one.
    const resetResponse = await postReset(
      request('/api/widget/reset', { widgetKey: tenant.widgetKey, sessionToken: restored.sessionToken }),
    );
    expect(resetResponse.status).toBe(200);
    expect(resetResponse.headers.get('cache-control')).toBe('no-store');
    const reset = resetResponseSchema.parse(await resetResponse.json());
    expect((await openSession(tenant, reset.sessionToken)).conversation).toBeNull();

    const next = await sendMessage(tenant, reset.sessionToken, 'Hello there');
    expect(next.events.at(-1)).toMatchObject({ type: 'turn.done', text: GREETING_REPLY });
    expect(conversationIdOf(next.events)).not.toBe(conversationId);
    const statuses = await t.db.query<{ id: string; status: string }>(
      'select id, status from public.conversations where organization_id = $1 order by created_at',
      [tenant.org.id],
    );
    expect(statuses).toEqual([
      { id: conversationId, status: 'closed' },
      { id: conversationIdOf(next.events), status: 'active' },
    ]);
  });

  it('answers unknown widgets with 404 and invalid or foreign session tokens with 401', async () => {
    const tenant = await newTenant();
    const other = await newTenant();
    const unknownKey = `wk_${'N'.repeat(32)}`;

    await expectApiError(await postSession(request('/api/widget/session', { widgetKey: unknownKey })), 404, 'widget_unavailable');
    const session = await openSession(tenant);
    await expectApiError(
      await postMessages(request('/api/widget/messages', { widgetKey: unknownKey, sessionToken: session.sessionToken, text: 'Hi' })),
      404,
      'widget_unavailable',
    );
    await expectApiError(
      await postMessages(request('/api/widget/messages', { widgetKey: tenant.widgetKey, sessionToken: 'forged.token', text: 'Hi' })),
      401,
      'invalid_session',
    );
    // A token minted by one tenant's widget is worthless at another tenant's widget.
    await expectApiError(
      await postMessages(request('/api/widget/messages', { widgetKey: other.widgetKey, sessionToken: session.sessionToken, text: 'Hi' })),
      401,
      'invalid_session',
    );
    await expectApiError(
      await postReset(request('/api/widget/reset', { widgetKey: other.widgetKey, sessionToken: session.sessionToken })),
      401,
      'invalid_session',
    );
    expect(await t.db.query('select id from public.conversations where organization_id = $1', [other.org.id])).toEqual([]);
  });

  it('rejects cross-origin requests with 403 and honours the forwarded host behind a proxy', async () => {
    const tenant = await newTenant();
    const evil = { origin: 'https://evil.example' };
    const session = await openSession(tenant);

    await expectApiError(await postSession(request('/api/widget/session', { widgetKey: tenant.widgetKey }, evil)), 403, 'invalid_request');
    await expectApiError(
      await postMessages(request('/api/widget/messages', { widgetKey: tenant.widgetKey, sessionToken: session.sessionToken, text: 'Hi' }, evil)),
      403,
      'invalid_request',
    );
    await expectApiError(
      await postReset(request('/api/widget/reset', { widgetKey: tenant.widgetKey, sessionToken: session.sessionToken }, evil)),
      403,
      'invalid_request',
    );
    await expectApiError(
      await postSession(request('/api/widget/session', { widgetKey: tenant.widgetKey }, { origin: 'null' })),
      403,
      'invalid_request',
    );
    // Behind the platform proxy the public host arrives in x-forwarded-host; the internal Host differs.
    const proxied = { origin: 'https://chat.example.com', host: 'internal:3000', 'x-forwarded-host': 'chat.example.com' };
    expect((await postSession(request('/api/widget/session', { widgetKey: tenant.widgetKey }, proxied))).status).toBe(200);
    await expectApiError(
      await postSession(request('/api/widget/session', { widgetKey: tenant.widgetKey }, { ...proxied, 'x-forwarded-host': 'other.example.com' })),
      403,
      'invalid_request',
    );
    // Non-browser clients send no Origin (and carry no ambient credentials).
    const noOrigin = new Request(`${APP_ORIGIN}/api/widget/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'localhost:3000' },
      body: JSON.stringify({ widgetKey: tenant.widgetKey }),
    });
    expect((await postSession(noOrigin)).status).toBe(200);
  });

  it('validates the request body: JSON only, schema-checked and size-limited', async () => {
    const tenant = await newTenant();
    const session = await openSession(tenant);

    await expectApiError(
      await postSession(request('/api/widget/session', { widgetKey: tenant.widgetKey }, { 'content-type': 'text/plain' })),
      415,
      'invalid_request',
    );
    await expectApiError(await postSession(request('/api/widget/session', '{"widgetKey":')), 400, 'invalid_request');
    await expectApiError(await postSession(request('/api/widget/session', { widgetKey: 'nope' })), 400, 'invalid_request');
    const tooLong = await expectApiError(
      await postMessages(
        request('/api/widget/messages', { widgetKey: tenant.widgetKey, sessionToken: session.sessionToken, text: 'x'.repeat(2001) }),
      ),
      400,
      'invalid_request',
    );
    expect(tooLong).toBe('Message is too long.');
    await expectApiError(
      await postMessages(
        request('/api/widget/messages', { widgetKey: tenant.widgetKey, sessionToken: session.sessionToken, text: 'x'.repeat(20_000) }),
      ),
      413,
      'invalid_request',
    );
    // A body larger than the limit is refused even without a usable Content-Length.
    const chunked = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`{"widgetKey":"${tenant.widgetKey}","pad":"${'p'.repeat(20_000)}"}`));
        controller.close();
      },
    });
    const streamed = new Request(`${APP_ORIGIN}/api/widget/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', host: 'localhost:3000', origin: APP_ORIGIN },
      body: chunked,
      duplex: 'half',
    } as RequestInit);
    await expectApiError(await postSession(streamed), 413, 'invalid_request');
  });

  it('answers 409 while a turn holds the conversation and 429 with Retry-After when rate limited', async () => {
    const tenant = await newTenant();
    const session = await openSession(tenant);
    const first = await sendMessage(tenant, session.sessionToken, 'Hello');
    const conversationId = conversationIdOf(first.events);

    // Another request (e.g. a second tab) is mid-turn.
    expect(await t.service.run((sql) => tryAcquireTurnLock(sql, tenant.org.id, conversationId, 60))).toBe(true);
    await expectApiError(
      await postMessages(request('/api/widget/messages', { widgetKey: tenant.widgetKey, sessionToken: session.sessionToken, text: 'Hi' })),
      409,
      'conversation_busy',
    );

    // A fixed clock half way through a minute: all four requests share one rate-limit window.
    const midMinute = new Date('2026-10-08T12:00:30.000Z');
    state.services = buildServices({ widgetEnv: { RATE_LIMIT_IP_PER_MINUTE: '1' }, now: () => midMinute });
    try {
      // Session starts are allowed three times the per-IP message limit.
      const ip = newIp();
      const limited = await openSession(tenant, undefined, ip);
      await openSession(tenant, limited.sessionToken, ip);
      await openSession(tenant, limited.sessionToken, ip);
      const response = await postSession(request('/api/widget/session', { widgetKey: tenant.widgetKey }, { 'x-forwarded-for': ip }));
      await expectApiError(response, 429, 'rate_limited');
      expect(response.headers.get('retry-after')).toBe('30');
    } finally {
      state.services = services;
    }
  });

  it('fails closed when the client IP is unusable: all such requests share one rate-limit bucket', async () => {
    const tenant = await newTenant();
    // A minute of its own (the shared bucket is per window); per IP: 1 message and 3 session starts a minute.
    const fixed = new Date('2026-10-08T12:10:30.000Z');
    state.services = buildServices({ widgetEnv: { RATE_LIMIT_IP_PER_MINUTE: '1' }, now: () => fixed });
    try {
      // E.g. a proxy that garbles X-Forwarded-For and sets no X-Real-IP.
      const garbled = (value: string) => ({ 'x-forwarded-for': value });
      const opened = await postSession(request('/api/widget/session', { widgetKey: tenant.widgetKey }, garbled('unknown')));
      expect(opened.status).toBe(200);
      const { sessionToken } = sessionResponseSchema.parse(await opened.json());

      const first = await postMessages(
        request('/api/widget/messages', { widgetKey: tenant.widgetKey, sessionToken, text: 'Hello' }, garbled('unknown')),
      );
      expect(first.status).toBe(200);
      expect((await readEvents(first)).at(-1)).toMatchObject({ type: 'turn.done' });
      await settleAfterWork();
      const second = await postMessages(
        request('/api/widget/messages', { widgetKey: tenant.widgetKey, sessionToken, text: 'Hello again' }, garbled('garbage')),
      );
      await expectApiError(second, 429, 'rate_limited');

      for (const value of ['unknown', 'not-an-ip']) {
        expect((await postSession(request('/api/widget/session', { widgetKey: tenant.widgetKey }, garbled(value)))).status).toBe(200);
      }
      const limited = await postSession(request('/api/widget/session', { widgetKey: tenant.widgetKey }, garbled('unknown')));
      await expectApiError(limited, 429, 'rate_limited');
      expect(limited.headers.get('retry-after')).toBe('30');
      // A request with a usable address is its own client.
      expect((await postSession(request('/api/widget/session', { widgetKey: tenant.widgetKey }))).status).toBe(200);
    } finally {
      state.services = services;
    }
  });

  it('answers 500 with a generic error when the server is misconfigured (no internals leak)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    state.services = undefined;
    try {
      const message = await expectApiError(
        await postSession(request('/api/widget/session', { widgetKey: `wk_${'M'.repeat(32)}` })),
        500,
        'internal',
      );
      expect(message).toBe('Something went wrong. Please try again.');
      expect(message).not.toContain('WIDGET_SESSION_SECRET');
      // The operator still sees the cause in the structured log.
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('"event":"webchat.request_failed"'));
    } finally {
      state.services = services;
    }
  });
});

// ── the widget page ─────────────────────────────────────────────────────────

describe('widget page', () => {
  const render = (widgetKey: string, searchParams: Record<string, string> = {}) =>
    WidgetPage({ params: Promise.resolve({ widgetKey }), searchParams: Promise.resolve(searchParams) });

  it('renders the chat with the public agent details for a published widget', async () => {
    const tenant = await newTenant();

    const embedded = await render(tenant.widgetKey, { embedded: '1' });
    expect(embedded.type).toBe(ChatWidget);
    const props: unknown = embedded.props;
    expect(props).toEqual({
      widgetKey: tenant.widgetKey,
      agentName: 'Front Desk',
      greeting: 'Hi! How can I help you today?',
      language: 'en',
      embedded: true,
    });
    const preview: unknown = (await render(tenant.widgetKey)).props;
    expect(preview).toMatchObject({ embedded: false });
  });

  it('shows the unavailable screen for unpublished widgets and when the server fails', async () => {
    const tenant = await newTenant();
    await t.db.query('update public.agent_channels set enabled = false where organization_id = $1', [tenant.org.id]);
    expect((await render(tenant.widgetKey)).type).toBe(WidgetUnavailable);

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    state.services = undefined;
    try {
      expect((await render(`wk_${'P'.repeat(32)}`)).type).toBe(WidgetUnavailable);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('"event":"widget.page_failed"'));
    } finally {
      state.services = services;
    }
  });

  it('is a 404 for malformed widget keys', async () => {
    await expect(render('not-a-widget-key')).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
  });
});
