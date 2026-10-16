import type { z } from 'zod';
import {
  MAX_SESSION_TOKEN_CHARS,
  MAX_VISITOR_MESSAGE_CHARS,
  apiErrorSchema,
  createSseParser,
  resetResponseSchema,
  sessionResponseSchema,
  type ApiErrorCode,
  type ResetRequest,
  type SendMessageRequest,
  type SessionRequest,
  type SessionResponse,
  type WidgetEvent,
} from '@/shared/widget-protocol';
import {
  acceptsInput,
  type ChatAction,
  type ChatStore,
  type ChatTurnView,
  type WidgetError,
  type WidgetState,
} from './chat-store';
import { browserTokenStorage, sessionStorageKey, type TokenStorage } from './session-storage';

/**
 * Browser controller for one chat widget. It owns every request, abort signal
 * and timer, and reduces server events into the store through the legal
 * TRANSITIONS; React components only read the store and call these methods.
 * Nothing here is a source of truth: the server persists the conversation and
 * the browser keeps only the opaque session token.
 */

export interface ChatControllerOptions {
  widgetKey: string;
  store: ChatStore;
  fetchImpl?: typeof fetch;
  storage?: TokenStorage;
  /** Origin of the chat API; '' (default) = same origin, as the widget page is served by the app. */
  baseUrl?: string;
}

/** Session and reset calls are small JSON round trips. */
const REQUEST_TIMEOUT_MS = 20_000;
/** A reply stream that delivers nothing for this long is treated as a dropped connection. */
const STREAM_IDLE_TIMEOUT_MS = 90_000;

const NETWORK_MESSAGE = "We couldn't reach the chat service. Check your connection and try again.";
const TIMEOUT_MESSAGE = 'The chat service is taking too long to respond. Please try again.';
const INTERRUPTED_MESSAGE = 'The connection dropped before the reply finished. Please try again.';

/** Used when the server gives no usable message; rate limits always get the friendly text. */
const FALLBACK_MESSAGES: Record<ApiErrorCode, string> = {
  invalid_request: "That message couldn't be sent.",
  widget_unavailable: 'This chat is currently unavailable.',
  invalid_session: 'Your chat session expired. Please try again.',
  rate_limited: 'Too many messages — please wait a moment.',
  conversation_busy: "I'm still answering your previous message — please wait a moment.",
  provider_unavailable: 'The assistant is temporarily unavailable. Please try again shortly.',
  internal: 'Something went wrong. Please try again.',
};

const RECOVERABLE: Record<ApiErrorCode, boolean> = {
  invalid_request: false,
  widget_unavailable: false,
  invalid_session: true,
  rate_limited: true,
  conversation_busy: true,
  provider_unavailable: true,
  internal: true,
};

/** What a status means when the body is not an ApiError (e.g. a proxy's error page). */
const STATUS_CODES: Readonly<Partial<Record<number, ApiErrorCode>>> = {
  400: 'invalid_request',
  401: 'invalid_session',
  404: 'widget_unavailable',
  409: 'conversation_busy',
  429: 'rate_limited',
};

type AbortReason = 'cancel' | 'dispose' | 'timeout';

/** The single request in flight. Work re-checks `reason` after every await, so aborted work never touches the store. */
interface Operation {
  readonly kind: ChatAction;
  readonly abort: AbortController;
  reason: AbortReason | null;
  timer: ReturnType<typeof setTimeout> | null;
  done: Promise<void>;
  /** Send only: the visitor's turn, and the assistant turn the server started for it. */
  readonly userTurnId: string | null;
  assistantTurnId: string | null;
  /** Send only: set by the terminal event (turn.done / turn.error). */
  finished: boolean;
  turnError: WidgetError | null;
}

/** A failure the visitor should see, already mapped to widget copy. */
class WidgetRequestError extends Error {
  readonly widgetError: WidgetError;

  constructor(widgetError: WidgetError) {
    super(widgetError.message);
    this.name = 'WidgetRequestError';
    this.widgetError = widgetError;
  }
}

