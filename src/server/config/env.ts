import 'server-only';
import { z } from 'zod';
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from '@/server/ai/retry';
import { PRICING_SNAPSHOT_DATE } from './pricing';

/**
 * Server configuration, validated with Zod. Sections are parsed lazily so a
 * script or test only needs the variables it actually uses, and `next build`
 * never requires runtime secrets.
 *
 * Model and provider names live here (and in .env) only — never in business code.
 */

type Env = Record<string, string | undefined>;

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const nonEmpty = z.string().trim().min(1);

function parseSection<T extends z.ZodType>(name: string, schema: T, env: Env): z.output<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid ${name} configuration:\n${issues}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const databaseSchema = z
  .object({
    DATABASE_URL: z
      .string()
      .regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection string')
      // node-postgres lets ?host= / ?hostaddr= override the URL host, which would bypass the TLS host check below.
      .refine((url) => !/[?&](host|hostaddr)=/i.test(url), 'must not set host or hostaddr as a query parameter'),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
    // TLS is configured here, not with ?sslmode in the URL (node-postgres would let URL parameters silently
    // override these settings). auto: no TLS for local hosts; otherwise TLS, verified when a CA is given.
    DATABASE_SSL: z.enum(['auto', 'verify', 'require', 'disable']).default('auto'),
    // PEM of the server CA (Supabase: Database settings → SSL configuration). Literal "\n" sequences are accepted.
    DATABASE_SSL_CA: z
      .string()
      .optional()
      .transform((value) => value?.replaceAll('\\n', '\n').trim() || undefined)
      .refine((value) => value === undefined || value.includes('-----BEGIN CERTIFICATE-----'), {
        error: 'must be a PEM certificate',
      }),
  })
  .refine((value) => value.DATABASE_SSL !== 'verify' || value.DATABASE_SSL_CA !== undefined, {
    error: 'DATABASE_SSL=verify needs DATABASE_SSL_CA',
    path: ['DATABASE_SSL_CA'],
  });

/** How the server connects to Postgres over the network. */
export type DatabaseTls = { mode: 'disable' } | { mode: 'require' } | { mode: 'verify'; ca: string };

export interface DatabaseConfig {
  url: string;
  poolMax: number;
  tls: DatabaseTls;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function databaseHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    // An unparsable URL fails at connect time with the driver's own error.
    return '';
  }
}

/** True when the connection goes to another host without certificate verification (no DATABASE_SSL_CA). */
export function isUnverifiedRemoteDatabase(config: DatabaseConfig): boolean {
  return !LOCAL_HOSTS.has(databaseHost(config.url)) && config.tls.mode !== 'verify';
}

/**
 * In production (NODE_ENV=production) a database on another host must be reached over VERIFIED TLS
 * (DATABASE_SSL_CA): an unverified connection would let a network attacker impersonate the database.
 */
export function loadDatabaseConfig(env: Env = process.env): DatabaseConfig {
  const config = resolveDatabaseConfig(env);
  if (env.NODE_ENV === 'production' && isUnverifiedRemoteDatabase(config)) {
    throw new Error(
      'Invalid database configuration:\n  - DATABASE_SSL_CA: production requires verified TLS to a remote database ' +
        '(set DATABASE_SSL_CA to the provider CA certificate; DATABASE_SSL=require/disable is not allowed)',
    );
  }
  return config;
}

function resolveDatabaseConfig(env: Env): DatabaseConfig {
  const parsed = parseSection('database', databaseSchema, env);
  const ca = parsed.DATABASE_SSL_CA;
  let tls: DatabaseTls;
  switch (parsed.DATABASE_SSL) {
    case 'disable':
      tls = { mode: 'disable' };
      break;
    case 'require':
      tls = { mode: 'require' };
      break;
    case 'verify':
      // The schema guarantees a CA in verify mode.
      tls = { mode: 'verify', ca: ca ?? '' };
      break;
    case 'auto': {
      const host = databaseHost(parsed.DATABASE_URL);
      tls = ca ? { mode: 'verify', ca } : LOCAL_HOSTS.has(host) ? { mode: 'disable' } : { mode: 'require' };
      break;
    }
  }
  return { url: parsed.DATABASE_URL, poolMax: parsed.DATABASE_POOL_MAX, tls };
}

