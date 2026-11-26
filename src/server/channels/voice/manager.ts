import type { AgentEvent } from '@/server/agent/runtime/events';
import type { ChatTurnInput, ChatTurnOutcome } from '@/server/agent/runtime/chat-turn';
import { buildInstructions, buildVoiceInstructions } from '@/server/agent/runtime/prompts';
import type { ToolExecutor } from '@/server/agent/tools/executor';
import { toModelTools, type ToolRegistry } from '@/server/agent/tools/registry';
import type { ModelRouter } from '@/server/ai/router';
import type { RealtimeVoiceProvider, VoiceDelegationConfig, VoiceEvent, VoiceRole, VoiceSideband } from '@/server/ai/voice-types';
import type { AiConfig, VoiceConfig } from '@/server/config/env';
import { serviceScope } from '@/server/db/scope';
import { truncateText } from '@/server/db/sql';
import type { Database } from '@/server/db/types';
import { consumeRateLimit } from '@/server/channels/webchat/rate-limit';
import { getAgent } from '@/server/domain/agents/repository';
import type { Agent } from '@/server/domain/agents/types';
import { getBusinessProfile } from '@/server/domain/business/repository';
import { appendMessage, releaseTurnLock, tryAcquireTurnLock } from '@/server/domain/conversations/service';
import type { NewMessage } from '@/server/domain/conversations/types';
import { DomainError } from '@/server/domain/types';
import type { Reservation, UsageGuard } from '@/server/domain/usage/limits';
import type { UsageRecorder } from '@/server/domain/usage/types';
import {
  claimStaleVoiceSession,
  endVoiceSession,
  findStaleVoiceSessions,
  markVoiceSessionActive,
  openVoiceSession,
  touchVoiceSession,
  VoiceLimitError,
  type VoiceSession,
} from '@/server/domain/voice/sessions';
import type { Logger } from '@/server/observability/logger';

/**
 * The voice engine run by the voice gateway (ARCHITECTURE.md §18): creates provider sessions from browser WebRTC
 * offers with pinned configuration, holds each session's sideband, and routes every event to the ONE server-side
 * handler for it — tool calls to the existing tool executor, delegated turns to the existing agent runtime,
 * transcripts into the conversation, usage into metering. Limits: concurrent sessions, maximum duration, silence,
 * and an organization spend reservation held for the whole session.
 */

export interface VoiceManagerDeps {
  db: Database;
  provider: RealtimeVoiceProvider;
  voice: VoiceConfig;
  ai: AiConfig;
  router: ModelRouter;
  tools: ToolRegistry;
  executor: ToolExecutor;
  usage: UsageRecorder;
  guard: UsageGuard;
  /** The shared agent runtime (client delegation). */
  runChatTurn: (input: ChatTurnInput, emit: (event: AgentEvent) => void) => Promise<ChatTurnOutcome>;
  logger: Logger;
  /** Identifies this gateway process in voice_sessions (recovery of sessions whose gateway died). */
  gatewayInstance: string;
  now?: () => Date;
  /** Milliseconds clock (test seam). */
  clock?: () => number;
  timers?: Timers;
  /**
   * Client delegation: how long the caller's transcript must stay unchanged before a delegated turn runs (the
   * delegation notice can arrive before the sentence is fully transcribed). Default 400 ms.
   */
  delegationSettleMs?: number;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const NODE_TIMERS: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface StartVoiceSessionInput {
  organizationId: string;
  agentId: string;
  /** The signed-in user starting a developer test session. */
  startedBy: string | null;
  sdpOffer: string;
}

export interface StartedVoiceSession {
  voiceSessionId: string;
  conversationId: string;
  sdpAnswer: string;
  maxDurationSeconds: number;
  delegation: 'responses' | 'client';
}

export interface VoiceSessionManager {
  start(input: StartVoiceSessionInput): Promise<StartedVoiceSession>;
  /** Ends a live session of this gateway (idempotent). False when it is not live here. */
  end(organizationId: string, voiceSessionId: string): Promise<boolean>;
  activeSessions(): number;
  /** Closes and settles sessions whose gateway stopped reporting (run at startup and periodically). */
  recoverStaleSessions(): Promise<number>;
  /** Ends every live session (graceful shutdown). */
  shutdown(): Promise<void>;
}

/** Heartbeat to voice_sessions while a session is live (well inside STALE_SESSION_SECONDS). */
const HEARTBEAT_MS = 15_000;
/** After asking the provider to close, wait this long for its `closed` event before settling ourselves. */
const CLOSE_GRACE_MS = 8_000;
/** The turn lock (fencing for transcript and tool writes) outlives the session by this margin. */
const LOCK_MARGIN_SECONDS = 120;
/** No caller or agent speech for this long ends the session (abandoned tab, open microphone in an empty room). */
export const MAX_SILENCE_MS = 120_000;
const MAX_TRANSCRIPT_CHARS = 4_000;
const DEFAULT_DELEGATION_SETTLE_MS = 400;
/** A delegated turn waits at most this long for the caller's sentence to settle. */
const MAX_DELEGATION_WAIT_MS = 2_000;

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? null) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