function apiFailure(code: ApiErrorCode, serverMessage?: string): WidgetRequestError {
  const message = code === 'rate_limited' || !serverMessage ? FALLBACK_MESSAGES[code] : serverMessage;
  return new WidgetRequestError({ code, message, recoverable: RECOVERABLE[code] });
}

function networkFailure(message: string): WidgetRequestError {
  return new WidgetRequestError({ code: 'network', message, recoverable: true });
}

function abortedError(): Error {
  return new Error('Request aborted');
}

function hasCode(error: unknown, code: ApiErrorCode): boolean {
  return error instanceof WidgetRequestError && error.widgetError.code === code;
}

async function readApiError(response: Response): Promise<WidgetRequestError> {
  try {
    const body: unknown = await response.json();
    const parsed = apiErrorSchema.safeParse(body);
    if (parsed.success) return apiFailure(parsed.data.error.code, parsed.data.error.message);
  } catch {
    // Not JSON: fall back to what the status means.
  }
  return apiFailure(STATUS_CODES[response.status] ?? 'internal');
}

function findLastUserTurn(turns: readonly ChatTurnView[]): { turn: ChatTurnView; index: number } | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.role === 'user') return { turn, index };
  }
  return null;
}

export class ChatController {
  private readonly widgetKey: string;
  private readonly store: ChatStore;
  private readonly fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  private readonly storage: TokenStorage;
  private readonly baseUrl: string;
  private readonly storageKey: string;
  /** In-memory copy of the session token (`undefined` = storage not read yet), so blocked storage never breaks a visit. */
  private token: string | null | undefined;
  /** True once the server issued a session to this controller. */
  private sessionReady = false;
  private op: Operation | null = null;
  private localTurns = 0;

  constructor(options: ChatControllerOptions) {
    this.widgetKey = options.widgetKey;
    this.store = options.store;
    const fetchImpl = options.fetchImpl;
    // Always called as a plain function: invoking `window.fetch` with another `this` throws "Illegal invocation".
    this.fetchImpl = (url, init) => (fetchImpl ?? fetch)(url, init);
    this.storage = options.storage ?? browserTokenStorage();
    this.baseUrl = options.baseUrl ?? '';
    this.storageKey = sessionStorageKey(options.widgetKey);
  }

  /** Starts (or re-syncs) the visitor session and shows the conversation the server restored. */
  open(): Promise<void> {
    if (this.op) return this.op.kind === 'open' ? this.op.done : Promise.resolve();
    // OPENING with nothing in flight means an earlier open was disposed mid-request (e.g. a React StrictMode remount).
    if (this.store.getState().state !== 'OPENING' && !this.transition('OPENING', 'open')) return Promise.resolve();
    return this.run('open', null, async (op) => {
      const session = await this.createSession(op);
      const s = this.store.getState();
      s.setAgent(session.agent);
      s.loadConversation(session.conversation);
      this.transition('READY', 'session');
    });
  }

  /** Sends a visitor message and streams the reply into the store. Ignored while a request is in flight. */
  send(text: string): Promise<void> {
    const message = text.trim();
    const s = this.store.getState();
    if (!message || message.length > MAX_VISITOR_MESSAGE_CHARS || this.op || !acceptsInput(s.state)) {
      return Promise.resolve();
    }
    const id = this.nextLocalTurnId();
    s.setLastUserText(message);
    s.appendTurn({ id, role: 'user', text: message, streaming: false, tools: [], failed: false });
    return this.submit(message, id);
  }

  /** Repeats what failed (opening, resetting, or the last message) after a recoverable error. */
  retry(): Promise<void> {
    const s = this.store.getState();
    if (this.op || s.state !== 'ERROR' || !s.error?.recoverable) return Promise.resolve();
    if (s.failedAction === 'open') return this.open();
    if (s.failedAction === 'reset') return this.reset();
    const text = s.lastUserText;
    const last = findLastUserTurn(s.turns);
    if (s.failedAction !== 'send' || !text || !last) return Promise.resolve();
    // Ask again in place: keep the visitor's bubble, drop the failed reply.
    s.removeTurns(s.turns.slice(last.index + 1).map((turn) => turn.id));
    s.patchTurn(last.turn.id, { failed: false });
    return this.submit(text, last.turn.id);
  }

