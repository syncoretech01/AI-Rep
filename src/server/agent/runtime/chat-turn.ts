import { createHash, randomUUID } from 'node:crypto';
import type { ModelRouter, TextRoute } from '@/server/ai/router';
import {
  ProviderError,
  type ModelInputItem,
  type ModelToolCall,
  type ProviderErrorCode,
  type TextGenerationRequest,
  type TextGenerationResult,
} from '@/server/ai/types';
import type { AiConfig } from '@/server/config/env';
import { serviceScope } from '@/server/db/scope';
import { truncateText } from '@/server/db/sql';
import type { Database } from '@/server/db/types';
import type { Agent } from '@/server/domain/agents/types';
import { getBusinessProfile } from '@/server/domain/business/repository';
import { appendMessage, getConversation, listMessages } from '@/server/domain/conversations/service';
import type { Message, NewMessage } from '@/server/domain/conversations/types';
import { DomainError, type Channel } from '@/server/domain/types';
import type { UsageRecorder } from '@/server/domain/usage/types';
import type { Logger } from '@/server/observability/logger';
import { DEFAULT_CONTEXT_BUDGETS, assembleContext, type AssembledContext } from '../context/assembler';
import type { ToolExecutionResult, ToolExecutor } from '../tools/executor';
import type { ToolRegistry } from '../tools/registry';
import type { AgentErrorCode, AgentEvent, AgentEventSink } from './events';
import { fallbackReply } from './prompts';
import { MIN_OVERFLOW_MESSAGES } from './summary';

/**
 * One chat turn, channel-neutral: persist the visitor message, assemble a
 * bounded context, run the cheap default model with server-side tools, escalate
 * only under the explicit policy, meter every model round and persist the reply.
 * Channels adapt the emitted AgentEvents to their transport.
 */

/**
 * Time budget chain: turn deadline (50 s) < the messages route's maxDuration (60 s, which also covers persisting
 * the reply and releasing the lock) < the conversation turn lock's TTL (120 s). The lock has no owner token, so a
 * turn must never outlive it, and a serverless platform kills the function at maxDuration. A write tool that has
 * started is awaited past the deadline (its outcome must be recorded); the database's timeouts bound it.
 */
export const TURN_DEADLINE_MS = 50_000;

export interface ChatRuntimeDeps {
  db: Database;
  router: ModelRouter;
  tools: ToolRegistry;
  executor: ToolExecutor;
  usage: UsageRecorder;
  ai: AiConfig;
  logger: Logger;
  now?: () => Date;
}

export interface ChatTurnInput {
  organizationId: string;
  /** Resolved server-side. */
  agent: Agent;
  /** The caller verified it belongs to the organization/agent and holds the conversation turn lock. */
  conversationId: string;
  channel: Channel;
  /** Already validated/trimmed by the channel. */
  userText: string;
  /** Opaque, non-PII visitor id hash (provider abuse monitoring). */
  endUserId?: string;
  /** Server-side cancellation only; a client disconnect must NOT cancel the turn. */
  signal?: AbortSignal;
}

export interface ChatTurnOutcome {
  status: 'completed' | 'failed';
  turnId: string;
  userMessageId: string | null;
  assistantMessageId: string | null;
  errorCode: AgentErrorCode | null;
}

/**
 * Transient provider failures (when retryable): worth one retry on the escalation profile (AI_RUNTIME.md
 * "failed cheap-model attempt").
 */
const ESCALATE_ON: ReadonlySet<ProviderErrorCode> = new Set(['unavailable', 'timeout', 'rate_limited']);
/**
 * Non-retryable rejections of the request itself: an unknown or retired model, an unsupported setting, credentials
 * or an exhausted quota. Configuration to fix, never a reason to serve every turn from the premium model.
 */
const REJECTED_ON: ReadonlySet<ProviderErrorCode> = new Set(['invalid_request', 'auth', 'rate_limited', 'unknown']);
/** Rejected tool arguments in one turn after which later rounds use the escalation profile. */
const INVALID_ARGUMENTS_BEFORE_ESCALATION = 2;

const PROVIDER_UNAVAILABLE_MESSAGE = "I'm having trouble responding right now. Please try again in a moment.";
const INTERNAL_ERROR_MESSAGE = 'Something went wrong. Please try again.';
const UNKNOWN_TOOL_LABEL = 'Working on it';
const ROUND_SEPARATOR = '\n\n';

// Column limits from supabase/migrations (messages).
const MAX_MESSAGE_CHARS = 20_000;
const MAX_TOOL_NAME_CHARS = 64;
/** Tool-call arguments kept in the transcript (raw text when they are not a JSON object). */
const MAX_RECORDED_ARGUMENT_CHARS = 2_000;

