import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { FORM_ERROR_KEY as CLIENT_FORM_ERROR_KEY, fieldErrors, type FormState } from '@/components/admin/form-state';
import {
  ADMIN_ONLY_MESSAGE,
  ADMIN_ONLY_STATE,
  FORM_ERROR_KEY,
  NO_ACCESS_STATE,
  STALE_PROCESSING_MS,
  UNEXPECTED_ERROR_STATE,
  expectedErrorState,
  formString,
  formStrings,
  hoursFieldErrors,
  invalidFormState,
  isRetryableSource,
  parseAgentSettingsForm,
  parseBusinessHoursForm,
  parseBusinessProfileForm,
  readBusinessHoursRows,
  zodFieldErrors,
} from '@/server/admin/forms';
import { authorizeAdminAction } from '@/server/auth/org-access';
import { DomainError } from '@/server/domain/types';

// Session and database stand-ins for authorizeAdminAction: the signed-in user, their role per organization
// slug, and a switch that makes every transaction fail like an unreachable database.
const access = vi.hoisted(() => {
  const state = {
    user: null as { id: string; email: string | null } | null,
    roles: new Map<string, 'owner' | 'admin' | 'member'>(),
    databaseError: null as Error | null,
  };
  const sql = {
    query: async (text: string, params: readonly unknown[] = []) => {
      const slug = params[1];
      const role = typeof slug === 'string' && text.includes('organization_members') ? state.roles.get(slug) : undefined;
      return role ? [{ id: '00000000-0000-4000-8000-0000000000aa', name: 'Acme', slug, created_at: new Date(), role }] : [];
    },
  };
  const db = {
    query: sql.query,
    transaction: async <T>(fn: (tx: typeof sql) => Promise<T>): Promise<T> => {
      if (state.databaseError) throw state.databaseError;
      return fn(sql);
    },
    close: async () => undefined,
  };
  return { state, db };
});

vi.mock('@/server/auth/session', () => ({
  getAuthUser: async () => access.state.user,
  requireUser: async () => access.state.user,
}));
vi.mock('@/server/app-services', () => ({ getAppServices: () => ({ db: access.db }) }));

function form(entries: Record<string, string | readonly string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    for (const item of typeof value === 'string' ? [value] : value) data.append(key, item);
  }
  return data;
}

const validSettings = {
  name: 'Front Desk',
  status: 'active',
  greeting: 'Hi there! How can we help?',
  language: 'en-US',
  timezone: 'America/New_York',
  instructions: 'Keep answers short.',
  'leadCapture.enabled': 'on',
  'leadCapture.requiredFields': ['phone', 'name'],
};

describe('formString / formStrings', () => {
  it('returns the submitted text, or an empty string when missing or a file', () => {
    const data = form({ name: 'Acme' });
    data.append('upload', new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    expect(formString(data, 'name')).toBe('Acme');
    expect(formString(data, 'missing')).toBe('');
    expect(formString(data, 'upload')).toBe('');
  });

  it('drops NUL characters and normalizes CRLF and CR line breaks', () => {
    const data = form({ text: 'a\u0000b\r\nc\rd\ne' });
    expect(formString(data, 'text')).toBe('ab\nc\nd\ne');
  });

  it('collects every text value of a repeated field', () => {
    const data = form({ tags: ['a', 'b\u0000'] });
    data.append('tags', new File(['x'], 'x.txt'));
    expect(formStrings(data, 'tags')).toEqual(['a', 'b']);
    expect(formStrings(data, 'none')).toEqual([]);
  });
});

describe('parseAgentSettingsForm', () => {
  it('parses a valid form, trimming values and normalizing line breaks', () => {
    const result = parseAgentSettingsForm(
      form({ ...validSettings, name: '  Front Desk  ', instructions: ' Line one\r\nLine two ' }),
    );
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      name: 'Front Desk',
      status: 'active',
      greeting: 'Hi there! How can we help?',
      language: 'en-US',
      timezone: 'America/New_York',
      instructions: 'Line one\nLine two',
      leadCapture: { enabled: true, requiredFields: ['name', 'phone'] },
    });
  });

  it('reads an unchecked lead capture box (not submitted) as disabled, with no required fields', () => {
    const { 'leadCapture.enabled': _enabled, 'leadCapture.requiredFields': _fields, ...rest } = validSettings;
    const result = parseAgentSettingsForm(form(rest));
    expect(result.success).toBe(true);
    expect(result.data?.leadCapture).toEqual({ enabled: false, requiredFields: [] });
  });

  it('reports invalid values under the field names the form uses', () => {
    const result = parseAgentSettingsForm(
      form({
        ...validSettings,
        name: '   ',
        status: 'sleeping',
        timezone: 'Mars/Phobos',
        'leadCapture.requiredFields': ['phone', 'fax'],
      }),
    );
    expect(result.success).toBe(false);
    expect(zodFieldErrors(result.error!)).toEqual({
      name: ['Enter a name.'],
      status: ['Choose active or paused.'],
      timezone: ['Choose a valid time zone, e.g. America/New_York.'],
      'leadCapture.requiredFields.1': ['Choose name, phone or email.'],
    });
  });

  it('rejects a missing form field as invalid rather than throwing', () => {
    const result = parseAgentSettingsForm(new FormData());
    expect(result.success).toBe(false);
    expect(Object.keys(zodFieldErrors(result.error!))).toEqual(
      expect.arrayContaining(['name', 'status', 'greeting', 'language', 'timezone']),
    );
  });

  it('counts a CRLF line break once against the 4,000 character instructions limit', () => {
    // Browsers submit textarea line breaks as CRLF: 5,000 characters on the wire, 4,000 as typed.
    const typedAtLimit = 'abc\r\n'.repeat(1000);
    expect(parseAgentSettingsForm(form({ ...validSettings, instructions: typedAtLimit })).success).toBe(true);
    const tooLong = parseAgentSettingsForm(form({ ...validSettings, instructions: 'x'.repeat(4001) }));
    expect(tooLong.success).toBe(false);
    expect(zodFieldErrors(tooLong.error!).instructions).toEqual([
      'Keep the instructions to 4,000 characters or fewer.',
    ]);
  });
});