// ---------------------------------------------------------------------------
// Supabase (Auth). The URL and publishable key are public by design.
// ---------------------------------------------------------------------------

const supabaseSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: nonEmpty,
});

export interface SupabaseConfig {
  url: string;
  publishableKey: string;
}

export function loadSupabaseConfig(env: Env = process.env): SupabaseConfig {
  const parsed = parseSection('Supabase', supabaseSchema, env);
  return { url: parsed.NEXT_PUBLIC_SUPABASE_URL, publishableKey: parsed.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY };
}

// ---------------------------------------------------------------------------
// AI runtime
// ---------------------------------------------------------------------------

/**
 * Price per 1M tokens in USD (missing cached/cache-write prices fall back to the input price), plus per-minute rates
 * for realtime voice models billed by session time (active / standby).
 */
export const modelPriceSchema = z.object({
  inputPerMTok: z.number().nonnegative().default(0),
  cachedInputPerMTok: z.number().nonnegative().optional(),
  cacheWritePerMTok: z.number().nonnegative().optional(),
  outputPerMTok: z.number().nonnegative().default(0),
  activePerMinute: z.number().nonnegative().optional(),
  standbyPerMinute: z.number().nonnegative().optional(),
});

// 'default' sends no reasoning setting at all (provider default) — required for models without reasoning support.
const reasoningEffortSchema = z.enum(['default', 'none', 'low', 'medium', 'high']);
export type ModelPrice = z.output<typeof modelPriceSchema>;

const pricingOverridesSchema = z.record(z.string().min(1), modelPriceSchema);

/** Must equal the vector(N) column type in supabase/migrations. */
export const EMBEDDING_DIMENSIONS = 1536;

const aiSchema = z.object({
  AI_TEXT_PROVIDER: nonEmpty.default('openai'),
  AI_TEXT_MODEL: nonEmpty.default('gpt-6-luna'),
  AI_TEXT_REASONING_EFFORT: reasoningEffortSchema.default('low'),
  AI_ESCALATION_PROVIDER: nonEmpty.default('openai'),
  // The current Sol model (developers.openai.com/api/docs/models, 2026-11-26). It rejects reasoning effort 'none'.
  AI_ESCALATION_MODEL: nonEmpty.default('gpt-6.2-sol'),
  AI_ESCALATION_REASONING_EFFORT: reasoningEffortSchema.default('medium'),
  AI_ESCALATION_ENABLED: booleanString.default(true),
  AI_EMBEDDING_PROVIDER: nonEmpty.default('openai'),
  AI_EMBEDDING_MODEL: nonEmpty.default('text-embedding-3-small'),
  AI_EMBEDDING_DIMENSIONS: z.coerce
    .number()
    .int()
    .refine((value) => value === EMBEDDING_DIMENSIONS, {
      error: `must be ${EMBEDDING_DIMENSIONS} to match knowledge_chunks.embedding`,
    })
    .default(EMBEDDING_DIMENSIONS),
  AI_MAX_RETRIEVED_CHUNKS: z.coerce.number().int().min(1).max(20).default(5),
  AI_MAX_RETRIEVED_TOKENS: z.coerce.number().int().min(100).max(8000).default(1800),
  AI_MAX_RECENT_MESSAGES: z.coerce.number().int().min(2).max(50).default(12),
  AI_MIN_RETRIEVAL_SIMILARITY: z.coerce.number().min(0).max(1).default(0.3),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(64).max(8192).default(800),
  AI_MAX_TOOL_ROUNDS: z.coerce.number().int().min(1).max(8).default(4),
  // Hard caps per turn and per conversation (cost and abuse controls).
  AI_MAX_TOOL_CALLS_PER_TURN: z.coerce.number().int().min(1).max(20).default(6),
  AI_MAX_TURN_TOKENS: z.coerce.number().int().min(2_000).max(500_000).default(40_000),
  AI_MAX_CONVERSATION_TURNS: z.coerce.number().int().min(1).max(10_000).default(100),
  // Escalated (premium-model) calls per conversation: escalation triggers can be provoked by a visitor.
  AI_MAX_ESCALATED_CALLS_PER_CONVERSATION: z.coerce.number().int().min(0).max(100).default(6),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),
  // Same-model retries of retryable provider failures (429, timeouts, 5xx). 0 disables them.
  AI_PROVIDER_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  // Organization-level estimated AI spend limits (USD, UTC day / calendar month). Per-organization overrides live
  // in app_private.organization_limits. 0 blocks all AI calls for organizations without an override.
  AI_ORG_DAILY_SPEND_LIMIT_USD: z.coerce.number().min(0).max(1_000_000).default(10),
  AI_ORG_MONTHLY_SPEND_LIMIT_USD: z.coerce.number().min(0).max(10_000_000).default(150),
  // Label stored with every cost estimate (the date of the price list the estimate used).
  AI_PRICING_VERSION: z.string().trim().min(1).max(64).default(PRICING_SNAPSHOT_DATE),
  AI_MODEL_PRICING_JSON: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (!raw?.trim()) return {};
      try {
        const parsed = pricingOverridesSchema.safeParse(JSON.parse(raw));
        if (parsed.success) return parsed.data;
        ctx.addIssue({ code: 'custom', message: parsed.error.issues[0]?.message ?? 'invalid pricing JSON' });
      } catch {
        ctx.addIssue({ code: 'custom', message: 'must be valid JSON' });
      }
      return z.NEVER;
    }),
});

