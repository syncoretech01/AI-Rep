/**
 * Provider-neutral AI contracts. Domain and agent code depend on these types
 * only; provider SDK types stay inside adapters (src/server/ai/<provider>/).
 */

export interface TokenUsage {
  /** All input tokens, including cached and cache-write tokens. */
  inputTokens: number;
  /** Input tokens served from the provider's prompt cache. */
  cachedInputTokens: number;
  /** Input tokens written to the provider's prompt cache (billed at a premium by some providers). */
  cacheWriteTokens: number;
  /** All output tokens, including reasoning tokens. */
  outputTokens: number;
  /** Reasoning tokens (already counted in outputTokens). */
  reasoningTokens: number;
}

/** Provider-neutral reasoning effort hint; adapters map or ignore it. */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

/**
 * Opaque provider data attached to an item so the adapter that produced it can replay it exactly.
 * Replayed verbatim only to the same provider AND model (e.g. encrypted reasoning from a cheap model
 * is not sent to the escalation model); otherwise the neutral fields are used.
 */
export interface ProviderState {
  provider: string;
  model: string;
  payload: unknown;
}

/** JSON Schema for a tool's arguments (always an object schema). */
export interface JsonObjectSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [keyword: string]: unknown;
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  parameters: JsonObjectSchema;
}

export interface ModelToolCall {
  /** Provider-issued id used to pair the call with its result. */
  callId: string;
  name: string;
  /** Raw JSON arguments exactly as produced by the model (validated later by the tool registry). */
  arguments: string;
}

/**
 * One item of model input.
 * - `providerState` on a message/tool call lets the adapter that produced it
 *   replay the provider-native item verbatim; other providers use the neutral fields.
 * - `provider_state` items (e.g. encrypted reasoning) are only meaningful to the
 *   provider that produced them; other providers skip them.
 * Provider state lives only within one turn's tool loop and is never persisted.
 */
export type ModelInputItem =
  | { type: 'message'; role: 'user' | 'assistant'; content: string; providerState?: ProviderState }
  | { type: 'tool_call'; call: ModelToolCall; providerState?: ProviderState }
  | { type: 'tool_result'; callId: string; output: string }
  | ({ type: 'provider_state' } & ProviderState);

export interface TextGenerationRequest {
  model: string;
  /** Stable system/developer instructions. */
  instructions: string;
  input: ModelInputItem[];
  tools: ModelToolDefinition[];
  /** Defaults to 'auto' when tools are present. */
  toolChoice?: 'auto' | 'none';
  /** Output cap; includes reasoning tokens for reasoning models. */
  maxOutputTokens?: number;
  reasoningEffort?: ReasoningEffort;
  /** Stable key that lets the provider reuse cached prompt prefixes (e.g. per agent). */
  cacheKey?: string;
  /** Opaque, non-PII end-user identifier for provider abuse monitoring. */
  endUserId?: string;
  signal?: AbortSignal;
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter';

export interface TextGenerationResult {
  provider: string;
  /** Model as reported by the provider (may be a dated snapshot of the requested model). */
  model: string;
  text: string;
  toolCalls: ModelToolCall[];
  /** Items to append to the request input to continue this exchange after tool results. */
  outputItems: ModelInputItem[];
  finishReason: FinishReason;
  usage: TokenUsage;
  durationMs: number;
}

export type TextStreamEvent =
  | { type: 'text.delta'; delta: string }
  | { type: 'completed'; result: TextGenerationResult };

export interface TextModelProvider {
  readonly id: string;
  generate(request: TextGenerationRequest): Promise<TextGenerationResult>;
  /** Yields text deltas as they arrive, then exactly one `completed` event. Throws ProviderError on failure. */
  stream(request: TextGenerationRequest): AsyncIterable<TextStreamEvent>;
}

export interface EmbeddingRequest {
  model: string;
  input: string[];
  dimensions?: number;
  signal?: AbortSignal;
}

export interface EmbeddingResult {
  provider: string;
  model: string;
  /** One vector per input, in input order. */
  vectors: number[][];
  usage: { inputTokens: number };
  durationMs: number;
}

export interface EmbeddingProvider {
  readonly id: string;
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
}

export type ProviderErrorCode =
  | 'auth'
  | 'rate_limited'
  | 'timeout'
  | 'unavailable'
  | 'invalid_request'
  | 'content_filter'
  | 'aborted'
  | 'unknown';

/** Normalized provider failure. Adapters translate SDK errors into this. */
export class ProviderError extends Error {
  readonly provider: string;
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(init: {
    provider: string;
    code: ProviderErrorCode;
    message: string;
    retryable: boolean;
    status?: number;
    cause?: unknown;
  }) {
    super(init.message, { cause: init.cause });
    this.name = 'ProviderError';
    this.provider = init.provider;
    this.code = init.code;
    this.retryable = init.retryable;
    this.status = init.status;
  }
}
