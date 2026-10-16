import { isDeepStrictEqual } from 'node:util';
import type { z } from 'zod';
import type { TextGenerationRequest, TextModelProvider } from '@/server/ai/types';
import { verifyWidgetSession, type WidgetSessionClaims } from '@/server/channels/webchat/session-token';
import { loadAiConfig, loadWidgetConfig, type ModelPrice, type WidgetConfig } from '@/server/config/env';
import type { ScopedDb } from '@/server/db/scope';
import { toDate, toNumber } from '@/server/db/sql';
import { setWebChatEnabled, updateAgentSettings } from '@/server/domain/agents/repository';
import type { AgentSettings } from '@/server/domain/agents/schemas';
import type { Agent, AgentChannel } from '@/server/domain/agents/types';
import { replaceBusinessHours, upsertBusinessProfile } from '@/server/domain/business/repository';
import type { BusinessProfileInput } from '@/server/domain/business/schemas';
import type { BusinessProfile, HoursInterval } from '@/server/domain/business/types';
import type { MessageRole } from '@/server/domain/conversations/types';
import { ingestTextSource } from '@/server/domain/knowledge/ingestion';
import type { KnowledgeSource } from '@/server/domain/knowledge/types';
import { createOrganization, type Organization } from '@/server/domain/organizations/service';
import type { LogFields, LogLevel, Logger } from '@/server/observability/logger';
import { createServices, type AppServices } from '@/server/services';
import {
  SSE_CONTENT_TYPE,
  apiErrorSchema,
  createSseParser,
  resetResponseSchema,
  sessionResponseSchema,
  type ApiErrorCode,
  type ResetResponse,
  type SessionResponse,
  type WidgetEvent,
} from '@/shared/widget-protocol';
import { createTestDatabase, type TestDatabase } from './db';
import { FakeEmbeddingProvider } from './fake-embeddings';
import { createAuthUser, type UserFixture } from './fixtures';
import { FakeReceptionistModel } from './receptionist-model';

/**
 * App harness for acceptance tests: the real application — public route handlers -> web chat channel ->
 * agent runtime -> tools -> domain services -> usage metering — over PGlite, with deterministic fake
 * model/embedding providers, a controllable clock and a recording logger. Configuration goes through the
 * production Zod loaders (`loadAiConfig`, `loadWidgetConfig`) and composition root (`createServices`).
 *
 * The route modules get their services from `@/server/app-services` and hand post-response work to
 * `after()` from 'next/server'. Vitest 5 only honours `vi.mock` at the top level of a TEST file, so every
 * test file that calls the routes through this harness starts with:
 *
 *   import type * as nextServer from 'next/server';
 *   vi.mock('@/server/app-services', async () => (await import('../support/app-harness')).mockedAppServices);
 *   vi.mock('next/server', async (importOriginal) => ({
 *     ...(await importOriginal<typeof nextServer>()),
 *     ...(await import('../support/app-harness')).mockedNextServer,
 *   }));
 *
 * Route modules are imported lazily (first `post`), after which the harness checks both mocks are active.
 *
 * Failures a visitor never sees (metering, audit, summary, tool or turn errors, unpriced models) only show
 * in the log: acceptance files fail any test that leaves an entry at warn level or above, after the test
 * has taken the warnings it expects with `logger.take(event)`.
 */

// ── configuration ───────────────────────────────────────────────────────────

/** Test secret, identical in every harness: visitor tokens survive a "redeploy" with another configuration. */
export const WIDGET_SESSION_SECRET = 'acceptance-harness-widget-session-secret-0123456789';
export const APP_ORIGIN = 'http://localhost:3000';
const APP_HOST = 'localhost:3000';

/**
 * Default start of the harness clock: Tuesday 2026-10-06 14:05:30 UTC (09:05 in America/Chicago). The clock
 * stands still unless a test moves it, so every request of a test shares one rate-limit window.
 */
export const HARNESS_START = new Date('2026-10-06T14:05:30.000Z');

/** Ids of the fake text providers every harness registers (each a FakeReceptionistModel by default). */
export const FAKE_TEXT_PROVIDERS = ['receptionist', 'escalation', 'alt'] as const;
export const FAKE_EMBEDDING_PROVIDER = 'fake';