  /** Closes the conversation on the server and shows a fresh chat (the greeting again). */
  reset(): Promise<void> {
    const s = this.store.getState();
    if (this.op || !acceptsInput(s.state)) return Promise.resolve();
    const sessionToken = this.readToken();
    if (!sessionToken) {
      // Nothing was started on the server for this visitor yet.
      s.resetConversation();
      return this.open();
    }
    if (!this.transition('OPENING', 'reset')) return Promise.resolve();
    return this.run('reset', null, async (op) => {
      try {
        const request: ResetRequest = { widgetKey: this.widgetKey, sessionToken };
        const response = await this.post(op, '/api/widget/reset', request, REQUEST_TIMEOUT_MS);
        this.saveToken((await this.readJson(op, response, resetResponseSchema)).sessionToken);
      } catch (error) {
        if (op.reason || !hasCode(error, 'invalid_session')) throw error;
        // An expired session has no conversation left to close; a fresh session starts a fresh one.
        this.forgetToken();
        await this.createSession(op);
      }
      this.store.getState().resetConversation();
      this.transition('READY', 'reset');
    });
  }

  /** Stops waiting for the current reply. The server still finishes and persists the turn. */
  cancel(): void {
    const op = this.op;
    if (op?.kind !== 'send' || op.finished) return;
    this.abortOperation(op, 'cancel');
    this.op = null;
    this.settleAbortedReply(op, 'cancel');
  }

  /** Aborts whatever is in flight and clears every timer (the widget unmounted). */
  dispose(): void {
    const op = this.op;
    if (!op) return;
    this.abortOperation(op, 'dispose');
    this.op = null;
    if (op.kind === 'send' && !op.finished) this.settleAbortedReply(op, 'dispose');
  }

  // ── operations ─────────────────────────────────────────────────────────────

  private run(kind: ChatAction, userTurnId: string | null, work: (op: Operation) => Promise<void>): Promise<void> {
    const op: Operation = {
      kind,
      abort: new AbortController(),
      reason: null,
      timer: null,
      done: Promise.resolve(),
      userTurnId,
      assistantTurnId: null,
      finished: false,
      turnError: null,
    };
    this.op = op;
    // A new attempt replaces the previous failure (no stale banner while retrying).
    this.store.getState().setError(null);
    op.done = work(op)
      .catch((error: unknown) => {
        this.fail(op, error);
      })
      .finally(() => {
        this.clearTimer(op);
        if (this.op === op) this.op = null;
      });
    return op.done;
  }

  private submit(text: string, userTurnId: string): Promise<void> {
    if (!this.transition('THINKING', 'send')) return Promise.resolve();
    return this.run('send', userTurnId, async (op) => {
      // The first open may have failed (e.g. offline); the session is then created with the message.
      if (!this.sessionReady) this.adoptSession(await this.createSession(op), userTurnId);
      const response = await this.postMessage(op, text, userTurnId);
      await this.readReply(op, response);
    });
  }

  private async postMessage(op: Operation, text: string, userTurnId: string): Promise<Response> {
    try {
      return await this.post(op, '/api/widget/messages', this.messageRequest(text), STREAM_IDLE_TIMEOUT_MS);
    } catch (error) {
      if (op.reason || !hasCode(error, 'invalid_session')) throw error;
      // The token expired or was revoked: start a fresh session once, then send once more.
      this.forgetToken();
      this.adoptSession(await this.createSession(op), userTurnId);
      return this.post(op, '/api/widget/messages', this.messageRequest(text), STREAM_IDLE_TIMEOUT_MS);
    }
  }

  private messageRequest(text: string): SendMessageRequest {
    const sessionToken = this.readToken();
    if (!sessionToken) throw apiFailure('invalid_session');
    return { widgetKey: this.widgetKey, sessionToken, text };
  }

  private async createSession(op: Operation): Promise<SessionResponse> {
    const sessionToken = this.readToken();
    const request: SessionRequest = sessionToken ? { widgetKey: this.widgetKey, sessionToken } : { widgetKey: this.widgetKey };
    const response = await this.post(op, '/api/widget/session', request, REQUEST_TIMEOUT_MS);
    const session = await this.readJson(op, response, sessionResponseSchema);
    // Always store the returned token: the server may re-issue it.
    this.saveToken(session.sessionToken);
    this.sessionReady = true;
    return session;
  }

