import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { createOpenAIClient, OpenAITextProvider } from '@/server/ai/openai/text-provider';
import {
  ProviderError,
  type ModelToolDefinition,
  type TextGenerationRequest,
  type TextStreamEvent,
} from '@/server/ai/types';

// ---------------------------------------------------------------------------
// Stubbed transport: a real SDK client whose fetch replays recorded SSE frames.
// ---------------------------------------------------------------------------

type Reply = Response | ((signal: AbortSignal | undefined) => Response | Promise<Response>);

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

function fakeClient(...replies: Reply[]) {
  const requests: CapturedRequest[] = [];
  const client = new OpenAI({
    apiKey: 'sk-test',
    maxRetries: 0,
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const raw = typeof init?.body === 'string' ? init.body : '{}';
      requests.push({ url, body: JSON.parse(raw) as Record<string, unknown> });
      const reply = replies[requests.length - 1];
      if (!reply) throw new Error(`Unexpected request #${requests.length}`);
      return typeof reply === 'function' ? reply(init?.signal ?? undefined) : reply;
    },
  });
  return { client, requests };
}

const encoder = new TextEncoder();
const frame = (event: { type: string }) => encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
const SSE_HEADERS = { 'content-type': 'text/event-stream', 'x-request-id': 'req_stream' };

/** An SSE response replaying `events`; `keepOpen` never ends the body (a stalled stream). */
function sse(events: Array<{ type: string }>, options: { keepOpen?: boolean } = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(frame(event));
      if (!options.keepOpen) controller.close();
    },
  });
  return new Response(body, { status: 200, headers: SSE_HEADERS });
}

/** An SSE response the test feeds event by event. */
function liveSse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body, { status: 200, headers: SSE_HEADERS }),
    send: (event: { type: string }) => controller.enqueue(frame(event)),
    /** Breaks the body like a dropped connection. */
    fail: (error: Error) => controller.error(error),
    close: () => controller.close(),
  };
}

function jsonError(status: number, code: string): Response {
  const error = { message: 'You sent: When are you open?', type: 'invalid_request_error', code, param: null };
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_err' },
  });
}

/** Fetch that never answers until the request is aborted. */
const neverAnswers: Reply = (signal) =>
  new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener('abort', () => {
      reject(new DOMException('This operation was aborted', 'AbortError'));
    });
  });

// ---------------------------------------------------------------------------
// Recorded Responses API payloads
// ---------------------------------------------------------------------------

const USAGE = {
  input_tokens: 120,
  input_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 },
  output_tokens: 30,
  output_tokens_details: { reasoning_tokens: 7 },
  total_tokens: 150,
};

function responseBody(output: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: 'resp_1',
    object: 'response',
    created_at: 1_760_000_000,
    status: 'completed',
    model: 'test-model-2026-10-01',
    output,
    usage: USAGE,
    error: null,
    incomplete_details: null,
    ...extra,
  };
}

const CREATED = { type: 'response.created', sequence_number: 0, response: responseBody([], { status: 'in_progress', usage: null }) };

const textDelta = (delta: string) => ({
  type: 'response.output_text.delta',
  item_id: 'msg_1',
  output_index: 0,
  content_index: 0,
  delta,
  logprobs: [],
  sequence_number: 1,
});

const completed = (output: unknown[], extra: Record<string, unknown> = {}) => ({
  type: 'response.completed',
  sequence_number: 9,
  response: responseBody(output, extra),
});

const incomplete = (output: unknown[], reason: string) => ({
  type: 'response.incomplete',
  sequence_number: 9,
  response: responseBody(output, { status: 'incomplete', incomplete_details: { reason } }),
});

const messageItem = (text: string) => ({
  type: 'message',
  id: 'msg_1',
  role: 'assistant',
  status: 'completed',
  phase: 'final_answer',
  content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
});

const REASONING_ITEM = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAA-encrypted', status: 'completed' };