/** Prices (USD per 1M tokens) for the fake model names, passed through AI_MODEL_PRICING_JSON. */
export const FAKE_MODEL_PRICING: Readonly<Record<string, ModelPrice>> = Object.freeze({
  'receptionist-mini': { inputPerMTok: 0.1, cachedInputPerMTok: 0.01, outputPerMTok: 0.5 },
  'escalation-max': { inputPerMTok: 2, cachedInputPerMTok: 0.2, outputPerMTok: 10 },
  'alt-mini': { inputPerMTok: 0.3, outputPerMTok: 1.2 },
  'fake-embed-v1': { inputPerMTok: 0.1, outputPerMTok: 0 },
  'fake-embed-v2': { inputPerMTok: 0.1, outputPerMTok: 0 },
});

type AiEnvKey =
  | 'AI_TEXT_PROVIDER'
  | 'AI_TEXT_MODEL'
  | 'AI_TEXT_REASONING_EFFORT'
  | 'AI_ESCALATION_PROVIDER'
  | 'AI_ESCALATION_MODEL'
  | 'AI_ESCALATION_REASONING_EFFORT'
  | 'AI_ESCALATION_ENABLED'
  | 'AI_EMBEDDING_PROVIDER'
  | 'AI_EMBEDDING_MODEL'
  | 'AI_EMBEDDING_DIMENSIONS'
  | 'AI_MAX_RETRIEVED_CHUNKS'
  | 'AI_MAX_RETRIEVED_TOKENS'
  | 'AI_MAX_RECENT_MESSAGES'
  | 'AI_MIN_RETRIEVAL_SIMILARITY'
  | 'AI_MAX_OUTPUT_TOKENS'
  | 'AI_MAX_TOOL_ROUNDS'
  | 'AI_REQUEST_TIMEOUT_MS'
  | 'AI_MODEL_PRICING_JSON';

/** AI environment variables, as a deployment would set them. */
export type AiEnv = Partial<Record<AiEnvKey, string>>;

type WidgetEnvKey =
  | 'WIDGET_SESSION_SECRET'
  | 'WIDGET_SESSION_TTL_HOURS'
  | 'RATE_LIMIT_IP_PER_MINUTE'
  | 'RATE_LIMIT_WIDGET_PER_MINUTE'
  | 'RATE_LIMIT_ORG_PER_MINUTE';

export type WidgetEnv = Partial<Record<WidgetEnvKey, string>>;

/** The harness defaults: cheap default model, an escalation model (enabled, as in production) and embeddings. */
export const DEFAULT_AI_ENV: Readonly<AiEnv> = Object.freeze({
  AI_TEXT_PROVIDER: 'receptionist',
  AI_TEXT_MODEL: 'receptionist-mini',
  AI_ESCALATION_PROVIDER: 'escalation',
  AI_ESCALATION_MODEL: 'escalation-max',
  AI_EMBEDDING_PROVIDER: FAKE_EMBEDDING_PROVIDER,
  AI_EMBEDDING_MODEL: 'fake-embed-v1',
  AI_MODEL_PRICING_JSON: JSON.stringify(FAKE_MODEL_PRICING),
});

// ── route mocks (wired by the test file's top-level vi.mock calls) ──────────

const wiring: { services: AppServices | null; afterWork: Promise<unknown>[]; afterCalls: number; verified: boolean } = {
  services: null,
  afterWork: [],
  afterCalls: 0,
  verified: false,
};

/** Module body for `vi.mock('@/server/app-services', …)`: the services of the harness that is calling a route. */
export const mockedAppServices = {
  getAppServices: (): AppServices => {
    if (wiring.services === null) throw new Error('app-harness: no harness is calling the routes');
    return wiring.services;
  },
};

/**
 * Overrides for `vi.mock('next/server', …)`. Outside a Next.js request scope `after()` throws: here its task
 * starts right away (the turn runs detached from the response anyway) and `settle()` awaits it.
 * `connection()` (the widget page's "render per request" marker) has nothing to wait for.
 */
