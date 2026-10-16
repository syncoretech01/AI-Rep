import 'server-only';
import { z } from 'zod';

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
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection string'),
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
        message: 'must be a PEM certificate',
      }),
  })
  .refine((value) => value.DATABASE_SSL !== 'verify' || value.DATABASE_SSL_CA !== undefined, {
    message: 'DATABASE_SSL=verify needs DATABASE_SSL_CA',
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

export function loadDatabaseConfig(env: Env = process.env): DatabaseConfig {
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
      let host = '';
      try {
        host = new URL(parsed.DATABASE_URL).hostname;
      } catch {
        // An unparsable URL fails at connect time with the driver's own error.
      }
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

/** Price per 1M tokens in USD. Missing cached/cache-write prices fall back to the input price. */
export const modelPriceSchema = z.object({
  inputPerMTok: z.number().nonnegative(),
  cachedInputPerMTok: z.number().nonnegative().optional(),
  cacheWritePerMTok: z.number().nonnegative().optional(),
  outputPerMTok: z.number().nonnegative().default(0),
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
  AI_ESCALATION_MODEL: nonEmpty.default('gpt-6-sol'),
  AI_ESCALATION_REASONING_EFFORT: reasoningEffortSchema.default('medium'),
  AI_ESCALATION_ENABLED: booleanString.default(true),
  AI_EMBEDDING_PROVIDER: nonEmpty.default('openai'),
  AI_EMBEDDING_MODEL: nonEmpty.default('text-embedding-3-small'),
  AI_EMBEDDING_DIMENSIONS: z.coerce
    .number()
    .int()
    .refine((value) => value === EMBEDDING_DIMENSIONS, {
      message: `must be ${EMBEDDING_DIMENSIONS} to match knowledge_chunks.embedding`,
    })
    .default(EMBEDDING_DIMENSIONS),
  AI_MAX_RETRIEVED_CHUNKS: z.coerce.number().int().min(1).max(20).default(5),
  AI_MAX_RETRIEVED_TOKENS: z.coerce.number().int().min(100).max(8000).default(1800),
  AI_MAX_RECENT_MESSAGES: z.coerce.number().int().min(2).max(50).default(12),
  AI_MIN_RETRIEVAL_SIMILARITY: z.coerce.number().min(0).max(1).default(0.3),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(64).max(8192).default(800),
  AI_MAX_TOOL_ROUNDS: z.coerce.number().int().min(1).max(8).default(4),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),
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
  };
  requestTimeoutMs: number;
  /** Per-model price overrides merged over the built-in pricing snapshot. */
  pricingOverrides: Record<string, ModelPrice>;
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
    },
    requestTimeoutMs: parsed.AI_REQUEST_TIMEOUT_MS,
    pricingOverrides: parsed.AI_MODEL_PRICING_JSON,
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