const CALL_ITEM = {
  type: 'function_call',
  id: 'fc_1',
  call_id: 'call_1',
  name: 'searchKnowledge',
  arguments: '{"query":"opening hours"}',
  status: 'completed',
};

const SEARCH_TOOL: ModelToolDefinition = {
  name: 'searchKnowledge',
  description: 'Search the business knowledge base.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  },
};

const request = (overrides: Partial<TextGenerationRequest> = {}): TextGenerationRequest => ({
  model: 'test-model',
  instructions: 'You are a concise receptionist.',
  input: [{ type: 'message', role: 'user', content: 'When are you open?' }],
  tools: [],
  ...overrides,
});

async function collect(stream: AsyncIterable<TextStreamEvent>): Promise<TextStreamEvent[]> {
  const events: TextStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function completedResult(events: TextStreamEvent[]) {
  const last = events.at(-1);
  if (last?.type !== 'completed') throw new Error('stream did not complete');
  return last.result;
}

// ---------------------------------------------------------------------------

describe('OpenAITextProvider request', () => {
  it('sends a stateless, streamed Responses API request with tools and caching hints', async () => {
    const { client, requests } = fakeClient(sse([CREATED, completed([messageItem('Hi')])]));
    const provider = new OpenAITextProvider({ client, timeoutMs: 5_000 });

    await provider.generate(
      request({
        tools: [SEARCH_TOOL],
        reasoningEffort: 'low',
        maxOutputTokens: 300,
        cacheKey: 'agent-cache-key',
        endUserId: 'v'.repeat(80),
      }),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toMatch(/\/responses$/);
    // Exact equality: no temperature/top_p, no previous_response_id, nothing unexpected.
    expect(requests[0]!.body).toEqual({
      model: 'test-model',
      instructions: 'You are a concise receptionist.',
      input: [{ role: 'user', content: 'When are you open?' }],
      tools: [
        {
          type: 'function',
          name: 'searchKnowledge',
          description: 'Search the business knowledge base.',
          parameters: SEARCH_TOOL.parameters,
          strict: false,
        },
      ],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      reasoning: { effort: 'low' },
      include: ['reasoning.encrypted_content'],
      max_output_tokens: 300,
      prompt_cache_key: 'agent-cache-key',
      safety_identifier: 'v'.repeat(64),
      store: false,
      stream: true,
      stream_options: { include_obfuscation: false },
    });
  });

  it('omits tool fields and unset options entirely', async () => {
    const { client, requests } = fakeClient(sse([CREATED, completed([messageItem('Hi')])]));
    await new OpenAITextProvider({ client, timeoutMs: 5_000 }).generate(request({ toolChoice: 'none' }));
    expect(requests[0]!.body).toEqual({
      model: 'test-model',
      instructions: 'You are a concise receptionist.',
      input: [{ role: 'user', content: 'When are you open?' }],
      store: false,
      stream: true,
      stream_options: { include_obfuscation: false },
    });
  });

  it('passes an explicit tool choice when tools are offered', async () => {
    const { client, requests } = fakeClient(sse([CREATED, completed([messageItem('Hi')])]));
    await new OpenAITextProvider({ client, timeoutMs: 5_000 }).generate(request({ tools: [SEARCH_TOOL], toolChoice: 'none' }));
    expect(requests[0]!.body).toMatchObject({ tool_choice: 'none', parallel_tool_calls: false });
  });

  it("replays this provider's raw items and maps everything else neutrally", async () => {
    const { client, requests } = fakeClient(sse([CREATED, completed([messageItem('Done')])]));
    await new OpenAITextProvider({ client, timeoutMs: 5_000 }).generate(
      request({
        input: [
          { type: 'message', role: 'user', content: 'Do you fix boilers?' },
          { type: 'message', role: 'assistant', content: 'Yes, we do.' },
          { type: 'provider_state', provider: 'openai', model: 'test-model', payload: REASONING_ITEM },
          {
            type: 'tool_call',
            call: { callId: 'call_1', name: 'searchKnowledge', arguments: '{"query":"boilers"}' },
            providerState: { provider: 'openai', model: 'test-model', payload: CALL_ITEM },
          },
          { type: 'tool_result', callId: 'call_1', output: '{"ok":true,"results":[]}' },
          { type: 'provider_state', provider: 'other', model: 'test-model', payload: { opaque: 'foreign reasoning' } },
          {
            type: 'tool_call',
            call: { callId: 'call_2', name: 'getBusinessHours', arguments: '{}' },
            providerState: { provider: 'other', model: 'test-model', payload: { foreign: true } },
          },
          { type: 'tool_result', callId: 'call_2', output: '{"ok":true}' },
          {
            type: 'message',
            role: 'assistant',
            content: 'Neutral copy',
            providerState: { provider: 'openai', model: 'test-model', payload: messageItem('Raw copy') },
          },
          { type: 'message', role: 'user', content: 'Thanks' },
        ],
      }),
    );

    expect(requests[0]!.body.input).toEqual([
      { role: 'user', content: 'Do you fix boilers?' },
      // Replies from earlier turns are labelled as final answers, as the API asks for replayed assistant messages.
      { role: 'assistant', content: 'Yes, we do.', phase: 'final_answer' },
      REASONING_ITEM,
      CALL_ITEM,
      { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true,"results":[]}' },
      { type: 'function_call', call_id: 'call_2', name: 'getBusinessHours', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_2', output: '{"ok":true}' },
      messageItem('Raw copy'),
      { role: 'user', content: 'Thanks' },
    ]);
  });

  it('does not replay raw items produced by a different model (mid-turn escalation)', async () => {
    const { client, requests } = fakeClient(sse([CREATED, completed([messageItem('Done')])]));
    await new OpenAITextProvider({ client, timeoutMs: 5_000 }).generate(
      request({
        model: 'stronger-model',
        input: [
          { type: 'message', role: 'user', content: 'Do you fix boilers?' },
          { type: 'provider_state', provider: 'openai', model: 'test-model', payload: REASONING_ITEM },
          {
            type: 'tool_call',
            call: { callId: 'call_1', name: 'searchKnowledge', arguments: '{"query":"boilers"}' },
            providerState: { provider: 'openai', model: 'test-model', payload: CALL_ITEM },
          },
          { type: 'tool_result', callId: 'call_1', output: '{"ok":true}' },
        ],
      }),
    );
    // The cheaper model's encrypted reasoning is dropped; the call/result pair is sent neutrally.
    expect(requests[0]!.body.input).toEqual([
      { role: 'user', content: 'Do you fix boilers?' },
      { type: 'function_call', call_id: 'call_1', name: 'searchKnowledge', arguments: '{"query":"boilers"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' },
    ]);
  });

  it('treats state from the same SDK under another provider id as foreign', async () => {
    const { client, requests } = fakeClient(sse([CREATED, completed([messageItem('Done')])]));
    await new OpenAITextProvider({ client, timeoutMs: 5_000, id: 'openai-eu' }).generate(
      request({
        input: [
          { type: 'message', role: 'user', content: 'Hi' },
          { type: 'provider_state', provider: 'openai', model: 'test-model', payload: REASONING_ITEM },
        ],
      }),
    );
    expect(requests[0]!.body.input).toEqual([{ role: 'user', content: 'Hi' }]);
  });
});

describe('OpenAITextProvider streaming results', () => {
  it('yields text deltas as they arrive, then exactly one completed event', async () => {
    const live = liveSse();
    const { client } = fakeClient(live.response);
    const stream = new OpenAITextProvider({ client, timeoutMs: 5_000 }).stream(request());

    live.send(CREATED);
    live.send(textDelta('Hel'));
    // The first delta is delivered while the provider is still generating.
    await expect(stream.next()).resolves.toEqual({ done: false, value: { type: 'text.delta', delta: 'Hel' } });

    live.send(textDelta('lo!'));
    live.send(completed([messageItem('Hello!')]));
    live.close();
    const rest = await collect(stream);
    expect(rest.map((event) => event.type)).toEqual(['text.delta', 'completed']);
    expect(completedResult(rest).text).toBe('Hello!');
  });

  it('returns text, provider-reported model, usage and replayable output items', async () => {
    const { client } = fakeClient(sse([CREATED, textDelta('Hello'), textDelta(' there'), completed([messageItem('Hello there')])]));
    const events = await collect(new OpenAITextProvider({ client, timeoutMs: 5_000 }).stream(request()));

    expect(events.slice(0, 2)).toEqual([
      { type: 'text.delta', delta: 'Hello' },
      { type: 'text.delta', delta: ' there' },
    ]);
    expect(events.filter((event) => event.type === 'completed')).toHaveLength(1);
    expect(completedResult(events)).toEqual({
      provider: 'openai',
      model: 'test-model-2026-10-01',
      text: 'Hello there',
      toolCalls: [],
      outputItems: [
        {
          type: 'message',
          role: 'assistant',
          content: 'Hello there',
          providerState: { provider: 'openai', model: 'test-model', payload: messageItem('Hello there') },
        },
      ],
      finishReason: 'stop',
      usage: { inputTokens: 120, cachedInputTokens: 40, cacheWriteTokens: 10, outputTokens: 30, reasoningTokens: 7 },
      durationMs: expect.any(Number) as number,
    });
  });

  it('extracts complete tool calls and keeps reasoning as provider state', async () => {
    const truncatedCall = { ...CALL_ITEM, id: 'fc_2', call_id: 'call_2', arguments: '{"que', status: 'incomplete' };
    const { client } = fakeClient(sse([CREATED, completed([REASONING_ITEM, CALL_ITEM, truncatedCall])]));
    const result = await new OpenAITextProvider({ client, timeoutMs: 5_000 }).generate(request({ tools: [SEARCH_TOOL] }));

    const call = { callId: 'call_1', name: 'searchKnowledge', arguments: '{"query":"opening hours"}' };
    expect(result.toolCalls).toEqual([call]);
    expect(result.finishReason).toBe('tool_calls');
    expect(result.text).toBe('');
    expect(result.outputItems).toEqual([
      { type: 'provider_state', provider: 'openai', model: 'test-model', payload: REASONING_ITEM },
      { type: 'tool_call', call, providerState: { provider: 'openai', model: 'test-model', payload: CALL_ITEM } },
    ]);
  });

  it('continues a tool loop by replaying the output items verbatim', async () => {
    const { client, requests } = fakeClient(
      sse([CREATED, completed([REASONING_ITEM, CALL_ITEM])]),
      sse([CREATED, textDelta('We open at 8am.'), completed([messageItem('We open at 8am.')])]),
    );
    const provider = new OpenAITextProvider({ client, timeoutMs: 5_000 });
    const first = await provider.generate(request({ tools: [SEARCH_TOOL] }));
    const second = await provider.generate(
      request({
        tools: [SEARCH_TOOL],
        input: [
          ...request().input,
          ...first.outputItems,
          { type: 'tool_result', callId: 'call_1', output: '{"ok":true,"results":[{"content":"8am-6pm"}]}' },
        ],
      }),
    );

    expect(requests[1]!.body.input).toEqual([
      { role: 'user', content: 'When are you open?' },
      REASONING_ITEM,
      CALL_ITEM,
      { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true,"results":[{"content":"8am-6pm"}]}' },
    ]);
    expect(second).toMatchObject({ text: 'We open at 8am.', finishReason: 'stop', toolCalls: [] });
  });

  it('counts missing usage and missing usage details as zero', async () => {
    const { client } = fakeClient(
      sse([CREATED, completed([messageItem('a')], { usage: null })]),
      sse([CREATED, completed([messageItem('b')], { usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 } })]),
    );
    const provider = new OpenAITextProvider({ client, timeoutMs: 5_000 });
    expect((await provider.generate(request())).usage).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    });
    expect((await provider.generate(request())).usage).toEqual({
      inputTokens: 9,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 3,
      reasoningTokens: 0,
    });
  });

  it('streams a refusal as reply text so the visitor never gets an empty answer', async () => {
    const refusal = "I can't help with that.";
    const refusalDelta = { type: 'response.refusal.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: refusal, sequence_number: 1 };
    const refusalItem = { ...messageItem(''), content: [{ type: 'refusal', refusal }] };
    const { client } = fakeClient(sse([CREATED, refusalDelta, completed([refusalItem])]));
    const events = await collect(new OpenAITextProvider({ client, timeoutMs: 5_000 }).stream(request()));

    expect(events[0]).toEqual({ type: 'text.delta', delta: refusal });
    expect(completedResult(events)).toMatchObject({
      text: refusal,
      finishReason: 'stop',
      outputItems: [{ type: 'message', role: 'assistant', content: refusal }],
    });
  });

  it('maps incomplete responses to length / content_filter finish reasons', async () => {
    const { client } = fakeClient(
      sse([CREATED, textDelta('We are open from'), incomplete([messageItem('We are open from')], 'max_output_tokens')]),
      sse([CREATED, incomplete([], 'content_filter')]),
    );
    const provider = new OpenAITextProvider({ client, timeoutMs: 5_000 });
    expect(await provider.generate(request())).toMatchObject({ finishReason: 'length', text: 'We are open from' });
    expect(await provider.generate(request())).toMatchObject({ finishReason: 'content_filter', text: '' });
  });
});

describe('OpenAITextProvider failures', () => {
  it('throws a retryable ProviderError for response.failed, after the deltas already sent', async () => {
    const failed = {
      type: 'response.failed',
      sequence_number: 3,
      response: responseBody([], { status: 'failed', error: { code: 'server_error', message: 'Internal failure' } }),
    };
    const { client } = fakeClient(sse([CREATED, textDelta('Partial'), failed]));
    const received: TextStreamEvent[] = [];
    const run = async () => {
      for await (const event of new OpenAITextProvider({ client, timeoutMs: 5_000 }).stream(request())) received.push(event);
    };
    await expect(run()).rejects.toMatchObject({ name: 'ProviderError', code: 'unavailable', retryable: true });
    expect(received).toEqual([{ type: 'text.delta', delta: 'Partial' }]);
  });

  it('reports a response blocked by content policy as a non-retryable content_filter', async () => {
    const failed = {
      type: 'response.failed',
      sequence_number: 2,
      response: responseBody([], { status: 'failed', error: { code: 'invalid_prompt', message: 'Flagged: When are you open?' } }),
    };
    const { client } = fakeClient(sse([CREATED, failed]));
    const error = await new OpenAITextProvider({ client, timeoutMs: 5_000 })
      .generate(request())
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'content_filter', retryable: false, message: 'openai: response blocked by content policy (invalid_prompt)' });
  });

  it('maps a connection dropped after the stream opened to a retryable unavailability', async () => {
    const live = liveSse();
    const { client } = fakeClient(live.response);
    const stream = new OpenAITextProvider({ client, timeoutMs: 5_000 }).stream(request());
    live.send(CREATED);
    live.send(textDelta('Hel'));
    await expect(stream.next()).resolves.toMatchObject({ value: { type: 'text.delta', delta: 'Hel' } });

    live.fail(new TypeError('terminated'));
    const error = await collect(stream).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: 'unavailable', retryable: true, message: 'openai: response stream was interrupted' });
    expect((error as ProviderError).cause).toBeInstanceOf(TypeError);
  });

  it('maps a malformed stream event to a retryable unavailability', async () => {
    const { client } = fakeClient(new Response('event: response.created\ndata: {not json\n\n', { status: 200, headers: SSE_HEADERS }));
    await expect(new OpenAITextProvider({ client, timeoutMs: 5_000 }).generate(request())).rejects.toMatchObject({
      code: 'unavailable',
      retryable: true,
      message: 'openai: response stream was interrupted',
    });
  });

  it('maps an SSE error event to a retryable ProviderError', async () => {
    const errorEvent = { type: 'error', code: 'server_error', message: 'stream broke', param: null, sequence_number: 1 };
    const { client } = fakeClient(sse([CREATED, errorEvent]));
    const failure = collect(new OpenAITextProvider({ client, timeoutMs: 5_000 }).stream(request()));
    await expect(failure).rejects.toBeInstanceOf(ProviderError);
    await expect(failure).rejects.toMatchObject({ code: 'unavailable', retryable: true });
  });

  it('fails when the stream ends without a terminal event', async () => {
    const { client } = fakeClient(sse([CREATED, textDelta('Hel')]));
    await expect(new OpenAITextProvider({ client, timeoutMs: 5_000 }).generate(request())).rejects.toMatchObject({
      code: 'unavailable',
      retryable: true,
      message: 'openai: response stream ended before completion',
    });
  });

  it.each([
    [429, 'rate_limit_exceeded', 'rate_limited', true],
    [429, 'insufficient_quota', 'rate_limited', false],
    [401, 'invalid_api_key', 'auth', false],
    [500, 'server_error', 'unavailable', true],
    [400, 'invalid_value', 'invalid_request', false],
  ] as const)('maps HTTP %i (%s) to %s', async (status, code, expected, retryable) => {
    const { client } = fakeClient(jsonError(status, code));
    const error = await new OpenAITextProvider({ client, timeoutMs: 5_000 })
      .generate(request())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ provider: 'openai', code: expected, retryable, status });
    // Provider messages can echo the request; ours never do.
    expect((error as ProviderError).message).not.toContain('When are you open?');
  });

  it('reports a caller abort mid-stream as aborted', async () => {
    const live = liveSse();
    const { client } = fakeClient(live.response);
    const caller = new AbortController();
    const stream = new OpenAITextProvider({ client, timeoutMs: 5_000 }).stream(request({ signal: caller.signal }));
    live.send(CREATED);
    live.send(textDelta('Hel'));
    await expect(stream.next()).resolves.toMatchObject({ value: { type: 'text.delta' } });

    caller.abort();
    await expect(collect(stream)).rejects.toMatchObject({ code: 'aborted', retryable: false });
  });

  it('does not call the API when the caller already aborted', async () => {
    const { client, requests } = fakeClient(sse([CREATED]));
    const failure = new OpenAITextProvider({ client, timeoutMs: 5_000 }).generate(request({ signal: AbortSignal.abort() }));
    await expect(failure).rejects.toMatchObject({ code: 'aborted', retryable: false });
    expect(requests).toHaveLength(0);
  });

  it('times out a stalled stream with a retryable timeout', async () => {
    const { client } = fakeClient(sse([CREATED, textDelta('Hel')], { keepOpen: true }));
    await expect(new OpenAITextProvider({ client, timeoutMs: 100 }).generate(request())).rejects.toMatchObject({
      code: 'timeout',
      retryable: true,
    });
  });

  it('times out when no response headers arrive', async () => {
    const { client } = fakeClient(neverAnswers);
    await expect(new OpenAITextProvider({ client, timeoutMs: 100 }).generate(request())).rejects.toMatchObject({
      code: 'timeout',
      retryable: true,
    });
  });
});

describe('OpenAITextProvider construction', () => {
  it('requires an API key or a client', () => {
    expect(() => new OpenAITextProvider({ timeoutMs: 1_000 })).toThrow('OpenAI provider requires an apiKey or a client');
    expect(new OpenAITextProvider({ apiKey: 'sk-test', timeoutMs: 1_000 }).id).toBe('openai');
  });

  it('builds the SDK client with the request timeout and two retries unless one is injected', () => {
    const client = createOpenAIClient({ apiKey: 'sk-test', timeoutMs: 12_345 });
    expect(client.timeout).toBe(12_345);
    expect(client.maxRetries).toBe(2);
    expect(createOpenAIClient({ apiKey: 'sk-test', timeoutMs: 1_000, maxRetries: 0 }).maxRetries).toBe(0);
    expect(createOpenAIClient({ client, timeoutMs: 1_000 })).toBe(client);
  });
});