export const mockedNextServer = {
  after: (task: unknown): void => {
    wiring.afterCalls += 1;
    let work: Promise<unknown>;
    try {
      work = Promise.resolve(typeof task === 'function' ? (task as () => unknown)() : task);
    } catch (error) {
      work = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    // A failure surfaces in settle(), not as an unhandled rejection in between.
    void work.catch(() => undefined);
    wiring.afterWork.push(work);
  },
  connection: (): Promise<void> => Promise.resolve(),
};

const ROUTES: Readonly<Record<WidgetApiPath, () => Promise<{ POST: (request: Request) => Promise<Response> }>>> = {
  '/api/widget/session': () => import('@/app/api/widget/session/route'),
  '/api/widget/messages': () => import('@/app/api/widget/messages/route'),
  '/api/widget/reset': () => import('@/app/api/widget/reset/route'),
};

export type WidgetApiPath = '/api/widget/session' | '/api/widget/messages' | '/api/widget/reset';

async function verifyRouteMocks(): Promise<void> {
  if (wiring.verified) return;
  const [appServices, nextServer] = await Promise.all([import('@/server/app-services'), import('next/server')]);
  if (appServices.getAppServices !== mockedAppServices.getAppServices || nextServer.after !== mockedNextServer.after) {
    throw new Error(
      "app-harness: mock '@/server/app-services' and 'next/server' at the top of the test file (see tests/support/app-harness.ts)",
    );
  }
  wiring.verified = true;
}

// ── recording logger and clock ──────────────────────────────────────────────

export interface LogEntry {
  level: LogLevel;
  event: string;
  fields: LogFields;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Keeps every structured log entry (children share the list) so tests can assert on what was logged. */
export class RecordingLogger implements Logger {
  readonly entries: LogEntry[];
  private readonly bindings: LogFields;

  constructor(entries: LogEntry[] = [], bindings: LogFields = {}) {
    this.entries = entries;
    this.bindings = bindings;
  }

  debug(event: string, fields?: LogFields): void {
    this.record('debug', event, fields);
  }
  info(event: string, fields?: LogFields): void {
    this.record('info', event, fields);
  }
  warn(event: string, fields?: LogFields): void {
    this.record('warn', event, fields);
  }
  error(event: string, fields?: LogFields): void {
    this.record('error', event, fields);
  }
  child(bindings: LogFields): Logger {
    return new RecordingLogger(this.entries, { ...this.bindings, ...bindings });
  }

  /** Entries at `level` or above. */
  atLeast(level: LogLevel): LogEntry[] {
    return this.entries.filter((entry) => LEVEL_ORDER[entry.level] >= LEVEL_ORDER[level]);
  }

  /** Event names of the entries at `level` or above, in order (readable in assertion diffs). */
  eventsAtLeast(level: LogLevel): string[] {
    return this.atLeast(level).map((entry) => `${entry.level} ${entry.event}`);
  }

  /** Removes and returns the entries of one event: a test takes the warnings it expects, so any others stand out. */
  take(event: string): LogEntry[] {
    const taken = this.entries.filter((entry) => entry.event === event);
    const kept = this.entries.filter((entry) => entry.event !== event);
    this.entries.splice(0, this.entries.length, ...kept);
    return taken;
  }

  /** Forgets every entry (for this logger and its children), e.g. between tests. */
  clear(): void {
    this.entries.length = 0;
  }

  private record(level: LogLevel, event: string, fields: LogFields = {}): void {
    this.entries.push({ level, event, fields: { ...this.bindings, ...fields } });
  }
}

export interface HarnessClock {
  readonly now: () => Date;
  set(at: Date): void;
  advance(ms: number): void;
}

function createClock(start: Date): HarnessClock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    set: (at) => {
      current = at.getTime();
    },
    advance: (ms) => {
      current += ms;
    },
  };
}

// ── harness ─────────────────────────────────────────────────────────────────

export interface AppHarnessOptions {
  /** AI environment overrides, merged over DEFAULT_AI_ENV and parsed by `loadAiConfig`. */
  ai?: AiEnv;
  /** Text providers by id, merged over the FakeReceptionistModel defaults (FAKE_TEXT_PROVIDERS). */
  textProviders?: Record<string, TextModelProvider>;
  /** Widget environment overrides, parsed by `loadWidgetConfig`. */
  widget?: WidgetEnv;
  /** Reuse a database (e.g. a "redeploy" with another configuration). `close()` then leaves it open. */
  database?: TestDatabase;
  /** Share a logger (e.g. with the harness that owns the database). */
  logger?: RecordingLogger;
  /** Start of the harness clock (default HARNESS_START). */
  now?: Date;
}

export interface PostInit {
  /** Extra or replacement request headers; `null` removes a default one (e.g. `origin`). */
  headers?: Record<string, string | null>;
}