export interface ModelSelection {
  provider: string;
  model: string;
}

export type ReasoningEffortSetting = z.output<typeof reasoningEffortSchema>;

/** A routable text model profile. Reasoning effort is per profile: some models reject 'none'. */
export interface TextModelProfile extends ModelSelection {
  reasoningEffort: ReasoningEffortSetting;
}

export interface AiConfig {
  text: TextModelProfile;
  escalation: TextModelProfile & { enabled: boolean };
  embedding: ModelSelection & { dimensions: number };
  budgets: {
    maxRetrievedChunks: number;
    maxRetrievedTokens: number;
    maxRecentMessages: number;
    minRetrievalSimilarity: number;
    maxOutputTokens: number;
    maxToolRounds: number;
    /** Tool calls executed per turn; further calls are refused (and audited). */
    maxToolCallsPerTurn: number;
    /** Provider-reported input + output tokens per turn; no further round starts once reached. */
    maxTurnTokens: number;
    /** Visitor messages per conversation (default; overridable per organization). */
    maxConversationTurns: number;
    /** Premium-model calls per conversation; further escalations are declined (the default model continues). */
    maxEscalatedCallsPerConversation: number;
  };
  requestTimeoutMs: number;
  retry: RetryPolicy;
  /** Default organization spend limits (USD); app_private.organization_limits overrides them per organization. */
  spendLimits: { dailyUsd: number; monthlyUsd: number };
  /** Per-model price overrides merged over the built-in pricing snapshot. */
  pricingOverrides: Record<string, ModelPrice>;
  pricingVersion: string;
}

