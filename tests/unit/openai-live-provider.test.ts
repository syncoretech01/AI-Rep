import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import {
  BROWSER_CLIENT_EVENTS,
  BROWSER_SERVER_EVENTS,
  LiveSideband,
  OpenAILiveProvider,
  commentaryChunks,
  toSessionConfig,
  type SidebandSocket,
} from '@/server/ai/openai/live-provider';
import { ProviderError, type ModelToolDefinition } from '@/server/ai/types';
import type { VoiceEvent, VoiceSessionRequest } from '@/server/ai/voice-types';

/**
 * The GPT-Live adapter against recorded wire shapes (docs verified 2026-11-26). These are contract tests of OUR
 * translation layer with a stubbed transport; they say nothing about live voice quality or provider behaviour.
 */

const TOOL: ModelToolDefinition = {
  name: 'getBusinessHours',
  description: 'Opening hours of the business.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};

function request(overrides: Partial<VoiceSessionRequest> = {}): VoiceSessionRequest {
  return {
    model: 'voice-model',
    voice: 'marin',
    instructions: 'Voice policy',
    delegation: { mode: 'responses', model: 'backend-model', instructions: 'Business rules', tools: [TOOL], reasoningEffort: 'low' },
    idleTimeoutSeconds: 20,
    sdpOffer: 'v=0 offer',
    correlationId: 'vs-1',
    ...overrides,
  };
}

class FakeSocket implements SidebandSocket {
  readyState = 1;
  readonly sent: Array<Record<string, unknown>> = [];
  closedWith: { code?: number; reason?: string } | null = null;
  private readonly listeners = new Map<string, Array<(event: { data?: unknown; code?: number }) => void>>();

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = 3;
  }

  addEventListener(type: string, listener: (event: { data?: unknown; code?: number }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  fire(type: string, event: { data?: unknown; code?: number } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  message(event: Record<string, unknown>): void {
    this.fire('message', { data: JSON.stringify(event) });
  }

  /** Sent events without their random event ids. */
  types(): unknown[] {
    return this.sent.map(({ event_id: _id, ...rest }) => rest);
  }
}

function sideband() {
  const socket = new FakeSocket();
  const band = new LiveSideband(socket, 'openai');
  const events: VoiceEvent[] = [];
  const disconnects: string[] = [];
  band.onEvent((event) => events.push(event));
  band.onDisconnect((reason) => disconnects.push(reason));
  return { socket, band, events, disconnects };
}

let eventCounter = 0;
const id = () => `evt_${String((eventCounter += 1))}`;

describe('toSessionConfig', () => {
  it('pins model, voice, instructions, Responses delegation with our tools, standby and a restricted data channel', () => {
    const config = toSessionConfig(request({ endUserId: 'user-123' }));
    expect(config).toMatchObject({
      model: 'voice-model',
      instructions: 'Voice policy',
      audio: { output: { voice: 'marin' } },
      delegation: {
        type: 'responses',
        responses: {
          model: 'backend-model',
          instructions: 'Business rules',
          tool_choice: 'auto',
          parallel_tool_calls: false,
          reasoning: { effort: 'low' },
          tools: [{ type: 'function', name: 'getBusinessHours', description: TOOL.description, parameters: TOOL.parameters, strict: false }],
        },
      },
      wake_policy: { type: 'speech' },
      idle_timeout_s: 20,
    });
    // The browser can hang up and mute, nothing else; it never sees tool, delegation or backend events.
    const channel = config.client?.data_channel;
    if (!channel) throw new Error('the browser data channel must be restricted');
    expect(channel.allowed_client_events).toEqual(['session.close', 'session.input_audio.mute', 'session.input_audio.unmute']);
    const allowed = channel.allowed_server_events;
    // Omitting the list would allow every event, so it must be explicit.
    if (!Array.isArray(allowed)) throw new Error('allowed_server_events must be an explicit list');
    const serverEvents = allowed.map((event) => event.type);
    expect(serverEvents).toEqual(BROWSER_SERVER_EVENTS);
    for (const type of serverEvents) expect(type).not.toMatch(/delegation|response\.|commentary|thinking|instructions/);
    expect(BROWSER_CLIENT_EVENTS).not.toContain('response.item.create');
    // The end user is identified to the provider only by a hash.
    expect(config.safety_identifier).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(config)).not.toContain('user-123');
  });

  it('configures client delegation without a backend model or tools, and omits the safety identifier when unknown', () => {
    const config = toSessionConfig(request({ delegation: { mode: 'client' } }));
    expect(config.delegation).toEqual({ type: 'client' });
    expect(config).not.toHaveProperty('safety_identifier');
  });
});

describe('OpenAILiveProvider', () => {
  it('creates the session from the WebRTC offer and returns the provider id and SDP answer', async () => {
    const bodies: unknown[] = [];
    const client = new OpenAI({
      apiKey: 'sk-test',
      maxRetries: 0,
      fetch: (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        bodies.push({ url, body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as unknown });
        return Promise.resolve(
          new Response(JSON.stringify({ session: { id: 'live_123', object: 'live.session' }, transport: { type: 'webrtc', sdp: 'v=0 answer' } }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    });
    const provider = new OpenAILiveProvider({ client, timeoutMs: 5_000 });
    await expect(provider.createSession(request())).resolves.toEqual({ providerSessionId: 'live_123', sdpAnswer: 'v=0 answer' });
    expect(bodies).toEqual([
      {
        url: expect.stringMatching(/\/v1\/live\/sessions$/) as unknown,
        body: expect.objectContaining({ transport: { type: 'webrtc', sdp: 'v=0 offer' }, session: expect.objectContaining({ model: 'voice-model' }) as unknown }) as unknown,
      },
    ]);
  });

  it('maps a provider rejection to a ProviderError', async () => {
    const client = new OpenAI({
      apiKey: 'sk-test',
      maxRetries: 0,
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'Invalid model', type: 'invalid_request_error', code: 'model_not_found' } }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    });
    const provider = new OpenAILiveProvider({ client, timeoutMs: 5_000 });
    await expect(provider.createSession(request())).rejects.toBeInstanceOf(ProviderError);
  });

  it('attaches the sideband with the server credential and resolves once the socket opens', async () => {
    const socket = new FakeSocket();
    socket.readyState = 0;
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const provider = new OpenAILiveProvider({
      apiKey: 'sk-server',
      timeoutMs: 5_000,
      createSocket: (url, headers) => {
        calls.push({ url, headers });
        return socket;
      },
    });
    const attached = provider.attach('live_123');
    socket.readyState = 1;
    socket.fire('open');
    await expect(attached).resolves.toBeInstanceOf(LiveSideband);
    expect(calls).toEqual([{ url: 'wss://api.openai.com/v1/live/sessions/live_123/attach', headers: { Authorization: 'Bearer sk-server' } }]);
  });

  it('rejects when the sideband cannot connect', async () => {
    const socket = new FakeSocket();
    socket.readyState = 0;
    const provider = new OpenAILiveProvider({ apiKey: 'sk-server', timeoutMs: 5_000, createSocket: () => socket });
    const attached = provider.attach('live_123');
    socket.fire('error');
    await expect(attached).rejects.toMatchObject({ name: 'ProviderError', code: 'unavailable' });
  });
});

describe('LiveSideband', () => {
  it('normalizes transcripts, usage, close and errors, and drops replayed and reflected events', () => {
    const { socket, events } = sideband();
    const started = { type: 'session.started', event_id: id(), session: {} };
    socket.message(started);
    socket.message(started); // Replayed on attach: same event_id.
    socket.message({ type: 'session.input_transcript.delta', event_id: id(), delta: 'Are you open', start_ms: 100, end_ms: 900 });
    socket.message({ type: 'session.output_transcript.delta', event_id: id(), delta: 'Yes.', start_ms: 1_200, end_ms: 1_600 });
    socket.message({ type: 'session.input_transcript.delta', delta: 'reflected, no event id' });
    socket.message({ type: 'session.usage.updated', event_id: id(), usage: { seconds: 30, active_seconds: 12, paused_seconds: 18 } });
    socket.message({ type: 'error', event_id: id(), error: { code: 'rate_limit', message: 'Slow down', type: 'error' } });
    socket.message({ type: 'error', event_id: id(), error: {} });
    socket.message({ type: 'session.closed', event_id: id(), reason: 'close_requested', usage: { seconds: 40 } });
    socket.fire('message', { data: 'not json' });

    expect(events).toEqual([
      { type: 'session.started' },
      { type: 'transcript.delta', role: 'user', text: 'Are you open', startMs: 100, endMs: 900 },
      { type: 'transcript.delta', role: 'assistant', text: 'Yes.', startMs: 1_200, endMs: 1_600 },
      { type: 'usage', activeSeconds: 12, standbySeconds: 18 },
      { type: 'error', code: 'rate_limit', message: 'Slow down', fatal: false },
      { type: 'error', code: 'unknown', message: '', fatal: false },
      { type: 'closed', reason: 'close_requested', usage: { activeSeconds: 40, standbySeconds: 0 } },
    ]);
  });

  it('surfaces each backend function call once and resumes the backend only after the last pending output', () => {
    const { socket, band, events } = sideband();
    const call = (callId: string) => ({
      type: 'response.event',
      event_id: id(),
      delegation_id: 'del_1',
      event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: callId, name: 'getBusinessHours', arguments: '{}' } },
    });
    socket.message(call('call_a'));
    socket.message(call('call_b'));
    expect(events).toEqual([
      { type: 'tool.call', callId: 'call_a', name: 'getBusinessHours', arguments: '{}' },
      { type: 'tool.call', callId: 'call_b', name: 'getBusinessHours', arguments: '{}' },
    ]);

    band.sendToolResult('call_a', '{"ok":true}');
    expect(socket.types()).toEqual([{ type: 'response.item.create', item: { type: 'function_call_output', call_id: 'call_a', output: '{"ok":true}' } }]);
    band.sendToolResult('call_b', '{"ok":true}');
    expect(socket.types().slice(1)).toEqual([
      { type: 'response.item.create', item: { type: 'function_call_output', call_id: 'call_b', output: '{"ok":true}' } },
      { type: 'response.create' },
    ]);
    // Every client event carries its own id.
    expect(new Set(socket.sent.map((event) => event.event_id)).size).toBe(3);
  });

  it('meters each backend response once, with the model when the provider names it', () => {
    const { socket, events } = sideband();
    const completed = (model?: string) => ({
      type: 'response.event',
      event_id: id(),
      delegation_id: 'del_1',
      event: {
        type: 'response.completed',
        response: { id: 'resp_1', ...(model && { model }), usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 100 }, output_tokens: 30 } },
      },
    });
    socket.message(completed('backend-model'));
    socket.message(completed('backend-model')); // Same response id under a new event id.
    expect(events).toEqual([
      {
        type: 'model.usage',
        model: 'backend-model',
        usage: { inputTokens: 120, cachedInputTokens: 100, cacheWriteTokens: 0, outputTokens: 30, reasoningTokens: 0 },
      },
    ]);
  });

  it('turns client delegations into delegated turns and ignores Responses-targeted ones', () => {
    const { socket, band, events } = sideband();
    socket.message({ type: 'session.delegation.created', event_id: id(), offset_ms: 2_000, delegation: { id: 'del_c', target: 'client' } });
    socket.message({ type: 'session.delegation.created', event_id: id(), offset_ms: 3_000, delegation: { id: 'del_r', target: 'responses' } });
    expect(events).toEqual([{ type: 'delegation.requested', delegationId: 'del_c', offsetMs: 2_000 }]);

    band.sendDelegatedReply('del_c', 'We are open until five.');
    expect(socket.types()).toEqual([{ type: 'session.commentary.append', content: 'We are open until five.', delegation_id: 'del_c' }]);
  });

  it('reports a dropped connection once, sends nothing on a closed socket, and closes the session on request', () => {
    const { socket, band, disconnects } = sideband();
    band.closeSession();
    expect(socket.types()).toEqual([{ type: 'session.close' }]);
    socket.fire('close', { code: 1006 });
    socket.fire('error');
    expect(disconnects).toEqual(['socket_closed:1006']);
    socket.readyState = 3;
    band.sendToolResult('call_x', '{}');
    expect(socket.sent).toHaveLength(1);
  });

  it('does not report its own disconnect as a drop', () => {
    const { socket, band, disconnects } = sideband();
    band.disconnect();
    socket.fire('close', { code: 1000 });
    expect(socket.closedWith).toEqual({ code: 1000, reason: 'done' });
    expect(disconnects).toEqual([]);
  });
});

describe('commentaryChunks', () => {
  it('keeps short replies whole and splits long ones at sentence boundaries within the limit', () => {
    expect(commentaryChunks('  Short reply.  ')).toEqual(['Short reply.']);
    const sentence = 'This sentence is exactly forty chars. ';
    const chunks = commentaryChunks(sentence.repeat(10), 100);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
      expect(chunk.endsWith('.')).toBe(true);
    }
    expect(chunks.join(' ')).toBe(sentence.repeat(10).trim());
    // No boundary: a hard cut.
    expect(commentaryChunks('x'.repeat(250), 100).map((chunk) => chunk.length)).toEqual([100, 100, 50]);
  });
});