export interface TurnResult {
  response: Response;
  events: WidgetEvent[];
  turnId: string;
  conversationId: string;
  /** The final event: turn.done or turn.error. */
  terminal: Extract<WidgetEvent, { type: 'turn.done' | 'turn.error' }>;
  /** The turn.done text; null when the turn failed. */
  reply: string | null;
  /** Every text delta, joined. */
  streamedText: string;
  toolCalls: Array<Extract<WidgetEvent, { type: 'tool.call' }>>;
  toolResults: Array<Extract<WidgetEvent, { type: 'tool.result' }>>;
}

export interface ApiErrorResult {
  status: number;
  code: ApiErrorCode;
  message: string;
  retryAfter: string | null;
}

/** A tenant as the product sets it up: onboarding, then the owner's configuration under RLS. */
export interface TenantSpec {
  name: string;
  agent: AgentSettings;
  profile: BusinessProfileInput;
  hours: HoursInterval[];
  knowledge: ReadonlyArray<{ title: string; text: string }>;
  /** Publish the web chat widget (default true). */
  publish?: boolean;
}

export interface ProvisionedTenant {
  owner: UserFixture;
  /** The owner's user-scoped (RLS) database access — what the admin UI uses. */
  asOwner: ScopedDb;
  organization: Organization;
  agent: Agent;
  profile: BusinessProfile;
  hours: HoursInterval[];
  channel: AgentChannel;
  widgetKey: string;
  sources: KnowledgeSource[];
}

export interface MessageRecord {
  id: string;
  seq: number;
  role: MessageRole;
  content: string;
  toolName: string | null;
  toolCallId: string | null;
  toolRunId: string | null;
  data: Record<string, unknown>;
  createdAt: Date;
}

export interface ToolRunRow {
  id: string;
  organizationId: string;
  agentId: string;
  conversationId: string | null;
  channel: string;
  toolName: string;
  providerCallId: string | null;
  status: string;
  input: unknown;
  output: unknown;
  errorCode: string | null;
  idempotencyKey: string | null;
  replayed: boolean;
}

export interface UsageRow {
  organizationId: string;
  agentId: string | null;
  conversationId: string | null;
  kind: string;
  purpose: string;
  provider: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  toolCalls: number;
  costUsd: number;
  pricingKnown: boolean;
  metadata: Record<string, unknown>;
}

export interface ConversationRow {
  id: string;
  organizationId: string;
  agentId: string;
  channel: string;
  status: string;
  visitorId: string | null;
  contactId: string | null;
  summary: string;
  summaryThroughSeq: number;
  messageCount: number;
  turnLockedUntil: Date | null;
  closedAt: Date | null;
}

export interface AppHarness {
  t: TestDatabase;
  services: AppServices;
  textModels: Readonly<Record<string, TextModelProvider>>;
  embeddings: FakeEmbeddingProvider;
  widget: WidgetConfig;
  clock: HarnessClock;
  logger: RecordingLogger;
  /** Calls the real route handler module with a browser-like same-origin request (a fresh client IP each call). */
  post(path: WidgetApiPath, body: unknown, init?: PostInit): Promise<Response>;
  /** Parses an SSE Response into WidgetEvents with the widget's own parser, checking the exact framing. */
  readEvents(response: Response): Promise<WidgetEvent[]>;
  /** readEvents for a messages stream, as one turn (it must start with turn.start). */
  readTurn(response: Response): Promise<TurnResult>;
  /** Parses an ApiError response (JSON, no-store, nothing beyond the protocol). */
  readError(response: Response): Promise<ApiErrorResult>;
  /** POST /api/widget/session, expecting 200. */
  openSession(widgetKey: string, sessionToken?: string, init?: PostInit): Promise<SessionResponse>;
  /** POST /api/widget/messages, expecting a stream; reads it and awaits the post-response work. */
  sendMessage(widgetKey: string, sessionToken: string, text: string, init?: PostInit): Promise<TurnResult>;
  /** POST /api/widget/reset, expecting 200. */
  resetConversation(widgetKey: string, sessionToken: string, init?: PostInit): Promise<ResetResponse>;
  /** Awaits all work handed to `after()` (the detached turn and its post-turn rolling summary). */
  settle(): Promise<void>;
  /** How many tasks the routes have handed to `after()` so far (in this test file). */
  afterTaskCount(): number;
  /** The claims of a session token as the server verifies them now (null when it would be rejected). */
  decodeSession(token: string): WidgetSessionClaims | null;
  /** Requests a recording text provider (fake or scripted) received, in order. */
  requestsTo(providerId: string): TextGenerationRequest[];
  /** Onboards a tenant through the product's domain services (see TenantSpec). */
  provisionTenant(spec: TenantSpec): Promise<ProvisionedTenant>;
  /** Messages of a conversation in seq order (privileged read: the database is the record). */
  messages(organizationId: string, conversationId: string): Promise<MessageRecord[]>;
  toolRuns(organizationId: string, conversationId: string): Promise<ToolRunRow[]>;
  /** Usage rows of the organization (optionally one conversation), oldest first. */
  usage(organizationId: string, conversationId?: string): Promise<UsageRow[]>;
  conversation(organizationId: string, conversationId: string): Promise<ConversationRow | null>;
  close(): Promise<void>;
}

