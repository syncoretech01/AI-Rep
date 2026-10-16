import 'server-only';
import OpenAI, { OpenAIError } from 'openai';
import { toResponseInputItem } from 'openai/lib/responses/ResponseInputItems';
import type {
  FunctionTool,
  Response as OpenAIResponse,
  ResponseCreateParamsStreaming,
  ResponseInputItem,
} from 'openai/resources/responses/responses';
import { z } from 'zod';
import {
  ProviderError,
  type FinishReason,
  type ModelInputItem,
  type ModelToolCall,
  type ModelToolDefinition,
  type ProviderState,
  type TextGenerationRequest,
  type TextGenerationResult,
  type TextModelProvider,
  type TextStreamEvent,
  type TokenUsage,
} from '../types';
import { failedResponseError, startProviderCall } from './errors';

export interface OpenAIProviderOptions {
  /** Required unless `client` is given. */
  apiKey?: string;
  /** Pre-built client (tests inject one with a stubbed fetch). */
  client?: OpenAI;
  /** Overall deadline per call, including SDK retries and the streamed body (AI_REQUEST_TIMEOUT_MS). */
  timeoutMs: number;
  /** SDK retries for connection errors, 429 and 5xx (default 2). */
  maxRetries?: number;
  /** Provider id reported in results and errors (default 'openai'). */
  id?: string;
}

export function createOpenAIClient(options: OpenAIProviderOptions): OpenAI {
  if (options.client) return options.client;
  if (!options.apiKey) throw new Error('OpenAI provider requires an apiKey or a client');
  // `timeout` only bounds the wait for response headers; calls add an overall deadline (startProviderCall).
  return new OpenAI({ apiKey: options.apiKey, timeout: options.timeoutMs, maxRetries: options.maxRetries ?? 2 });
}

const tokenCount = z.number().nonnegative().catch(0);
/** Provider-reported usage; detail fields that an API version omits count as zero. */
const usageSchema = z.object({
  input_tokens: tokenCount,
  input_tokens_details: z
    .object({ cached_tokens: tokenCount, cache_write_tokens: tokenCount })
    .catch({ cached_tokens: 0, cache_write_tokens: 0 }),
  output_tokens: tokenCount,
  output_tokens_details: z.object({ reasoning_tokens: tokenCount }).catch({ reasoning_tokens: 0 }),
});

const NO_USAGE: TokenUsage = { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };

/**
 * TextModelProvider over the OpenAI Responses API (streaming, stateless:
 * `store: false` — PostgreSQL owns the conversation history).
 */
export class OpenAITextProvider implements TextModelProvider {
  readonly id: string;
  private readonly client: OpenAI;
  private readonly timeoutMs: number;

  constructor(options: OpenAIProviderOptions) {
    this.id = options.id ?? 'openai';
    this.client = createOpenAIClient(options);
    this.timeoutMs = options.timeoutMs;
  }

  async generate(request: TextGenerationRequest): Promise<TextGenerationResult> {
    for await (const event of this.stream(request)) {
      if (event.type === 'completed') return event.result;
    }
    // Unreachable: stream() ends with `completed` or throws.
    throw new ProviderError({ provider: this.id, code: 'unknown', retryable: false, message: `${this.id}: no result` });
  }

  async *stream(request: TextGenerationRequest): AsyncGenerator<TextStreamEvent, void, undefined> {
    const call = startProviderCall(this.id, this.timeoutMs, request.signal);
    const startedAt = performance.now();
    let streamOpened = false;
    let text = '';
    try {
      const events = await this.client.responses.create(this.toParams(request), { signal: call.signal });
      streamOpened = true;
      for await (const event of events) {
        switch (event.type) {
          case 'response.output_text.delta':
          case 'response.refusal.delta':
            if (event.delta) {
              text += event.delta;
              yield { type: 'text.delta', delta: event.delta };
            }
            break;
          case 'response.completed':
          case 'response.incomplete': {
            const elapsedMs = Math.round(performance.now() - startedAt);
            yield {
              type: 'completed',
              result: this.toResult(event.type, event.response, text, elapsedMs, request.model),
            };
            return;
          }
          case 'response.failed':
            throw failedResponseError(event.response.error?.code, this.id);
          default:
            break;
        }
      }
    } catch (error) {
      if (streamOpened && !(error instanceof OpenAIError) && !(error instanceof ProviderError)) {
        // Transport failure while reading the body (connection reset, malformed event): transient.
        throw call.toError(
          new ProviderError({
            provider: this.id,
            code: 'unavailable',
            retryable: true,
            message: `${this.id}: response stream was interrupted`,
            cause: error,
          }),
        );
      }
      throw call.toError(error);
    }
    // The SDK ends iteration silently when the request is aborted; otherwise the stream was cut short.
    throw call.toError(
      new ProviderError({
        provider: this.id,
        code: 'unavailable',
        retryable: true,
        message: `${this.id}: response stream ended before completion`,
      }),
    );
  }

