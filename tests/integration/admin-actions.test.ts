import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  class RedirectSignal extends Error {
    readonly url: string;
    constructor(url: string) {
      super(`NEXT_REDIRECT ${url}`);
      this.url = url;
    }
  }
  const state: { user: { id: string; email: string | null } | null; services: unknown; revalidated: string[] } = {
    user: null,
    services: undefined,
    revalidated: [],
  };
  return { RedirectSignal, state };
});

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new hoisted.RedirectSignal(url);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next/cache', () => ({
  revalidatePath: (path: string, type?: string) => {
    hoisted.state.revalidated.push(`${path}|${type ?? ''}`);
  },
}));
vi.mock('@/server/auth/session', () => ({
  getAuthUser: async () => hoisted.state.user,
  requireUser: async () => {
    if (!hoisted.state.user) throw new hoisted.RedirectSignal('/login');
    return hoisted.state.user;
  },
}));
vi.mock('@/server/app-services', () => ({ getAppServices: () => hoisted.state.services }));

import { createAgentAction } from '@/app/o/[orgSlug]/agents/actions';
import {
  rotateWidgetKeyAction,
  setWebChatEnabledAction,
  updateAgentSettingsAction,
  updateBusinessHoursAction,
  updateBusinessProfileAction,
} from '@/app/o/[orgSlug]/agents/[agentId]/actions';
import {
  addTextSourceAction,
  deleteSourceAction,
  retrySourceAction,
  uploadFileSourceAction,
} from '@/app/o/[orgSlug]/knowledge/actions';
import { createOrganizationAction } from '@/app/onboarding/actions';
import type { Embedder } from '@/server/ai/embedder';
import { ProviderError } from '@/server/ai/types';
import { getOrgAccessForAction, requireOrgAccess } from '@/server/auth/org-access';
import type { Database, Row, SqlParam } from '@/server/db/types';
import { silentLogger, type Logger } from '@/server/observability/logger';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { fakeEmbed } from '../support/fake-embeddings';
import { addMember, createAgent, createAuthUser, createTenant, type TenantFixture } from '../support/fixtures';

const IDLE = { status: 'idle' } as const;

const goodEmbedder: Embedder = {
  model: 'fake-embedding',
  embed: async (texts) => ({ vectors: texts.map((text) => fakeEmbed(text)), model: 'fake-embedding' }),
};
const brokenEmbedder: Embedder = {
  model: 'fake-embedding',
  embed: async () => {
    throw new ProviderError({ provider: 'fake', code: 'unavailable', message: 'down', retryable: true });
  },
};

let t: TestDatabase;

function useEmbedder(embedder: Embedder) {
  hoisted.state.services = { db: t.db, logger: silentLogger, embedder };
}

function signIn(user: { id: string; email: string } | null) {
  hoisted.state.user = user ? { id: user.id, email: user.email } : null;
}

function form(entries: Record<string, string | readonly string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    for (const item of typeof value === 'string' ? [value] : value) data.append(key, item);
  }
  return data;
}

async function redirectOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof hoisted.RedirectSignal) return error.url;
    throw error;
  }
  throw new Error('expected a redirect');
}

/** `t.db`, except that statements containing `fragment` fail (as if the connection dropped right then). */
function failingOn(fragment: string): Database {
  return {
    query: t.db.query,
    close: t.db.close,
    transaction: (fn) =>
      t.db.transaction((tx) =>
        fn({
          query: <T extends object = Row>(text: string, params?: readonly SqlParam[]): Promise<T[]> =>
            text.includes(fragment) ? Promise.reject(new Error('connection lost')) : tx.query<T>(text, params),
        }),
      ),
  };
}

/** A logger that keeps the events logged at error level. */
function errorRecorder(events: string[]): Logger {
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (event) => {
      events.push(event);
    },
    child: () => logger,
  };
  return logger;
}

async function auditActions(orgId: string): Promise<Array<{ action: string; actor_type: string; actor_id: string }>> {
  return t.db.query(
    'select action, actor_type, actor_id from public.audit_logs where organization_id = $1 order by created_at, id',
    [orgId],
  );
}