/** FakeReceptionistModel, ScriptedTextProvider and similar test doubles keep every request they receive. */
interface RecordingTextProvider extends TextModelProvider {
  readonly requests: TextGenerationRequest[];
}

function isRecording(provider: TextModelProvider): provider is RecordingTextProvider {
  return Array.isArray((provider as Partial<RecordingTextProvider>).requests);
}

let clientCounter = 0;
/**
 * A distinct client per request: per-IP rate limits never couple unrelated simulated visitors. IPv6 clients
 * are counted by /64 network, so each one gets a network of its own.
 */
function nextClientIp(): string {
  clientCounter += 1;
  return `2001:db8:${(clientCounter >>> 16).toString(16)}:${(clientCounter & 0xffff).toString(16)}::1`;
}

export async function createAppHarness(options: AppHarnessOptions = {}): Promise<AppHarness> {
  const ownsDatabase = options.database === undefined;
  const t = options.database ?? (await createTestDatabase());
  try {
    return buildHarness(t, ownsDatabase, options);
  } catch (error) {
    if (ownsDatabase) await t.close();
    throw error;
  }
}

function buildHarness(t: TestDatabase, ownsDatabase: boolean, options: AppHarnessOptions): AppHarness {
  const logger = options.logger ?? new RecordingLogger();
  const clock = createClock(options.now ?? HARNESS_START);
  const ai = loadAiConfig({ ...DEFAULT_AI_ENV, ...options.ai });
  const widget = loadWidgetConfig({ WIDGET_SESSION_SECRET, ...options.widget });
  const embeddings = new FakeEmbeddingProvider(FAKE_EMBEDDING_PROVIDER);
  const textModels: Record<string, TextModelProvider> = {};
  for (const id of FAKE_TEXT_PROVIDERS) textModels[id] = new FakeReceptionistModel(id);
  Object.assign(textModels, options.textProviders);

  const services = createServices({
    db: t.db,
    logger,
    ai,
    widget,
    now: clock.now,
    providers: {
      text: Object.fromEntries(Object.entries(textModels).map(([id, provider]) => [id, () => provider])),
      embedding: { [FAKE_EMBEDDING_PROVIDER]: () => embeddings },
    },
  });

  async function post(path: WidgetApiPath, body: unknown, init: PostInit = {}): Promise<Response> {
    const route = await ROUTES[path]();
    await verifyRouteMocks();
    const headers = new Headers();
    const defaults: Record<string, string> = {
      'content-type': 'application/json',
      host: APP_HOST,
      // The widget iframe is served by the app itself: its requests are same-origin.
      origin: APP_ORIGIN,
      'x-forwarded-for': nextClientIp(),
    };
    for (const [name, value] of Object.entries({ ...defaults, ...init.headers })) {
      if (value !== null) headers.set(name, value);
    }
    const request = new Request(`${APP_ORIGIN}${path}`, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    // The route reads its services synchronously before its first await, so this is the harness it uses.
    wiring.services = services;
    return route.POST(request);
  }

  async function settle(): Promise<void> {
    while (wiring.afterWork.length > 0) {
      await Promise.all(wiring.afterWork.splice(0));
    }
  }

  async function sendMessage(widgetKey: string, sessionToken: string, text: string, init?: PostInit): Promise<TurnResult> {
    const turn = await readTurn(await post('/api/widget/messages', { widgetKey, sessionToken, text }, init));
    await settle();
    return turn;
  }

  async function provisionTenant(spec: TenantSpec): Promise<ProvisionedTenant> {
    // Sign-up happens in Supabase Auth (outside the app): the account is a fixture.
    const owner = await createAuthUser(t.db);
    // Onboarding runs on the privileged connection (the user is not a member yet), like createOrganizationAction.
    const onboarded = await createOrganization(t.db, { name: spec.name, ownerUserId: owner.id, agentName: spec.agent.name });
    const { organization } = onboarded;
    const agentId = onboarded.agent.id;
    // From here on: the owner in the admin UI, i.e. user scope with RLS.
    const asOwner = t.asUser(owner.id);
    const configured = await asOwner.run(async (sql) => {
      const agent = await updateAgentSettings(sql, organization.id, agentId, spec.agent);
      const profile = await upsertBusinessProfile(sql, organization.id, agentId, spec.profile);
      const hours = await replaceBusinessHours(sql, organization.id, agentId, spec.hours);
      const channel = await setWebChatEnabled(sql, organization.id, agentId, spec.publish ?? true);
      return { agent, profile, hours, channel };
    });
    const sources: KnowledgeSource[] = [];
    for (const { title, text } of spec.knowledge) {
      const source = await ingestTextSource(
        asOwner,
        services.embedder,
        { organizationId: organization.id, agentId: null, kind: 'text', title, text, createdBy: owner.id },
        { logger },
      );
      if (source.status !== 'ready') {
        throw new Error(`provisionTenant: knowledge "${title}" is ${source.status} (${source.error ?? 'no reason'})`);
      }
      sources.push(source);
    }
    const widgetKey = configured.channel.publicKey;
    if (widgetKey === null) throw new Error('provisionTenant: the web chat channel has no widget key');
    return { owner, asOwner, organization, ...configured, widgetKey, sources };
  }

  return {
    t,
    services,
    textModels,
    embeddings,
    widget,
    clock,
    logger,
    post,
    readEvents,
    readTurn,
    readError,
    openSession: async (widgetKey, sessionToken, init) =>
      readJson(
        await post('/api/widget/session', sessionToken === undefined ? { widgetKey } : { widgetKey, sessionToken }, init),
        sessionResponseSchema,
      ),
    sendMessage,
    resetConversation: async (widgetKey, sessionToken, init) =>
      readJson(await post('/api/widget/reset', { widgetKey, sessionToken }, init), resetResponseSchema),
    settle,
    afterTaskCount: () => wiring.afterCalls,
    decodeSession: (token) => verifyWidgetSession(token, { secret: widget.sessionSecret, now: clock.now() }),
    requestsTo: (providerId) => {
      const provider = textModels[providerId];
      if (provider === undefined || !isRecording(provider)) throw new Error(`Text provider "${providerId}" does not record its requests`);
      return provider.requests;
    },
    provisionTenant,
    messages: (organizationId, conversationId) => readMessages(t, organizationId, conversationId),
    toolRuns: (organizationId, conversationId) => readToolRuns(t, organizationId, conversationId),
    usage: (organizationId, conversationId) => readUsage(t, organizationId, conversationId),
    conversation: (organizationId, conversationId) => readConversation(t, organizationId, conversationId),
    close: async () => {
      if (wiring.services === services) wiring.services = null;
      if (ownsDatabase) await t.close();
    },
  };
}

// ── wire protocol readers ───────────────────────────────────────────────────

/**
 * Reads the whole stream with the widget's parser and checks it is exactly the protocol: every frame is
 * `event: <type>\ndata: <json>`, the JSON carries no field beyond the event schema (no internal error
 * codes, tool outputs or tenant ids), and there is exactly one terminal event, the last one.
 */
async function readEvents(response: Response): Promise<WidgetEvent[]> {
  const contentType = response.headers.get('content-type');
  if (response.status !== 200 || contentType !== SSE_CONTENT_TYPE || !response.body) {
    throw new Error(`Expected a 200 ${SSE_CONTENT_TYPE} stream, got ${response.status} ${String(contentType)}: ${await response.text()}`);
  }
  const events: WidgetEvent[] = [];
  const invalid: string[] = [];
  const parser = createSseParser(
    (event) => events.push(event),
    (raw) => invalid.push(raw),
  );
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    raw += text;
    parser.push(text);
  }
  const tail = decoder.decode();
  raw += tail;
  parser.push(tail);
  parser.flush();
  if (invalid.length > 0) throw new Error(`The stream carried frames that are not widget events: ${invalid.join(' | ')}`);

  const frames = raw.split('\n\n');
  if (frames.pop() !== '' || frames.length !== events.length) {
    throw new Error(`Unexpected SSE framing: ${JSON.stringify(raw)}`);
  }
  frames.forEach((frame, index) => {
    const event = events[index];
    const [eventLine, dataLine, ...rest] = frame.split('\n');
    if (event === undefined || eventLine !== `event: ${event.type}` || !dataLine?.startsWith('data: ') || rest.length > 0) {
      throw new Error(`Malformed SSE frame #${index}: ${JSON.stringify(frame)}`);
    }
    const data: unknown = JSON.parse(dataLine.slice('data: '.length));
    if (!isDeepStrictEqual(data, event)) throw new Error(`SSE frame #${index} carries fields beyond the protocol: ${dataLine}`);
  });

  const types = events.map((event) => event.type);
  const firstTerminal = types.findIndex((type) => type === 'turn.done' || type === 'turn.error');
  if (events.length === 0 || firstTerminal !== events.length - 1) {
    throw new Error(`Expected exactly one terminal event, at the end: ${types.join(', ')}`);
  }
  return events;
}

