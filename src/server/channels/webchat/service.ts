import { createHash, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { ChatTurnInput, ChatTurnOutcome } from '@/server/agent/runtime/chat-turn';
import type { AgentEvent, AgentEventSink } from '@/server/agent/runtime/events';
import type { WidgetConfig } from '@/server/config/env';
import { serviceScope } from '@/server/db/scope';
import type { Database } from '@/server/db/types';
import { findPublishedWidget, type PublishedWidget } from '@/server/domain/agents/repository';
import {
  closeConversation,
  getActiveVisitorConversation,
  getOrCreateVisitorConversation,
  listMessages,
  releaseTurnLock,
  tryAcquireTurnLock,
} from '@/server/domain/conversations/service';
import type { Message } from '@/server/domain/conversations/types';
import type { Channel } from '@/server/domain/types';
import type { Logger } from '@/server/observability/logger';
import {
  WIDGET_KEY_PATTERN,
  encodeSseEvent,
  resetRequestSchema,
  sendMessageRequestSchema,
  sessionRequestSchema,
  type ApiErrorCode,
  type PublicAgent,
  type PublicMessage,
  type ResetRequest,
  type SendMessageRequest,
  type SessionRequest,
  type SessionResponse,
  type WidgetEvent,
} from '@/shared/widget-protocol';
import { rateLimitSubject } from './client-ip';
import { consumeRateLimit, hashClientIp } from './rate-limit';
import { signWidgetSession, verifyWidgetSession } from './session-token';

/**
 * Public web chat channel: adapts the widget's HTTP/SSE transport to the
 * channel-neutral agent runtime (injected as `runTurn`). No business logic here.
 *
 * There is no user: every query runs in SERVICE scope, and the tenant comes only
 * from the widget key lookup — never from the request body or the session token.
 */

const CHANNEL: Channel = 'web_chat';
/** Longer than the runtime's turn deadline and the route's maxDuration, so a live turn never loses its lock. */
export const TURN_LOCK_TTL_SECONDS = 120;
/**
 * Post-turn work (rolling summary) must finish within this many ms of the request start, inside the messages
 * route's maxDuration: a call the platform kills after the provider billed it would go unmetered.
 */
export const POST_TURN_BUDGET_MS = 55_000;
/** Below this much remaining budget, post-turn work is skipped (the next turn folds the summary instead). */
const MIN_POST_TURN_MS = 2_000;
/** Restored history on open/refresh. */
const RESTORED_MESSAGE_LIMIT = 50;
const RATE_WINDOW_SECONDS = 60;
/** Opening the widget (and "New chat") is cheaper than a turn: three times the per-IP message budget. */
const SESSION_RATE_MULTIPLIER = 3;
const END_USER_ID_CHARS = 32;

const DEFAULT_MESSAGES: Record<ApiErrorCode, string> = {
  invalid_request: 'The request is invalid.',
  widget_unavailable: 'This chat is currently unavailable.',
  invalid_session: 'Your chat session has expired. Please try again.',
  rate_limited: 'Too many messages — please wait a moment.',
  conversation_busy: "I'm still answering your previous message — please wait a moment.",
  provider_unavailable: 'The assistant is temporarily unavailable. Please try again shortly.',
  internal: 'Something went wrong. Please try again.',
};

/** An expected failure of a widget API call. `message` is safe to show to the visitor. */
export class WebChatError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: ApiErrorCode, status: number, message: string = DEFAULT_MESSAGES[code], retryAfterSeconds?: number) {
    super(message);
    this.name = 'WebChatError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface ClientInfo {
  /** The client's address (see getClientIp); null when the request carries no usable one. */
  ip: string | null;
}

export interface WebChatServiceDeps {
  db: Database;
  logger: Logger;
  widget: WidgetConfig;
  runTurn: (input: ChatTurnInput, emit: AgentEventSink) => Promise<ChatTurnOutcome>;
  /** Post-turn maintenance (rolling summary). Must never throw. */
  afterTurn: (params: {
    organizationId: string;
    agentId: string;
    conversationId: string;
    channel: Channel;
    /** Aborts when the request's post-turn budget (POST_TURN_BUDGET_MS from the request start) runs out. */
    signal: AbortSignal;
  }) => Promise<void>;
  now?: () => Date;
}

export interface WebChatService {
  describeWidget(widgetKey: string): Promise<PublicAgent | null>;
  startSession(request: SessionRequest, client: ClientInfo): Promise<SessionResponse>;
  openMessageStream(
    request: SendMessageRequest,
    client: ClientInfo,
  ): Promise<{ stream: ReadableStream<Uint8Array>; done: Promise<void> }>;
  resetConversation(request: ResetRequest, client: ClientInfo): Promise<{ ok: true; sessionToken: string }>;
}