describe('parseBusinessProfileForm', () => {
  it('trims values and turns blank fields into null', () => {
    const result = parseBusinessProfileForm(
      form({
        businessName: '  Acme Plumbing ',
        description: '',
        phone: '   ',
        email: 'hello@acme.example',
        website: 'https://acme.example',
        address: '1 Main St\r\nSpringfield',
      }),
    );
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      businessName: 'Acme Plumbing',
      description: null,
      phone: null,
      email: 'hello@acme.example',
      website: 'https://acme.example',
      address: '1 Main St\nSpringfield',
      serviceArea: null,
    });
  });

  it('reports an invalid email and website on their fields', () => {
    const result = parseBusinessProfileForm(form({ email: 'not-an-email', website: 'acme.example' }));
    expect(result.success).toBe(false);
    expect(zodFieldErrors(result.error!)).toEqual({
      email: ['Enter a valid email address.'],
      website: ['Enter a full web address starting with https://'],
    });
  });
});

describe('business hours form', () => {
  it('reads intervals by day and row, ignoring empty rows and unrelated fields', () => {
    const data = form({
      'day-1-open-0': '09:00',
      'day-1-close-0': '12:00',
      'day-1-open-1': '13:00',
      'day-1-close-1': '17:30',
      'day-2-open-0': '',
      'day-2-close-0': '',
      'day-6-open-0': '10:00',
      'day-6-close-0': '14:00',
      'day-7-open-0': '09:00',
      'day-1-open-x': '09:00',
      name: 'unrelated',
    });
    const result = parseBusinessHoursForm(data);
    expect(result.success).toBe(true);
    expect(result.data).toEqual([
      { dayOfWeek: 1, opensAt: '09:00', closesAt: '12:00' },
      { dayOfWeek: 1, opensAt: '13:00', closesAt: '17:30' },
      { dayOfWeek: 6, opensAt: '10:00', closesAt: '14:00' },
    ]);
  });

  it('sorts rows by day and row number regardless of field order', () => {
    const data = form({
      'day-3-open-1': '14:00',
      'day-3-close-1': '18:00',
      'day-0-open-0': '10:00',
      'day-0-close-0': '12:00',
      'day-3-open-0': '08:00',
      'day-3-close-0': '12:00',
    });
    expect(readBusinessHoursRows(data)).toEqual([
      { dayOfWeek: 0, row: 0, opensAt: '10:00', closesAt: '12:00' },
      { dayOfWeek: 3, row: 0, opensAt: '08:00', closesAt: '12:00' },
      { dayOfWeek: 3, row: 1, opensAt: '14:00', closesAt: '18:00' },
    ]);
  });

  it('treats a 00:00 closing time as midnight and drops zero seconds', () => {
    const result = parseBusinessHoursForm(
      form({ 'day-5-open-0': '18:00:00', 'day-5-close-0': '00:00', 'day-0-open-0': '00:00', 'day-0-close-0': '00:00' }),
    );
    expect(result.success).toBe(true);
    expect(result.data).toEqual([
      { dayOfWeek: 0, opensAt: '00:00', closesAt: '24:00' },
      { dayOfWeek: 5, opensAt: '18:00', closesAt: '24:00' },
    ]);
  });

  it('accepts an empty week (closed every day)', () => {
    const result = parseBusinessHoursForm(form({ 'day-1-open-0': '', 'day-1-close-0': '' }));
    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });

  it('reports overlapping intervals on the day', () => {
    const data = form({
      'day-1-open-0': '09:00',
      'day-1-close-0': '12:00',
      'day-1-open-1': '11:00',
      'day-1-close-1': '14:00',
    });
    const result = parseBusinessHoursForm(data);
    expect(result.success).toBe(false);
    expect(hoursFieldErrors(result.error!, readBusinessHoursRows(data))).toEqual({
      'day-1': ['Monday has overlapping opening hours.'],
    });
  });

  it('maps time errors to the editor field that holds them, keeping the row number', () => {
    const data = form({
      // Row 1 of Tuesday was removed in the editor: row numbers are positions, not array indexes.
      'day-2-open-0': '09:00',
      'day-2-close-0': '12:00',
      'day-2-open-2': '15:00',
      'day-2-close-2': '',
      'day-3-open-0': '17:00',
      'day-3-close-0': '09:00',
    });
    const result = parseBusinessHoursForm(data);
    expect(result.success).toBe(false);
    expect(hoursFieldErrors(result.error!, readBusinessHoursRows(data))).toEqual({
      'day-2-close-2': ['Use a time between 00:00 and 24:00 (HH:MM).'],
      'day-3-close-0': ['Closing time must be after opening time.'],
    });
  });

  it('reports a week with too many intervals as a form error', () => {
    const entries: Record<string, string> = {};
    for (let row = 0; row < 29; row += 1) {
      const hour = String(row % 24).padStart(2, '0');
      entries[`day-${row % 7}-open-${row}`] = `${hour}:00`;
      entries[`day-${row % 7}-close-${row}`] = `${hour}:30`;
    }
    const data = form(entries);
    const result = parseBusinessHoursForm(data);
    expect(result.success).toBe(false);
    expect(hoursFieldErrors(result.error!, readBusinessHoursRows(data))[FORM_ERROR_KEY]).toEqual([
      'Add at most 28 opening intervals.',
    ]);
  });
});

