import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import type OpenAI from 'openai';
import type { MediaSessionConfig, ServerEvent } from 'openai/resources/live/live';
import { z } from 'zod';
import type { ModelToolDefinition, TokenUsage } from '../types';
import { ProviderError } from '../types';
import type {
  CreatedVoiceSession,
  RealtimeVoiceProvider,
  VoiceEvent,
  VoiceSessionRequest,
  VoiceSideband,
} from '../voice-types';
import { startProviderCall } from './errors';
import { createOpenAIClient } from './text-provider';

/**
 * RealtimeVoiceProvider over OpenAI's GPT-Live API (https://developers.openai.com/api/docs/guides/live, verified
 * 2026-11-26): sessions are created server-side from the browser's WebRTC offer (`POST /v1/live/sessions`) with
 * pinned, immutable configuration and a restricted browser data channel; the gateway attaches to the session's
 * sideband (`wss://api.openai.com/v1/live/sessions/{id}/attach`) for tool calls, transcripts, usage and control.
 * Provider wire formats stay in this file.
 */

/** What the browser's data channel may send: hang up and mute; never tool outputs, context or config. */
export const BROWSER_CLIENT_EVENTS = ['session.close', 'session.input_audio.mute', 'session.input_audio.unmute'];
/** What the browser may see: lifecycle, live transcripts and usage. Never delegation, tool or backend events. */
export const BROWSER_SERVER_EVENTS = [
  'session.started',
  'session.closed',
  'session.paused',
  'session.resumed',
  'session.input_audio.muted',
  'session.input_audio.unmuted',
  'session.input_transcript.delta',
  'session.output_transcript.delta',
  'session.usage.updated',
  'error',
];

/** A WebSocket as the sideband uses it (Node's global WebSocket satisfies this; tests inject a fake). */
export interface SidebandSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'close' | 'error' | 'message', listener: (event: { data?: unknown; code?: number; reason?: string }) => void): void;
}

export interface OpenAILiveProviderOptions {
  apiKey?: string;
  client?: OpenAI;
  /** Deadline for session creation (initialization included). */
  timeoutMs: number;
  id?: string;
  /** Sideband base URL (default wss://api.openai.com/v1). */
  sidebandBaseUrl?: string;
  createSocket?: (url: string, headers: Record<string, string>) => SidebandSocket;
}

const OPEN = 1;
const ATTACH_TIMEOUT_MS = 10_000;
/** session.commentary.append accepts at most 500 tokens per event; ~1,500 characters stays well inside that. */
const MAX_COMMENTARY_CHARS = 1_500;
/** Replayed events keep their event_id: remember enough of them to drop duplicates. */
const MAX_SEEN_EVENT_IDS = 5_000;

function defaultSocket(url: string, headers: Record<string, string>): SidebandSocket {
  // Node's global (undici) WebSocket accepts request headers as a non-standard init option.
  const Socket = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => SidebandSocket;
  return new Socket(url, { headers });
}

export class OpenAILiveProvider implements RealtimeVoiceProvider {
  readonly id: string;
  private readonly client: OpenAI;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly sidebandBaseUrl: string;
  private readonly createSocket: (url: string, headers: Record<string, string>) => SidebandSocket;

  constructor(options: OpenAILiveProviderOptions) {
    this.id = options.id ?? 'openai';
    this.client = createOpenAIClient(options);
    this.apiKey = options.apiKey ?? this.client.apiKey ?? '';
    this.timeoutMs = options.timeoutMs;
    this.sidebandBaseUrl = options.sidebandBaseUrl ?? 'wss://api.openai.com/v1';
    this.createSocket = options.createSocket ?? defaultSocket;
  }

  async createSession(request: VoiceSessionRequest): Promise<CreatedVoiceSession> {
    const call = startProviderCall(this.id, this.timeoutMs, request.signal);
    try {
      const created = await this.client.live.create(
        { session: toSessionConfig(request), transport: { type: 'webrtc', sdp: request.sdpOffer } },
        { signal: call.signal },
      );
      return { providerSessionId: created.session.id, sdpAnswer: created.transport.sdp };
    } catch (error) {
      throw call.toError(error);
    }
  }

  attach(providerSessionId: string): Promise<VoiceSideband> {
    const url = `${this.sidebandBaseUrl}/live/sessions/${encodeURIComponent(providerSessionId)}/attach`;
    const socket = this.createSocket(url, { Authorization: `Bearer ${this.apiKey}` });
    const sideband = new LiveSideband(socket, this.id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new ProviderError({ provider: this.id, code: 'timeout', retryable: true, message: `${this.id}: sideband attach timed out` }));
      }, ATTACH_TIMEOUT_MS);
      if (socket.readyState === OPEN) {
        clearTimeout(timer);
        resolve(sideband);
        return;
      }
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(sideband);
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new ProviderError({ provider: this.id, code: 'unavailable', retryable: true, message: `${this.id}: sideband attach failed` }));
      });
    });
  }
}