const validSettings = {
  name: 'Night Desk',
  status: 'paused',
  greeting: 'Hello there!',
  language: 'en-GB',
  timezone: 'Europe/London',
  instructions: 'Be brief.',
  'leadCapture.enabled': 'on',
  'leadCapture.requiredFields': ['email'],
};

beforeAll(async () => {
  t = await createTestDatabase();
  useEmbedder(goodEmbedder);
});

afterAll(async () => {
  await t.close();
});

describe('org access', () => {
  it('resolves members, 404s non-members and unknown slugs, and sends signed-out users to /login', async () => {
    const a = await createTenant(t.db, 'Alpha');
    const b = await createTenant(t.db, 'Beta');
    signIn(a.owner);
    const access = await requireOrgAccess(a.org.slug);
    expect(access).toMatchObject({ role: 'owner', isAdmin: true, organization: { id: a.org.id, slug: a.org.slug } });
    expect(access.db.actor).toEqual({ kind: 'user', userId: a.owner.id });
    await expect(requireOrgAccess(b.org.slug)).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(requireOrgAccess('no-such-org')).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(requireOrgAccess('Not A Slug!')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(await getOrgAccessForAction(b.org.slug)).toBeNull();
    expect(await getOrgAccessForAction({ slug: a.org.slug } as unknown as string)).toBeNull();
    signIn(null);
    expect(await redirectOf(requireOrgAccess(a.org.slug))).toBe('/login');
    expect(await getOrgAccessForAction(a.org.slug)).toBeNull();
  });

  it('marks plain members as non-admins', async () => {
    const a = await createTenant(t.db);
    const member = await createAuthUser(t.db);
    await addMember(t.db, a.org.id, member.id, 'member');
    signIn(member);
    expect(await requireOrgAccess(a.org.slug)).toMatchObject({ role: 'member', isAdmin: false });
  });
});

describe('createOrganizationAction', () => {
  it('requires a session and a name', async () => {
    signIn(null);
    expect(await createOrganizationAction(IDLE, form({ name: 'Acme' }))).toMatchObject({ status: 'error' });
    const user = await createAuthUser(t.db);
    signIn(user);
    expect(await createOrganizationAction(IDLE, form({ name: '   ' }))).toEqual({
      status: 'error',
      message: 'Please correct the highlighted fields.',
      fieldErrors: { name: ['Enter the organization name.'] },
    });
  });

  it('creates the organization with the session user as owner and opens the first agent', async () => {
    const user = await createAuthUser(t.db);
    signIn(user);
    const url = await redirectOf(createOrganizationAction(IDLE, form({ name: 'Acme Plumbing', agentName: 'Ava' })));
    const match = /^\/o\/([a-z0-9-]+)\/agents\/([0-9a-f-]{36})$/.exec(url);
    expect(match).not.toBeNull();
    const [, slug, agentId] = match!;
    const rows = await t.db.query<{ role: string; agent_name: string }>(
      `select m.role, a.name as agent_name from public.organizations o
       join public.organization_members m on m.organization_id = o.id
       join public.agents a on a.organization_id = o.id
       where o.slug = $1 and m.user_id = $2 and a.id = $3`,
      [slug!, user.id, agentId!],
    );
    expect(rows).toEqual([{ role: 'owner', agent_name: 'Ava' }]);
  });
});

describe('createAgentAction', () => {
  it('lets an owner create an agent with a profile and an unpublished channel, audited', async () => {
    const a = await createTenant(t.db, 'Gamma Services');
    signIn(a.owner);
    hoisted.state.revalidated = [];
    const url = await redirectOf(createAgentAction(a.org.slug, IDLE, form({ name: ' After Hours ' })));
    const agentId = url.split('/').at(-1)!;
    expect(url).toBe(`/o/${a.org.slug}/agents/${agentId}`);
    const [agent] = await t.db.query<{ name: string; business_name: string; enabled: boolean; public_key: string }>(
      `select a.name, p.business_name, c.enabled, c.public_key from public.agents a
       join public.business_profiles p on p.agent_id = a.id and p.organization_id = a.organization_id
       join public.agent_channels c on c.agent_id = a.id and c.organization_id = a.organization_id
       where a.id = $1 and a.organization_id = $2`,
      [agentId, a.org.id],
    );
    expect(agent).toMatchObject({ name: 'After Hours', business_name: 'Gamma Services', enabled: false });
    expect(agent!.public_key).toMatch(/^wk_/);
    expect(await t.db.query('select 1 from public.business_hours where agent_id = $1', [agentId])).toHaveLength(0);
    expect(await auditActions(a.org.id)).toEqual([{ action: 'agent.created', actor_type: 'user', actor_id: a.owner.id }]);
    expect(hoisted.state.revalidated).toEqual(['/o/[orgSlug]|layout']);
  });

  it('refuses members, non-members and invalid names without writing', async () => {
    const a = await createTenant(t.db);
    const b = await createTenant(t.db);
    const member = await createAuthUser(t.db);
    await addMember(t.db, a.org.id, member.id, 'member');
    signIn(member);
    expect(await createAgentAction(a.org.slug, IDLE, form({ name: 'X' }))).toEqual({
      status: 'error',
      message: 'Only owners and admins can change settings.',
    });
    signIn(b.owner);
    expect(await createAgentAction(a.org.slug, IDLE, form({ name: 'X' }))).toEqual({
      status: 'error',
      message: 'You are signed out or no longer have access to this organization.',
    });
    signIn(a.owner);
    expect(await createAgentAction(a.org.slug, IDLE, form({ name: '' }))).toMatchObject({
      status: 'error',
      fieldErrors: { name: ['Enter a name.'] },
    });
    expect(await t.db.query('select 1 from public.agents where organization_id = $1', [a.org.id])).toHaveLength(1);
    expect(await auditActions(a.org.id)).toEqual([]);
  });

  it('still opens the new agent when its channel cannot be created; publishing creates the channel', async () => {
    const a = await createTenant(t.db);
    signIn(a.owner);
    const errors: string[] = [];
    hoisted.state.services = { db: failingOn('insert into public.agent_channels'), logger: errorRecorder(errors), embedder: goodEmbedder };
    let agentId: string;
    try {
      const url = await redirectOf(createAgentAction(a.org.slug, IDLE, form({ name: 'Overflow Desk' })));
      agentId = url.split('/').at(-1)!;
      expect(url).toBe(`/o/${a.org.slug}/agents/${agentId}`);
    } finally {
      useEmbedder(goodEmbedder);
    }
    // The agent and its audit entry exist; only the channel is missing, and the failure is logged.
    expect(errors).toEqual(['admin.web_chat_channel_failed']);
    expect(await t.db.query('select name from public.agents where id = $1', [agentId])).toEqual([{ name: 'Overflow Desk' }]);
    expect(await t.db.query('select 1 from public.agent_channels where agent_id = $1', [agentId])).toHaveLength(0);
    expect((await auditActions(a.org.id)).map((row) => row.action)).toEqual(['agent.created']);

    expect(await setWebChatEnabledAction(a.org.slug, agentId, IDLE, form({ enabled: 'true' }))).toMatchObject({
      status: 'success',
    });
    expect(await t.db.query('select enabled from public.agent_channels where agent_id = $1', [agentId])).toEqual([
      { enabled: true },
    ]);
  });
});

describe('agent configuration actions', () => {
  let a: TenantFixture;
  let b: TenantFixture;

  beforeAll(async () => {
    a = await createTenant(t.db, 'Delta');
    b = await createTenant(t.db, 'Epsilon');
  });

  it('saves settings and audits them', async () => {
    signIn(a.owner);
    const state = await updateAgentSettingsAction(a.org.slug, a.agent.id, IDLE, form(validSettings));
    expect(state).toEqual({ status: 'success', message: 'Settings saved.' });
    const [row] = await t.db.query<Record<string, unknown>>(
      'select name, status, language, timezone, lead_capture from public.agents where id = $1',
      [a.agent.id],
    );
    expect(row).toEqual({
      name: 'Night Desk',
      status: 'paused',
      language: 'en-GB',
      timezone: 'Europe/London',
      lead_capture: { enabled: true, requiredFields: ['email'] },
    });
    expect((await auditActions(a.org.id)).at(-1)).toMatchObject({ action: 'agent.settings_updated', actor_id: a.owner.id });
  });

  it('returns field errors for invalid settings', async () => {
    signIn(a.owner);
    const state = await updateAgentSettingsAction(a.org.slug, a.agent.id, IDLE, form({ ...validSettings, language: 'english!' }));
    expect(state).toEqual({
      status: 'error',
      message: 'Please correct the highlighted fields.',
      fieldErrors: { language: ['Use a language code such as en or en-US.'] },
    });
  });

  it("cannot touch another organization's agent, and treats malformed ids as not found", async () => {
    signIn(a.owner);
    expect(await updateAgentSettingsAction(a.org.slug, b.agent.id, IDLE, form(validSettings))).toEqual({
      status: 'error',
      message: 'Agent not found.',
    });
    expect(await updateAgentSettingsAction(a.org.slug, 'not-a-uuid', IDLE, form(validSettings))).toEqual({
      status: 'error',
      message: 'Agent not found.',
    });
    // Bound arguments come back from the browser: an array that stringifies to a valid UUID is not one.
    const tampered = [a.agent.id] as unknown as string;
    for (const state of [
      await updateAgentSettingsAction(a.org.slug, tampered, IDLE, form(validSettings)),
      await updateBusinessProfileAction(a.org.slug, tampered, IDLE, form({ businessName: 'X' })),
      await updateBusinessHoursAction(a.org.slug, tampered, IDLE, form({})),
      await setWebChatEnabledAction(a.org.slug, tampered, IDLE, form({ enabled: 'true' })),
      await rotateWidgetKeyAction(a.org.slug, tampered, IDLE, form({})),
    ]) {
      expect(state).toEqual({ status: 'error', message: 'Agent not found.' });
    }
    expect(await setWebChatEnabledAction(a.org.slug, b.agent.id, IDLE, form({ enabled: 'false' }))).toEqual({
      status: 'error',
      message: 'Agent not found.',
    });
    expect(await rotateWidgetKeyAction(a.org.slug, b.agent.id, IDLE, form({}))).toEqual({
      status: 'error',
      message: 'Agent not found.',
    });
    expect(await updateBusinessHoursAction(a.org.slug, b.agent.id, IDLE, form({}))).toEqual({
      status: 'error',
      message: 'Agent not found.',
    });
    expect(await updateBusinessProfileAction(a.org.slug, b.agent.id, IDLE, form({ businessName: 'Hijack' }))).toEqual({
      status: 'error',
      message: 'Agent not found.',
    });
    const [other] = await t.db.query<{ name: string; enabled: boolean; public_key: string }>(
      `select a.name, c.enabled, c.public_key from public.agents a join public.agent_channels c on c.agent_id = a.id
       where a.id = $1`,
      [b.agent.id],
    );
    expect(other).toEqual({ name: 'Front Desk', enabled: true, public_key: b.widgetKey });
    expect(await t.db.query('select 1 from public.business_profiles where agent_id = $1', [b.agent.id])).toHaveLength(0);
  });

  it('refuses plain members before writing', async () => {
    const member = await createAuthUser(t.db);
    await addMember(t.db, a.org.id, member.id, 'member');
    // No channel yet: publishing or rotating would create one (in service scope, where RLS does not apply).
    const bare = await createAgent(t.db, a.org.id, { name: 'Bare Desk' });
    const channels = () =>
      t.db.query('select agent_id, enabled, public_key from public.agent_channels where organization_id = $1 order by agent_id', [
        a.org.id,
      ]);
    const before = await channels();
    signIn(member);
    for (const state of [
      await updateAgentSettingsAction(a.org.slug, a.agent.id, IDLE, form({ ...validSettings, name: 'Member edit' })),
      await updateBusinessProfileAction(a.org.slug, a.agent.id, IDLE, form({ businessName: 'Member edit' })),
      await updateBusinessHoursAction(a.org.slug, a.agent.id, IDLE, form({})),
      await setWebChatEnabledAction(a.org.slug, a.agent.id, IDLE, form({ enabled: 'false' })),
      await rotateWidgetKeyAction(a.org.slug, a.agent.id, IDLE, form({})),
      await setWebChatEnabledAction(a.org.slug, bare.id, IDLE, form({ enabled: 'true' })),
      await rotateWidgetKeyAction(a.org.slug, bare.id, IDLE, form({})),
    ]) {
      expect(state).toEqual({ status: 'error', message: 'Only owners and admins can change settings.' });
    }
    const [row] = await t.db.query<{ name: string }>('select name from public.agents where id = $1', [a.agent.id]);
    expect(row!.name).not.toBe('Member edit');
    // The role check is what guards the widget key writes: no key was rotated, no channel created or toggled.
    expect(await channels()).toEqual(before);
  });

  it('saves the business profile and reports invalid fields', async () => {
    signIn(a.owner);
    expect(
      await updateBusinessProfileAction(
        a.org.slug,
        a.agent.id,
        IDLE,
        form({ businessName: 'Delta Heating', phone: '555 0100', website: '', email: 'hi@delta.example' }),
      ),
    ).toEqual({ status: 'success', message: 'Business profile saved.' });
    const [profile] = await t.db.query('select business_name, phone, website, email from public.business_profiles where agent_id = $1', [
      a.agent.id,
    ]);
    expect(profile).toEqual({ business_name: 'Delta Heating', phone: '555 0100', website: null, email: 'hi@delta.example' });
    expect(await updateBusinessProfileAction(a.org.slug, a.agent.id, IDLE, form({ email: 'nope' }))).toMatchObject({
      status: 'error',
      fieldErrors: { email: ['Enter a valid email address.'] },
    });
  });

  it('replaces the weekly hours, maps errors to editor fields, and can close every day', async () => {
    signIn(a.owner);
    const week = form({
      'day-1-open-0': '09:00',
      'day-1-close-0': '12:00',
      'day-1-open-1': '13:00',
      'day-1-close-1': '17:00',
      'day-6-open-0': '22:00',
      'day-6-close-0': '00:00',
    });
    expect(await updateBusinessHoursAction(a.org.slug, a.agent.id, IDLE, week)).toEqual({
      status: 'success',
      message: 'Opening hours saved.',
    });
    const hours = await t.db.query(
      `select day_of_week, to_char(opens_at, 'HH24:MI') as opens, to_char(closes_at, 'HH24:MI') as closes
       from public.business_hours where agent_id = $1 order by day_of_week, opens_at`,
      [a.agent.id],
    );
    expect(hours).toEqual([
      { day_of_week: 1, opens: '09:00', closes: '12:00' },
      { day_of_week: 1, opens: '13:00', closes: '17:00' },
      { day_of_week: 6, opens: '22:00', closes: '24:00' },
    ]);

    const overlapping = form({ 'day-1-open-0': '09:00', 'day-1-close-0': '12:00', 'day-1-open-1': '11:00', 'day-1-close-1': '13:00' });
    expect(await updateBusinessHoursAction(a.org.slug, a.agent.id, IDLE, overlapping)).toEqual({
      status: 'error',
      message: 'Please correct the opening hours.',
      fieldErrors: { 'day-1': ['Monday has overlapping opening hours.'] },
    });

    expect(await updateBusinessHoursAction(a.org.slug, a.agent.id, IDLE, form({}))).toMatchObject({ status: 'success' });
    expect(await t.db.query('select 1 from public.business_hours where agent_id = $1', [a.agent.id])).toHaveLength(0);
  });

  it('publishes, unpublishes and rotates the widget key, audited', async () => {
    const c = await createTenant(t.db);
    signIn(c.owner);
    expect(await setWebChatEnabledAction(c.org.slug, c.agent.id, IDLE, form({ enabled: 'false' }))).toMatchObject({
      status: 'success',
    });
    expect(await setWebChatEnabledAction(c.org.slug, c.agent.id, IDLE, form({ enabled: 'maybe' }))).toMatchObject({
      status: 'error',
    });
    expect(await rotateWidgetKeyAction(c.org.slug, c.agent.id, IDLE, form({}))).toMatchObject({ status: 'success' });
    expect(await setWebChatEnabledAction(c.org.slug, c.agent.id, IDLE, form({ enabled: 'true' }))).toEqual({
      status: 'success',
      message: 'Web chat is published.',
    });
    const [channel] = await t.db.query<{ enabled: boolean; public_key: string }>(
      'select enabled, public_key from public.agent_channels where agent_id = $1',
      [c.agent.id],
    );
    expect(channel!.enabled).toBe(true);
    expect(channel!.public_key).not.toBe(c.widgetKey);
    expect((await auditActions(c.org.id)).map((row) => row.action)).toEqual([
      'agent.web_chat_unpublished',
      'agent.widget_key_rotated',
      'agent.web_chat_published',
    ]);
  });

  it('publishes an agent that has no web chat channel yet, with a server-generated widget key', async () => {
    const c = await createTenant(t.db);
    const bare = await createAgent(t.db, c.org.id, { name: 'Night Desk' });
    signIn(c.owner);
    expect(await setWebChatEnabledAction(c.org.slug, bare.id, IDLE, form({ enabled: 'true' }))).toEqual({
      status: 'success',
      message: 'Web chat is published.',
    });
    const channels = await t.db.query<{ enabled: boolean; public_key: string }>(
      'select enabled, public_key from public.agent_channels where agent_id = $1',
      [bare.id],
    );
    expect(channels).toEqual([{ enabled: true, public_key: expect.stringMatching(/^wk_[A-Za-z0-9]{32}$/) as unknown }]);
    expect((await auditActions(c.org.id)).map((row) => row.action)).toEqual(['agent.web_chat_published']);
  });
});

describe('knowledge actions', () => {
  it('adds text knowledge (ready, chunked, audited) and refuses another organization\'s agent as scope', async () => {
    const a = await createTenant(t.db);
    const b = await createTenant(t.db);
    signIn(a.owner);
    useEmbedder(goodEmbedder);
    const state = await addTextSourceAction(
      a.org.slug,
      IDLE,
      form({ title: 'Pricing', text: 'Our standard call-out fee is $89.\r\n\r\nWe offer 24/7 emergency repair.', agentId: '' }),
    );
    expect(state).toEqual({ status: 'success', message: 'Added "Pricing". The assistant can use it now.' });
    const [source] = await t.db.query<{ status: string; chunk_count: number; agent_id: string | null; created_by: string }>(
      'select status, chunk_count, agent_id, created_by from public.knowledge_sources where organization_id = $1',
      [a.org.id],
    );
    expect(source).toMatchObject({ status: 'ready', agent_id: null, created_by: a.owner.id });
    expect(source!.chunk_count).toBeGreaterThan(0);
    expect((await auditActions(a.org.id)).map((row) => row.action)).toEqual(['knowledge_source.created']);

    expect(
      await addTextSourceAction(a.org.slug, IDLE, form({ title: 'Sneaky', text: 'Some text.', agentId: b.agent.id })),
    ).toEqual({ status: 'error', message: 'Choose a valid agent.' });
    expect(await addTextSourceAction(a.org.slug, IDLE, form({ title: '', text: ' ', agentId: 'x' }))).toMatchObject({
      status: 'error',
      fieldErrors: { title: ['Enter a title.'], text: ['Enter some text.'], agentId: ['Choose a valid agent.'] },
    });
    expect(await t.db.query('select 1 from public.knowledge_sources where organization_id = $1', [a.org.id])).toHaveLength(1);
  });

  it('uploads a Markdown file and validates the upload', async () => {
    const a = await createTenant(t.db);
    signIn(a.owner);
    useEmbedder(goodEmbedder);
    const upload = new FormData();
    upload.append('file', new File(['# FAQ\n\nWe serve Springfield.'], 'faq.md', { type: '' }));
    upload.append('title', '');
    upload.append('agentId', a.agent.id);
    expect(await uploadFileSourceAction(a.org.slug, IDLE, upload)).toMatchObject({ status: 'success' });
    const [source] = await t.db.query('select title, kind, file_name, mime_type, agent_id from public.knowledge_sources where organization_id = $1', [
      a.org.id,
    ]);
    expect(source).toEqual({ title: 'faq', kind: 'file', file_name: 'faq.md', mime_type: 'text/markdown', agent_id: a.agent.id });

    const pdf = new FormData();
    pdf.append('file', new File(['%PDF'], 'faq.pdf', { type: 'application/pdf' }));
    expect(await uploadFileSourceAction(a.org.slug, IDLE, pdf)).toEqual({
      status: 'error',
      message: 'Upload a .txt, .md or .markdown file.',
      fieldErrors: { file: ['Upload a .txt, .md or .markdown file.'] },
    });
    const binary = new FormData();
    binary.append('file', new File([new Uint8Array([104, 0, 105])], 'notes.txt'));
    expect(await uploadFileSourceAction(a.org.slug, IDLE, binary)).toMatchObject({
      fieldErrors: { file: ['The file contains binary data, not text.'] },
    });
    expect(await uploadFileSourceAction(a.org.slug, IDLE, new FormData())).toMatchObject({
      fieldErrors: { file: ['Choose a file to upload.'] },
    });
  });

  it('reports a processing failure, then retries it; refuses to retry a ready source', async () => {
    const a = await createTenant(t.db);
    signIn(a.owner);
    useEmbedder(brokenEmbedder);
    const failed = await addTextSourceAction(a.org.slug, IDLE, form({ title: 'Hours', text: 'Open late on Fridays.', agentId: '' }));
    expect(failed).toEqual({
      status: 'error',
      message:
        '"Hours" was saved but could not be processed: The embedding service is unavailable. Please try again later. You can retry it from the list.',
    });
    const [source] = await t.db.query<{ id: string; status: string }>(
      'select id, status from public.knowledge_sources where organization_id = $1',
      [a.org.id],
    );
    expect(source!.status).toBe('failed');

    useEmbedder(goodEmbedder);
    expect(await retrySourceAction(a.org.slug, source!.id, IDLE, form({}))).toEqual({ status: 'success', message: 'Processed.' });
    expect(await retrySourceAction(a.org.slug, source!.id, IDLE, form({}))).toEqual({
      status: 'error',
      message: 'This source is being processed or does not need a retry.',
    });
    expect((await auditActions(a.org.id)).map((row) => row.action)).toEqual([
      'knowledge_source.created',
      'knowledge_source.reindexed',
    ]);
  });

  it('deletes only its own sources and refuses members', async () => {
    const a = await createTenant(t.db);
    const b = await createTenant(t.db);
    useEmbedder(goodEmbedder);
    signIn(b.owner);
    await addTextSourceAction(b.org.slug, IDLE, form({ title: 'B facts', text: 'Pinball restoration.', agentId: '' }));
    const [bSource] = await t.db.query<{ id: string }>('select id from public.knowledge_sources where organization_id = $1', [
      b.org.id,
    ]);
    signIn(a.owner);
    await addTextSourceAction(a.org.slug, IDLE, form({ title: 'A facts', text: 'Boiler repair.', agentId: '' }));
    const [aSource] = await t.db.query<{ id: string }>('select id from public.knowledge_sources where organization_id = $1', [
      a.org.id,
    ]);

    expect(await deleteSourceAction(a.org.slug, bSource!.id, IDLE, form({}))).toEqual({
      status: 'error',
      message: 'Knowledge source not found.',
    });
    expect(await retrySourceAction(a.org.slug, bSource!.id, IDLE, form({}))).toEqual({
      status: 'error',
      message: 'Knowledge source not found.',
    });
    expect(await t.db.query('select 1 from public.knowledge_sources where id = $1', [bSource!.id])).toHaveLength(1);
    const tampered = [aSource!.id] as unknown as string;
    expect(await deleteSourceAction(a.org.slug, tampered, IDLE, form({}))).toEqual({
      status: 'error',
      message: 'Knowledge source not found.',
    });
    expect(await retrySourceAction(a.org.slug, tampered, IDLE, form({}))).toEqual({
      status: 'error',
      message: 'Knowledge source not found.',
    });

    const member = await createAuthUser(t.db);
    await addMember(t.db, a.org.id, member.id, 'member');
    signIn(member);
    expect(await deleteSourceAction(a.org.slug, aSource!.id, IDLE, form({}))).toEqual({
      status: 'error',
      message: 'Only owners and admins can change settings.',
    });

    signIn(a.owner);
    expect(await deleteSourceAction(a.org.slug, aSource!.id, IDLE, form({}))).toEqual({ status: 'success', message: 'Deleted.' });
    expect(await deleteSourceAction(a.org.slug, aSource!.id, IDLE, form({}))).toEqual({
      status: 'error',
      message: 'Knowledge source not found.',
    });
    expect(await t.db.query('select 1 from public.knowledge_chunks where source_id = $1', [aSource!.id])).toHaveLength(0);
  });
});