describe('zodFieldErrors', () => {
  it('keys messages by dotted path and collects root issues under the form key', () => {
    const schema = z.object({
      name: z.string().min(2, 'Too short.'),
      contact: z.object({ email: z.email('Bad email.') }),
      tags: z.array(z.string('Text only.')),
    });
    const result = schema.safeParse({ name: 'a', contact: { email: 'nope' }, tags: ['ok', 3] });
    expect(zodFieldErrors(result.error!)).toEqual({
      name: ['Too short.'],
      'contact.email': ['Bad email.'],
      'tags.1': ['Text only.'],
    });

    const root = z.string().refine(() => false, 'Something is off.').safeParse('x');
    expect(zodFieldErrors(root.error!)).toEqual({ [FORM_ERROR_KEY]: ['Something is off.'] });
  });

  it('lists a repeated message once per field', () => {
    const result = z.string().min(5, 'Wrong length.').max(1, 'Wrong length.').safeParse('abc');
    expect(result.error?.issues).toHaveLength(2);
    expect(zodFieldErrors(result.error!)).toEqual({ [FORM_ERROR_KEY]: ['Wrong length.'] });
  });

  it('builds the error state for an invalid form', () => {
    const result = z.object({ title: z.string().min(1, 'Enter a title.') }).safeParse({ title: '' });
    expect(invalidFormState(result.error!)).toEqual({
      status: 'error',
      message: 'Please correct the highlighted fields.',
      fieldErrors: { title: ['Enter a title.'] },
    });
  });
});

describe('field errors in the form components', () => {
  it('finds the server keys under the names the inputs use', () => {
    const settings = parseAgentSettingsForm(form({ ...validSettings, name: '', 'leadCapture.requiredFields': ['fax'] }));
    const settingsState: FormState = invalidFormState(settings.error!);
    expect(fieldErrors(settingsState, 'name')).toEqual(['Enter a name.']);
    // The required-fields checkbox group shows every 'leadCapture.*' message.
    expect(fieldErrors(settingsState, 'leadCapture')).toEqual(['Choose name, phone or email.']);
    expect(fieldErrors(settingsState, 'greeting')).toEqual([]);

    const data = form({
      'day-2-open-1': '17:00',
      'day-2-close-1': '09:00',
      'day-4-open-0': '09:00',
      'day-4-close-0': '12:00',
      'day-4-open-1': '10:00',
      'day-4-close-1': '11:00',
    });
    const hours = parseBusinessHoursForm(data);
    const hoursState: FormState = {
      status: 'error',
      message: 'Please correct the opening hours.',
      fieldErrors: hoursFieldErrors(hours.error!, readBusinessHoursRows(data)),
    };
    expect(fieldErrors(hoursState, 'day-2-close-1')).toEqual(['Closing time must be after opening time.']);
    expect(fieldErrors(hoursState, 'day-4')).toEqual(['Thursday has overlapping opening hours.']);
    // A day's key does not swallow its rows' messages (they are shown next to the inputs).
    expect(fieldErrors(hoursState, 'day-2')).toEqual([]);
  });

  it('shares the key for errors that belong to no single field', () => {
    expect(CLIENT_FORM_ERROR_KEY).toBe(FORM_ERROR_KEY);
    expect(fieldErrors({ status: 'success', message: 'Saved.' }, 'name')).toEqual([]);
  });
});