/** The pinned session configuration (model, instructions and audio are immutable after startup). */
export function toSessionConfig(request: VoiceSessionRequest): MediaSessionConfig {
  const { delegation } = request;
  return {
    model: request.model,
    instructions: request.instructions,
    audio: { output: { voice: request.voice } },
    delegation:
      delegation.mode === 'responses'
        ? {
            type: 'responses',
            responses: {
              model: delegation.model,
              instructions: delegation.instructions,
              tools: delegation.tools.map(toFunctionTool),
              tool_choice: 'auto',
              // One call at a time keeps the server-side tool loop sequential and auditable.
              parallel_tool_calls: false,
              ...(delegation.reasoningEffort && { reasoning: { effort: delegation.reasoningEffort } }),
            },
          }
        : { type: 'client' },
    client: {
      data_channel: {
        allowed_client_events: BROWSER_CLIENT_EVENTS,
        allowed_server_events: BROWSER_SERVER_EVENTS.map((type) => ({ type })),
      },
    },
    // Standby while nobody speaks (cheaper rate); speech wakes the session.
    wake_policy: { type: 'speech' },
    idle_timeout_s: request.idleTimeoutSeconds,
    ...(request.endUserId && { safety_identifier: createHash('sha256').update(request.endUserId).digest('hex').slice(0, 64) }),
  };
}

function toFunctionTool(tool: ModelToolDefinition) {
  // Arguments are validated by our executor with Zod, so strict mode (all-required schemas) is not used.
  return { type: 'function' as const, name: tool.name, description: tool.description, parameters: tool.parameters, strict: false };
}

const tokenCount = z.number().nonnegative().catch(0);
const usageSchema = z.object({
  input_tokens: tokenCount,
  input_tokens_details: z
    .object({ cached_tokens: tokenCount, cache_write_tokens: tokenCount })
    .catch({ cached_tokens: 0, cache_write_tokens: 0 }),
  output_tokens: tokenCount,
  output_tokens_details: z.object({ reasoning_tokens: tokenCount }).catch({ reasoning_tokens: 0 }),
});
const functionCallSchema = z.object({
  type: z.literal('response.output_item.done'),
  item: z.object({ type: z.literal('function_call'), call_id: z.string().min(1), name: z.string(), arguments: z.string() }),
});
const errorSchema = z
  .object({ code: z.string().min(1).catch('unknown'), message: z.string().catch('') })
  .catch({ code: 'unknown', message: '' });
const responseCompletedSchema = z.object({
  type: z.literal('response.completed'),
  response: z.object({ id: z.string(), model: z.string().optional(), usage: z.unknown().optional() }),
});