  /**
   * A session created while sending: show what the server already has for this visitor (if anything) above the
   * pending message. With nothing to restore, the visible turns stay as they are.
   */
  private adoptSession(session: SessionResponse, pendingTurnId: string): void {
    const s = this.store.getState();
    s.setAgent(session.agent);
    if (!session.conversation) return;
    const pending = s.turns.find((turn) => turn.id === pendingTurnId);
    s.loadConversation(session.conversation);
    if (pending) s.appendTurn(pending);
  }

  private async post(op: Operation, path: string, body: unknown, timeoutMs: number): Promise<Response> {
    this.armTimer(op, timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: op.abort.signal,
      });
    } catch {
      throw networkFailure(NETWORK_MESSAGE);
    }
    if (op.reason) throw abortedError();
    if (!response.ok) throw await readApiError(response);
    return response;
  }

  private async readJson<T>(op: Operation, response: Response, schema: z.ZodType<T>): Promise<T> {
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      // Malformed JSON fails validation below; a body that never fully arrived is a network failure.
      if (!(error instanceof SyntaxError) && !op.reason) throw networkFailure(NETWORK_MESSAGE);
    }
    if (op.reason) throw abortedError();
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw apiFailure('internal');
    return parsed.data;
  }

  /** Streams `text/event-stream` frames into the store until the terminal event. */
  private async readReply(op: Operation, response: Response): Promise<void> {
    const parser = createSseParser((event) => {
      if (!op.reason && !op.finished) this.reduce(op, event);
    });
    const reader = response.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      // Wakes a pending read when the request is cancelled or times out.
      const stop = () => void reader.cancel().catch(() => undefined);
      op.abort.signal.addEventListener('abort', stop, { once: true });
      try {
        for (;;) {
          // A read that fails without an abort is the connection dropping mid-reply: reported as interrupted below.
          const chunk = await reader.read().catch(() => null);
          if (!chunk || chunk.done || op.reason) break;
          this.armTimer(op, STREAM_IDLE_TIMEOUT_MS);
          parser.push(decoder.decode(chunk.value, { stream: true }));
          if (op.finished) break;
        }
        if (!op.finished && !op.reason) {
          parser.push(decoder.decode());
          parser.flush();
        }
      } finally {
        op.abort.signal.removeEventListener('abort', stop);
        // Nothing follows the terminal event: release the connection without waiting for the server to close it.
        if (op.finished) stop();
      }
    }
    if (op.reason) throw abortedError();
    if (op.turnError) throw new WidgetRequestError(op.turnError);
    if (!op.finished) throw networkFailure(INTERRUPTED_MESSAGE);
  }

  /** Reduces one server event into the store; the TRANSITIONS table guards every state change. */
  private reduce(op: Operation, event: WidgetEvent): void {
    if (event.type === 'turn.error') {
      op.finished = true;
      op.turnError = { code: event.code, message: event.message, recoverable: event.recoverable };
      return;
    }
    if (!this.trackReply(op, event.turnId)) return;
    const s = this.store.getState();
    switch (event.type) {
      case 'turn.start':
        s.setConversationId(event.conversationId);
        return;
      case 'tool.call':
        this.transition('TOOL', event.name);
        s.upsertTool(event.turnId, { callId: event.callId, name: event.name, label: event.label, status: 'running' });
        return;
      case 'tool.result': {
        const label = this.findTurn(event.turnId)?.tools.find((tool) => tool.callId === event.callId)?.label;
        s.upsertTool(event.turnId, {
          callId: event.callId,
          name: event.name,
          label: label ?? event.name,
          status: event.ok ? 'done' : 'error',
        });
        // Parallel calls: stay in TOOL until the last one has reported back.
        const running = this.findTurn(event.turnId)?.tools.some((tool) => tool.status === 'running') ?? false;
        if (!running && this.store.getState().state !== 'THINKING') this.transition('THINKING', 'tool.result');
        return;
      }
      case 'text.delta':
        if (this.store.getState().state !== 'SPEAKING') this.transition('SPEAKING', 'text.delta');
        s.appendDelta(event.turnId, event.delta);
        return;
      case 'turn.done':
        op.finished = true;
        // The final text is authoritative: it replaces whatever was streamed.
        s.patchTurn(event.turnId, { text: event.text, streaming: false });
        s.setActiveTurn(null);
        this.transition('READY', 'turn.done');
        return;
    }
  }

  /** The first event of a reply creates its assistant turn; events for any other turn are ignored. */
  private trackReply(op: Operation, turnId: string): boolean {
    if (op.assistantTurnId === null) {
      op.assistantTurnId = turnId;
      const s = this.store.getState();
      s.appendTurn({ id: turnId, role: 'assistant', text: '', streaming: true, tools: [], failed: false });
      s.setActiveTurn(turnId);
    }
    return op.assistantTurnId === turnId;
  }

  private fail(op: Operation, error: unknown): void {
    // Cancel and dispose settle synchronously when requested; late errors from aborted work are expected.
    if (op.reason === 'cancel' || op.reason === 'dispose') return;
    const widgetError: WidgetError =
      op.reason === 'timeout'
        ? { code: 'network', message: TIMEOUT_MESSAGE, recoverable: true }
        : error instanceof WidgetRequestError
          ? error.widgetError
          : { code: 'internal', message: FALLBACK_MESSAGES.internal, recoverable: true };
    const s = this.store.getState();
    if (op.kind === 'send') {
      // Mark the reply if the server started one, otherwise the visitor's message.
      if (op.assistantTurnId !== null) s.patchTurn(op.assistantTurnId, { streaming: false, failed: true });
      else if (op.userTurnId !== null) s.patchTurn(op.userTurnId, { failed: true });
      s.setActiveTurn(null);
    }
    s.setError(widgetError, op.kind);
    this.transition('ERROR', widgetError.code);
  }

  /** Keeps a stopped reply as far as it got (or drops it if nothing arrived) and frees the composer. */
  private settleAbortedReply(op: Operation, reason: AbortReason): void {
    const s = this.store.getState();
    const id = op.assistantTurnId;
    if (id !== null) {
      if (this.findTurn(id)?.text) s.patchTurn(id, { streaming: false });
      else s.removeTurns([id]);
    }
    s.setActiveTurn(null);
    this.transition('READY', reason);
  }

  // ── timers ─────────────────────────────────────────────────────────────────

  private armTimer(op: Operation, ms: number): void {
    if (op.reason) return;
    this.clearTimer(op);
    op.timer = setTimeout(() => {
      this.abortOperation(op, 'timeout');
    }, ms);
  }

  private clearTimer(op: Operation): void {
    if (op.timer !== null) {
      clearTimeout(op.timer);
      op.timer = null;
    }
  }

  private abortOperation(op: Operation, reason: AbortReason): void {
    if (op.reason) return;
    op.reason = reason;
    this.clearTimer(op);
    op.abort.abort();
  }

  // ── session token (the only thing the browser keeps) ─────────────────────

  private readToken(): string | null {
    if (this.token === undefined) {
      try {
        this.token = this.storage.get(this.storageKey);
      } catch {
        this.token = null;
      }
    }
    // A corrupted value would fail request validation; a fresh session is better than a dead widget.
    return this.token && this.token.length <= MAX_SESSION_TOKEN_CHARS ? this.token : null;
  }

  private saveToken(token: string): void {
    this.token = token;
    try {
      this.storage.set(this.storageKey, token);
    } catch {
      // The in-memory copy keeps this page working.
    }
  }

  private forgetToken(): void {
    this.token = null;
    try {
      this.storage.remove(this.storageKey);
    } catch {
      // Nothing else to clean up.
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private transition(next: WidgetState, reason: string): boolean {
    return this.store.getState().transition(next, reason);
  }

  private findTurn(id: string): ChatTurnView | undefined {
    return this.store.getState().turns.find((turn) => turn.id === id);
  }

  private nextLocalTurnId(): string {
    this.localTurns += 1;
    return `local-${this.localTurns}`;
  }
}
