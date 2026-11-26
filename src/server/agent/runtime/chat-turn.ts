import { createHash, randomUUID } from 'node:crypto';
import { withRetries, type RetryOptions } from '@/server/ai/retry';
import type { ModelRouter, QualityFailure, TextRoute } from '@/server/ai/router';
import {
  ProviderError,
  type ModelInputItem,
  type ModelToolCall,
  type TextGenerationRequest,
  type TextGenerationResult,
} from '@/server/ai/types';
import type { AiConfig } from '@/server/config/env';
import { serviceScope } from '@/server/db/scope';
import { truncateText } from '@/server/db/sql';
import type { Database } from '@/server/db/types';
import type { Agent } from '@/server/domain/agents/types';
import { getBusinessProfile } from '@/server/domain/business/repository';
import {
  TurnLockLostError,
  appendMessage,
  countUserMessages,
  getConversation,
  listMessages,
} from '@/server/domain/conversations/service';
import type { Message, NewMessage } from '@/server/domain/conversations/types';
import { DomainError, type Channel } from '@/server/domain/types';
import { UsageLimitError, countEscalatedCalls, type UsageGuard } from '@/server/domain/usage/limits';
import type { UsageRecorder } from '@/server/domain/usage/types';
import type { Logger } from '@/server/observability/logger';
import { DEFAULT_CONTEXT_BUDGETS, assembleContext, type AssembledContext } from '../context/assembler';
import type { ToolExecutionResult, ToolExecutor } from '../tools/executor';
import type { ToolRegistry } from '../tools/registry';
import type { AgentErrorCode, AgentEvent, AgentEventSink } from './events';
import { fallbackReply } from './prompts';
import { MIN_OVERFLOW_MESSAGES } from './summary';

/**
 * One chat turn, channel-neutral: persist the visitor message, assemble a bounded context, run the cheap default
 * model with server-side tools, escalate only under the explicit policy, meter every model call against the
 * organization's spend limits and persist the reply. Channels adapt the emitted AgentEvents to their transport.
 */

/**
 * Time budget chain: turn deadline (50 s) < the messages route's maxDuration (60 s, which also covers persisting
 * the reply and releasing the lock) < the conversation turn lock's TTL (120 s). A serverless platform kills the
 * function at maxDuration. Should a turn ever outlive its lock anyway, the lock's owner token fences it: its
 * writes fail once another turn owns the conversation. A write tool that has started is awaited past the deadline
 * (its outcome must be recorded); the database's timeouts bound it.
 */
export const TURN_DEADLINE_MS = 50_000;

export interface ChatRuntimeDeps {
  db: Database;
  router: ModelRouter;
  tools: ToolRegistry;
  executor: ToolExecutor;
  usage: UsageRecorder;
  /** Organization spend limits and conversation-length limits. */
  guard: UsageGuard;
  ai: AiConfig;
  logger: Logger;
  now?: () => Date;
  /** Test seams for the retry policy (jitter, waiting, clock). */
  retryEnvironment?: Pick<RetryOptions, 'random' | 'sleep' | 'clock'>;
}