  private toParams(request: TextGenerationRequest): ResponseCreateParamsStreaming {
    const params: ResponseCreateParamsStreaming = {
      model: request.model,
      instructions: request.instructions,
      input: toInputItems(request.input, this.id, request.model),
      store: false,
      stream: true,
      stream_options: { include_obfuscation: false },
    };
    if (request.tools.length > 0) {
      params.tools = request.tools.map(toFunctionTool);
      params.tool_choice = request.toolChoice ?? 'auto';
      // One call per round keeps the server-side tool loop sequential and auditable.
      params.parallel_tool_calls = false;
    }
    if (request.reasoningEffort) {
      params.reasoning = { effort: request.reasoningEffort };
      // Without stored responses, reasoning items can only be replayed in the tool loop in encrypted form.
      params.include = ['reasoning.encrypted_content'];
    }
    if (request.maxOutputTokens !== undefined) params.max_output_tokens = request.maxOutputTokens;
    if (request.cacheKey) params.prompt_cache_key = request.cacheKey;
    if (request.endUserId) params.safety_identifier = request.endUserId.slice(0, 64);
    return params;
  }

  private toResult(
    status: 'response.completed' | 'response.incomplete',
    response: OpenAIResponse,
    text: string,
    durationMs: number,
    requestedModel: string,
  ): TextGenerationResult {
    const toolCalls: ModelToolCall[] = [];
    const outputItems: ModelInputItem[] = [];
    // Tagged with the REQUESTED (configured) model: that is what the next request in the loop names.
    const replayState = (item: Parameters<typeof toResponseInputItem>[0]): ProviderState | undefined => {
      const payload = toResponseInputItem(item);
      return payload ? { provider: this.id, model: requestedModel, payload } : undefined;
    };

    // Take reasoning/tool items only from the final output: streamed `output_item.added`
    // events can carry incomplete encrypted reasoning.
    for (const item of response.output) {
      if (item.type === 'reasoning') {
        const state = replayState(item);
        if (state) outputItems.push({ type: 'provider_state', ...state });
      } else if (item.type === 'function_call') {
        // A call cut off by the output limit has partial arguments: never execute it.
        if (item.status === 'incomplete') continue;
        const call: ModelToolCall = { callId: item.call_id, name: item.name, arguments: item.arguments };
        toolCalls.push(call);
        outputItems.push({ type: 'tool_call', call, providerState: replayState(item) });
      } else if (item.type === 'message') {
        const content = item.content.map((part) => (part.type === 'output_text' ? part.text : part.refusal)).join('');
        outputItems.push({ type: 'message', role: 'assistant', content, providerState: replayState(item) });
      }
      // Other item types belong to built-in tools we never offer.
    }

    const usage = usageSchema.safeParse(response.usage);
    return {
      provider: this.id,
      model: response.model,
      text,
      toolCalls,
      outputItems,
      finishReason: finishReasonOf(status, response, toolCalls.length),
      usage: usage.success
        ? {
            inputTokens: usage.data.input_tokens,
            cachedInputTokens: usage.data.input_tokens_details.cached_tokens,
            cacheWriteTokens: usage.data.input_tokens_details.cache_write_tokens,
            outputTokens: usage.data.output_tokens,
            reasoningTokens: usage.data.output_tokens_details.reasoning_tokens,
          }
        : NO_USAGE,
      durationMs,
    };
  }
}

/** Arguments are validated server-side with Zod, so strict mode (all-required schemas) is not used. */
function toFunctionTool(tool: ModelToolDefinition): FunctionTool {
  return { type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false };
}

/**
 * Items this provider and model produced earlier in the turn are replayed verbatim (keeps
 * reasoning/tool-call pairing intact); everything else uses the neutral fields. After a mid-turn
 * escalation to another model, the cheaper model's encrypted reasoning is therefore dropped.
 */
function toInputItems(items: readonly ModelInputItem[], providerId: string, model: string): ResponseInputItem[] {
  const isOwn = (state: ProviderState | undefined): state is ProviderState =>
    state?.provider === providerId && state.model === model;
  const own = (state: ProviderState | undefined): ResponseInputItem | undefined =>
    isOwn(state) ? (state.payload as ResponseInputItem) : undefined;

  const input: ResponseInputItem[] = [];
  for (const item of items) {
    switch (item.type) {
      case 'message':
        if (item.role === 'user') {
          input.push({ role: 'user', content: item.content });
        } else {
          // Neutral assistant text is a finished reply (earlier turns come from the database). The
          // API asks callers to resend `phase` on replayed assistant messages: dropping it degrades newer models.
          input.push(own(item.providerState) ?? { role: 'assistant', content: item.content, phase: 'final_answer' });
        }
        break;
      case 'tool_call':
        input.push(
          own(item.providerState) ?? {
            type: 'function_call',
            call_id: item.call.callId,
            name: item.call.name,
            arguments: item.call.arguments,
          },
        );
        break;
      case 'tool_result':
        input.push({ type: 'function_call_output', call_id: item.callId, output: item.output });
        break;
      case 'provider_state':
        // Opaque state (e.g. encrypted reasoning) only means something to the provider/model that produced it.
        if (isOwn(item)) input.push(item.payload as ResponseInputItem);
        break;
    }
  }
  return input;
}

function finishReasonOf(
  status: 'response.completed' | 'response.incomplete',
  response: OpenAIResponse,
  toolCallCount: number,
): FinishReason {
  if (status === 'response.incomplete') {
    return response.incomplete_details?.reason === 'content_filter' ? 'content_filter' : 'length';
  }
  return toolCallCount > 0 ? 'tool_calls' : 'stop';
}