interface LiveSession {
  record: VoiceSession;
  agent: Agent;
  lockToken: string;
  reservation: Reservation | null;
  sideband: VoiceSideband | null;
  providerSessionId: string;
  delegation: 'responses' | 'client';
  /** Backend model of Responses delegation (metering when a usage event does not name it). */
  delegationModel: string | null;
  startedAt: number;
  lastActivityAt: number;
  usage: { activeSeconds: number; standbySeconds: number; fromProvider: boolean };
  transcript: Record<VoiceRole, string>;
  /** Provider timing of the agent's latest words (ms from session start): caller speech before it is a barge-in. */
  lastAssistantEndMs: number | null;
  /** Provider timing (ms from session start) of the utterance being accumulated, per speaker. */
  spans: Record<VoiceRole, { startMs: number | null; endMs: number | null }>;
  /** End of the caller's latest completed utterance: the agent's next words start a response gap from here. */
  lastUserEndMs: number | null;
  /** Clock time of the latest caller transcript delta (client delegation waits for it to settle). */
  lastUserDeltaAt: number;
  handledCalls: Set<string>;
  handledDelegations: Set<string>;
  /** Tool calls and delegated turns run one at a time, in arrival order. */
  queue: Promise<void>;
  stats: { toolCalls: number; interruptions: number; delegatedTurns: number; responseGapsMs: number[] };
  timers: unknown[];
  closeRequested: boolean;
  finalizing: Promise<void> | null;
  /** Resolves once the session is fully settled. */
  done: Promise<void>;
  settled: () => void;
}

