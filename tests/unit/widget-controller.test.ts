import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SSE_CONTENT_TYPE,
  encodeSseEvent,
  type ApiErrorCode,
  type PublicMessage,
  type SessionResponse,
  type WidgetEvent,
} from '@/shared/widget-protocol';
import { ChatController } from '@/widget/chat-controller';
import { createChatStore, type ChatStore, type WidgetState } from '@/widget/chat-store';
import { browserTokenStorage, sessionStorageKey, type TokenStorage } from '@/widget/session-storage';

const WIDGET_KEY = 'wk_TestWidgetKey0123456789abcdefXYZ';
const STORAGE_KEY = sessionStorageKey(WIDGET_KEY);
const AGENT = { name: 'Front Desk', greeting: 'Hi! How can I help?', language: 'en' };
const SESSION = '/api/widget/session';
const MESSAGES = '/api/widget/messages';
const RESET = '/api/widget/reset';

// ── fakes ─────────────────────────────────────────────────────────────────────

interface FakeRequest {
  path: string;
  body: Record<string, unknown>;
  signal: AbortSignal;
}
type Handler = (request: FakeRequest) => Response | Promise<Response>;

/** A scripted `fetch`: each request to a path consumes the next handler queued for it. */
function scriptedFetch() {
  const queues = new Map<string, Handler[]>();
  const calls: FakeRequest[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
    const request: FakeRequest = { path, body, signal: init?.signal ?? new AbortController().signal };
    calls.push(request);
    const handler = queues.get(path)?.shift();
    if (!handler) throw new Error(`unexpected request to ${path}`);
    return handler(request);
  };
  return {
    fetchImpl,
    calls,
    on(path: string, ...handlers: Handler[]) {
      queues.set(path, [...(queues.get(path) ?? []), ...handlers]);
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function session(sessionToken: string, conversation: SessionResponse['conversation'] = null): Handler {
  const body: SessionResponse = { sessionToken, agent: AGENT, conversation };
  return () => json(body);
}

function apiError(status: number, code: ApiErrorCode, message = 'Request failed'): Handler {
  return () => json({ error: { code, message } }, status);
}

function offline(): Handler {
  return () => {
    throw new TypeError('Failed to fetch');
  };
}

const encoder = new TextEncoder();

/** Cuts bytes at awkward places: inside frames, JSON strings and multi-byte UTF-8 characters. */
function awkwardChunks(bytes: Uint8Array): Uint8Array[] {
  const sizes = [1, 2, 3, 5, 8, 13, 21];
  const chunks: Uint8Array[] = [];
  for (let offset = 0, i = 0; offset < bytes.length; i += 1) {
    const size = sizes[i % sizes.length]!;
    chunks.push(bytes.slice(offset, offset + size));
    offset += size;
  }
  return chunks;
}

/** The controllable body of a `text/event-stream` response; it errors when the request is aborted (like fetch). */
function sseResponse(signal: AbortSignal) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  signal.addEventListener('abort', () => {
    controller.error(new DOMException('The operation was aborted.', 'AbortError'));
  });
  return {
    response: new Response(body, { status: 200, headers: { 'content-type': SSE_CONTENT_TYPE } }),
    push(events: WidgetEvent[]) {
      for (const chunk of awkwardChunks(encoder.encode(events.map(encodeSseEvent).join('')))) {
        controller.enqueue(chunk);
      }
    },
    close() {
      controller.close();
    },
    /** The connection fails mid-body (not an abort). */
    drop() {
      controller.error(new TypeError('network error'));
    },
  };
}

/** A reply stream with all of `events`, closed afterwards. */
function sse(events: WidgetEvent[]): Handler {
  return ({ signal }) => {
    const stream = sseResponse(signal);
    stream.push(events);
    stream.close();
    return stream.response;
  };
}

/** A reply stream the test feeds by hand. */
function liveSse() {
  let current: ReturnType<typeof sseResponse> | null = null;
  const handler: Handler = ({ signal }) => {
    current = sseResponse(signal);
    return current.response;
  };
  const stream = () => {
    if (!current) throw new Error('the message request has not been made yet');
    return current;
  };
  return {
    handler,
    push: (...events: WidgetEvent[]) => {
      stream().push(events);
    },
    close: () => {
      stream().close();
    },
    drop: () => {
      stream().drop();
    },
  };
}

function reply(turnId: string, text: string, conversationId = 'conv-1'): WidgetEvent[] {
  return [
    { type: 'turn.start', turnId, conversationId },
    { type: 'text.delta', turnId, delta: text },
    { type: 'turn.done', turnId, messageId: `msg-${turnId}`, text },
  ];
}

function memoryStorage(initial: Record<string, string> = {}): TokenStorage {
  const data = new Map(Object.entries(initial));
  return {
    get: (key) => data.get(key) ?? null,
    set: (key, value) => {
      data.set(key, value);
    },
    remove: (key) => {
      data.delete(key);
    },
  };
}

const blockedStorage: TokenStorage = {
  get() {
    throw new DOMException('Access is denied for this document.', 'SecurityError');
  },
  set() {
    throw new DOMException('Access is denied for this document.', 'SecurityError');
  },
  remove() {
    throw new DOMException('Access is denied for this document.', 'SecurityError');
  },
};

function setup(storage: TokenStorage = memoryStorage()) {
  const store = createChatStore();
  const http = scriptedFetch();
  const controller = new ChatController({ widgetKey: WIDGET_KEY, store, fetchImpl: http.fetchImpl, storage });
  return { store, http, storage, controller };
}

/** Every state the store passes through from now on. */
function recordStates(store: ChatStore): WidgetState[] {
  const states: WidgetState[] = [];
  store.subscribe((next, previous) => {
    if (next.state !== previous.state) states.push(next.state);
  });
  return states;
}

function turnSummary(store: ChatStore) {
  return store.getState().turns.map((t) => ({ role: t.role, text: t.text, failed: t.failed, streaming: t.streaming }));
}

const HISTORY: PublicMessage[] = [
  { id: 'm1', role: 'user', content: 'Do you work weekends?', createdAt: '2026-10-08T10:00:00.000Z' },
  { id: 'm2', role: 'assistant', content: 'Yes, Saturdays 9 to 1.', createdAt: '2026-10-08T10:00:02.000Z' },
];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── session ──────────────────────────────────────────────────────────────────

describe('ChatController.open', () => {
  it('restores the visitor conversation from the server and stores the re-issued token', async () => {
    const { store, http, storage, controller } = setup(memoryStorage({ [STORAGE_KEY]: 'tok-old' }));
    http.on(SESSION, session('tok-new', { id: 'conv-1', messages: HISTORY }));
    const states = recordStates(store);

    await controller.open();

    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]).toMatchObject({ path: SESSION, body: { widgetKey: WIDGET_KEY, sessionToken: 'tok-old' } });
    expect(states).toEqual(['OPENING', 'READY']);
    const s = store.getState();
    expect(s.agent).toEqual(AGENT);
    expect(s.conversationId).toBe('conv-1');
    expect(s.turns).toEqual([
      { id: 'm1', role: 'user', text: 'Do you work weekends?', streaming: false, tools: [], failed: false },
      { id: 'm2', role: 'assistant', text: 'Yes, Saturdays 9 to 1.', streaming: false, tools: [], failed: false },
    ]);
    expect(storage.get(STORAGE_KEY)).toBe('tok-new');
  });

  it('sends no token on a first visit and shows an empty conversation', async () => {
    const { store, http, storage, controller } = setup();
    http.on(SESSION, session('tok-1'));
    await controller.open();
    expect(http.calls[0]?.body).toEqual({ widgetKey: WIDGET_KEY });
    expect(store.getState()).toMatchObject({ state: 'READY', conversationId: null, turns: [] });
    expect(storage.get(STORAGE_KEY)).toBe('tok-1');
  });

  it('reports a network failure as recoverable and retry() opens again', async () => {
    const { store, http, controller } = setup();
    http.on(SESSION, offline(), session('tok-1', { id: 'conv-1', messages: HISTORY }));

    await controller.open();
    expect(store.getState()).toMatchObject({ state: 'ERROR', failedAction: 'open' });
    expect(store.getState().error).toMatchObject({ code: 'network', recoverable: true });

    await controller.retry();
    expect(store.getState()).toMatchObject({ state: 'READY', error: null, failedAction: null, conversationId: 'conv-1' });
    expect(http.calls).toHaveLength(2);
  });

  it('clears the previous error as soon as a retry starts', async () => {
    const { store, http, controller } = setup();
    let respond: (response: Response) => void = () => undefined;
    http.on(
      SESSION,
      offline(),
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    );
    await controller.open();
    expect(store.getState().error).not.toBeNull();

    const retrying = controller.retry();
    expect(store.getState()).toMatchObject({ state: 'OPENING', error: null, failedAction: null });
    respond(json({ sessionToken: 'tok-1', agent: AGENT, conversation: null }));
    await retrying;
    expect(store.getState().state).toBe('READY');
  });

  it('tells a malformed session response apart from one that never fully arrived', async () => {
    const { store, http, controller } = setup();
    http.on(
      SESSION,
      () => new Response('<html>Welcome to the hotel Wi-Fi</html>', { status: 200 }),
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.error(new TypeError('network error'));
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    await controller.open();
    expect(store.getState().error).toEqual({
      code: 'internal',
      message: 'Something went wrong. Please try again.',
      recoverable: true,
    });

    await controller.retry();
    expect(store.getState()).toMatchObject({ state: 'ERROR', error: { code: 'network', recoverable: true } });
  });

  it('treats an unpublished widget as unrecoverable', async () => {
    const { store, http, controller } = setup();
    http.on(SESSION, apiError(404, 'widget_unavailable', 'This chat is currently unavailable.'));
    await controller.open();
    expect(store.getState().error).toEqual({
      code: 'widget_unavailable',
      message: 'This chat is currently unavailable.',
      recoverable: false,
    });
    await controller.retry();
    expect(http.calls).toHaveLength(1);
  });

  it('can be disposed mid-request and opened again (React StrictMode remount)', async () => {
    const { store, http, controller } = setup();
    http.on(
      SESSION,
      ({ signal }) =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
      session('tok-1', { id: 'conv-1', messages: HISTORY }),
    );
    const states = recordStates(store);

    const first = controller.open();
    controller.dispose();
    expect(http.calls[0]?.signal.aborted).toBe(true);
    const second = controller.open();
    await Promise.all([first, second]);

    expect(states).toEqual(['OPENING', 'READY']);
    expect(store.getState().turns).toHaveLength(2);
    expect(http.calls).toHaveLength(2);
  });
});

// ── messages ─────────────────────────────────────────────────────────────────

describe('ChatController.send', () => {
  async function ready(storage?: TokenStorage) {
    const env = setup(storage);
    env.http.on(SESSION, session('tok-1'));
    await env.controller.open();
    return env;
  }

  it('streams a reply through THINKING -> TOOL -> THINKING -> SPEAKING -> READY and keeps the final text', async () => {
    const { store, http, controller } = await ready();
    const states = recordStates(store);
    const streamed: string[] = [];
    store.subscribe((s) => {
      const text = s.turns.find((t) => t.id === 'turn-1')?.text;
      if (text !== undefined && text !== streamed[streamed.length - 1]) streamed.push(text);
    });
    http.on(
      MESSAGES,
      sse([
        { type: 'turn.start', turnId: 'turn-1', conversationId: 'conv-1' },
        { type: 'tool.call', turnId: 'turn-1', callId: 'call-1', name: 'searchKnowledge', label: 'Searching our information' },
        { type: 'tool.result', turnId: 'turn-1', callId: 'call-1', name: 'searchKnowledge', ok: true },
        { type: 'text.delta', turnId: 'turn-1', delta: 'We offer 24/7 ' },
        { type: 'text.delta', turnId: 'turn-1', delta: 'emergency repair — café ☕ hours.' },
        { type: 'turn.done', turnId: 'turn-1', messageId: 'msg-2', text: 'We offer 24/7 emergency repair.' },
      ]),
    );

    await controller.send('  Do you do emergency repairs?  ');

    expect(states).toEqual(['THINKING', 'TOOL', 'THINKING', 'SPEAKING', 'READY']);
    expect(http.calls[1]).toMatchObject({
      path: MESSAGES,
      body: { widgetKey: WIDGET_KEY, sessionToken: 'tok-1', text: 'Do you do emergency repairs?' },
    });
    // Multi-byte characters split across chunks arrive intact; turn.done replaces the streamed text.
    expect(streamed).toEqual([
      '',
      'We offer 24/7 ',
      'We offer 24/7 emergency repair — café ☕ hours.',
      'We offer 24/7 emergency repair.',
    ]);
    const s = store.getState();
    expect(s).toMatchObject({ conversationId: 'conv-1', activeTurnId: null, error: null });
    expect(s.lastUserText).toBe('Do you do emergency repairs?');
    expect(s.turns[0]).toMatchObject({ role: 'user', text: 'Do you do emergency repairs?', failed: false });
    expect(s.turns[1]).toEqual({
      id: 'turn-1',
      role: 'assistant',
      text: 'We offer 24/7 emergency repair.',
      streaming: false,
      tools: [{ callId: 'call-1', name: 'searchKnowledge', label: 'Searching our information', status: 'done' }],
      failed: false,
    });
  });

  it('shows tool progress while it runs and stays in TOOL until parallel calls finish', async () => {
    const { store, http, controller } = await ready();
    const live = liveSse();
    http.on(MESSAGES, live.handler);
    const sending = controller.send('Call me back at 555 0100');
    await vi.waitFor(() => {
      expect(http.calls).toHaveLength(2);
    });

    live.push(
      { type: 'turn.start', turnId: 'turn-1', conversationId: 'conv-1' },
      { type: 'tool.call', turnId: 'turn-1', callId: 'a', name: 'captureLead', label: 'Saving your details' },
      { type: 'tool.call', turnId: 'turn-1', callId: 'b', name: 'getBusinessHours', label: 'Checking our hours' },
      { type: 'tool.result', turnId: 'turn-1', callId: 'a', name: 'captureLead', ok: false },
    );
    await vi.waitFor(() => {
      expect(store.getState().turns[1]?.tools.map((t) => t.status)).toEqual(['error', 'running']);
    });
    expect(store.getState().state).toBe('TOOL');
    expect(store.getState().activeTurnId).toBe('turn-1');
    expect(store.getState().turns[1]?.streaming).toBe(true);

    live.push(
      { type: 'tool.result', turnId: 'turn-1', callId: 'b', name: 'getBusinessHours', ok: true },
      ...reply('turn-1', 'Thanks! We will call you.').slice(1),
    );
    live.close();
    await sending;
    expect(store.getState().state).toBe('READY');
    expect(store.getState().turns[1]?.tools.map((t) => [t.label, t.status])).toEqual([
      ['Saving your details', 'error'],
      ['Checking our hours', 'done'],
    ]);
  });

  it('marks the reply failed on turn.error, enters ERROR, and retry() asks again in place', async () => {
    const { store, http, controller } = await ready();
    http.on(
      MESSAGES,
      sse([
        { type: 'turn.start', turnId: 'turn-1', conversationId: 'conv-1' },
        { type: 'text.delta', turnId: 'turn-1', delta: 'Let me check' },
        {
          type: 'turn.error',
          turnId: 'turn-1',
          code: 'provider_unavailable',
          message: 'The assistant is temporarily unavailable.',
          recoverable: true,
        },
      ]),
      sse(reply('turn-2', 'We are open 8 to 6 on weekdays.')),
    );
    const states = recordStates(store);

    await controller.send('What are your hours?');

    expect(states).toEqual(['THINKING', 'SPEAKING', 'ERROR']);
    expect(store.getState().error).toEqual({
      code: 'provider_unavailable',
      message: 'The assistant is temporarily unavailable.',
      recoverable: true,
    });
    expect(store.getState().activeTurnId).toBeNull();
    expect(turnSummary(store)).toEqual([
      { role: 'user', text: 'What are your hours?', failed: false, streaming: false },
      { role: 'assistant', text: 'Let me check', failed: true, streaming: false },
    ]);

    await controller.retry();

    expect(http.calls[2]?.body).toMatchObject({ text: 'What are your hours?' });
    expect(store.getState()).toMatchObject({ state: 'READY', error: null });
    expect(turnSummary(store)).toEqual([
      { role: 'user', text: 'What are your hours?', failed: false, streaming: false },
      { role: 'assistant', text: 'We are open 8 to 6 on weekdays.', failed: false, streaming: false },
    ]);
  });

  it('marks the visitor message failed when the turn fails before a reply starts', async () => {
    const { store, http, controller } = await ready();
    http.on(
      MESSAGES,
      sse([{ type: 'turn.error', turnId: null, code: 'internal', message: 'Something broke.', recoverable: false }]),
    );
    await controller.send('Hello');
    expect(store.getState()).toMatchObject({
      state: 'ERROR',
      error: { code: 'internal', message: 'Something broke.', recoverable: false },
    });
    expect(turnSummary(store)).toEqual([{ role: 'user', text: 'Hello', failed: true, streaming: false }]);
    // Not recoverable: retry is a no-op.
    await controller.retry();
    expect(http.calls).toHaveLength(2);
  });

  it('shows the friendly message on HTTP 429', async () => {
    const { store, http, controller } = await ready();
    http.on(MESSAGES, apiError(429, 'rate_limited', 'Rate limit exceeded for this client'));
    await controller.send('hello');
    expect(store.getState()).toMatchObject({ state: 'ERROR', failedAction: 'send' });
    expect(store.getState().error).toEqual({
      code: 'rate_limited',
      message: 'Too many messages — please wait a moment.',
      recoverable: true,
    });
    expect(turnSummary(store)).toEqual([{ role: 'user', text: 'hello', failed: true, streaming: false }]);
  });

  it.each([
    {
      name: 'conversation_busy (409) keeps the server message',
      response: () => json({ error: { code: 'conversation_busy', message: 'Still answering.' } }, 409),
      expected: { code: 'conversation_busy', message: 'Still answering.', recoverable: true },
    },
    {
      name: 'invalid_request (400) is not recoverable',
      response: () => json({ error: { code: 'invalid_request', message: 'message is too long' } }, 400),
      expected: { code: 'invalid_request', message: 'message is too long', recoverable: false },
    },
    {
      name: 'a proxy error page falls back to a generic message',
      response: () => new Response('<html>Bad gateway</html>', { status: 502 }),
      expected: { code: 'internal', message: 'Something went wrong. Please try again.', recoverable: true },
    },
    {
      name: 'a non-ApiError 409 body is mapped from the status',
      response: () => json({ detail: 'busy' }, 409),
      expected: {
        code: 'conversation_busy',
        message: "I'm still answering your previous message — please wait a moment.",
        recoverable: true,
      },
    },
  ])('maps HTTP errors: $name', async ({ response, expected }) => {
    const { store, http, controller } = await ready();
    http.on(MESSAGES, response);
    await controller.send('hello');
    expect(store.getState().state).toBe('ERROR');
    expect(store.getState().error).toEqual(expected);
  });

  it('reports a network failure as recoverable; retry() resends the same text once', async () => {
    const { store, http, controller } = await ready();
    http.on(MESSAGES, offline(), sse(reply('turn-1', 'Hello again!')));

    await controller.send('Hi there');
    expect(store.getState().error).toMatchObject({ code: 'network', recoverable: true });
    expect(turnSummary(store)).toEqual([{ role: 'user', text: 'Hi there', failed: true, streaming: false }]);

    await controller.retry();
    expect(http.calls.filter((c) => c.path === MESSAGES).map((c) => c.body.text)).toEqual(['Hi there', 'Hi there']);
    expect(turnSummary(store)).toEqual([
      { role: 'user', text: 'Hi there', failed: false, streaming: false },
      { role: 'assistant', text: 'Hello again!', failed: false, streaming: false },
    ]);
    expect(store.getState().state).toBe('READY');
  });

  it('reports a stream that ends without turn.done as interrupted, keeping the partial reply', async () => {
    const { store, http, controller } = await ready();
    http.on(
      MESSAGES,
      sse([
        { type: 'turn.start', turnId: 'turn-1', conversationId: 'conv-1' },
        { type: 'text.delta', turnId: 'turn-1', delta: 'Our prices start' },
      ]),
    );
    await controller.send('Prices?');
    expect(store.getState().error).toMatchObject({ code: 'network', recoverable: true });
    expect(store.getState().error?.message).toContain('connection dropped');
    expect(store.getState().turns[1]).toMatchObject({ text: 'Our prices start', streaming: false, failed: true });
  });

  it('reports a connection that fails mid-reply as a recoverable network error', async () => {
    const { store, http, controller } = await ready();
    const live = liveSse();
    http.on(MESSAGES, live.handler);
    const sending = controller.send('Prices?');
    await vi.waitFor(() => {
      expect(http.calls).toHaveLength(2);
    });
    live.push(
      { type: 'turn.start', turnId: 'turn-1', conversationId: 'conv-1' },
      { type: 'text.delta', turnId: 'turn-1', delta: 'Our prices start' },
    );
    await vi.waitFor(() => {
      expect(store.getState().state).toBe('SPEAKING');
    });

    live.drop();
    await sending;

    expect(store.getState()).toMatchObject({ state: 'ERROR', failedAction: 'send', activeTurnId: null });
    expect(store.getState().error).toMatchObject({ code: 'network', recoverable: true });
    expect(store.getState().error?.message).toContain('connection dropped');
    expect(store.getState().turns[1]).toMatchObject({ text: 'Our prices start', streaming: false, failed: true });
  });

  it('re-creates an expired session once and retries the message once', async () => {
    const { store, http, controller } = setup(memoryStorage({ [STORAGE_KEY]: 'tok-old' }));
    http.on(SESSION, session('tok-1', { id: 'conv-1', messages: HISTORY }), session('tok-2'));
    http.on(MESSAGES, apiError(401, 'invalid_session', 'Session expired.'), sse(reply('turn-1', 'Welcome back!', 'conv-2')));
    await controller.open();

    await controller.send('Are you open now?');

    expect(http.calls.map((c) => [c.path, c.body.sessionToken])).toEqual([
      [SESSION, 'tok-old'],
      [MESSAGES, 'tok-1'],
      // The rejected token is dropped, so the server starts a fresh visitor session.
      [SESSION, undefined],
      [MESSAGES, 'tok-2'],
    ]);
    expect(store.getState()).toMatchObject({ state: 'READY', error: null, conversationId: 'conv-2' });
    // Nothing new to restore, so what the visitor already saw stays on screen.
    expect(turnSummary(store).map((t) => t.text)).toEqual([
      'Do you work weekends?',
      'Yes, Saturdays 9 to 1.',
      'Are you open now?',
      'Welcome back!',
    ]);
  });

  it('does not loop when the fresh session is rejected too', async () => {
    const { store, http, controller } = await ready();
    http.on(SESSION, session('tok-2'));
    http.on(MESSAGES, apiError(401, 'invalid_session'), apiError(401, 'invalid_session'));
    await controller.send('hello');
    expect(http.calls.map((c) => c.path)).toEqual([SESSION, MESSAGES, SESSION, MESSAGES]);
    expect(store.getState()).toMatchObject({ state: 'ERROR', error: { code: 'invalid_session', recoverable: true } });
  });

  it('creates the session together with the first message when opening failed', async () => {
    const { store, http, controller } = setup();
    http.on(SESSION, offline(), session('tok-1', { id: 'conv-1', messages: HISTORY }));
    http.on(MESSAGES, sse(reply('turn-1', 'Yes, we are!')));
    await controller.open();
    expect(store.getState().state).toBe('ERROR');

    await controller.send('Are you open today?');

    expect(http.calls.map((c) => c.path)).toEqual([SESSION, SESSION, MESSAGES]);
    expect(http.calls[2]?.body.sessionToken).toBe('tok-1');
    expect(store.getState().state).toBe('READY');
    expect(turnSummary(store).map((t) => t.text)).toEqual([
      'Do you work weekends?',
      'Yes, Saturdays 9 to 1.',
      'Are you open today?',
      'Yes, we are!',
    ]);
  });

  it('ignores new messages while a reply is in flight', async () => {
    const { store, http, controller } = await ready();
    const live = liveSse();
    http.on(MESSAGES, live.handler);

    const first = controller.send('one');
    await controller.send('two');
    await vi.waitFor(() => {
      expect(http.calls).toHaveLength(2);
    });
    expect(store.getState().turns.filter((t) => t.role === 'user').map((t) => t.text)).toEqual(['one']);

    live.push(...reply('turn-1', 'Got it.'));
    live.close();
    await first;
    expect(store.getState().state).toBe('READY');
    expect(http.calls).toHaveLength(2);
  });

  it('ignores empty and over-long messages', async () => {
    const { store, http, controller } = await ready();
    await controller.send('   ');
    await controller.send('x'.repeat(2001));
    expect(http.calls).toHaveLength(1);
    expect(store.getState().turns).toEqual([]);
  });
});

// ── reset, cancel, dispose ──────────────────────────────────────────────────

describe('ChatController.reset', () => {
  it('closes the conversation, clears the turns and stores the new token', async () => {
    const { store, http, storage, controller } = setup();
    http.on(SESSION, session('tok-1', { id: 'conv-1', messages: HISTORY }));
    http.on(RESET, () => json({ ok: true, sessionToken: 'tok-2' }));
    await controller.open();
    const states = recordStates(store);

    await controller.reset();

    expect(http.calls[1]).toMatchObject({ path: RESET, body: { widgetKey: WIDGET_KEY, sessionToken: 'tok-1' } });
    expect(states).toEqual(['OPENING', 'READY']);
    // The agent stays, so the greeting is shown again for the empty conversation.
    expect(store.getState()).toMatchObject({ turns: [], conversationId: null, agent: AGENT, lastUserText: null });
    expect(storage.get(STORAGE_KEY)).toBe('tok-2');
  });

  it('starts a fresh session when the old one has expired', async () => {
    const { store, http, storage, controller } = setup();
    http.on(SESSION, session('tok-1', { id: 'conv-1', messages: HISTORY }), session('tok-3'));
    http.on(RESET, apiError(401, 'invalid_session'));
    await controller.open();

    await controller.reset();

    expect(http.calls.map((c) => [c.path, c.body.sessionToken])).toEqual([
      [SESSION, undefined],
      [RESET, 'tok-1'],
      [SESSION, undefined],
    ]);
    expect(store.getState()).toMatchObject({ state: 'READY', turns: [], conversationId: null });
    expect(storage.get(STORAGE_KEY)).toBe('tok-3');
  });

  it('keeps the conversation when the reset fails, and retry() repeats the reset (not an undelivered message)', async () => {
    const { store, http, controller } = setup();
    http.on(SESSION, session('tok-1', { id: 'conv-1', messages: HISTORY }));
    http.on(MESSAGES, offline());
    http.on(RESET, offline(), () => json({ ok: true, sessionToken: 'tok-2' }));
    await controller.open();
    await controller.send('Are you open?');
    expect(store.getState()).toMatchObject({ state: 'ERROR', failedAction: 'send' });

    await controller.reset();
    // The UI offers Retry in the banner (failedAction 'reset'), not next to the still-undelivered message.
    expect(store.getState()).toMatchObject({ state: 'ERROR', failedAction: 'reset', conversationId: 'conv-1' });
    expect(turnSummary(store).map((t) => [t.text, t.failed])).toEqual([
      ['Do you work weekends?', false],
      ['Yes, Saturdays 9 to 1.', false],
      ['Are you open?', true],
    ]);

    await controller.retry();
    expect(http.calls.map((c) => c.path)).toEqual([SESSION, MESSAGES, RESET, RESET]);
    expect(store.getState()).toMatchObject({ state: 'READY', turns: [], error: null, failedAction: null });
  });
});

describe('ChatController.cancel and dispose', () => {
  it('cancel() stops waiting, keeps the partial reply and frees the composer at once', async () => {
    const { store, http, controller } = setup();
    http.on(SESSION, session('tok-1'));
    await controller.open();
    const live = liveSse();
    http.on(MESSAGES, live.handler, sse(reply('turn-2', 'Sure.')));

    const sending = controller.send('Tell me about pricing');
    await vi.waitFor(() => {
      expect(http.calls).toHaveLength(2);
    });
    live.push(
      { type: 'turn.start', turnId: 'turn-1', conversationId: 'conv-1' },
      { type: 'text.delta', turnId: 'turn-1', delta: 'Our pricing' },
    );
    await vi.waitFor(() => {
      expect(store.getState().state).toBe('SPEAKING');
    });

    controller.cancel();
    expect(store.getState().state).toBe('READY');
    expect(http.calls[1]?.signal.aborted).toBe(true);
    await sending;

    expect(store.getState()).toMatchObject({ state: 'READY', error: null, activeTurnId: null });
    expect(turnSummary(store)).toEqual([
      { role: 'user', text: 'Tell me about pricing', failed: false, streaming: false },
      { role: 'assistant', text: 'Our pricing', failed: false, streaming: false },
    ]);

    await controller.send('And weekends?');
    expect(store.getState().state).toBe('READY');
    expect(turnSummary(store).map((t) => t.text)).toEqual(['Tell me about pricing', 'Our pricing', 'And weekends?', 'Sure.']);
  });

  it('cancel() before the reply starts drops nothing but the wait', async () => {
    const { store, http, controller } = setup();
    http.on(SESSION, session('tok-1'));
    await controller.open();
    const live = liveSse();
    http.on(MESSAGES, live.handler);

    const sending = controller.send('Hello?');
    await vi.waitFor(() => {
      expect(http.calls).toHaveLength(2);
    });
    live.push({ type: 'turn.start', turnId: 'turn-1', conversationId: 'conv-1' });
    await vi.waitFor(() => {
      expect(store.getState().turns).toHaveLength(2);
    });
    controller.cancel();
    await sending;
    // The empty assistant bubble is removed; the visitor message stays (the server still answers and persists it).
    expect(turnSummary(store)).toEqual([{ role: 'user', text: 'Hello?', failed: false, streaming: false }]);
    expect(store.getState().state).toBe('READY');
  });

  it('times out a silent stream and leaves no timers behind', async () => {
    vi.useFakeTimers();
    const { store, http, controller } = setup();
    http.on(SESSION, session('tok-1'));
    await controller.open();
    expect(vi.getTimerCount()).toBe(0);

    const live = liveSse();
    http.on(MESSAGES, live.handler);
    const sending = controller.send('Anyone there?');
    await vi.advanceTimersByTimeAsync(10);
    live.push({ type: 'turn.start', turnId: 'turn-1', conversationId: 'conv-1' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.getState().state).toBe('THINKING');

    await vi.advanceTimersByTimeAsync(31_000);
    await sending;

    expect(http.calls[1]?.signal.aborted).toBe(true);
    expect(store.getState().state).toBe('ERROR');
    expect(store.getState().error).toMatchObject({ code: 'network', recoverable: true });
    expect(store.getState().error?.message).toContain('taking too long');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('dispose() aborts an in-flight reply and clears its timer', async () => {
    vi.useFakeTimers();
    const { store, http, controller } = setup();
    http.on(SESSION, session('tok-1'));
    await controller.open();
    const live = liveSse();
    http.on(MESSAGES, live.handler);

    const sending = controller.send('Hello?');
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.getTimerCount()).toBe(1);

    controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(http.calls[1]?.signal.aborted).toBe(true);
    await sending;
    expect(store.getState()).toMatchObject({ state: 'READY', error: null });
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ── token storage ────────────────────────────────────────────────────────────

describe('session token storage', () => {
  it('keeps working when browser storage throws (token kept in memory)', async () => {
    const { store, http, controller } = setup(blockedStorage);
    http.on(SESSION, session('tok-1'));
    http.on(MESSAGES, sse(reply('turn-1', 'Hi!')));
    http.on(RESET, () => json({ ok: true, sessionToken: 'tok-2' }));

    await controller.open();
    await controller.send('Hello');
    await controller.reset();

    expect(http.calls.map((c) => [c.path, c.body.sessionToken])).toEqual([
      [SESSION, undefined],
      [MESSAGES, 'tok-1'],
      [RESET, 'tok-1'],
    ]);
    expect(store.getState()).toMatchObject({ state: 'READY', error: null });
  });

  it('only ever stores the opaque session token, under a per-widget key', async () => {
    const writes: [string, string][] = [];
    const storage: TokenStorage = { get: () => null, set: (key, value) => void writes.push([key, value]), remove: () => undefined };
    const { http, controller } = setup(storage);
    http.on(SESSION, session('tok-1'));
    http.on(MESSAGES, sse(reply('turn-1', 'Hi Jane, we will call 555-0100.')));
    await controller.open();
    await controller.send('I am Jane, call me at 555-0100');
    expect(writes).toEqual([[`syncore:widget:${WIDGET_KEY}`, 'tok-1']]);
  });

  it("keeps tokens per widget key, so one business's session is never sent to another's widget", async () => {
    const storage = memoryStorage();
    const otherKey = 'wk_OtherTenantWidget0123456789abcd';
    const first = setup(storage);
    first.http.on(SESSION, session('tok-tenant-a'));
    await first.controller.open();

    const store = createChatStore();
    const http = scriptedFetch();
    http.on(SESSION, session('tok-tenant-b'));
    await new ChatController({ widgetKey: otherKey, store, fetchImpl: http.fetchImpl, storage }).open();

    expect(http.calls[0]?.body).toEqual({ widgetKey: otherKey });
    expect(storage.get(STORAGE_KEY)).toBe('tok-tenant-a');
    expect(storage.get(sessionStorageKey(otherKey))).toBe('tok-tenant-b');
  });

  it('calls same-origin relative URLs by default and the configured base URL otherwise', async () => {
    const store = createChatStore();
    const http = scriptedFetch();
    http.on('https://app.example.com/api/widget/session', session('tok-1'));
    const controller = new ChatController({
      widgetKey: WIDGET_KEY,
      store,
      fetchImpl: http.fetchImpl,
      storage: memoryStorage(),
      baseUrl: 'https://app.example.com',
    });
    await controller.open();
    expect(store.getState().state).toBe('READY');

    const local = setup();
    local.http.on(SESSION, session('tok-1'));
    await local.controller.open();
    expect(local.http.calls.map((c) => c.path)).toEqual(['/api/widget/session']);
  });

  it('browserTokenStorage falls back to memory without window.localStorage', () => {
    const storage = browserTokenStorage();
    expect(storage.get('k')).toBeNull();
    storage.set('k', 'v');
    expect(storage.get('k')).toBe('v');
    storage.remove('k');
    expect(storage.get('k')).toBeNull();
  });

  it('browserTokenStorage survives blocked or failing localStorage', () => {
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new DOMException('Access is denied for this document.', 'SecurityError');
      },
    });
    const blocked = browserTokenStorage();
    blocked.set('k', 'v');
    expect(blocked.get('k')).toBe('v');

    const saved = new Map<string, string>([['k', 'from-disk']]);
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => saved.get(key) ?? null,
        setItem: () => {
          throw new DOMException('Quota exceeded', 'QuotaExceededError');
        },
        removeItem: (key: string) => saved.delete(key),
      },
    });
    const full = browserTokenStorage();
    expect(full.get('k')).toBe('from-disk');
    full.set('k', 'newer');
    expect(full.get('k')).toBe('newer');
    full.remove('k');
    expect(full.get('k')).toBeNull();
  });
});