interface Reply {
  /** The rounds' text, without provisional text (see generateReply). */
  text: string;
  /** Whether the final round answered: it wrote text that was not cut off. */
  answered: boolean;
  /** Tools that returned ok in this turn. */
  succeededTools: ReadonlySet<string>;
  model: string;
  tier: TextRoute['tier'];
  rounds: number;
}

export async function runChatTurn(
  deps: ChatRuntimeDeps,
  input: ChatTurnInput,
  emit: AgentEventSink,
): Promise<ChatTurnOutcome> {
  const turnId = randomUUID();
  const { organizationId, agent, conversationId, channel } = input;
  const db = serviceScope(deps.db);
  const now = () => deps.now?.() ?? new Date();
  const deadline = AbortSignal.timeout(TURN_DEADLINE_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  const logger = deps.logger.child({ turnId, organizationId, agentId: agent.id, conversationId });
  // The transport may already be gone (closed stream): the turn still completes and is persisted.
  const send = (event: AgentEvent) => {
    try {
      emit(event);
    } catch {
      // Ignored on purpose.
    }
  };
  const append = (message: NewMessage) => db.run((sql) => appendMessage(sql, organizationId, conversationId, message));

  if (agent.organizationId !== organizationId) throw new DomainError('not_found', 'Conversation not found.');
  if (input.userText.trim() === '') throw new DomainError('invalid', 'The message is empty.');

  // 1. Persist the visitor message and load what the context needs, in one transaction.
  const loaded = await db.run(async (sql) => {
    const conversation = await getConversation(sql, organizationId, conversationId);
    if (!conversation || conversation.agentId !== agent.id || conversation.status !== 'active') {
      throw new DomainError('not_found', 'Conversation not found.');
    }
    // Every message the rolling summary does not cover yet, so the model gets each earlier message verbatim or
    // summarized. The summary keeps them to the recent window plus less than one batch; the cap only bounds a
    // backlog left by failed summary runs (the next successful run folds it, oldest first).
    const unsummarized = await listMessages(sql, organizationId, conversationId, {
      roles: ['user', 'assistant'],
      afterSeq: conversation.summaryThroughSeq,
      limit: deps.ai.budgets.maxRecentMessages + MIN_OVERFLOW_MESSAGES,
    });
    const latest = unsummarized.at(-1);
    // A retry after a failed turn resends the same text: the unanswered message is reused, not duplicated.
    const isRetry = latest?.role === 'user' && latest.content === truncateText(input.userText, MAX_MESSAGE_CHARS);
    const userMessage = isRetry
      ? latest
      : await appendMessage(sql, organizationId, conversationId, { role: 'user', content: input.userText });
    const history: Message[] = isRetry ? unsummarized : [...unsummarized, userMessage];
    const business = await getBusinessProfile(sql, organizationId, agent.id);
    return { userMessage, history, business, summary: conversation.summary };
  });
  const userMessageId = loaded.userMessage.id;
  send({ type: 'turn.start', turnId, conversationId });

  // From here on nothing escapes: every outcome is persisted and reported through events.
  try {
    // 2. Context: only the tools this agent may use on this channel.
    const tools = deps.tools.availableFor(agent, channel);
    const context = assembleContext({
      agent,
      business: loaded.business,
      channel,
      now: now(),
      summary: loaded.summary,
      history: loaded.history,
      tools,
      budgets: { maxRecentMessages: deps.ai.budgets.maxRecentMessages, ...DEFAULT_CONTEXT_BUDGETS },
    });

    // 3-5. Model rounds with tool calls.
    const reply = await generateReply(context);

    // 6. The reply. When the final round did not answer (no text, or text cut off by the output cap or a filter,
    // perhaps after a preamble such as "Let me check."), a safe fallback completes it.
    const fallback = !reply.answered;
    let content = reply.text;
    if (fallback) {
      const ending = fallbackReply(tools.map((tool) => tool.name), reply.succeededTools);
      content = content ? `${content}${ROUND_SEPARATOR}${ending}` : ending;
    }
    const assistant = await append({
      role: 'assistant',
      content,
      data: { model: reply.model, tier: reply.tier, rounds: reply.rounds, ...(fallback && { fallback: true }) },
    });
    send({ type: 'turn.done', turnId, messageId: assistant.id, text: assistant.content });
    return { status: 'completed', turnId, userMessageId, assistantMessageId: assistant.id, errorCode: null };
  } catch (error) {
    // 7. Failures: a marker in the transcript, one terminal event, never an exception.
    const providerCode = providerFailureCode(error);
    const errorCode: AgentErrorCode = providerCode === null ? 'internal' : 'provider_unavailable';
    if (providerCode === null) {
      logger.error('agent.turn.failed', { error });
    } else {
      logger.warn('agent.turn.provider_failed', {
        code: providerCode,
        ...(error instanceof ProviderError && { provider: error.provider, status: error.status }),
      });
    }
    try {
      await append({ role: 'system', content: 'assistant_unavailable', data: { code: providerCode ?? 'internal' } });
    } catch (markerError) {
      logger.error('agent.turn.marker_failed', { error: markerError });
    }
    send({
      type: 'turn.error',
      turnId,
      code: errorCode,
      message: errorCode === 'internal' ? INTERNAL_ERROR_MESSAGE : PROVIDER_UNAVAILABLE_MESSAGE,
      recoverable: true,
    });
    return { status: 'failed', turnId, userMessageId, assistantMessageId: null, errorCode };
  }

  /** Deadline/cancellation or a provider error are provider failures; anything else is internal (null). */
  function providerFailureCode(error: unknown): string | null {
    if (deadline.aborted) return 'deadline';
    if (input.signal?.aborted) return 'cancelled';
    return error instanceof ProviderError ? error.code : null;
  }

  async function generateReply(context: AssembledContext): Promise<Reply> {
    const task = 'chat_response';
    const items: ModelInputItem[] = [...context.input];
    const texts: string[] = [];
    const succeededTools = new Set<string>();
    const cacheKey = createHash('sha256').update(`${organizationId}:${agent.id}`).digest('base64url');
    const maxRounds = deps.ai.budgets.maxToolRounds;
    let route = deps.router.selectText({ task, channel });
    let escalated = false;
    let invalidArguments = 0;
    let streamedText = false;
    let reply: Reply = { text: '', answered: false, succeededTools, model: route.model, tier: route.tier, rounds: 0 };

    const escalationRoute = (trigger: string, errorCode?: ProviderErrorCode): TextRoute => {
      const selected = deps.router.selectText({ task, channel, priorFailure: true });
      logger.warn('agent.turn.escalated', { tier: selected.tier, reason: selected.reason, trigger, errorCode });
      return selected;
    };

    for (let round = 1; round <= maxRounds; round += 1) {
      if (!escalated && invalidArguments >= INVALID_ARGUMENTS_BEFORE_ESCALATION && deps.router.canEscalate(task)) {
        route = escalationRoute('invalid_arguments');
        escalated = true;
      }
      // The final round keeps the tools (the input already holds tool calls) but must answer in text.
      const toolChoice = round === maxRounds ? 'none' : 'auto';
      let attempt: RoundAttempt;
      try {
        attempt = await streamRound(route, requestFor(route, toolChoice));
      } catch (error) {
        const streamed = error instanceof RoundFailure && error.streamed;
        const cause = error instanceof RoundFailure ? error.cause : error;
        if (!(cause instanceof ProviderError)) throw cause;
        if (route.tier === 'default' && !cause.retryable && REJECTED_ON.has(cause.code)) {
          // Alertable: every turn fails until the default profile (AI_TEXT_*) or its credentials/quota are fixed.
          logger.error('agent.default_model.rejected', {
            provider: cause.provider,
            model: route.model,
            code: cause.code,
            status: cause.status,
          });
        }
        // One retry on the escalation profile for a transient failure, only if the visitor has not seen any of this
        // round's text.
        const retryable =
          cause.retryable &&
          ESCALATE_ON.has(cause.code) &&
          !streamed &&
          !escalated &&
          !signal.aborted &&
          deps.router.canEscalate(task);
        if (!retryable) throw cause;
        route = escalationRoute('provider_error', cause.code);
        escalated = true;
        attempt = await streamRound(route, requestFor(route, toolChoice)).catch((retryError: unknown) => {
          throw retryError instanceof RoundFailure ? retryError.cause : retryError;
        });
      }

      const { result } = attempt;
      streamedText ||= attempt.streamed;
      // Text written next to a call of a tool with side effects predates the tool's outcome, so it may claim a
      // success that never happens (CLAUDE.md #9): it is left out of the reply, which replaces the streamed text.
      const provisional = result.toolCalls.some((call) => deps.tools.get(call.name)?.sideEffects === 'writes');
      const text = provisional ? '' : result.text.trim();
      if (text) texts.push(text);
      reply = {
        text: texts.join(ROUND_SEPARATOR),
        // Only the last round counts: a preamble ("Let me check.") alone does not answer.
        answered: text !== '' && result.finishReason !== 'length' && result.finishReason !== 'content_filter',
        succeededTools,
        model: result.model,
        tier: route.tier,
        rounds: round,
      };
      // Metered outside any transaction (the recorder writes through its own connection).
      await deps.usage.recordTextGeneration({ organizationId, agentId: agent.id, conversationId }, task, {
        provider: route.providerId,
        model: result.model,
        usage: result.usage,
        toolCalls: result.toolCalls.length,
        durationMs: result.durationMs,
        metadata: { tier: route.tier, round },
      });

      if (result.toolCalls.length === 0 || toolChoice === 'none') break;
      items.push(...result.outputItems);
      for (const call of result.toolCalls) {
        const execution = await runTool(call);
        if (execution.ok) succeededTools.add(call.name);
        if (execution.errorCode === 'invalid_arguments') invalidArguments += 1;
        items.push({ type: 'tool_result', callId: call.callId, output: execution.modelOutput });
      }
    }
    return reply;

    function requestFor(selected: TextRoute, choice: 'auto' | 'none'): TextGenerationRequest {
      return {
        model: selected.model,
        instructions: context.instructions,
        input: [...items],
        tools: context.tools,
        toolChoice: choice,
        maxOutputTokens: deps.ai.budgets.maxOutputTokens,
        reasoningEffort: selected.reasoningEffort,
        cacheKey,
        endUserId: input.endUserId,
        signal,
      };
    }

    /** Streams one model call, forwarding text deltas; a failure records whether any text was already shown. */
    async function streamRound(selected: TextRoute, request: TextGenerationRequest): Promise<RoundAttempt> {
      let streamed = false;
      try {
        for await (const event of selected.provider.stream(request)) {
          if (event.type === 'completed') return { result: event.result, streamed };
          if (event.delta === '') continue;
          if (!streamed && streamedText) send({ type: 'text.delta', turnId, delta: ROUND_SEPARATOR });
          streamed = true;
          send({ type: 'text.delta', turnId, delta: event.delta });
        }
        throw new ProviderError({
          provider: selected.providerId,
          code: 'unavailable',
          retryable: true,
          message: `${selected.providerId}: response stream ended without a result`,
        });
      } catch (error) {
        throw new RoundFailure(error, streamed);
      }
    }
  }

  /** One tool call: announced, recorded in the transcript, executed through the executor, reported. */
  async function runTool(call: ModelToolCall): Promise<ToolExecutionResult> {
    const toolName = truncateText(call.name, MAX_TOOL_NAME_CHARS);
    // Only offered tools show their label: a refused captureLead must not tell the visitor "Saving your details".
    const offered = deps.tools.availableFor(agent, channel).find((tool) => tool.name === call.name);
    const label = offered?.label ?? UNKNOWN_TOOL_LABEL;
    send({ type: 'tool.call', turnId, callId: call.callId, toolName, label });
    await append({
      role: 'tool_call',
      toolName,
      toolCallId: call.callId,
      data: { arguments: recordedArguments(call.arguments) },
    });
    const execution = await deps.executor.execute(call, { organizationId, agent, conversationId, channel, now: now(), signal });
    await append({
      role: 'tool_result',
      toolName,
      toolCallId: call.callId,
      toolRunId: execution.toolRunId,
      data: { ok: execution.ok, errorCode: execution.errorCode, replayed: execution.replayed },
    });
    send({
      type: 'tool.result',
      turnId,
      callId: call.callId,
      toolName,
      ok: execution.ok,
      ...(execution.errorCode !== null && { errorCode: execution.errorCode }),
    });
    return execution;
  }
}

interface RoundAttempt {
  result: TextGenerationResult;
  /** Whether this round already streamed text to the visitor. */
  streamed: boolean;
}

/** A failed model call, and whether the visitor had already seen part of its text (then it cannot be retried). */
class RoundFailure extends Error {
  readonly streamed: boolean;

  constructor(cause: unknown, streamed: boolean) {
    super('Model round failed', { cause });
    this.name = 'RoundFailure';
    this.streamed = streamed;
  }
}

/** The parsed arguments object, or the raw text (bounded) when it is not one. */
function recordedArguments(raw: string): unknown {
  if (raw.length <= MAX_RECORDED_ARGUMENT_CHARS) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed;
    } catch {
      // Not JSON: kept as text.
    }
  }
  return truncateText(raw, MAX_RECORDED_ARGUMENT_CHARS, '…');
}
