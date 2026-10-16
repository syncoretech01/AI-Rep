import {
  ProviderError,
  type ModelInputItem,
  type ModelToolCall,
  type TextGenerationRequest,
  type TextGenerationResult,
  type TextModelProvider,
  type TextStreamEvent,
} from '@/server/ai/types';

/**
 * Deterministic, rule-based stand-in for an instruction-following LLM, used by
 * integration and acceptance tests. It reads the input after the last user
 * message and either calls ONE of the offered tools or answers — grounded in
 * tool results only, never inventing facts and never claiming a failed action succeeded.
 *
 * Before tool results: contact details (email / phone-like number) -> captureLead;
 * hours/open/close -> getBusinessHours; address/location/phone number/email/contact ->
 * getBusinessInfo; a question -> searchKnowledge; otherwise a short greeting.
 * After tool results: an answer built from the latest result.
 * It only calls tools present in `request.tools` (never with toolChoice 'none').
 */

export const GREETING_REPLY = 'Hello! How can I help you today?';
export const NO_INFORMATION_REPLY =
  "I'm sorry, I don't have information about that. Would you like me to take your details so someone can follow up?";
export const FAILURE_REPLY = "I'm sorry, I couldn't complete that just now. Please try again in a moment.";
export const NO_LEAD_CAPTURE_REPLY =
  "Thanks for reaching out! I'm not able to take contact details in this chat, but you can contact the business directly.";