describe('expectedErrorState', () => {
  it('shows domain error messages, which are written for admins', () => {
    expect(expectedErrorState(new DomainError('not_found', 'Agent not found.'))).toEqual({
      status: 'error',
      message: 'Agent not found.',
    });
    expect(expectedErrorState(new DomainError('forbidden', 'Only owners and admins can manage knowledge.'))).toEqual({
      status: 'error',
      message: 'Only owners and admins can manage knowledge.',
    });
  });

  it('maps an RLS rejection (42501) to the owners-and-admins message', () => {
    expect(expectedErrorState({ code: '42501', message: 'new row violates row-level security policy' })).toEqual({
      status: 'error',
      message: ADMIN_ONLY_MESSAGE,
    });
  });

  it('returns null for anything unexpected, so internals are never shown', () => {
    expect(expectedErrorState(new Error('connection terminated'))).toBeNull();
    expect(expectedErrorState({ code: '23505', message: 'duplicate key value violates unique constraint' })).toBeNull();
    expect(expectedErrorState('boom')).toBeNull();
    expect(expectedErrorState(null)).toBeNull();
  });
});

describe('isRetryableSource', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it('allows retrying failed sources at any time', () => {
    expect(isRetryableSource({ status: 'failed', updatedAt: now }, now)).toBe(true);
  });

  it('allows retrying a source only once it has been processing for more than 5 minutes', () => {
    expect(isRetryableSource({ status: 'processing', updatedAt: ago(60_000) }, now)).toBe(false);
    expect(isRetryableSource({ status: 'processing', updatedAt: ago(STALE_PROCESSING_MS) }, now)).toBe(false);
    expect(isRetryableSource({ status: 'processing', updatedAt: ago(STALE_PROCESSING_MS + 1000) }, now)).toBe(true);
    expect(isRetryableSource({ status: 'pending', updatedAt: ago(STALE_PROCESSING_MS + 1000) }, now)).toBe(true);
  });

  it('never retries a ready source', () => {
    expect(isRetryableSource({ status: 'ready', updatedAt: ago(24 * 3600 * 1000) }, now)).toBe(false);
  });
});

describe('authorizeAdminAction', () => {
  const userId = '00000000-0000-4000-8000-000000000001';

  beforeEach(() => {
    access.state.user = { id: userId, email: 'owner@example.com' };
    access.state.roles = new Map([
      ['acme', 'owner'],
      ['beta', 'admin'],
      ['gamma', 'member'],
    ]);
    access.state.databaseError = null;
  });

  it('authorizes owners and admins with user-scoped database access', async () => {
    for (const slug of ['acme', 'beta']) {
      const result = await authorizeAdminAction(slug);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.access).toMatchObject({ isAdmin: true, organization: { slug }, user: { id: userId } });
      expect(result.access.db.actor).toEqual({ kind: 'user', userId });
    }
  });

  it('refuses plain members before anything is written', async () => {
    expect(await authorizeAdminAction('gamma')).toEqual({ ok: false, state: ADMIN_ONLY_STATE });
  });

  it('gives signed-out users, non-members and tampered slugs the same answer', async () => {
    expect(await authorizeAdminAction('other-org')).toEqual({ ok: false, state: NO_ACCESS_STATE });
    // Bound Server Action arguments come back from the browser and can be any serializable value.
    expect(await authorizeAdminAction(['acme'] as unknown as string)).toEqual({ ok: false, state: NO_ACCESS_STATE });
    access.state.user = null;
    expect(await authorizeAdminAction('acme')).toEqual({ ok: false, state: NO_ACCESS_STATE });
  });

  it('answers a failed lookup with the generic error state instead of throwing, and logs it', async () => {
    access.state.databaseError = new Error('connect ECONNREFUSED 10.0.0.5:6543');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await authorizeAdminAction('acme')).toEqual({ ok: false, state: UNEXPECTED_ERROR_STATE });
    expect(logged).toHaveBeenCalledOnce();
    expect(String(logged.mock.calls[0]?.[0])).toContain('"event":"admin.authorization_failed"');
  });
});