function toPublicAgent({ agent }: PublishedWidget): PublicAgent {
  return { name: agent.name, greeting: agent.greeting, language: agent.language };
}

function toPublicMessages(messages: readonly Message[]): PublicMessage[] {
  return messages.flatMap((message) =>
    message.role === 'user' || message.role === 'assistant'
      ? [{ id: message.id, role: message.role, content: message.content, createdAt: message.createdAt.toISOString() }]
      : [],
  );
}

/** Explicit fields only: internal details (e.g. a tool's error code) never reach the browser. */
function toWidgetEvent(event: AgentEvent): WidgetEvent {
  switch (event.type) {
    case 'turn.start':
      return { type: 'turn.start', turnId: event.turnId, conversationId: event.conversationId };
    case 'text.delta':
      return { type: 'text.delta', turnId: event.turnId, delta: event.delta };
    case 'tool.call':
      return { type: 'tool.call', turnId: event.turnId, callId: event.callId, name: event.toolName, label: event.label };
    case 'tool.result':
      return { type: 'tool.result', turnId: event.turnId, callId: event.callId, name: event.toolName, ok: event.ok };
    case 'turn.done':
      return { type: 'turn.done', turnId: event.turnId, messageId: event.messageId, text: event.text };
    case 'turn.error':
      return {
        type: 'turn.error',
        turnId: event.turnId,
        code: event.code === 'provider_unavailable' ? 'provider_unavailable' : 'internal',
        message: event.message,
        recoverable: event.recoverable,
      };
  }
}

/** Opaque, non-PII visitor identifier for provider abuse monitoring. */
function endUserIdFor(visitorId: string): string {
  return createHash('sha256').update(visitorId).digest('hex').slice(0, END_USER_ID_CHARS);
}

/** Requests are re-validated here too: the service is the boundary for every caller, not just the routes. */
function parseRequest<T>(schema: z.ZodType<T>, request: unknown): T {
  const result = schema.safeParse(request);
  if (!result.success) throw new WebChatError('invalid_request', 400);
  return result.data;
}