type Decision = { kind: 'text'; text: string } | { kind: 'tool'; name: string; arguments: Record<string, unknown> };

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const PHONE = /\+?\(?\d[\d\s().-]{5,}\d/;
const NAME_PREFIX = /\b(?:i['’]m|i am|my name is|this is)\s+/i;
const NAME = /^[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*){0,2}/u;
const HOURS = /\b(?:hours?|open|opening|close[sd]?|closing)\b/i;
const BUSINESS_INFO = /\b(?:address|location|located|where are you|phone number|e-?mail|contact|reach you)\b/i;
const QUESTION_START = /^(?:what|when|where|who|why|how|do|does|did|can|could|is|are|will|would|should|which)\b/i;

const MISSING_LABELS: Record<string, string> = {
  name: 'name',
  phone: 'phone number',
  email: 'email address',
  'phone or email': 'phone number or email address',
};

export class FakeReceptionistModel implements TextModelProvider {
  readonly id: string;
  readonly requests: TextGenerationRequest[] = [];
  private callCounter = 0;

  constructor(id = 'receptionist') {
    this.id = id;
  }

  async generate(request: TextGenerationRequest): Promise<TextGenerationResult> {
    for await (const event of this.stream(request)) {
      if (event.type === 'completed') return event.result;
    }
    throw new Error(`FakeReceptionistModel "${this.id}": stream ended without a result`);
  }

  async *stream(request: TextGenerationRequest): AsyncGenerator<TextStreamEvent, void, undefined> {
    // Snapshot the arrays: the runtime keeps appending to its input between rounds.
    this.requests.push({ ...request, input: [...request.input], tools: [...request.tools] });
    if (request.signal?.aborted) {
      throw new ProviderError({ provider: this.id, code: 'aborted', retryable: false, message: `${this.id}: aborted` });
    }

    const decision = decide(request);
    const toolCalls: ModelToolCall[] = [];
    let text = '';
    if (decision.kind === 'text') {
      text = decision.text;
      for (const delta of splitIntoDeltas(text)) yield { type: 'text.delta', delta };
    } else {
      this.callCounter += 1;
      toolCalls.push({
        callId: `call_${this.id}_${this.callCounter}`,
        name: decision.name,
        arguments: JSON.stringify(decision.arguments),
      });
    }

    const outputItems: ModelInputItem[] = text
      ? [{ type: 'message', role: 'assistant', content: text }]
      : toolCalls.map((call) => ({ type: 'tool_call', call }));
    const outputChars = text.length + toolCalls.reduce((sum, call) => sum + call.arguments.length, 0);
    yield {
      type: 'completed',
      result: {
        provider: this.id,
        model: request.model,
        text,
        toolCalls,
        outputItems,
        finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        usage: {
          inputTokens: Math.ceil(inputChars(request) / 4),
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: Math.max(1, Math.ceil(outputChars / 4)),
          reasoningTokens: 0,
        },
        durationMs: 1,
      },
    };
  }
}

function decide(request: TextGenerationRequest): Decision {
  const lastUser = request.input.findLastIndex((item) => item.type === 'message' && item.role === 'user');
  const userItem = request.input[lastUser];
  const userText = userItem?.type === 'message' ? userItem.content : '';
  const after = request.input.slice(lastUser + 1);

  const latestResult = after.filter((item) => item.type === 'tool_result').at(-1);
  if (latestResult) {
    const call = after.find((item) => item.type === 'tool_call' && item.call.callId === latestResult.callId);
    return { kind: 'text', text: answer(call?.type === 'tool_call' ? call.call : undefined, latestResult.output) };
  }
  // The rolling-summary request (src/server/agent/runtime/summary.ts) is answered with a plain summary.
  if (userText.startsWith('Previous summary:')) return { kind: 'text', text: summarize(userText) };

  const tools = new Set(request.toolChoice === 'none' ? [] : request.tools.map((tool) => tool.name));
  const tool = (name: string, args: Record<string, unknown>): Decision | null =>
    tools.has(name) ? { kind: 'tool', name, arguments: args } : null;

  const contact = extractContact(userText);
  if (contact.phone !== null || contact.email !== null) {
    return (
      tool('captureLead', { ...contact, summary: userText.slice(0, 300) }) ?? { kind: 'text', text: NO_LEAD_CAPTURE_REPLY }
    );
  }
  if (HOURS.test(userText)) {
    const decision = tool('getBusinessHours', {});
    if (decision) return decision;
  }
  if (BUSINESS_INFO.test(userText)) {
    const decision = tool('getBusinessInfo', {});
    if (decision) return decision;
  }
  if (userText.includes('?') || QUESTION_START.test(userText.trim())) {
    return tool('searchKnowledge', { query: userText.trim().slice(0, 300) }) ?? { kind: 'text', text: NO_INFORMATION_REPLY };
  }
  return { kind: 'text', text: GREETING_REPLY };
}

function extractContact(text: string): { name: string | null; phone: string | null; email: string | null } {
  const email = EMAIL.exec(text)?.[0] ?? null;
  const phoneMatch = PHONE.exec(text)?.[0] ?? null;
  const digits = phoneMatch?.replace(/\D/g, '').length ?? 0;
  const phone = phoneMatch !== null && digits >= 7 && digits <= 15 ? phoneMatch.trim() : null;
  const prefix = NAME_PREFIX.exec(text);
  const name = prefix ? (NAME.exec(text.slice(prefix.index + prefix[0].length))?.[0] ?? null) : null;
  return { name, phone, email };
}

/** A reply grounded in the latest tool result only. */
function answer(call: ModelToolCall | undefined, output: string): string {
  const result = parseRecord(output);
  if (result?.ok !== true) {
    const error = parseRecord(result?.error);
    const missing = parseRecord(error?.details)?.missing;
    if (error?.code === 'missing_information' && Array.isArray(missing)) {
      const labels = missing.map((field) => MISSING_LABELS[String(field)] ?? String(field));
      return `Could you please share your ${labels.join(' and ')}?`;
    }
    return FAILURE_REPLY;
  }

  switch (call?.name) {
    case 'searchKnowledge': {
      const top = Array.isArray(result.results) ? parseRecord(result.results[0]) : null;
      if (typeof top?.content !== 'string') return NO_INFORMATION_REPLY;
      return `Here's what I found: ${flatten(top.content)}`;
    }
    case 'captureLead': {
      const name = parseRecord(call.arguments)?.name;
      return `Thanks${typeof name === 'string' && name ? ` ${name}` : ''}! I've saved your details and someone will be in touch.`;
    }
    case 'getBusinessHours': {
      if (result.configured === false || !Array.isArray(result.weekly)) {
        return "I'm sorry, I don't have our opening hours available.";
      }
      const days = result.weekly
        .map((entry) => parseRecord(entry))
        .filter((entry) => Array.isArray(entry?.hours) && entry.hours.length > 0)
        .map((entry) => `${String(entry?.day)} ${(entry?.hours as unknown[]).map(String).join(', ')}`);
      return `${result.isOpenNow === true ? "We're open right now" : "We're closed right now"}. Our hours: ${days.join('; ')}.`;
    }
    case 'getBusinessInfo': {
      const fields = ['businessName', 'phone', 'email', 'website', 'address', 'serviceArea']
        .filter((field) => typeof result[field] === 'string')
        .map((field) => `${field}: ${String(result[field])}`);
      if (fields.length === 0) return "I'm sorry, I don't have our contact details available.";
      return `Here are our details: ${fields.join(', ')}.`;
    }
    default:
      return "I've checked that for you. Is there anything else I can help with?";
  }
}

function summarize(input: string): string {
  const visitorLines = input
    .split('\n')
    .filter((line) => line.startsWith('Visitor: '))
    .map((line) => line.slice('Visitor: '.length));
  return `Visitor said: ${visitorLines.join(' | ')}`.slice(0, 600);
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

function flatten(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(' ');
}

function inputChars(request: TextGenerationRequest): number {
  let chars = request.instructions.length;
  for (const item of request.input) {
    if (item.type === 'message') chars += item.content.length;
    else if (item.type === 'tool_call') chars += item.call.arguments.length;
    else if (item.type === 'tool_result') chars += item.output.length;
  }
  return chars;
}

/** ~3 deltas on code-point boundaries (never splits a surrogate pair). */
function splitIntoDeltas(text: string): string[] {
  const chars = Array.from(text);
  if (chars.length === 0) return [];
  const size = Math.ceil(chars.length / 3);
  const deltas: string[] = [];
  for (let start = 0; start < chars.length; start += size) deltas.push(chars.slice(start, start + size).join(''));
  return deltas;
}
