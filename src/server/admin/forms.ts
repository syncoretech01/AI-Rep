import type { z } from 'zod';
import { isPermissionDenied } from '@/server/db/sql';
import { agentSettingsSchema } from '@/server/domain/agents/schemas';
import { businessProfileSchema, weeklyHoursSchema } from '@/server/domain/business/schemas';
import type { KnowledgeSource } from '@/server/domain/knowledge/types';
import { DomainError } from '@/server/domain/types';

/**
 * Admin form handling shared by the Server Actions: FormData -> typed input, validation errors -> field
 * messages, failures -> safe messages. Pure (no I/O); the domain schemas stay the single source of rules.
 */

/** Result of an admin Server Action, rendered by the form that submitted it (useActionState). */
export type ActionState =
  | { status: 'idle' }
  | { status: 'success'; message: string }
  | { status: 'error'; message: string; fieldErrors?: Record<string, string[]> };

/** `fieldErrors` key for problems that belong to no single field. */
export const FORM_ERROR_KEY = '_form';

export const ADMIN_ONLY_MESSAGE = 'Only owners and admins can change settings.';
export const SIGNED_OUT_MESSAGE = 'Your session has ended. Sign in again to continue.';
/** For organization actions: a signed-out user and a non-member (e.g. just removed) get the same answer. */
export const NO_ACCESS_MESSAGE = 'You are signed out or no longer have access to this organization.';
export const UNEXPECTED_ERROR_MESSAGE = 'Something went wrong. Please try again.';
const INVALID_FORM_MESSAGE = 'Please correct the highlighted fields.';

export const ADMIN_ONLY_STATE: ActionState = { status: 'error', message: ADMIN_ONLY_MESSAGE };
export const SIGNED_OUT_STATE: ActionState = { status: 'error', message: SIGNED_OUT_MESSAGE };
export const NO_ACCESS_STATE: ActionState = { status: 'error', message: NO_ACCESS_MESSAGE };
export const UNEXPECTED_ERROR_STATE: ActionState = { status: 'error', message: UNEXPECTED_ERROR_MESSAGE };

/** A knowledge source still 'processing' after this long was interrupted (e.g. the request was killed). */
export const STALE_PROCESSING_MS = 5 * 60 * 1000;

const HOURS_FIELD = /^day-([0-6])-(open|close)-(\d{1,3})$/;
// <input type="time"> may submit seconds ('09:00:00') when a value was set with them.
const TIME_WITH_ZERO_SECONDS = /^(\d{2}:\d{2}):00(?:\.0{1,3})?$/;

function cleanText(value: FormDataEntryValue | null): string {
  if (typeof value !== 'string') return '';
  return value.replaceAll('\u0000', '').replace(/\r\n?/g, '\n');
}

/**
 * A text field's value; '' when missing or not text (a File). NUL characters are dropped (Postgres text
 * rejects them with 22021, aborting the transaction) and line breaks become '\n' (browsers submit textarea
 * line breaks as CRLF, which would count twice against length limits).
 */
export function formString(formData: FormData, key: string): string {
  return cleanText(formData.get(key));
}

/** Every text value submitted under `key` (checkbox groups, multi-selects). */
export function formStrings(formData: FormData, key: string): string[] {
  return formData
    .getAll(key)
    .filter((value) => typeof value === 'string')
    .map(cleanText);
}

/** Field names match the schema paths, so validation errors line up with the inputs. */
export function parseAgentSettingsForm(formData: FormData): ReturnType<typeof agentSettingsSchema.safeParse> {
  return agentSettingsSchema.safeParse({
    name: formString(formData, 'name'),
    status: formString(formData, 'status'),
    greeting: formString(formData, 'greeting'),
    language: formString(formData, 'language'),
    timezone: formString(formData, 'timezone'),
    instructions: formString(formData, 'instructions'),
    leadCapture: {
      // An unchecked checkbox is not submitted at all.
      enabled: formData.has('leadCapture.enabled'),
      requiredFields: formStrings(formData, 'leadCapture.requiredFields'),
    },
  });
}

/** Blank fields become null (the schema trims them). */
export function parseBusinessProfileForm(formData: FormData): ReturnType<typeof businessProfileSchema.safeParse> {
  return businessProfileSchema.safeParse({
    businessName: formString(formData, 'businessName'),
    description: formString(formData, 'description'),
    phone: formString(formData, 'phone'),
    email: formString(formData, 'email'),
    website: formString(formData, 'website'),
    address: formString(formData, 'address'),
    serviceArea: formString(formData, 'serviceArea'),
  });
}

