import { z } from 'zod';
import { AGENT_STATUSES, LEAD_FIELDS, type LeadCaptureSettings, type LeadField } from './types';

/**
 * Agent configuration rules. Limits mirror the `agents` table checks in
 * supabase/migrations. Isomorphic: the admin UI may reuse them for early
 * feedback; the server always re-validates. Messages are safe to show to an
 * admin user.
 */

const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const LANGUAGE_MESSAGE = 'Use a language code such as en or en-US.';
const TIMEZONE_MESSAGE = 'Choose a valid time zone, e.g. America/New_York.';
const DEFAULT_REQUIRED_FIELDS: readonly LeadField[] = ['name', 'phone'];

/** True for IANA time zone names the runtime knows, e.g. 'America/New_York'. */
export function isValidTimeZone(value: string): boolean {
  // Intl also accepts UTC offsets such as '+05:00'; those are not IANA zones (no DST rules).
  if (!/^[A-Za-z]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Keeps known fields once each, in a stable order. */
function knownLeadFields(fields: readonly unknown[]): LeadField[] {
  return LEAD_FIELDS.filter((field) => fields.includes(field));
}

export const leadCaptureSettingsSchema = z.object({
  enabled: z.boolean(),
  requiredFields: z
    .array(z.enum(LEAD_FIELDS, 'Choose name, phone or email.'))
    .max(LEAD_FIELDS.length, 'Choose name, phone or email.')
    .transform(knownLeadFields),
});

export const agentSettingsSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(80, 'Keep the name to 80 characters or fewer.'),
  status: z.enum(AGENT_STATUSES, 'Choose active or paused.'),
  greeting: z
    .string()
    .trim()
    .min(1, 'Enter a greeting.')
    .max(500, 'Keep the greeting to 500 characters or fewer.'),
  // `abort`: an over-long value gets one message, not the same message twice.
  language: z
    .string()
    .trim()
    .max(35, { error: LANGUAGE_MESSAGE, abort: true })
    .regex(LANGUAGE_TAG, LANGUAGE_MESSAGE),
  timezone: z
    .string()
    .trim()
    .max(64, { error: TIMEZONE_MESSAGE, abort: true })
    .refine(isValidTimeZone, TIMEZONE_MESSAGE),
  instructions: z.string().trim().max(4000, 'Keep the instructions to 4,000 characters or fewer.'),
  leadCapture: leadCaptureSettingsSchema,
});

export type AgentSettings = z.output<typeof agentSettingsSchema>;

/** Column defaults of `agents` (supabase/migrations), applied when an agent is created without them. */
export const DEFAULT_AGENT_SETTINGS: Omit<AgentSettings, 'name'> = {
  status: 'active',
  greeting: 'Hi! How can I help you today?',
  language: 'en',
  timezone: 'UTC',
  instructions: '',
  leadCapture: { enabled: true, requiredFields: [...DEFAULT_REQUIRED_FIELDS] },
};

/** Stored JSON is read leniently: unknown fields are ignored; missing or invalid values use the defaults. */
const storedLeadCaptureSchema = z.object({
  enabled: z.boolean().catch(true),
  requiredFields: z
    .array(z.unknown())
    .transform(knownLeadFields)
    .catch(() => [...DEFAULT_REQUIRED_FIELDS]),
});

/** Parses `agents.lead_capture`. Never throws: a damaged value falls back to the defaults. */
export function parseLeadCapture(value: unknown): LeadCaptureSettings {
  const result = storedLeadCaptureSchema.safeParse(value);
  return result.success ? result.data : { enabled: true, requiredFields: [...DEFAULT_REQUIRED_FIELDS] };
}

// ---------------------------------------------------------------------------
// Web chat allowed sites (agent_channels.config.allowedOrigins)
// ---------------------------------------------------------------------------

/**
 * Sites allowed to embed the widget. Browsers enforce the list through the widget page's CSP `frame-ancestors`;
 * it is NOT authentication (a script can still call the public API directly; rate limits and spend limits bound
 * that). Empty list = any site may embed it.
 */
export const MAX_ALLOWED_ORIGINS = 20;
const MAX_ORIGIN_CHARS = 200;
const WILDCARD_ORIGIN = /^https:\/\/\*\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LOCAL_DEVELOPMENT_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Normalizes one site to a CSP-safe origin: `https://host[:port]`, `https://*.example.com`, or
 * `http://localhost[:port]` for development. Null when it is not a bare origin (paths, queries, credentials and
 * other schemes are refused).
 */
export function normalizeAllowedOrigin(raw: string): string | null {
  const value = raw.trim().replace(/\/+$/, '').toLowerCase();
  if (value === '' || value.length > MAX_ORIGIN_CHARS) return null;
  if (value.startsWith('https://*.')) return WILDCARD_ORIGIN.test(value) ? value : null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const secure = url.protocol === 'https:';
  const localDevelopment = url.protocol === 'http:' && LOCAL_DEVELOPMENT_HOSTS.has(url.hostname);
  if (!secure && !localDevelopment) return null;
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return null;
  // DNS labels or a bracketed IPv6 literal only (the URL parser lets characters such as '*' through).
  if (!/^(?:[a-z0-9-]+\.)*[a-z0-9-]+$|^\[[0-9a-f:.]+\]$/.test(url.hostname)) return null;
  // Rebuilt from parsed parts: nothing but scheme, host and port can reach the response header.
  return `${url.protocol}//${url.host}`;
}

/** Admin input: one site per line (commas and spaces also separate). Duplicates are dropped. */
export const allowedOriginsInputSchema = z
  .string()
  .max(MAX_ALLOWED_ORIGINS * (MAX_ORIGIN_CHARS + 2), 'The list of sites is too long.')
  .transform((text, ctx) => {
    const origins: string[] = [];
    for (const entry of text.split(/[\s,]+/).filter((item) => item !== '')) {
      const origin = normalizeAllowedOrigin(entry);
      if (origin === null) {
        ctx.addIssue({
          code: 'custom',
          message: `"${entry.slice(0, 80)}" is not a website address. Use the form https://www.example.com.`,
        });
        return z.NEVER;
      }
      if (!origins.includes(origin)) origins.push(origin);
    }
    if (origins.length > MAX_ALLOWED_ORIGINS) {
      ctx.addIssue({ code: 'custom', message: `List at most ${MAX_ALLOWED_ORIGINS} sites.` });
      return z.NEVER;
    }
    return origins;
  });

/**
 * True when `agent_channels.config` holds a non-empty allowed-sites list, valid or not. A list whose entries are all
 * invalid (e.g. written without a scheme through the Data API) must restrict embedding to nobody, never to everybody.
 */
export function hasAllowedOriginsList(config: unknown): boolean {
  if (typeof config !== 'object' || config === null || !('allowedOrigins' in config)) return false;
  const list = config.allowedOrigins;
  return Array.isArray(list) && list.length > 0;
}

/** Parses `agent_channels.config` leniently: invalid entries are dropped, never trusted. */
export function parseAllowedOrigins(config: unknown): string[] {
  if (typeof config !== 'object' || config === null || !('allowedOrigins' in config)) return [];
  const list = config.allowedOrigins;
  if (!Array.isArray(list)) return [];
  const origins: string[] = [];
  for (const entry of list.slice(0, MAX_ALLOWED_ORIGINS)) {
    const origin = typeof entry === 'string' ? normalizeAllowedOrigin(entry) : null;
    if (origin !== null && !origins.includes(origin)) origins.push(origin);
  }
  return origins;
}
