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
