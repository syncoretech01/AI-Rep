import { estimateTokens } from '@/server/ai/tokens';
import type { ModelInputItem, ModelToolDefinition } from '@/server/ai/types';
import { truncateText } from '@/server/db/sql';
import type { Agent } from '@/server/domain/agents/types';
import type { BusinessProfile } from '@/server/domain/business/types';
import type { Message } from '@/server/domain/conversations/types';
import type { Channel } from '@/server/domain/types';
import { buildInstructions } from '../runtime/prompts';
import { toModelTools } from '../tools/registry';
import type { ToolDefinition } from '../tools/types';

/**
 * The one ContextAssembler for every channel (ARCHITECTURE.md §12): concise
 * instructions, the rolling summary, the user/assistant text the summary does not
 * cover yet and only the tools available to this agent on this channel
 * (AI_RUNTIME.md "Context budgeting"). The rolling summary keeps that text to a
 * recent window (summaryOverflow), so every earlier message reaches the model
 * verbatim or summarized, never neither. Earlier turns' tool payloads and the full
 * transcript never reach the model; knowledge arrives through searchKnowledge.
 */

export interface ContextBudgets {
  /** AI_MAX_RECENT_MESSAGES: the recent window kept verbatim, the current message included. */
  maxRecentMessages: number;
  /** Earlier messages of the recent window beyond this estimate are summarized as well. */
  maxHistoryTokens: number;
  /** Longer messages are truncated with an ellipsis. */
  maxMessageChars: number;
  maxSummaryChars: number;
}

export const DEFAULT_CONTEXT_BUDGETS: Omit<ContextBudgets, 'maxRecentMessages'> = Object.freeze({
  maxHistoryTokens: 3000,
  maxMessageChars: 2000,
  maxSummaryChars: 2000,
});

export interface AssembleContextInput {
  agent: Agent;
  business: BusinessProfile | null;
  channel: Channel;
  now: Date;
  /** Rolling summary ('' when none). */
  summary: string;
  /**
   * Every user/assistant message the rolling summary does not cover yet, chronological, the current user
   * message LAST. All of them are sent: one left out would reach the model neither verbatim nor summarized.
   * The caller bounds the list (the summary keeps it to the recent window plus less than one summary batch).
   */
  history: readonly Message[];
  tools: readonly ToolDefinition[];
  budgets: ContextBudgets;
}

export interface AssembledContext {
  instructions: string;
  input: ModelInputItem[];
  tools: ModelToolDefinition[];
  stats: {
    instructionTokens: number;
    historyMessages: number;
    historyTokens: number;
    toolCount: number;
  };
}

interface HistoryEntry {
  role: 'user' | 'assistant';
  content: string;
  tokens: number;
}

export function assembleContext(input: AssembleContextInput): AssembledContext {
  const { budgets } = input;
  const summary = truncateText(input.summary.trim(), budgets.maxSummaryChars, '…');
  const instructions = buildInstructions({
    agent: input.agent,
    business: input.business,
    channel: input.channel,
    now: input.now,
    summary,
    toolNames: input.tools.map((tool) => tool.name),
  });
  const history = input.history.flatMap((message) => historyEntry(message, budgets) ?? []);

  return {
    instructions,
    input: history.map((entry) => ({ type: 'message', role: entry.role, content: entry.content })),
    tools: toModelTools(input.tools),
    stats: {
      instructionTokens: estimateTokens(instructions),
      historyMessages: history.length,
      historyTokens: history.reduce((sum, entry) => sum + entry.tokens, 0),
      toolCount: input.tools.length,
    },
  };
}

/**
 * How many of the oldest unsummarized messages the rolling summary should fold: those outside the recent window
 * of the NEXT turn. That turn adds the visitor's next message, so its window holds the newest
 * `maxRecentMessages - 1` of these, as far as they fit `maxHistoryTokens`. Until they are folded, every turn
 * still sends them (assembleContext drops nothing).
 */
export function summaryOverflow(unsummarized: readonly Message[], budgets: ContextBudgets): number {
  const window = Math.max(0, Math.floor(budgets.maxRecentMessages) - 1);
  let kept = 0;
  let tokens = 0;
  for (const message of unsummarized.toReversed()) {
    if (kept === window) break;
    tokens += historyEntry(message, budgets)?.tokens ?? 0;
    if (tokens > budgets.maxHistoryTokens) break;
    kept += 1;
  }
  return unsummarized.length - kept;
}

/** A message as the model receives it: non-empty user/assistant text, bounded. Anything else is never sent. */
function historyEntry(message: Message, budgets: ContextBudgets): HistoryEntry | null {
  if (message.role !== 'user' && message.role !== 'assistant') return null;
  if (message.content.trim() === '') return null;
  const content = truncateText(message.content, budgets.maxMessageChars, '…');
  return { role: message.role, content, tokens: estimateTokens(content) };
}