export function createWebChatService(deps: WebChatServiceDeps): WebChatService {
  const { db, widget } = deps;
  const logger = deps.logger.child({ module: 'webchat' });
  const now = deps.now ?? (() => new Date());
  const service = serviceScope(db);

  /**
   * Pseudonymous per-client key for rate limits and logs: the hashed IPv4 address or IPv6 /64 network. Requests
   * without a usable IP share one 'unknown' bucket (fail closed, never unlimited).
   */
  function ipHashOf(client: ClientInfo): string {
    const subject = client.ip === null ? null : rateLimitSubject(client.ip);
    return subject === null ? 'unknown' : hashClientIp(subject, widget.sessionSecret);
  }

  async function enforceLimit(
    scope: 'session' | 'ip' | 'widget' | 'organization',
    key: string,
    limit: number,
    fields: Record<string, string>,
  ): Promise<void> {
    const decision = await consumeRateLimit(db, { key, limit, windowSeconds: RATE_WINDOW_SECONDS, now: now() });
    if (decision.allowed) return;
    logger.warn('webchat.rate_limited', { scope, retryAfterSeconds: decision.retryAfterSeconds, ...fields });
    throw new WebChatError('rate_limited', 429, undefined, decision.retryAfterSeconds);
  }

  /** Opening the widget and "New chat" share one per-IP budget. */
  function enforceSessionLimit(client: ClientInfo): Promise<void> {
    const ipHash = ipHashOf(client);
    const limit = widget.rateLimits.ipPerMinute * SESSION_RATE_MULTIPLIER;
    return enforceLimit('session', `webchat:session:${ipHash}`, limit, { ipHash });
  }

  /** Never throws: a lock that cannot be released expires after TURN_LOCK_TTL_SECONDS. */
  async function releaseLock(organizationId: string, conversationId: string, fields: Record<string, string>): Promise<void> {
    try {
      await service.run((sql) => releaseTurnLock(sql, organizationId, conversationId));
    } catch (error) {
      logger.error('webchat.turn_lock_release_failed', { ...fields, error });
    }
  }

  function conversationBusy(fields: Record<string, string>): WebChatError {
    logger.info('webchat.conversation_busy', fields);
    return new WebChatError('conversation_busy', 409);
  }

  function lookupWidget(widgetKey: string): Promise<PublishedWidget | null> {
    if (!WIDGET_KEY_PATTERN.test(widgetKey)) return Promise.resolve(null);
    return service.run((sql) => findPublishedWidget(sql, widgetKey));
  }

  async function requireWidget(widgetKey: string): Promise<PublishedWidget> {
    const published = await lookupWidget(widgetKey);
    if (!published) throw new WebChatError('widget_unavailable', 404);
    return published;
  }

  /** The visitor of a genuine, unexpired token issued for THIS agent; null for anything else. */
  function visitorOf(sessionToken: string | undefined, agentId: string): string | null {
    if (sessionToken === undefined) return null;
    const claims = verifyWidgetSession(sessionToken, { secret: widget.sessionSecret, now: now() });
    return claims !== null && claims.agentId === agentId ? claims.visitorId : null;
  }

  function requireVisitor(sessionToken: string, { agent }: PublishedWidget): string {
    const visitorId = visitorOf(sessionToken, agent.id);
    if (visitorId === null) {
      logger.info('webchat.invalid_session', { organizationId: agent.organizationId, agentId: agent.id });
      throw new WebChatError('invalid_session', 401);
    }
    return visitorId;
  }

  /** Re-issued on every session call and reset: a sliding expiry for returning visitors. */
  function issueToken(agentId: string, visitorId: string): string {
    return signWidgetSession(
      { agentId, visitorId },
      { secret: widget.sessionSecret, ttlSeconds: widget.sessionTtlSeconds, now: now() },
    );
  }

  /**
   * Streams one turn as SSE. The turn runs detached from the HTTP response: a client
   * disconnect only stops delivery, while the turn completes and is persisted.
   */
  function streamTurn(
    input: ChatTurnInput,
    requestStartedAt: number,
  ): { stream: ReadableStream<Uint8Array>; done: Promise<void> } {
    const { organizationId, agent, conversationId } = input;
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let open = true;
    let turnId: string | null = null;
    // The final event (turn.done / turn.error) is held until the turn lock is released: the widget
    // accepts the next message as soon as it reads it, so the conversation must already be free.
    let terminal: WidgetEvent | null = null;

    const deliver = (event: WidgetEvent): void => {
      if (!open || !controller) return;
      try {
        controller.enqueue(encoder.encode(encodeSseEvent(event)));
      } catch {
        open = false; // The client went away.
      }
    };
    const emit: AgentEventSink = (event) => {
      if (terminal) return; // Nothing follows the final event.
      turnId ??= event.turnId;
      const widgetEvent = toWidgetEvent(event);
      if (widgetEvent.type === 'turn.done' || widgetEvent.type === 'turn.error') terminal = widgetEvent;
      else deliver(widgetEvent);
    };

    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
      cancel() {
        open = false;
      },
    });

    const fields = { organizationId, agentId: agent.id, conversationId };
    const settle = async (): Promise<void> => {
      let outcome: ChatTurnOutcome | null = null;
      try {
        outcome = await deps.runTurn(input, emit);
      } catch (error) {
        logger.error('webchat.turn_crashed', { ...fields, error });
      }
      if (outcome?.status === 'failed') logger.warn('webchat.turn_failed', { ...fields, errorCode: outcome.errorCode });

      await releaseLock(organizationId, conversationId, fields);
      // The visitor must always see an end to the reply, whatever the runtime did.
      deliver(
        terminal ?? {
          type: 'turn.error',
          turnId: outcome?.turnId ?? turnId,
          code: 'internal',
          message: DEFAULT_MESSAGES.internal,
          recoverable: true,
        },
      );
      if (open) {
        open = false;
        try {
          controller?.close();
        } catch {
          // Already closed or errored by the client.
        }
      }

      const remainingMs = POST_TURN_BUDGET_MS - (performance.now() - requestStartedAt);
      if (outcome?.status === 'completed' && remainingMs < MIN_POST_TURN_MS) {
        logger.info('webchat.after_turn_skipped', { ...fields, remainingMs: Math.round(remainingMs) });
      } else if (outcome?.status === 'completed') {
        try {
          await deps.afterTurn({
            organizationId,
            agentId: agent.id,
            conversationId,
            channel: input.channel,
            signal: AbortSignal.timeout(Math.floor(remainingMs)),
          });
        } catch (error) {
          logger.error('webchat.after_turn_failed', { ...fields, error });
        }
      }
    };

    return { stream, done: settle().catch((error: unknown) => logger.error('webchat.settle_failed', { ...fields, error })) };
  }

  return {
    async describeWidget(widgetKey) {
      const published = await lookupWidget(widgetKey);
      return published ? toPublicAgent(published) : null;
    },

    async startSession(request, client) {
      const { widgetKey, sessionToken } = parseRequest(sessionRequestSchema, request);
      await enforceSessionLimit(client);

      // One read: the widget, and the restored visitor's active conversation. Page views never create rows.
      const session = await service.run(async (sql) => {
        const published = await findPublishedWidget(sql, widgetKey);
        if (!published) return null;
        const { agent } = published;
        const restoredVisitorId = visitorOf(sessionToken, agent.id);
        if (restoredVisitorId === null) return { published, visitorId: randomUUID(), conversation: null };

        const active = await getActiveVisitorConversation(sql, {
          organizationId: agent.organizationId,
          agentId: agent.id,
          visitorId: restoredVisitorId,
        });
        const messages = active
          ? await listMessages(sql, agent.organizationId, active.id, {
              roles: ['user', 'assistant'],
              limit: RESTORED_MESSAGE_LIMIT,
            })
          : [];
        return {
          published,
          visitorId: restoredVisitorId,
          conversation: active ? { id: active.id, messages: toPublicMessages(messages) } : null,
        };
      });
      if (!session) throw new WebChatError('widget_unavailable', 404);

      return {
        sessionToken: issueToken(session.published.agent.id, session.visitorId),
        agent: toPublicAgent(session.published),
        conversation: session.conversation,
      };
    },

    async openMessageStream(request, client) {
      // Wall-clock start of the request: post-turn work is budgeted against the route's maxDuration.
      const requestStartedAt = performance.now();
      const { widgetKey, sessionToken, text } = parseRequest(sendMessageRequestSchema, request);
      // Per-IP first, before any lookup: floods of bad keys or tokens are throttled too.
      const ipHash = ipHashOf(client);
      await enforceLimit('ip', `webchat:ip:${ipHash}`, widget.rateLimits.ipPerMinute, { ipHash });

      const published = await requireWidget(widgetKey);
      const visitorId = requireVisitor(sessionToken, published);
      const { agent, channel } = published;
      const organizationId = agent.organizationId;
      const scope = { organizationId, agentId: agent.id };
      const visitor = { organizationId, agentId: agent.id, visitorId };

      // The widget's and the organization's budgets are shared by all the tenant's visitors, so unauthenticated
      // and busy requests must not drain them: a busy conversation is refused (409) before anything is charged.
      // A visitor without an active conversation is charged BEFORE it is created, so a message the budgets reject
      // never leaves an empty conversation behind (rejected requests would otherwise add rows past the budgets).
      const active = await service.run(async (sql) => {
        const conversation = await getActiveVisitorConversation(sql, visitor);
        if (!conversation) return null;
        return {
          id: conversation.id,
          locked: await tryAcquireTurnLock(sql, organizationId, conversation.id, TURN_LOCK_TTL_SECONDS),
        };
      });
      if (active && !active.locked) throw conversationBusy({ ...scope, conversationId: active.id });

      try {
        await enforceLimit('widget', `webchat:widget:${channel.id}`, widget.rateLimits.widgetPerMinute, scope);
        await enforceLimit('organization', `webchat:org:${organizationId}`, widget.rateLimits.organizationPerMinute, scope);
      } catch (error) {
        // No turn runs: the conversation must be free for the visitor's next message.
        if (active) await releaseLock(organizationId, active.id, { ...scope, conversationId: active.id });
        throw error;
      }

      let conversationId: string;
      if (active) {
        conversationId = active.id;
      } else {
        const opened = await service.run(async (sql) => {
          const conversation = await getOrCreateVisitorConversation(sql, { ...visitor, channel: CHANNEL });
          return {
            id: conversation.id,
            locked: await tryAcquireTurnLock(sql, organizationId, conversation.id, TURN_LOCK_TTL_SECONDS),
          };
        });
        // Only when first messages of this visitor race (e.g. from two tabs): the other one opened the
        // conversation and runs its turn. This one was charged without a turn, within its per-IP limit.
        if (!opened.locked) throw conversationBusy({ ...scope, conversationId: opened.id });
        conversationId = opened.id;
      }

      return streamTurn(
        {
          organizationId,
          agent,
          conversationId,
          channel: CHANNEL,
          userText: text,
          endUserId: endUserIdFor(visitorId),
        },
        requestStartedAt,
      );
    },

    async resetConversation(request, client) {
      const { widgetKey, sessionToken } = parseRequest(resetRequestSchema, request);
      await enforceSessionLimit(client);

      const published = await requireWidget(widgetKey);
      const visitorId = requireVisitor(sessionToken, published);
      const { agent } = published;
      await service.run(async (sql) => {
        const active = await getActiveVisitorConversation(sql, {
          organizationId: agent.organizationId,
          agentId: agent.id,
          visitorId,
        });
        // Closed, not deleted: the conversation stays in the admin's history; the next message starts a new one.
        if (active) await closeConversation(sql, agent.organizationId, active.id);
      });
      return { ok: true, sessionToken: issueToken(agent.id, visitorId) };
    },
  };
}