export interface ChatTurnInput {
  organizationId: string;
  /** Resolved server-side. */
  agent: Agent;
  /** The caller verified it belongs to the organization/agent and holds the conversation turn lock. */
  conversationId: string;
  /** Owner token of the caller's turn lock: every write of the turn is fenced with it. */
  lockToken: string;
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

/** Rejected tool calls in one turn after which later rounds use the escalation profile. */
const INVALID_TOOL_CALLS_BEFORE_ESCALATION = 2;

const PROVIDER_UNAVAILABLE_MESSAGE = "I'm having trouble responding right now. Please try again in a moment.";
const INTERNAL_ERROR_MESSAGE = 'Something went wrong. Please try again.';
const SPEND_LIMIT_MESSAGE = "I can't reply right now. Please contact the business directly.";
const CONVERSATION_LIMIT_MESSAGE = 'This conversation has reached its length limit. Please start a new chat.';
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

/** Totals for the turn's telemetry event. */
interface TurnStats {
  modelCalls: number;
  retries: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  escalation: string | null;
  firstTokenMs: number | null;
}

export async function runChatTurn(
  deps: ChatRuntimeDeps,
  input: ChatTurnInput,
  emit: AgentEventSink,
): Promise<ChatTurnOutcome> {
  const turnId = randomUUID();
  const { organizationId, agent, conversationId, channel, lockToken } = input;
  const db = serviceScope(deps.db);
  const now = () => deps.now?.() ?? new Date();
  const clock = deps.retryEnvironment?.clock ?? (() => performance.now());
  const startedAt = clock();
  const deadlineAt = startedAt + TURN_DEADLINE_MS;
  const deadline = AbortSignal.timeout(TURN_DEADLINE_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  const logger = deps.logger.child({ turnId, organizationId, agentId: agent.id, conversationId, channel });
  const stats: TurnStats = {
    modelCalls: 0,
    retries: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    escalation: null,
    firstTokenMs: null,
  };
  // The transport may already be gone (closed stream): the turn still completes and is persisted.
  const send = (event: AgentEvent) => {
    if (event.type === 'text.delta' && stats.firstTokenMs === null) stats.firstTokenMs = Math.round(clock() - startedAt);
    try {
      emit(event);
    } catch {
      // Ignored on purpose.
    }
  };
  // Fenced: a turn that lost its lock to another worker cannot write into the conversation.
  const append = (message: NewMessage) =>
    db.run((sql) => appendMessage(sql, organizationId, conversationId, message, { lockToken }));

  if (agent.organizationId !== organizationId) throw new DomainError('not_found', 'Conversation not found.');
  if (input.userText.trim() === '') throw new DomainError('invalid', 'The message is empty.');
  const limits = await deps.guard.limits(organizationId);

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
    if (!isRetry && (await countUserMessages(sql, organizationId, conversationId)) >= limits.maxConversationTurns) {
      return null;
    }
    const userMessage = isRetry
      ? latest
      : await appendMessage(sql, organizationId, conversationId, { role: 'user', content: input.userText }, { lockToken });
    const history: Message[] = isRetry ? unsummarized : [...unsummarized, userMessage];
    const business = await getBusinessProfile(sql, organizationId, agent.id);
    return { userMessage, history, business, summary: conversation.summary };
  });
  send({ type: 'turn.start', turnId, conversationId });