/** One opening interval row of the weekly hours editor. */
export interface BusinessHoursRow {
  dayOfWeek: number;
  /** Position of the row within its day in the editor (the `<i>` of its field names). */
  row: number;
  opensAt: string;
  closesAt: string;
}

function normalizeTime(value: string): string {
  const trimmed = value.trim();
  return TIME_WITH_ZERO_SECONDS.exec(trimmed)?.[1] ?? trimmed;
}

/**
 * Reads `day-<0..6>-open-<i>` / `day-<0..6>-close-<i>` fields, sorted by day then row. Rows with both times
 * empty are ignored (the day is closed). Time inputs cannot express 24:00, so a closing time of 00:00 means
 * midnight at the end of the day.
 */
export function readBusinessHoursRows(formData: FormData): BusinessHoursRow[] {
  const rows = new Map<string, BusinessHoursRow>();
  for (const [key, value] of formData) {
    const match = HOURS_FIELD.exec(key);
    if (!match || typeof value !== 'string') continue;
    const dayOfWeek = Number(match[1]);
    const row = Number(match[3]);
    const id = `${dayOfWeek}-${row}`;
    const entry = rows.get(id) ?? { dayOfWeek, row, opensAt: '', closesAt: '' };
    const time = normalizeTime(cleanText(value));
    if (match[2] === 'open') {
      entry.opensAt ||= time;
    } else {
      entry.closesAt ||= time === '00:00' ? '24:00' : time;
    }
    rows.set(id, entry);
  }
  return [...rows.values()]
    .filter((entry) => entry.opensAt !== '' || entry.closesAt !== '')
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.row - b.row);
}

/** The editor's rows as validated weekly hours; issue paths index `readBusinessHoursRows(formData)`. */
export function parseBusinessHoursForm(formData: FormData): ReturnType<typeof weeklyHoursSchema.safeParse> {
  return weeklyHoursSchema.safeParse(
    readBusinessHoursRows(formData).map(({ dayOfWeek, opensAt, closesAt }) => ({ dayOfWeek, opensAt, closesAt })),
  );
}

function addMessage(fieldErrors: Record<string, string[]>, key: string, message: string): void {
  const messages = (fieldErrors[key] ??= []);
  if (!messages.includes(message)) messages.push(message);
}

/** Validation messages keyed by dotted field path ('leadCapture.requiredFields'); root issues under FORM_ERROR_KEY. */
export function zodFieldErrors(error: z.ZodError): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length === 0 ? FORM_ERROR_KEY : issue.path.map(String).join('.');
    addMessage(fieldErrors, key, issue.message);
  }
  return fieldErrors;
}

/**
 * Weekly hours issues keyed by the editor's field names: `day-<d>-open-<i>` / `day-<d>-close-<i>` for one
 * time, `day-<d>` for the day as a whole (overlapping intervals), FORM_ERROR_KEY for the whole week.
 */
export function hoursFieldErrors(error: z.ZodError, rows: readonly BusinessHoursRow[]): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const [index, field] = issue.path;
    const row = typeof index === 'number' ? rows[index] : undefined;
    let key = FORM_ERROR_KEY;
    if (row && field === 'opensAt') key = `day-${row.dayOfWeek}-open-${row.row}`;
    else if (row && field === 'closesAt') key = `day-${row.dayOfWeek}-close-${row.row}`;
    else if (row) key = `day-${row.dayOfWeek}`;
    addMessage(fieldErrors, key, issue.message);
  }
  return fieldErrors;
}

/** Error state for a form that failed validation; the messages come from the schemas (safe to show). */
export function invalidFormState(error: z.ZodError, message = INVALID_FORM_MESSAGE): ActionState {
  return { status: 'error', message, fieldErrors: zodFieldErrors(error) };
}

/**
 * Error state for an expected failure, or null for anything else (log it, show UNEXPECTED_ERROR_MESSAGE).
 * DomainError messages are written for admins. Under RLS an owner/admin-only insert by a plain member
 * fails with a raw 42501 rather than a DomainError.
 */
export function expectedErrorState(error: unknown): ActionState | null {
  if (error instanceof DomainError) return { status: 'error', message: error.message };
  if (isPermissionDenied(error)) return ADMIN_ONLY_STATE;
  return null;
}

/** A failed source, or one stuck in processing (an interrupted request), can be processed again. */
export function isRetryableSource(source: Pick<KnowledgeSource, 'status' | 'updatedAt'>, now: Date): boolean {
  if (source.status === 'failed') return true;
  const unfinished = source.status === 'processing' || source.status === 'pending';
  return unfinished && now.getTime() - source.updatedAt.getTime() > STALE_PROCESSING_MS;
}
