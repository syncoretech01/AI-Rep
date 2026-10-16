/**
 * Typed agent-runtime events (server-internal). Channels adapt them to their
 * transport — the web chat channel maps them to widget SSE events.
 */

export type AgentErrorCode = 'provider_unavailable' | 'internal';

export type AgentEvent =
  | { type: 'turn.start'; turnId: string; conversationId: string }
  | { type: 'text.delta'; turnId: string; delta: string }
  | { type: 'tool.call'; turnId: string; callId: string; toolName: string; label: string }
  | { type: 'tool.result'; turnId: string; callId: string; toolName: string; ok: boolean; errorCode?: string }
  /**
   * `text` is the authoritative, persisted reply. It can differ from the joined text.delta stream: text of a round
   * that calls a write tool is provisional and dropped, and a fallback sentence can be appended. Channels must show
   * `text` (voice channels, which cannot retract spoken deltas, will need their own handling).
   */
  | { type: 'turn.done'; turnId: string; messageId: string; text: string }
  | { type: 'turn.error'; turnId: string; code: AgentErrorCode; message: string; recoverable: boolean };

export type AgentEventSink = (event: AgentEvent) => void;