  if (loaded === null) {
    // Conversation-length limit: nothing is persisted and no model is called.
    logger.warn('usage.limit.enforced', { resource: 'conversation_turns', scope: 'conversation', limit: limits.maxConversationTurns });
    send({ type: 'turn.error', turnId, code: 'limit_reached', message: CONVERSATION_LIMIT_MESSAGE, recoverable: false });
    return { status: 'failed', turnId, userMessageId: null, assistantMessageId: null, errorCode: 'limit_reached' };
  }
  const userMessageId = loaded.userMessage.id;

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
    logTurn('completed', { model: reply.model, tier: reply.tier, rounds: reply.rounds, fallback });
    return { status: 'completed', turnId, userMessageId, assistantMessageId: assistant.id, errorCode: null };
  } catch (error) {
    // 7. Failures: a marker in the transcript, one terminal event, never an exception.
    const failure = classifyFailure(error);
    if (failure.reason === 'internal') logger.error('agent.turn.failed', { error });
    if (failure.reason === 'lock_lost') logger.warn('agent.turn.lock_lost', {});
    if (failure.marker) {
      try {
        await append({ role: 'system', content: 'assistant_unavailable', data: { code: failure.reason } });
      } catch (markerError) {
        logger.error('agent.turn.marker_failed', { error: markerError });
      }
    }
    send({ type: 'turn.error', turnId, code: failure.code, message: failure.message, recoverable: failure.recoverable });
    logTurn('failed', { errorCode: failure.code, reason: failure.reason });
    return { status: 'failed', turnId, userMessageId, assistantMessageId: null, errorCode: failure.code };
  }

  function classifyFailure(error: unknown): {
    code: AgentErrorCode;
    reason: string;
    message: string;
    recoverable: boolean;
    marker: boolean;
  } {
    if (error instanceof TurnLockLostError) {
      // Another worker owns the conversation now: write nothing more.
      return { code: 'internal', reason: 'lock_lost', message: INTERNAL_ERROR_MESSAGE, recoverable: true, marker: false };
    }
    if (error instanceof UsageLimitError) {
      return { code: 'limit_reached', reason: error.scope, message: SPEND_LIMIT_MESSAGE, recoverable: false, marker: true };
    }
    // Deadline/cancellation or a provider error are provider failures; anything else is internal.
    const reason = deadline.aborted
      ? 'deadline'
      : input.signal?.aborted
        ? 'cancelled'
        : error instanceof ProviderError
          ? error.code
          : null;
    if (reason === null) {
      return { code: 'internal', reason: 'internal', message: INTERNAL_ERROR_MESSAGE, recoverable: true, marker: true };
    }
    return {
      code: 'provider_unavailable',
      reason,
      message: PROVIDER_UNAVAILABLE_MESSAGE,
      recoverable: true,
      marker: true,
    };
  }

  /** One normalized event per turn (AI_RUNTIME.md "Observability"): latency, rounds, tokens, cost, outcome. */
  function logTurn(outcome: 'completed' | 'failed', fields: Record<string, unknown>): void {
    logger.info('agent.turn.finished', {
      outcome,
      latencyMs: Math.round(clock() - startedAt),
      firstTokenMs: stats.firstTokenMs,
      modelCalls: stats.modelCalls,
      retries: stats.retries,
      toolCalls: stats.toolCalls,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      estimatedCostUsd: Math.round(stats.estimatedCostUsd * 1e8) / 1e8,
      escalation: stats.escalation,
      ...fields,
    });
  }

  async function generateReply(context: AssembledContext): Promise<Reply> {
    const task = 'chat_response';
    const items: ModelInputItem[] = [...context.input];
    const texts: string[] = [];
    const succeededTools = new Set<string>();
    const cacheKey = createHash('sha256').update(`${organizationId}:${agent.id}`).digest('base64url');
    const { maxToolRounds, maxToolCallsPerTurn, maxTurnTokens } = deps.ai.budgets;
    let route = deps.router.selectText({ task, channel });
    logger.debug('ai.route.selected', routeFields(route));
    let invalidToolCalls = 0;
    let streamedText = false;
    let reply: Reply = { text: '', answered: false, succeededTools, model: route.model, tier: route.tier, rounds: 0 };

    /**
     * Escalates once per turn, only for a demonstrated model-quality failure, and only while the conversation is
     * under its premium-call cap (a visitor can provoke quality failures on purpose).
     */
    const escalate = async (failure: QualityFailure): Promise<boolean> => {
      if (route.tier === 'escalation' || !deps.router.canEscalate(task)) return false;
      const used = await db.run((sql) => countEscalatedCalls(sql, organizationId, conversationId));
      if (used >= deps.ai.budgets.maxEscalatedCallsPerConversation) {
        logger.warn('usage.limit.enforced', {
          resource: 'escalated_calls',
          scope: 'conversation',
          limit: deps.ai.budgets.maxEscalatedCallsPerConversation,
          trigger: failure,
        });
        return false;
      }
      route = deps.router.selectText({ task, channel, qualityFailure: failure });
      stats.escalation = route.reason;
      logger.info('ai.route.escalated', { ...routeFields(route), trigger: failure });
      return true;
    };

    /**
     * The organization's spend limit refused the premium model: the turn continues on the default model (which may
     * still fit the budget) instead of failing. Returns false for any other error.
     */
    const declineEscalation = (error: unknown): boolean => {
      if (!(error instanceof UsageLimitError) || route.tier !== 'escalation') return false;
      logger.warn('ai.route.escalation_declined', { ...routeFields(route), reason: error.scope });
      stats.escalation = `${route.reason}:declined`;
      route = deps.router.selectText({ task, channel });
      return true;
    };

    for (let round = 1; round <= maxToolRounds; round += 1) {
      if (round > 1 && stats.inputTokens + stats.outputTokens >= maxTurnTokens) {
        // Token budget spent: no further round; the fallback completes the reply if needed.
        logger.warn('usage.limit.enforced', {
          resource: 'turn_tokens',
          scope: 'turn',
          limit: maxTurnTokens,
          used: stats.inputTokens + stats.outputTokens,
        });
        break;
      }
      if (invalidToolCalls >= INVALID_TOOL_CALLS_BEFORE_ESCALATION) await escalate('invalid_tool_calls');
      // The final round keeps the tools (the input already holds tool calls) but must answer in text.
      const toolChoice = round === maxToolRounds || stats.toolCalls >= maxToolCallsPerTurn ? 'none' : 'auto';
      let attempt: RoundAttempt;
      try {
        attempt = await callModel(route, toolChoice, round);
      } catch (error) {
        if (!declineEscalation(error)) throw error;
        attempt = await callModel(route, toolChoice, round);
      }
      // An empty answer (no text, no tool call) from the default model is a quality failure: the same round is
      // asked once more on the escalation profile. Nothing was streamed, so nothing is repeated to the visitor.
      if (isEmptyResponse(attempt.result) && (await escalate('empty_response'))) {
        try {
          attempt = await callModel(route, toolChoice, round);
        } catch (error) {
          // Refused by the spend limit: keep the empty answer, which the safe fallback completes.
          if (!declineEscalation(error)) throw error;
        }
      }

      const { result } = attempt;
      streamedText ||= attempt.streamed;
      // Text written next to a call of a tool with side effects predates the tool's outcome, so it may claim a
      // success that never happens (CLAUDE.md #9): it is left out of the reply, which replaces the streamed text.
      const provisional = result.toolCalls.some((call) => {
        const effects = deps.tools.get(call.name)?.sideEffects;
        return effects !== undefined && effects !== 'none';
      });
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

      if (result.toolCalls.length === 0 || toolChoice === 'none') break;
      items.push(...result.outputItems);
      for (const call of result.toolCalls) {
        const execution = await runTool(call, stats.toolCalls >= maxToolCallsPerTurn);
        if (execution.ok) succeededTools.add(call.name);
        if (execution.errorCode === 'invalid_arguments' || execution.errorCode === 'unknown_tool') invalidToolCalls += 1;
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

    /**
     * One model call: reserve its conservatively estimated cost against the organization's spend limits, stream it (retrying
     * retryable failures on the same model while nothing has been shown to the visitor), meter it, release the
     * reservation.
     */
    async function callModel(selected: TextRoute, choice: 'auto' | 'none', round: number): Promise<RoundAttempt> {
      const request = requestFor(selected, choice);
      const reservation = await deps.guard.reserveText(organizationId, {
        model: selected.model,
        inputTokens: estimateRequestTokens(request),
        maxOutputTokens: request.maxOutputTokens ?? deps.ai.budgets.maxOutputTokens,
      });
      let attempts = 0;
      try {
        const attempt = await withRetries(
          (attemptNumber) => {
            attempts = attemptNumber;
            return streamRound(selected, request);
          },
          {
            policy: deps.ai.retry,
            deadlineAt,
            signal,
            // A response the visitor already saw part of is never repeated.
            canRetry: (error) => !(error instanceof RoundFailure && error.streamed),
            unwrap: (error) => (error instanceof RoundFailure ? error.cause : error),
            onRetry: ({ retry, delayMs, error }) => {
              stats.retries += 1;
              logger.warn('ai.call.retry', {
                ...routeFields(selected),
                round,
                retry,
                delayMs,
                code: error.code,
                status: error.status,
                retryAfterMs: error.retryAfterMs,
              });
            },
            ...deps.retryEnvironment,
          },
        );
        const { result } = attempt;
        stats.modelCalls += 1;
        stats.inputTokens += result.usage.inputTokens;
        stats.outputTokens += result.usage.outputTokens;
        // Metered outside any transaction (the recorder writes through its own connection).
        const recorded = await deps.usage.recordTextGeneration({ organizationId, agentId: agent.id, conversationId }, task, {
          provider: selected.providerId,
          model: result.model,
          usage: result.usage,
          toolCalls: result.toolCalls.length,
          durationMs: result.durationMs,
          metadata: {
            tier: selected.tier,
            round,
            route: selected.reason,
            attempts,
            ...(result.firstTokenMs !== undefined && { firstTokenMs: result.firstTokenMs }),
          },
        });
        stats.estimatedCostUsd += recorded.estimatedCostUsd;
        logger.info('ai.call.completed', {
          ...routeFields(selected),
          round,
          attempts,
          finishReason: result.finishReason,
          durationMs: result.durationMs,
          firstTokenMs: result.firstTokenMs ?? null,
          inputTokens: result.usage.inputTokens,
          cachedInputTokens: result.usage.cachedInputTokens,
          outputTokens: result.usage.outputTokens,
          reasoningTokens: result.usage.reasoningTokens,
          toolCalls: result.toolCalls.length,
          estimatedCostUsd: recorded.estimatedCostUsd,
          pricingKnown: recorded.pricingKnown,
        });
        return attempt;
      } catch (error) {
        const cause = error instanceof RoundFailure ? error.cause : error;
        if (cause instanceof ProviderError) {
          const fields = {
            ...routeFields(selected),
            round,
            attempts,
            code: cause.code,
            status: cause.status,
            retryable: cause.retryable,
            streamed: error instanceof RoundFailure && error.streamed,
          };
          // Alertable: every turn fails until the profile (AI_TEXT_*/AI_ESCALATION_*), credentials or quota are fixed.
          const alert = !cause.retryable && ['auth', 'invalid_request', 'rate_limited'].includes(cause.code);
          if (alert) logger.error('ai.call.failed', fields);
          else logger.warn('ai.call.failed', fields);
        }
        throw cause;
      } finally {
        await deps.guard.release(reservation);
      }
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

  /** One tool call: announced, recorded in the transcript, executed (or refused) through the executor, reported. */
  async function runTool(call: ModelToolCall, overBudget: boolean): Promise<ToolExecutionResult> {
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
    const context = { organizationId, agent, conversationId, channel, now: now(), signal, lockToken };
    let execution: ToolExecutionResult;
    if (overBudget) {
      logger.warn('usage.limit.enforced', { resource: 'tool_calls', scope: 'turn', limit: deps.ai.budgets.maxToolCallsPerTurn });
      execution = await deps.executor.refuse(call, context, {
        code: 'limit_reached',
        message: 'The tool-call limit for this reply was reached. Answer with the information you already have.',
        retryable: false,
      });
    } else {
      stats.toolCalls += 1;
      execution = await deps.executor.execute(call, context);
    }
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

function routeFields(route: TextRoute): Record<string, string> {
  return { provider: route.providerId, model: route.model, tier: route.tier, route: route.reason };
}

/** Neither text nor a tool call, although the model finished normally. */
function isEmptyResponse(result: TextGenerationResult): boolean {
  return result.finishReason === 'stop' && result.toolCalls.length === 0 && result.text.trim() === '';
}

/** Conservative input size of a request, for the spend reservation (billing uses provider-reported usage). */
function estimateRequestTokens(request: TextGenerationRequest): number {
  let chars = request.instructions.length + JSON.stringify(request.tools).length;
  for (const item of request.input) {
    switch (item.type) {
      case 'message':
        chars += item.content.length;
        break;
      case 'tool_call':
        chars += item.call.name.length + item.call.arguments.length;
        break;
      case 'tool_result':
        chars += item.output.length;
        break;
      case 'provider_state':
        chars += JSON.stringify(item.payload ?? '').length;
        break;
    }
  }
  // Deliberately conservative (about 2 characters per token, where English averages ~4): dense scripts such as
  // CJK tokenize far tighter, and an under-estimate would let concurrent calls overshoot the spend limit.
  return Math.ceil(chars / 2);
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
