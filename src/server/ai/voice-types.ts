import type { ModelToolDefinition, ReasoningEffort, TokenUsage } from './types';

/**
 * Provider-neutral contracts for native realtime speech-to-speech sessions (ARCHITECTURE.md §18). The voice gateway
 * depends on these only; provider wire formats stay inside adapters (src/server/ai/<provider>/).
 *
 * A session is created server-side from the browser's WebRTC offer (media then flows browser ⇄ provider directly),
 * and the gateway attaches a server-side control connection ("sideband") that receives tool calls, transcripts,
 * usage and lifecycle events. Every tool call is answered by our tool executor; the browser never executes tools.
 */

/** Who produces the spoken content (decided in Phase 2 spike S2.2; configured by AI_VOICE_DELEGATION). */
export type VoiceDelegationConfig =
  /** A provider-hosted text model answers; our function tools are called through the sideband. */
  | {
      mode: 'responses';
      model: string;
      instructions: string;
      tools: ModelToolDefinition[];
      reasoningEffort: ReasoningEffort | undefined;
    }
  /** Our agent runtime answers each delegated turn; the voice model speaks what we return. */
  | { mode: 'client' };

export interface VoiceSessionRequest {
  model: string;
  voice: string;
  /**
   * The voice model's own instructions (persona, conversation and delegation policy), pinned at creation. The
   * business rules travel with the delegation (Responses) or live in our agent runtime (client).
   */
  instructions: string;
  delegation: VoiceDelegationConfig;
  /** Seconds of silence before the provider returns the session to (cheaper) standby. */
  idleTimeoutSeconds: number;
  /** The browser's WebRTC SDP offer. */
  sdpOffer: string;
  /** Opaque correlation id (our voice session id). */
  correlationId: string;
  /** Who is speaking (hashed before it reaches the provider, for its abuse monitoring). */
  endUserId?: string;
  signal?: AbortSignal;
}

export interface CreatedVoiceSession {
  providerSessionId: string;
  /** The SDP answer returned to the browser. */
  sdpAnswer: string;
}

export type VoiceRole = 'user' | 'assistant';

/** Normalized events from the sideband. */
export type VoiceEvent =
  | { type: 'session.started' }
  /** Incremental transcript of what the caller said (user) or what the agent said (assistant). */
  | { type: 'transcript.delta'; role: VoiceRole; text: string; startMs?: number; endMs?: number }
  /** A function tool call to execute (Responses delegation). */
  | { type: 'tool.call'; callId: string; name: string; arguments: string }
  /** The voice model hands a turn to us (client delegation); the caller's words arrive as transcript deltas. */
  | { type: 'delegation.requested'; delegationId: string; offsetMs?: number }
  /** Cumulative session time reported by the provider. */
  | { type: 'usage'; activeSeconds: number; standbySeconds: number }
  /** Tokens of the provider-hosted delegated model (Responses delegation); the model when the provider names it. */
  | { type: 'model.usage'; model?: string; usage: TokenUsage }
  | { type: 'error'; code: string; message: string; fatal: boolean }
  /** The session ended at the provider. */
  | { type: 'closed'; reason: string; usage?: { activeSeconds: number; standbySeconds: number } };

/** The server-side control connection of one session. */
export interface VoiceSideband {
  /** Registers the event handler (called in order; one handler per sideband). */
  onEvent(handler: (event: VoiceEvent) => void): void;
  /** The connection closed (with or without a `closed` event first). */
  onDisconnect(handler: (reason: string) => void): void;
  /** Returns a tool's output for a call and lets the model continue. */
  sendToolResult(callId: string, output: string): void;
  /** Gives the voice model our answer for a delegated turn (client delegation). */
  sendDelegatedReply(delegationId: string, text: string): void;
  /** Asks the provider to end the session (it then reports `closed` with final usage). */
  closeSession(): void;
  /** Drops the control connection without ending the session (shutdown of this gateway instance). */
  disconnect(): void;
}

export interface RealtimeVoiceProvider {
  readonly id: string;
  createSession(request: VoiceSessionRequest): Promise<CreatedVoiceSession>;
  /** Opens the sideband for a session. Must be called immediately after createSession (short replay window). */
  attach(providerSessionId: string, options?: { signal?: AbortSignal }): Promise<VoiceSideband>;
}