export function createVoiceSessionManager(deps: VoiceManagerDeps): VoiceSessionManager {
  const service = serviceScope(deps.db);
  const clock = deps.clock ?? (() => Date.now());
  const now = () => deps.now?.() ?? new Date();
  const timers = deps.timers ?? NODE_TIMERS;
  const live = new Map<string, LiveSession>();
  const logger = deps.logger.child({ module: 'voice' });

  async function start(input: StartVoiceSessionInput): Promise<StartedVoiceSession> {
    const { organizationId } = input;
    if (input.sdpOffer.trim() === '') throw new DomainError('invalid', 'The WebRTC offer is empty.');
    const agent = await service.run((sql) => getAgent(sql, organizationId, input.agentId));
    if (agent?.status !== 'active') throw new DomainError('not_found', 'Agent not found or not active.');
    // Every creation is billed by the provider (even one that never connects), so starts are rate limited.
    const starts = await consumeRateLimit(deps.db, {
      key: `voice:start:${organizationId}`,
      limit: deps.voice.sessionStartsPerMinute,
      windowSeconds: 60,
      now: now(),
    });
    if (!starts.allowed) throw new VoiceLimitError('session_starts');

    const limits = await deps.guard.limits(organizationId);
    const maxDurationSeconds = Math.min(deps.voice.maxSessionSeconds, limits.maxVoiceSessionSeconds);
    const delegation = deps.voice.delegation;
    // The whole session's worst case (active time for its full length, plus delegated text in Responses mode) is
    // reserved up front, so a session can never run past the organization's spend limit.
    const reservation = await deps.guard.reserveVoice(organizationId, {
      model: deps.voice.model,
      maxSeconds: maxDurationSeconds,
      extraUsd: delegation === 'responses' ? (deps.voice.delegatedTextReservePerMinuteUsd * maxDurationSeconds) / 60 : 0,
    });

    let record: VoiceSession | null = null;
    let lockToken: string | null = null;
    let sideband: VoiceSideband | null = null;
    let providerSessionId: string | null = null;
    try {
      record = await service.run((sql) =>
        openVoiceSession(sql, {
          organizationId,
          agentId: agent.id,
          startedBy: input.startedBy,
          provider: deps.voice.provider,
          model: deps.voice.model,
          voice: deps.voice.voice,
          delegation,
          maxDurationSeconds,
          maxConcurrentSessions: Math.min(deps.voice.maxConcurrentSessions, limits.maxConcurrentVoiceSessions),
          gatewayInstance: deps.gatewayInstance,
        }),
      );
      const opened = record;
      lockToken = await service.run((sql) =>
        tryAcquireTurnLock(sql, organizationId, opened.conversationId, maxDurationSeconds + LOCK_MARGIN_SECONDS),
      );
      if (lockToken === null) throw new Error('voice: could not lock the new conversation');

      const business = await service.run((sql) => getBusinessProfile(sql, organizationId, agent.id));
      const toolDefinitions = deps.tools.availableFor(agent, 'web_voice');
      // The business rules (shared with text) go to whoever answers: the delegated backend model here, or our agent
      // runtime in client delegation. The voice model gets only its conversation and delegation policy.
      const rules = buildInstructions({
        agent,
        business,
        channel: 'web_voice',
        now: now(),
        toolNames: toolDefinitions.map((tool) => tool.name),
      });
      const route = deps.router.selectText({ task: 'chat_response', channel: 'web_voice' });
      const delegationConfig: VoiceDelegationConfig =
        delegation === 'responses'
          ? {
              mode: 'responses',
              model: deps.voice.delegationModel ?? route.model,
              instructions: rules,
              tools: toModelTools(toolDefinitions),
              reasoningEffort: route.reasoningEffort,
            }
          : { mode: 'client' };

      const created = await deps.provider.createSession({
        model: deps.voice.model,
        voice: deps.voice.voice,
        instructions: buildVoiceInstructions({ agent, business }),
        delegation: delegationConfig,
        idleTimeoutSeconds: deps.voice.idleTimeoutSeconds,
        sdpOffer: input.sdpOffer,
        correlationId: opened.id,
        ...(input.startedBy && { endUserId: input.startedBy }),
      });
      providerSessionId = created.providerSessionId;
      // Attach at once: the sideband replays only a few seconds of events.
      sideband = await deps.provider.attach(created.providerSessionId);
      const createdId = created.providerSessionId;
      await service.run((sql) => markVoiceSessionActive(sql, organizationId, opened.id, createdId));

      let settled: () => void = () => undefined;
      const done = new Promise<void>((resolve) => {
        settled = resolve;
      });
      const session: LiveSession = {
        done,
        settled,
        record: opened,
        agent,
        lockToken,
        reservation,
        sideband,
        providerSessionId: created.providerSessionId,
        delegation,
        delegationModel: delegationConfig.mode === 'responses' ? delegationConfig.model : null,
        startedAt: clock(),
        lastActivityAt: clock(),
        usage: { activeSeconds: 0, standbySeconds: 0, fromProvider: false },
        transcript: { user: '', assistant: '' },
        lastAssistantEndMs: null,
        spans: { user: { startMs: null, endMs: null }, assistant: { startMs: null, endMs: null } },
        lastUserEndMs: null,
        lastUserDeltaAt: 0,
        handledCalls: new Set(),
        handledDelegations: new Set(),
        queue: Promise.resolve(),
        stats: { toolCalls: 0, interruptions: 0, delegatedTurns: 0, responseGapsMs: [] },
        timers: [],
        closeRequested: false,
        finalizing: null,
      };
      live.set(opened.id, session);
      run(session);
      logger.info('voice.session.started', {
        organizationId,
        agentId: agent.id,
        voiceSessionId: opened.id,
        conversationId: opened.conversationId,
        providerSessionId: created.providerSessionId,
        model: deps.voice.model,
        delegation,
        maxDurationSeconds,
      });
      return {
        voiceSessionId: opened.id,
        conversationId: opened.conversationId,
        sdpAnswer: created.sdpAnswer,
        maxDurationSeconds,
        delegation,
      };
    } catch (error) {
      // Nothing may leak: the provider session, the lock, the reservation and the record are all settled here.
      logger.warn('voice.session.start_failed', { organizationId, voiceSessionId: record?.id ?? null, error });
      if (sideband) {
        sideband.closeSession();
        sideband.disconnect();
      }
      const opened = record;
      if (opened) {
        await service
          .run((sql) =>
            endVoiceSession(sql, organizationId, opened.id, {
              status: 'failed',
              reason: providerSessionId ? 'start_failed_after_create' : 'start_failed',
              usage: { activeSeconds: 0, standbySeconds: 0, source: 'estimated', estimatedCostUsd: 0 },
            }),
          )
          .catch((settleError: unknown) => logger.error('voice.session.settle_failed', { error: settleError }));
        const token = lockToken;
        if (token) await service.run((sql) => releaseTurnLock(sql, organizationId, opened.conversationId, token)).catch(() => false);
      }
      await deps.guard.release(reservation);
      throw error;
    }
  }

  /** Wires the sideband and the session's timers. */
  function run(session: LiveSession): void {
    const { sideband } = session;
    if (!sideband) return;
    sideband.onEvent((event) => {
      handleEvent(session, event);
    });
    sideband.onDisconnect((reason) => {
      if (!session.finalizing) {
        logger.warn('voice.sideband.disconnected', { voiceSessionId: session.record.id, reason });
        void finalize(session, session.closeRequested ? 'ended' : 'failed', session.closeRequested ? 'closed' : 'sideband_lost');
      }
    });
    session.timers.push(
      timers.setTimeout(() => {
        logger.info('voice.session.max_duration', { voiceSessionId: session.record.id });
        requestClose(session, 'max_duration');
      }, session.record.maxDurationSeconds * 1000),
      timers.setInterval(() => {
        if (clock() - session.lastActivityAt >= MAX_SILENCE_MS) {
          logger.info('voice.session.silence', { voiceSessionId: session.record.id });
          requestClose(session, 'silence');
          return;
        }
        void service
          .run((sql) => touchVoiceSession(sql, session.record.organizationId, session.record.id))
          .catch((error: unknown) => logger.warn('voice.session.heartbeat_failed', { voiceSessionId: session.record.id, error }));
      }, HEARTBEAT_MS),
    );
  }

  function handleEvent(session: LiveSession, event: VoiceEvent): void {
    if (session.finalizing) return;
    switch (event.type) {
      case 'session.started':
        return;
      case 'transcript.delta': {
        session.lastActivityAt = clock();
        if (event.role === 'user') {
          session.lastUserDeltaAt = clock();
          // GPT-Live reports no interruption event: caller speech that starts before the agent's latest words ended
          // is a barge-in. The agent's utterance is recorded as interrupted; committed tool runs are never undone.
          const bargeIn =
            session.transcript.assistant !== '' &&
            event.startMs !== undefined &&
            session.lastAssistantEndMs !== null &&
            event.startMs < session.lastAssistantEndMs;
          if (bargeIn) session.stats.interruptions += 1;
          if (session.transcript.assistant !== '') flushTranscript(session, 'assistant', bargeIn ? { interrupted: true } : {});
        } else {
          if (event.endMs !== undefined) session.lastAssistantEndMs = event.endMs;
          // A switch of speaker completes the caller's utterance.
          if (session.transcript.user !== '') flushTranscript(session, 'user');
        }
        session.transcript[event.role] = truncateText(session.transcript[event.role] + event.text, MAX_TRANSCRIPT_CHARS);
        const span = session.spans[event.role];
        if (span.startMs === null && event.startMs !== undefined) span.startMs = event.startMs;
        if (event.endMs !== undefined) span.endMs = event.endMs;
        return;
      }
      case 'tool.call':
        if (session.handledCalls.has(event.callId)) {
          logger.warn('voice.tool.duplicate_event', { voiceSessionId: session.record.id, callId: event.callId });
          return;
        }
        session.handledCalls.add(event.callId);
        flushTranscript(session, 'user');
        enqueue(session, () => runTool(session, event));
        return;
      case 'delegation.requested':
        if (session.delegation !== 'client' || session.handledDelegations.has(event.delegationId)) return;
        session.handledDelegations.add(event.delegationId);
        enqueue(session, () => runDelegatedTurn(session, event.delegationId));
        return;
      case 'usage':
        session.usage = { activeSeconds: event.activeSeconds, standbySeconds: event.standbySeconds, fromProvider: true };
        return;
      case 'model.usage':
        void deps.usage.recordTextGeneration(
          { organizationId: session.record.organizationId, agentId: session.agent.id, conversationId: session.record.conversationId },
          'voice_delegation',
          {
            provider: deps.voice.provider,
            model: event.model ?? session.delegationModel ?? 'unknown',
            usage: event.usage,
            toolCalls: 0,
            durationMs: 0,
            metadata: { voiceSessionId: session.record.id },
          },
        );
        return;
      case 'error':
        logger.warn('voice.provider.error', { voiceSessionId: session.record.id, code: event.code, fatal: event.fatal });
        if (event.fatal) void finalize(session, 'failed', `provider_error:${event.code}`);
        return;
      case 'closed':
        if (event.usage) session.usage = { ...event.usage, fromProvider: true };
        void finalize(session, 'ended', session.closeRequested ? (closeReasons.get(session) ?? event.reason) : event.reason);
        return;
    }
  }

  const closeReasons = new WeakMap<LiveSession, string>();

  function requestClose(session: LiveSession, reason: string): void {
    if (session.finalizing || session.closeRequested) return;
    session.closeRequested = true;
    closeReasons.set(session, reason);
    session.sideband?.closeSession();
    // If the provider never confirms, settle anyway (estimated usage) so nothing stays open.
    session.timers.push(timers.setTimeout(() => void finalize(session, 'ended', reason), CLOSE_GRACE_MS));
  }

  function enqueue(session: LiveSession, task: () => Promise<void>): void {
    session.queue = session.queue.then(task).catch((error: unknown) => {
      logger.error('voice.session.task_failed', { voiceSessionId: session.record.id, error });
    });
  }

  async function append(session: LiveSession, message: NewMessage): Promise<void> {
    const { organizationId, conversationId } = session.record;
    await service.run((sql) => appendMessage(sql, organizationId, conversationId, message, { lockToken: session.lockToken }));
  }

  /**
   * Completes an utterance: logs its provider timing (the response gap is the time from the end of the caller's words
   * to the start of the agent's, on the provider's clock: VOICE_QUALITY.md latency, without the network leg to the
   * browser) and persists it (Responses delegation; in client delegation the agent runtime persists turns).
   */
  function flushTranscript(session: LiveSession, role: VoiceRole, flags: { interrupted?: boolean } = {}): void {
    const text = session.transcript[role].trim();
    const span = session.spans[role];
    session.transcript[role] = '';
    session.spans[role] = { startMs: null, endMs: null };
    if (text === '') return;
    const timing: Record<string, number> = {};
    if (span.startMs !== null) timing.startMs = span.startMs;
    if (span.endMs !== null) timing.endMs = span.endMs;
    if (role === 'user') {
      if (span.endMs !== null) session.lastUserEndMs = span.endMs;
    } else if (span.startMs !== null && session.lastUserEndMs !== null && span.startMs >= session.lastUserEndMs) {
      timing.responseGapMs = span.startMs - session.lastUserEndMs;
      session.stats.responseGapsMs.push(timing.responseGapMs);
      session.lastUserEndMs = null;
    }
    logger.info('voice.turn.completed', {
      voiceSessionId: session.record.id,
      conversationId: session.record.conversationId,
      role,
      ...timing,
      interrupted: flags.interrupted === true,
      chars: text.length,
    });
    if (session.delegation === 'client') return;
    const data = { source: 'voice_transcript', ...timing, ...(flags.interrupted && { interrupted: true }) };
    const message: NewMessage = { role, content: text, data };
    enqueue(session, () => append(session, message));
  }

  async function runTool(session: LiveSession, call: { callId: string; name: string; arguments: string }): Promise<void> {
    const { record, agent } = session;
    const toolName = truncateText(call.name, 64) || '(unnamed)';
    const startedAt = clock();
    await append(session, { role: 'tool_call', toolName, toolCallId: call.callId, data: { arguments: call.arguments.slice(0, 2_000) } });
    const execution = await deps.executor.execute(call, {
      organizationId: record.organizationId,
      agent,
      conversationId: record.conversationId,
      channel: 'web_voice',
      now: now(),
      lockToken: session.lockToken,
    });
    session.stats.toolCalls += 1;
    await append(session, {
      role: 'tool_result',
      toolName,
      toolCallId: call.callId,
      toolRunId: execution.toolRunId,
      data: { ok: execution.ok, errorCode: execution.errorCode, replayed: execution.replayed },
    });
    // The voice model learns the outcome only from the executor: it can never announce an unconfirmed action.
    if (!session.finalizing) session.sideband?.sendToolResult(call.callId, execution.modelOutput);
    logger.info('voice.tool.completed', {
      voiceSessionId: record.id,
      toolName,
      ok: execution.ok,
      errorCode: execution.errorCode,
      durationMs: Math.round(clock() - startedAt),
    });
  }

  /** Waits until the caller's transcript has stopped changing (or a cap), so the delegated turn sees the whole sentence. */
  async function transcriptSettled(session: LiveSession): Promise<void> {
    const settleMs = deps.delegationSettleMs ?? DEFAULT_DELEGATION_SETTLE_MS;
    const step = Math.min(100, settleMs);
    // Bounded by iterations as well as by the clock, so a stalled clock can never hang the turn.
    for (let waited = 0; settleMs > 0 && waited < MAX_DELEGATION_WAIT_MS && !session.finalizing; waited += step) {
      if (clock() - session.lastUserDeltaAt >= settleMs) return;
      await new Promise((resolve) => setTimeout(resolve, step));
    }
  }

  /** Client delegation: the caller's last utterance goes through the shared agent runtime; we return its reply. */
  async function runDelegatedTurn(session: LiveSession, delegationId: string): Promise<void> {
    await transcriptSettled(session);
    const userText = session.transcript.user.trim();
    session.transcript.user = '';
    if (userText === '') {
      logger.warn('voice.delegation.empty_transcript', { voiceSessionId: session.record.id, delegationId });
      return;
    }
    const startedAt = clock();
    let reply = '';
    let toolCalls = 0;
    const outcome = await deps.runChatTurn(
      {
        organizationId: session.record.organizationId,
        agent: session.agent,
        conversationId: session.record.conversationId,
        lockToken: session.lockToken,
        channel: 'web_voice',
        userText,
      },
      (event) => {
        if (event.type === 'turn.done') reply = event.text;
        if (event.type === 'turn.error') reply = event.message;
        if (event.type === 'tool.call') toolCalls += 1;
      },
    );
    session.stats.delegatedTurns += 1;
    session.stats.toolCalls += toolCalls;
    if (reply !== '' && !session.finalizing) session.sideband?.sendDelegatedReply(delegationId, reply);
    logger.info('voice.delegation.completed', {
      voiceSessionId: session.record.id,
      delegationId,
      status: outcome.status,
      toolCalls,
      durationMs: Math.round(clock() - startedAt),
    });
  }

  /** Settles a session exactly once: usage, record, reservation, lock, connection, timers. */
  function finalize(session: LiveSession, status: 'ended' | 'failed', reason: string): Promise<void> {
    session.finalizing ??= (async () => {
      for (const handle of session.timers) {
        timers.clearTimeout(handle);
        timers.clearInterval(handle);
      }
      flushTranscript(session, 'user');
      flushTranscript(session, 'assistant');
      await session.queue;
      const { record, agent } = session;
      const elapsedSeconds = Math.max(0, (clock() - session.startedAt) / 1000);
      // Provider-reported seconds when we have them; otherwise everything since start counts as active (the dearer
      // rate), so an estimate never under-charges.
      const usage = session.usage.fromProvider
        ? { activeSeconds: session.usage.activeSeconds, standbySeconds: session.usage.standbySeconds, source: 'provider' as const }
        : { activeSeconds: elapsedSeconds, standbySeconds: 0, source: 'estimated' as const };
      const context = { organizationId: record.organizationId, agentId: agent.id, conversationId: record.conversationId };
      const recorded = await deps.usage.recordVoiceSession(context, {
        provider: deps.voice.provider,
        model: deps.voice.model,
        activeSeconds: usage.activeSeconds,
        standbySeconds: usage.standbySeconds,
        source: usage.source,
        metadata: { voiceSessionId: record.id, delegation: session.delegation },
      });
      try {
        await service.run((sql) =>
          endVoiceSession(sql, record.organizationId, record.id, {
            status,
            reason,
            usage: { ...usage, estimatedCostUsd: recorded.estimatedCostUsd },
          }),
        );
      } catch (error) {
        logger.error('voice.session.settle_failed', { voiceSessionId: record.id, error });
      }
      if (session.reservation) await deps.guard.release(session.reservation);
      await service
        .run((sql) => releaseTurnLock(sql, record.organizationId, record.conversationId, session.lockToken))
        .catch((error: unknown) => logger.warn('voice.session.unlock_failed', { voiceSessionId: record.id, error }));
      session.sideband?.disconnect();
      live.delete(record.id);
      session.settled();
      logger.info('voice.session.ended', {
        organizationId: record.organizationId,
        voiceSessionId: record.id,
        status,
        reason,
        durationSeconds: Math.round(elapsedSeconds),
        activeSeconds: usage.activeSeconds,
        standbySeconds: usage.standbySeconds,
        usageSource: usage.source,
        estimatedCostUsd: recorded.estimatedCostUsd,
        toolCalls: session.stats.toolCalls,
        delegatedTurns: session.stats.delegatedTurns,
        interruptions: session.stats.interruptions,
        responseGaps: session.stats.responseGapsMs.length,
        medianResponseGapMs: median(session.stats.responseGapsMs),
        maxResponseGapMs: session.stats.responseGapsMs.length > 0 ? Math.max(...session.stats.responseGapsMs) : null,
      });
    })();
    return session.finalizing;
  }

  async function end(organizationId: string, voiceSessionId: string): Promise<boolean> {
    const session = live.get(voiceSessionId);
    // Another organization's id behaves like an unknown one.
    if (session?.record.organizationId !== organizationId) return false;
    requestClose(session, 'ended_by_user');
    await session.done;
    return true;
  }

  async function recoverStaleSessions(): Promise<number> {
    const stale = await service.run((sql) => findStaleVoiceSessions(sql));
    let recovered = 0;
    for (const record of stale) {
      if (live.has(record.id)) continue;
      // Exactly one gateway instance settles a stale session.
      const claimed = await service.run((sql) =>
        claimStaleVoiceSession(sql, record.organizationId, record.id, deps.gatewayInstance),
      );
      if (!claimed) continue;
      // The provider session may still be running: ask it to close (best effort), then settle with an estimate.
      if (record.providerSessionId) {
        try {
          const sideband = await deps.provider.attach(record.providerSessionId);
          sideband.closeSession();
          sideband.disconnect();
        } catch (error) {
          logger.warn('voice.recovery.attach_failed', { voiceSessionId: record.id, error });
        }
      }
      const lastSeen = record.lastEventAt.getTime();
      const startedAt = (record.connectedAt ?? record.createdAt).getTime();
      const activeSeconds = Math.max(0, (lastSeen - startedAt) / 1000);
      const context = { organizationId: record.organizationId, agentId: record.agentId, conversationId: record.conversationId };
      const recorded = await deps.usage.recordVoiceSession(context, {
        provider: record.provider,
        model: record.model,
        activeSeconds,
        standbySeconds: 0,
        source: 'estimated',
        metadata: { voiceSessionId: record.id, recovered: true },
      });
      const ended = await service.run((sql) =>
        endVoiceSession(sql, record.organizationId, record.id, {
          status: 'failed',
          reason: 'gateway_lost',
          usage: { activeSeconds, standbySeconds: 0, source: 'estimated', estimatedCostUsd: recorded.estimatedCostUsd },
        }),
      );
      if (ended) recovered += 1;
      logger.warn('voice.recovery.session_settled', { organizationId: record.organizationId, voiceSessionId: record.id });
    }
    return recovered;
  }

  async function shutdown(): Promise<void> {
    const sessions = [...live.values()];
    for (const session of sessions) requestClose(session, 'gateway_shutdown');
    await Promise.all(sessions.map((session) => session.done));
  }

  return { start, end, activeSessions: () => live.size, recoverStaleSessions, shutdown };
}