async function readTurn(response: Response): Promise<TurnResult> {
  const events = await readEvents(response);
  const start = events[0];
  const terminal = events.at(-1);
  if (start?.type !== 'turn.start') throw new Error(`The turn did not start: ${JSON.stringify(events)}`);
  if (terminal?.type !== 'turn.done' && terminal?.type !== 'turn.error') throw new Error('The turn did not end');
  return {
    response,
    events,
    turnId: start.turnId,
    conversationId: start.conversationId,
    terminal,
    reply: terminal.type === 'turn.done' ? terminal.text : null,
    streamedText: events.flatMap((event) => (event.type === 'text.delta' ? [event.delta] : [])).join(''),
    toolCalls: events.flatMap((event) => (event.type === 'tool.call' ? [event] : [])),
    toolResults: events.flatMap((event) => (event.type === 'tool.result' ? [event] : [])),
  };
}

function checkJsonHeaders(response: Response, body: string): void {
  const contentType = response.headers.get('content-type') ?? '';
  const cacheControl = response.headers.get('cache-control');
  if (!contentType.startsWith('application/json') || cacheControl !== 'no-store') {
    throw new Error(`Expected an uncacheable JSON response, got ${contentType} / ${String(cacheControl)}: ${body}`);
  }
}

/** A 200 JSON body that is exactly the schema (nothing beyond the protocol reaches the browser). */
async function readJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const text = await response.text();
  if (response.status !== 200) throw new Error(`Expected 200, got ${response.status}: ${text}`);
  checkJsonHeaders(response, text);
  const body: unknown = JSON.parse(text);
  const parsed = schema.parse(body);
  if (!isDeepStrictEqual(body, parsed)) throw new Error(`The response carries fields beyond the protocol: ${text}`);
  return parsed;
}