export function loadAiConfig(env: Env = process.env): AiConfig {
  const parsed = parseSection('AI', aiSchema, env);
  return {
    text: {
      provider: parsed.AI_TEXT_PROVIDER,
      model: parsed.AI_TEXT_MODEL,
      reasoningEffort: parsed.AI_TEXT_REASONING_EFFORT,
    },
    escalation: {
      enabled: parsed.AI_ESCALATION_ENABLED,
      provider: parsed.AI_ESCALATION_PROVIDER,
      model: parsed.AI_ESCALATION_MODEL,
      reasoningEffort: parsed.AI_ESCALATION_REASONING_EFFORT,
    },
    embedding: {
      provider: parsed.AI_EMBEDDING_PROVIDER,
      model: parsed.AI_EMBEDDING_MODEL,
      dimensions: parsed.AI_EMBEDDING_DIMENSIONS,
    },
    budgets: {
      maxRetrievedChunks: parsed.AI_MAX_RETRIEVED_CHUNKS,
      maxRetrievedTokens: parsed.AI_MAX_RETRIEVED_TOKENS,
      maxRecentMessages: parsed.AI_MAX_RECENT_MESSAGES,
      minRetrievalSimilarity: parsed.AI_MIN_RETRIEVAL_SIMILARITY,
      maxOutputTokens: parsed.AI_MAX_OUTPUT_TOKENS,
      maxToolRounds: parsed.AI_MAX_TOOL_ROUNDS,
      maxToolCallsPerTurn: parsed.AI_MAX_TOOL_CALLS_PER_TURN,
      maxTurnTokens: parsed.AI_MAX_TURN_TOKENS,
      maxConversationTurns: parsed.AI_MAX_CONVERSATION_TURNS,
      maxEscalatedCallsPerConversation: parsed.AI_MAX_ESCALATED_CALLS_PER_CONVERSATION,
    },
    requestTimeoutMs: parsed.AI_REQUEST_TIMEOUT_MS,
    retry: { ...DEFAULT_RETRY_POLICY, maxRetries: parsed.AI_PROVIDER_MAX_RETRIES },
    spendLimits: { dailyUsd: parsed.AI_ORG_DAILY_SPEND_LIMIT_USD, monthlyUsd: parsed.AI_ORG_MONTHLY_SPEND_LIMIT_USD },
    pricingOverrides: parsed.AI_MODEL_PRICING_JSON,
    pricingVersion: parsed.AI_PRICING_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Realtime voice (Phase 2): GPT-Live sessions run by the voice gateway
// ---------------------------------------------------------------------------

const voiceSchema = z.object({
  AI_VOICE_PROVIDER: nonEmpty.default('openai'),
  AI_VOICE_MODEL: nonEmpty.default('gpt-live-1.1'),
  AI_VOICE_NAME: z.string().trim().min(1).max(64).default('marin'),
  // Which engine produces the spoken content: 'responses' (provider-hosted backend model, our tools on the sideband)
  // or 'client' (our agent runtime; the voice model speaks what it returns). See ARCHITECTURE.md §18.
  AI_VOICE_DELEGATION: z.enum(['responses', 'client']).default('responses'),
  // Backend model for Responses delegation (a Responses-capable model; the cheap text model by default).
  AI_VOICE_DELEGATION_MODEL: nonEmpty.optional(),
  VOICE_MAX_SESSION_SECONDS: z.coerce.number().int().min(30).max(7_200).default(600),
  VOICE_MAX_CONCURRENT_SESSIONS: z.coerce.number().int().min(0).max(1_000).default(2),
  // Session starts per organization per minute (each WebRTC session creation is billed by the provider).
  VOICE_SESSION_STARTS_PER_MINUTE: z.coerce.number().int().min(1).max(1_000).default(6),
  // Provider idle timeout before the session returns to (cheaper) standby: 5-60 s.
  VOICE_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(60).default(20),
  // Estimated delegated-model spend reserved per session minute on top of voice time (Responses delegation).
  VOICE_DELEGATED_TEXT_RESERVE_PER_MINUTE_USD: z.coerce.number().min(0).max(10).default(0.01),
  VOICE_GATEWAY_URL: z.url().default('http://127.0.0.1:4100'),
  VOICE_GATEWAY_PORT: z.coerce.number().int().min(1).max(65_535).default(4100),
  VOICE_GATEWAY_SECRET: z.string().min(32, 'must be at least 32 characters').optional(),
  // The developer voice page (/o/<org>/voice-lab) is off unless explicitly enabled.
  VOICE_DEV_ENABLED: booleanString.default(false),
});

export type VoiceDelegation = 'responses' | 'client';

export interface VoiceConfig {
  provider: string;
  model: string;
  voice: string;
  delegation: VoiceDelegation;
  /** Responses delegation backend model (configured text model when unset). */
  delegationModel: string | undefined;
  maxSessionSeconds: number;
  maxConcurrentSessions: number;
  sessionStartsPerMinute: number;
  idleTimeoutSeconds: number;
  delegatedTextReservePerMinuteUsd: number;
  gateway: { url: string; port: number; secret: string | undefined };
  devPageEnabled: boolean;
}

export function loadVoiceConfig(env: Env = process.env): VoiceConfig {
  const parsed = parseSection('voice', voiceSchema, env);
  return {
    provider: parsed.AI_VOICE_PROVIDER,
    model: parsed.AI_VOICE_MODEL,
    voice: parsed.AI_VOICE_NAME,
    delegation: parsed.AI_VOICE_DELEGATION,
    delegationModel: parsed.AI_VOICE_DELEGATION_MODEL,
    maxSessionSeconds: parsed.VOICE_MAX_SESSION_SECONDS,
    maxConcurrentSessions: parsed.VOICE_MAX_CONCURRENT_SESSIONS,
    sessionStartsPerMinute: parsed.VOICE_SESSION_STARTS_PER_MINUTE,
    idleTimeoutSeconds: parsed.VOICE_IDLE_TIMEOUT_SECONDS,
    delegatedTextReservePerMinuteUsd: parsed.VOICE_DELEGATED_TEXT_RESERVE_PER_MINUTE_USD,
    gateway: { url: parsed.VOICE_GATEWAY_URL, port: parsed.VOICE_GATEWAY_PORT, secret: parsed.VOICE_GATEWAY_SECRET },
    devPageEnabled: parsed.VOICE_DEV_ENABLED,
  };
}

// ---------------------------------------------------------------------------
// Provider credentials (server-only secrets)
// ---------------------------------------------------------------------------

const openAiSchema = z.object({
  OPENAI_API_KEY: nonEmpty.optional(),
});

export interface OpenAIConfig {
  apiKey: string | undefined;
}

export function loadOpenAIConfig(env: Env = process.env): OpenAIConfig {
  return { apiKey: parseSection('OpenAI', openAiSchema, env).OPENAI_API_KEY };
}

// ---------------------------------------------------------------------------
// Public web chat widget
// ---------------------------------------------------------------------------

const widgetSchema = z.object({
  WIDGET_SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
  WIDGET_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(24 * 7),
  RATE_LIMIT_IP_PER_MINUTE: z.coerce.number().int().min(1).default(20),
  RATE_LIMIT_WIDGET_PER_MINUTE: z.coerce.number().int().min(1).default(120),
  RATE_LIMIT_ORG_PER_MINUTE: z.coerce.number().int().min(1).default(300),
});

export interface WidgetConfig {
  sessionSecret: string;
  sessionTtlSeconds: number;
  rateLimits: { ipPerMinute: number; widgetPerMinute: number; organizationPerMinute: number };
}

export function loadWidgetConfig(env: Env = process.env): WidgetConfig {
  const parsed = parseSection('widget', widgetSchema, env);
  return {
    sessionSecret: parsed.WIDGET_SESSION_SECRET,
    sessionTtlSeconds: parsed.WIDGET_SESSION_TTL_HOURS * 3600,
    rateLimits: {
      ipPerMinute: parsed.RATE_LIMIT_IP_PER_MINUTE,
      widgetPerMinute: parsed.RATE_LIMIT_WIDGET_PER_MINUTE,
      organizationPerMinute: parsed.RATE_LIMIT_ORG_PER_MINUTE,
    },
  };
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const logSchema = z.object({
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type LogLevel = z.output<typeof logSchema>['LOG_LEVEL'];

export function loadLogLevel(env: Env = process.env): LogLevel {
  return parseSection('logging', logSchema, env).LOG_LEVEL;
}
