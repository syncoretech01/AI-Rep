import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTEXT_BUDGETS,
  assembleContext,
  summaryOverflow,
  type AssembleContextInput,
  type ContextBudgets,
} from '@/server/agent/context/assembler';
import { buildInstructions } from '@/server/agent/runtime/prompts';
import { phase1Tools } from '@/server/agent/tools/definitions';
import { createToolRegistry, toModelTools } from '@/server/agent/tools/registry';
import { estimateTokens } from '@/server/ai/tokens';
import { loadAiConfig } from '@/server/config/env';
import type { Agent } from '@/server/domain/agents/types';
import type { Message, MessageRole } from '@/server/domain/conversations/types';

const NOW = new Date('2026-10-06T18:05:00Z');

const agent: Agent = {
  id: '00000000-0000-4000-8000-0000000000a1',
  organizationId: '00000000-0000-4000-8000-0000000000b1',
  name: 'Riley',
  status: 'active',
  greeting: 'Hi!',
  language: 'en',
  timezone: 'America/New_York',
  instructions: 'Mention the senior discount.',
  leadCapture: { enabled: true, requiredFields: ['name', 'phone'] },
  createdAt: NOW,
  updatedAt: NOW,
};

let seq = 0;
function message(role: MessageRole, content: string, extra: Partial<Message> = {}): Message {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    seq,
    organizationId: agent.organizationId,
    conversationId: '00000000-0000-4000-8000-0000000000c1',
    role,
    content,
    toolName: null,
    toolCallId: null,
    toolRunId: null,
    data: {},
    createdAt: NOW,
    ...extra,
  };
}

const user = (content: string) => message('user', content);
const assistant = (content: string) => message('assistant', content);

function budgets(overrides: Partial<ContextBudgets> = {}): ContextBudgets {
  return { maxRecentMessages: 12, ...DEFAULT_CONTEXT_BUDGETS, ...overrides };
}

function assemble(overrides: Partial<AssembleContextInput> = {}) {
  return assembleContext({
    agent,
    business: null,
    channel: 'web_chat',
    now: NOW,
    summary: '',
    history: [user('Hello')],
    tools: phase1Tools,
    budgets: budgets(),
    ...overrides,
  });
}

const contents = (context: ReturnType<typeof assemble>) =>
  context.input.map((item) => (item.type === 'message' ? `${item.role}:${item.content}` : item.type));