async function readError(response: Response): Promise<ApiErrorResult> {
  const text = await response.text();
  if (response.status < 400) throw new Error(`Expected an error status, got ${response.status}: ${text}`);
  checkJsonHeaders(response, text);
  const body: unknown = JSON.parse(text);
  const parsed = apiErrorSchema.parse(body);
  if (!isDeepStrictEqual(body, parsed)) throw new Error(`The error carries fields beyond the protocol: ${text}`);
  return {
    status: response.status,
    code: parsed.error.code,
    message: parsed.error.message,
    retryAfter: response.headers.get('retry-after'),
  };
}

// ── database readers (privileged: the database, not the transcript a model saw, is the record) ──

async function readMessages(t: TestDatabase, organizationId: string, conversationId: string): Promise<MessageRecord[]> {
  const rows = await t.db.query<{
    id: string;
    seq: number | string;
    role: MessageRole;
    content: string;
    tool_name: string | null;
    tool_call_id: string | null;
    tool_run_id: string | null;
    data: Record<string, unknown>;
    created_at: Date | string;
  }>(
    `select id, seq, role, content, tool_name, tool_call_id, tool_run_id, data, created_at
     from public.messages where organization_id = $1 and conversation_id = $2 order by seq`,
    [organizationId, conversationId],
  );
  return rows.map((row) => ({
    id: row.id,
    seq: toNumber(row.seq),
    role: row.role,
    content: row.content,
    toolName: row.tool_name,
    toolCallId: row.tool_call_id,
    toolRunId: row.tool_run_id,
    data: row.data,
    createdAt: toDate(row.created_at),
  }));
}

