import {
  ProviderError,
  type ModelInputItem,
  type ModelToolCall,
  type TextGenerationRequest,
  type TextGenerationResult,
  type TextModelProvider,
  type TextStreamEvent,
  type TokenUsage,
} from '@/server/ai/types';

/** One scripted model response. */
export interface ScriptedTurn {
  text?: string;
  /** `arguments` is JSON-stringified; pass a string to send raw (e.g. malformed) JSON. */
  toolCalls?: Array<{ name: string; arguments: unknown; callId?: string }>;
  /** Thrown before anything is yielded (simulates a provider failure). */
  error?: ProviderError;
  usage?: Partial<TokenUsage>;
}

/** A fixed sequence of turns, or a function of the request and its 0-based index. */
export type Script = ScriptedTurn[] | ((request: TextGenerationRequest, index: number) => ScriptedTurn);

const DEFAULT_USAGE: TokenUsage = {
  inputTokens: 100,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 20,
  reasoningTokens: 0,
};

/**
 * Deterministic TextModelProvider for tests: replays scripted turns and records every request.
 * Text streams in ~3 deltas; tool calls get generated call ids unless the script sets them.
 */
export class ScriptedTextProvider implements TextModelProvider {
  readonly id: string;
  readonly requests: TextGenerationRequest[] = [];
  private readonly script: Script;
  private callCounter = 0;

  constructor(id: string, script: Script) {
    this.id = id;
    this.script = script;
  }

  async generate(request: TextGenerationRequest): Promise<TextGenerationResult> {
    for await (const event of this.stream(request)) {
      if (event.type === 'completed') return event.result;
    }
    throw new Error(`ScriptedTextProvider "${this.id}": stream ended without a result`);
  }

  async *stream(request: TextGenerationRequest): AsyncGenerator<TextStreamEvent, void, undefined> {
    const index = this.requests.length;
    // Snapshot the arrays: callers may keep appending to the same input array between tool rounds.
    this.requests.push({ ...request, input: [...request.input], tools: [...request.tools] });
    const turn = this.turnAt(request, index);
    if (turn.error) throw turn.error;
    if (request.signal?.aborted) {
      throw new ProviderError({ provider: this.id, code: 'aborted', retryable: false, message: 'aborted' });
    }

    const text = turn.text ?? '';
    for (const delta of splitIntoDeltas(text)) yield { type: 'text.delta', delta };

    const toolCalls: ModelToolCall[] = (turn.toolCalls ?? []).map((call) => {
      this.callCounter += 1;
      return {
        callId: call.callId ?? `call_${this.id}_${this.callCounter}`,
        name: call.name,
        arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
      };
    });
    const outputItems: ModelInputItem[] = [
      ...(text ? [{ type: 'message' as const, role: 'assistant' as const, content: text }] : []),
      ...toolCalls.map((call) => ({ type: 'tool_call' as const, call })),
    ];

    yield {
      type: 'completed',
      result: {
        provider: this.id,
        model: request.model,
        text,
        toolCalls,
        outputItems,
        finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        usage: { ...DEFAULT_USAGE, ...turn.usage },
        durationMs: 1,
      },
    };
  }

  private turnAt(request: TextGenerationRequest, index: number): ScriptedTurn {
    if (typeof this.script === 'function') return this.script(request, index);
    const turn = this.script[index];
    if (!turn) {
      throw new Error(
        `ScriptedTextProvider "${this.id}" received request #${index + 1} but its script has only ${this.script.length} turn(s)`,
      );
    }
    return turn;
  }
}

/** Splits text into ~3 deltas on code-point boundaries (never splits a surrogate pair). */
function splitIntoDeltas(text: string): string[] {
  const chars = Array.from(text);
  if (chars.length === 0) return [];
  const size = Math.ceil(chars.length / 3);
  const deltas: string[] = [];
  for (let start = 0; start < chars.length; start += size) deltas.push(chars.slice(start, start + size).join(''));
  return deltas;
}