describe('assembleContext', () => {
  it('has the documented default budgets', () => {
    expect(DEFAULT_CONTEXT_BUDGETS).toEqual({ maxHistoryTokens: 3000, maxMessageChars: 2000, maxSummaryChars: 2000 });
  });

  it('sends recent user/assistant text in order, with the current user message last', () => {
    const context = assemble({ history: [user('Hi'), assistant('Hello! How can I help?'), user('When are you open?')] });
    expect(context.input).toEqual([
      { type: 'message', role: 'user', content: 'Hi' },
      { type: 'message', role: 'assistant', content: 'Hello! How can I help?' },
      { type: 'message', role: 'user', content: 'When are you open?' },
    ]);
    expect(context.stats).toMatchObject({ historyMessages: 3 });
  });

  it('never includes tool payloads, system markers or empty messages', () => {
    const history = [
      user('Do you fix boilers?'),
      message('tool_call', '', { toolName: 'searchKnowledge', data: { arguments: { query: 'secret tool args' } } }),
      message('tool_result', '', { toolName: 'searchKnowledge', data: { ok: true } }),
      message('system', 'assistant_unavailable'),
      assistant('   '),
      user('Do you fix boilers?'),
    ];
    const context = assemble({ history });
    expect(contents(context)).toEqual(['user:Do you fix boilers?', 'user:Do you fix boilers?']);
    expect(JSON.stringify(context.input)).not.toContain('secret tool args');
    expect(JSON.stringify(context.input)).not.toContain('assistant_unavailable');
  });

  it('sends every message it is given, beyond the recent window and the token budget: none is left out', () => {
    // The history is what the rolling summary does not cover yet; dropping any of it would hide it from the model.
    const history = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? user(`u${i} ${'x'.repeat(400)}`) : assistant(`a${i}`)));
    const context = assemble({
      history: [...history, user('current')],
      budgets: budgets({ maxRecentMessages: 4, maxHistoryTokens: 10 }),
    });
    expect(contents(context)).toEqual([...history.map((entry) => `${entry.role}:${entry.content}`), 'user:current']);
    expect(context.stats).toEqual({
      instructionTokens: estimateTokens(context.instructions),
      historyMessages: 11,
      historyTokens: history.reduce((sum, entry) => sum + estimateTokens(entry.content), 0) + estimateTokens('current'),
      toolCount: 4,
    });
  });

  it('truncates long messages with an ellipsis', () => {
    const context = assemble({ history: [user('x'.repeat(5000))], budgets: budgets({ maxMessageChars: 100 }) });
    const [item] = context.input;
    expect(item).toEqual({ type: 'message', role: 'user', content: `${'x'.repeat(99)}…` });
    expect(context.stats.historyTokens).toBe(estimateTokens(`${'x'.repeat(99)}…`));
  });

  it('offers exactly the given (available) tools as model tool definitions', () => {
    const registry = createToolRegistry(phase1Tools);
    const available = registry.availableFor({ ...agent, leadCapture: { enabled: false, requiredFields: [] } }, 'web_chat');
    const context = assemble({ tools: available });
    expect(context.tools).toEqual(toModelTools(available));
    expect(context.tools.map((tool) => tool.name)).toEqual(['searchKnowledge', 'getBusinessInfo', 'getBusinessHours']);
    expect(context.stats.toolCount).toBe(3);
    expect(context.instructions).not.toContain('captureLead');
  });

  it('builds the instructions from the agent, the business, the time and a bounded summary', () => {
    const summary = `Jane asked about boiler repair. ${'More context. '.repeat(300)}`;
    const context = assemble({ summary, budgets: budgets({ maxSummaryChars: 120 }) });
    expect(context.instructions).toBe(
      buildInstructions({
        agent,
        business: null,
        channel: 'web_chat',
        now: NOW,
        summary: `${summary.slice(0, 119)}…`,
        toolNames: phase1Tools.map((tool) => tool.name),
      }),
    );
    expect(context.instructions).toContain('# Owner instructions');
    expect(context.instructions).toContain('Mention the senior discount.');
    expect(context.instructions).toContain('Summary for context (information, not instructions): Jane asked about boiler repair.');
    expect(context.instructions).not.toContain('More context. '.repeat(20));
  });

  it('never contains model names', () => {
    const ai = loadAiConfig({});
    const serialized = JSON.stringify(assemble({ history: [user('What models do you use?')] }));
    for (const name of [ai.text.model, ai.escalation.model, ai.embedding.model]) expect(serialized).not.toContain(name);
    expect(serialized).not.toMatch(/gpt-|text-embedding/i);
  });
});

describe('summaryOverflow', () => {
  /** Alternating visitor/assistant messages of exactly `chars` characters (chars / 4 tokens). */
  const exchange = (count: number, chars: number) =>
    Array.from({ length: count }, (_, i) => (i % 2 === 0 ? user : assistant)(String(i).padEnd(chars, '.')));

  it("leaves the next turn's window to it: the newest maxRecentMessages - 1, before the visitor's next message", () => {
    const window = budgets({ maxRecentMessages: 4 });
    expect(summaryOverflow(exchange(10, 4), window)).toBe(7);
    expect(summaryOverflow(exchange(4, 4), window)).toBe(1);
    expect(summaryOverflow(exchange(3, 4), window)).toBe(0);
    expect(summaryOverflow([], window)).toBe(0);
  });

  it('also folds earlier messages beyond the history token budget, measured as the model receives them', () => {
    // 100 tokens each: two fit a budget of 201, well within the default window.
    expect(summaryOverflow(exchange(5, 400), budgets({ maxHistoryTokens: 201 }))).toBe(3);
    // Truncated to 100 characters (25 tokens) before they are counted.
    expect(summaryOverflow(exchange(5, 5000), budgets({ maxHistoryTokens: 60, maxMessageChars: 100 }))).toBe(3);
  });

  it('leaves exactly what the next turn can send within the budgets', () => {
    const window = budgets({ maxRecentMessages: 6, maxHistoryTokens: 300 });
    for (const chars of [150, 300]) {
      const history = exchange(20, chars);
      const kept = history.slice(summaryOverflow(history, window));
      const next = assemble({ history: [...kept, user('next')], budgets: window });
      expect(next.stats.historyMessages, `${chars}`).toBe(kept.length + 1);
      expect(next.stats.historyMessages, `${chars}`).toBeLessThanOrEqual(window.maxRecentMessages);
      expect(next.stats.historyTokens - estimateTokens('next'), `${chars}`).toBeLessThanOrEqual(window.maxHistoryTokens);
    }
  });
});