async function readToolRuns(t: TestDatabase, organizationId: string, conversationId: string): Promise<ToolRunRow[]> {
  const rows = await t.db.query<{
    id: string;
    organization_id: string;
    agent_id: string;
    conversation_id: string | null;
    channel: string;
    tool_name: string;
    provider_call_id: string | null;
    status: string;
    input: unknown;
    output: unknown;
    error_code: string | null;
    idempotency_key: string | null;
    replayed: boolean;
  }>(
    `select id, organization_id, agent_id, conversation_id, channel, tool_name, provider_call_id, status, input, output,
            error_code, idempotency_key, replayed
     from public.tool_runs where organization_id = $1 and conversation_id = $2 order by started_at, id`,
    [organizationId, conversationId],
  );
  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    agentId: row.agent_id,
    conversationId: row.conversation_id,
    channel: row.channel,
    toolName: row.tool_name,
    providerCallId: row.provider_call_id,
    status: row.status,
    input: row.input,
    output: row.output,
    errorCode: row.error_code,
    idempotencyKey: row.idempotency_key,
    replayed: row.replayed,
  }));
}

async function readUsage(t: TestDatabase, organizationId: string, conversationId?: string): Promise<UsageRow[]> {
  const rows = await t.db.query<{
    organization_id: string;
    agent_id: string | null;
    conversation_id: string | null;
    kind: string;
    purpose: string;
    provider: string;
    model: string;
    input_tokens: number | string;
    cached_input_tokens: number | string;
    cache_write_tokens: number | string;
    output_tokens: number | string;
    reasoning_tokens: number | string;
    tool_calls: number | string;
    estimated_cost_usd: number | string;
    pricing_known: boolean;
    metadata: Record<string, unknown>;
  }>(
    `select organization_id, agent_id, conversation_id, kind, purpose, provider, model, input_tokens, cached_input_tokens,
            cache_write_tokens, output_tokens, reasoning_tokens, tool_calls, estimated_cost_usd, pricing_known, metadata
     from public.usage_records
     where organization_id = $1 and ($2::uuid is null or conversation_id = $2::uuid)
     order by created_at, id`,
    [organizationId, conversationId ?? null],
  );
  return rows.map((row) => ({
    organizationId: row.organization_id,
    agentId: row.agent_id,
    conversationId: row.conversation_id,
    kind: row.kind,
    purpose: row.purpose,
    provider: row.provider,
    model: row.model,
    inputTokens: toNumber(row.input_tokens),
    cachedInputTokens: toNumber(row.cached_input_tokens),
    cacheWriteTokens: toNumber(row.cache_write_tokens),
    outputTokens: toNumber(row.output_tokens),
    reasoningTokens: toNumber(row.reasoning_tokens),
    toolCalls: toNumber(row.tool_calls),
    costUsd: toNumber(row.estimated_cost_usd),
    pricingKnown: row.pricing_known,
    metadata: row.metadata,
  }));
}

async function readConversation(t: TestDatabase, organizationId: string, conversationId: string): Promise<ConversationRow | null> {
  const [row] = await t.db.query<{
    id: string;
    organization_id: string;
    agent_id: string;
    channel: string;
    status: string;
    visitor_id: string | null;
    contact_id: string | null;
    summary: string;
    summary_through_seq: number | string;
    message_count: number | string;
    turn_locked_until: Date | string | null;
    closed_at: Date | string | null;
  }>(
    `select id, organization_id, agent_id, channel, status, visitor_id, contact_id, summary, summary_through_seq,
            message_count, turn_locked_until, closed_at
     from public.conversations where organization_id = $1 and id = $2`,
    [organizationId, conversationId],
  );
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    agentId: row.agent_id,
    channel: row.channel,
    status: row.status,
    visitorId: row.visitor_id,
    contactId: row.contact_id,
    summary: row.summary,
    summaryThroughSeq: toNumber(row.summary_through_seq),
    messageCount: toNumber(row.message_count),
    turnLockedUntil: row.turn_locked_until === null ? null : toDate(row.turn_locked_until),
    closedAt: row.closed_at === null ? null : toDate(row.closed_at),
  };
}