function toUsage(raw: unknown): TokenUsage {
  const parsed = usageSchema.safeParse(raw);
  if (!parsed.success) return { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  return {
    inputTokens: parsed.data.input_tokens,
    cachedInputTokens: parsed.data.input_tokens_details.cached_tokens,
    cacheWriteTokens: parsed.data.input_tokens_details.cache_write_tokens,
    outputTokens: parsed.data.output_tokens,
    reasoningTokens: parsed.data.output_tokens_details.reasoning_tokens,
  };
}

function seconds(usage: { seconds: number; active_seconds?: number; paused_seconds?: number } | undefined) {
  if (!usage) return undefined;
  return { activeSeconds: usage.active_seconds ?? usage.seconds, standbySeconds: usage.paused_seconds ?? 0 };
}

/** Splits a reply into commentary-sized chunks at sentence boundaries where possible. */
export function commentaryChunks(text: string, maxChars = MAX_COMMENTARY_CHARS): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
    const end = cut > maxChars / 2 ? cut + 1 : maxChars;
    chunks.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** One session's sideband: normalizes provider events and speaks the GPT-Live client-event protocol. */
export class LiveSideband implements VoiceSideband {
  private eventHandler: (event: VoiceEvent) => void = () => undefined;
  private disconnectHandler: (reason: string) => void = () => undefined;
  private readonly seen = new Set<string>();
  private readonly countedResponses = new Set<string>();
  /** Function calls awaiting outputs, per delegation: one response.create once all of them are answered. */
  private readonly pending = new Map<string, Set<string>>();
  private readonly callDelegation = new Map<string, string>();
  private disconnected = false;

  constructor(
    private readonly socket: SidebandSocket,
    private readonly provider: string,
  ) {
    socket.addEventListener('message', (message) => {
      this.receive(message.data);
    });
    socket.addEventListener('close', (event) => {
      this.closed(`socket_closed:${String(event.code ?? 'unknown')}`);
    });
    socket.addEventListener('error', () => {
      this.closed('socket_error');
    });
  }

  onEvent(handler: (event: VoiceEvent) => void): void {
    this.eventHandler = handler;
  }

  onDisconnect(handler: (reason: string) => void): void {
    this.disconnectHandler = handler;
  }

  sendToolResult(callId: string, output: string): void {
    this.send({ type: 'response.item.create', item: { type: 'function_call_output', call_id: callId, output } });
    const delegation = this.callDelegation.get(callId) ?? '';
    this.callDelegation.delete(callId);
    const waiting = this.pending.get(delegation);
    waiting?.delete(callId);
    // Appending an output alone does not resume the backend: one response.create after the last pending output.
    if (!waiting || waiting.size === 0) {
      this.pending.delete(delegation);
      this.send({ type: 'response.create' });
    }
  }

  sendDelegatedReply(delegationId: string, text: string): void {
    for (const content of commentaryChunks(text)) {
      this.send({ type: 'session.commentary.append', content, delegation_id: delegationId });
    }
  }

  closeSession(): void {
    this.send({ type: 'session.close' });
  }

  disconnect(): void {
    this.disconnected = true;
    try {
      this.socket.close(1000, 'done');
    } catch {
      // Already closed.
    }
  }

  private send(event: Record<string, unknown>): void {
    if (this.socket.readyState !== OPEN) return;
    this.socket.send(JSON.stringify({ event_id: `evt_${randomUUID()}`, ...event }));
  }

  private closed(reason: string): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.disconnectHandler(reason);
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') return;
    let event: ServerEvent;
    try {
      event = JSON.parse(data) as ServerEvent;
    } catch {
      return;
    }
    // Reflected audio carries no event_id and is not needed server-side; replayed events are dropped by event_id.
    if (!('event_id' in event) || typeof event.event_id !== 'string') return;
    if (this.seen.has(event.event_id)) return;
    this.seen.add(event.event_id);
    if (this.seen.size > MAX_SEEN_EVENT_IDS) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    for (const normalized of this.normalize(event)) this.eventHandler(normalized);
  }

  private normalize(event: ServerEvent): VoiceEvent[] {
    switch (event.type) {
      case 'session.started':
        return [{ type: 'session.started' }];
      case 'session.input_transcript.delta':
        return [{ type: 'transcript.delta', role: 'user', text: event.delta, startMs: event.start_ms, endMs: event.end_ms }];
      case 'session.output_transcript.delta':
        return [{ type: 'transcript.delta', role: 'assistant', text: event.delta, startMs: event.start_ms, endMs: event.end_ms }];
      case 'session.delegation.created':
        return event.delegation.target === 'client'
          ? [{ type: 'delegation.requested', delegationId: event.delegation.id, offsetMs: event.offset_ms }]
          : [];
      case 'response.event':
        return this.normalizeResponseEvent(event.event, event.delegation_id ?? '');
      case 'session.usage.updated': {
        const usage = seconds(event.usage);
        return usage ? [{ type: 'usage', ...usage }] : [];
      }
      case 'session.closed': {
        const usage = seconds(event.usage);
        return [{ type: 'closed', reason: event.reason, ...(usage && { usage }) }];
      }
      case 'error': {
        // GPT-Live reports errors without ending the session; an ending session sends session.closed. Checked at
        // runtime: an error event without a code or message must not break the session's handler.
        const error = errorSchema.parse(event.error);
        return [{ type: 'error', code: error.code, message: error.message.slice(0, 300), fatal: false }];
      }
      default:
        return [];
    }
  }

  private normalizeResponseEvent(inner: Record<string, unknown>, delegationId: string): VoiceEvent[] {
    const call = functionCallSchema.safeParse(inner);
    if (call.success) {
      const { call_id: callId, name, arguments: args } = call.data.item;
      const waiting = this.pending.get(delegationId) ?? new Set<string>();
      waiting.add(callId);
      this.pending.set(delegationId, waiting);
      this.callDelegation.set(callId, delegationId);
      return [{ type: 'tool.call', callId, name, arguments: args }];
    }
    const completed = responseCompletedSchema.safeParse(inner);
    // Each backend response is counted once (its usage is in response.completed).
    if (completed.success && !this.countedResponses.has(completed.data.response.id)) {
      this.countedResponses.add(completed.data.response.id);
      return [{ type: 'model.usage', model: completed.data.response.model, usage: toUsage(completed.data.response.usage) }];
    }
    return [];
  }
}
