import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  class RedirectSignal extends Error {
    readonly url: string;
    constructor(url: string) {
      super(`NEXT_REDIRECT ${url}`);
      this.url = url;
    }
  }
  const state: { user: { id: string; email: string | null } | null; services: unknown; pathname: string } = {
    user: null,
    services: undefined,
    pathname: '/',
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
  usePathname: () => hoisted.state.pathname,
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'app.example.com', 'x-forwarded-proto': 'https' }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('@/server/auth/session', () => ({
  getAuthUser: async () => hoisted.state.user,
  requireUser: async () => {
    if (!hoisted.state.user) throw new hoisted.RedirectSignal('/login');
    return hoisted.state.user;
  },
}));
vi.mock('@/server/app-services', () => ({ getAppServices: () => hoisted.state.services }));

import CheckEmailPage from '@/app/(auth)/check-email/page';
import LoginPage from '@/app/(auth)/login/page';
import SignUpPage from '@/app/(auth)/signup/page';
import AuthErrorPage from '@/app/auth/error/page';
import AgentPage from '@/app/o/[orgSlug]/agents/[agentId]/page';
import AgentsPage from '@/app/o/[orgSlug]/agents/page';
import ConversationPage from '@/app/o/[orgSlug]/conversations/[conversationId]/page';
import ConversationsPage from '@/app/o/[orgSlug]/conversations/page';
import KnowledgePage from '@/app/o/[orgSlug]/knowledge/page';
import OrganizationLayout from '@/app/o/[orgSlug]/layout';
import LeadsPage from '@/app/o/[orgSlug]/leads/page';
import OrganizationNotFound from '@/app/o/[orgSlug]/not-found';
import OverviewPage from '@/app/o/[orgSlug]/page';
import OnboardingPage from '@/app/onboarding/page';
import HomePage from '@/app/page';
import type { Embedder } from '@/server/ai/embedder';
import { ProviderError } from '@/server/ai/types';
import { userScope } from '@/server/db/scope';
import { jsonParam } from '@/server/db/sql';
import { replaceBusinessHours, upsertBusinessProfile } from '@/server/domain/business/repository';
import { captureLead } from '@/server/domain/contacts/service';
import { appendMessage } from '@/server/domain/conversations/service';
import { ingestTextSource } from '@/server/domain/knowledge/ingestion';
import { createOrganization } from '@/server/domain/organizations/service';
import { silentLogger } from '@/server/observability/logger';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { fakeEmbed } from '../support/fake-embeddings';
import { addMember, createAuthUser, createConversation, createTenant, type TenantFixture, type UserFixture } from '../support/fixtures';

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
let a: TenantFixture;
let b: TenantFixture;
let member: UserFixture;
let conversationId: string;
let otherConversationId: string;

function signIn(user: { id: string; email: string } | null) {
  hoisted.state.user = user ? { id: user.id, email: user.email } : null;
}

async function html(element: Promise<ReactElement> | ReactElement): Promise<string> {
  return renderToStaticMarkup(await element);
}

async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'rendered';
  } catch (error) {
    if (error instanceof hoisted.RedirectSignal) return `redirect:${error.url}`;
    if (error instanceof Error && error.message === 'NEXT_NOT_FOUND') return 'not-found';
    throw error;
  }
}

const params = <T,>(value: T) => ({ params: Promise.resolve(value) });
const search = (value: Record<string, string | string[] | undefined>) => ({ searchParams: Promise.resolve(value) });

beforeAll(async () => {
  t = await createTestDatabase();
  hoisted.state.services = { db: t.db, logger: silentLogger, embedder: goodEmbedder };
  a = await createTenant(t.db, 'Acme <Plumbing> & Sons');
  b = await createTenant(t.db, 'Beta');
  member = await createAuthUser(t.db);
  await addMember(t.db, a.org.id, member.id, 'member');

  const owner = userScope(t.db, a.owner.id);
  await owner.run(async (sql) => {
    await upsertBusinessProfile(sql, a.org.id, a.agent.id, {
      businessName: 'Acme Plumbing',
      description: 'Pipes.',
      phone: '555 0100',
      email: 'hi@acme.example',
      website: 'https://acme.example',
      address: '1 Main St',
      serviceArea: 'Springfield',
    });
    await replaceBusinessHours(sql, a.org.id, a.agent.id, [
      { dayOfWeek: 1, opensAt: '09:00', closesAt: '17:00' },
      { dayOfWeek: 5, opensAt: '18:00', closesAt: '24:00' },
    ]);
  });
  await ingestTextSource(owner, goodEmbedder, {
    organizationId: a.org.id,
    agentId: null,
    kind: 'text',
    title: 'Pricing <b>',
    text: 'Call-out fee is $89.',
    createdBy: a.owner.id,
  });
  await ingestTextSource(owner, brokenEmbedder, {
    organizationId: a.org.id,
    agentId: a.agent.id,
    kind: 'file',
    title: 'FAQ',
    text: 'We serve Springfield.',
    createdBy: a.owner.id,
    file: { name: 'faq.md', mimeType: 'text/markdown', byteSize: 21 },
  });
  await t.db.query(
    `insert into public.knowledge_sources (organization_id, agent_id, kind, title, status, created_at, updated_at)
     values ($1, null, 'text', 'Stuck', 'processing', now() - interval '1 hour', now() - interval '1 hour')`,
    [a.org.id],
  );

  const conversation = await createConversation(t.db, a.org.id, a.agent.id);
  conversationId = conversation.id;
  otherConversationId = (await createConversation(t.db, b.org.id, b.agent.id)).id;
  const [run] = await t.db.query<{ id: string }>(
    `insert into public.tool_runs (organization_id, agent_id, conversation_id, channel, tool_name, status, input, output, duration_ms, finished_at)
     values ($1, $2, $3, 'web_chat', 'getBusinessHours', 'succeeded', '{}'::jsonb, $4::jsonb, 12, now()) returning id`,
    [a.org.id, a.agent.id, conversationId, jsonParam({ isOpenNow: true, weekly: [{ day: 'Monday' }], nextChange: { kind: 'closes' }, timezone: 'UTC' })],
  );
  const [failedRun] = await t.db.query<{ id: string }>(
    `insert into public.tool_runs (organization_id, agent_id, conversation_id, channel, tool_name, status, input, error_code, error_message, duration_ms, finished_at)
     values ($1, $2, $3, 'web_chat', 'captureLead', 'failed', '{}'::jsonb, 'invalid', 'A valid phone number or email address is required.', 1500, now()) returning id`,
    [a.org.id, a.agent.id, conversationId],
  );
  await t.service.run(async (sql) => {
    const append = (message: Parameters<typeof appendMessage>[3]) => appendMessage(sql, a.org.id, conversationId, message);
    await append({ role: 'user', content: 'When are you open?\nThanks <script>' });
    await append({ role: 'tool_call', toolName: 'getBusinessHours', toolCallId: 'c1', data: { arguments: { day: 'monday', ['k'.repeat(300)]: 'x'.repeat(500), list: ['a', 1], nested: { x: 1 } } } });
    await append({ role: 'tool_result', toolName: 'getBusinessHours', toolCallId: 'c1', toolRunId: run!.id, data: { ok: true, errorCode: null, replayed: false } });
    await append({ role: 'tool_call', toolName: 'captureLead', toolCallId: 'c2', data: { arguments: 'not json {' } });
    await append({ role: 'tool_result', toolName: 'captureLead', toolCallId: 'c2', toolRunId: failedRun!.id, data: { ok: false, errorCode: 'invalid', replayed: false } });
    await append({ role: 'assistant', content: 'We are open 9-5.', data: { model: 'm', tier: 'escalation', rounds: 2 } });
    await append({ role: 'assistant', content: 'Sorry.', data: { fallback: true, tier: 'default' } });
    await append({ role: 'system', content: 'assistant_unavailable', data: { code: 'unavailable' } });
    await append({ role: 'system', content: 'constructor', data: {} });
    await captureLead(sql, {
      organizationId: a.org.id,
      agentId: a.agent.id,
      conversationId,
      channel: 'web_chat',
      name: 'Jo <Visitor>',
      phone: '+1 555 0100',
      email: 'jo@example.com',
      summary: 'Leaking tap.\nUrgent.',
    });
  });
});

afterAll(async () => {
  await t.close();
});

describe('public pages', () => {
  it('shows the landing page to visitors and sends signed-in users to their organization', async () => {
    signIn(null);
    expect(await html(HomePage())).toContain('Create account');
    signIn(a.owner);
    expect(await outcome(HomePage())).toBe(`redirect:/o/${a.org.slug}`);
    const fresh = await createAuthUser(t.db);
    signIn(fresh);
    expect(await outcome(HomePage())).toBe('redirect:/onboarding');
  });

  it('renders the auth pages with a safe, normalized next path', async () => {
    signIn(null);
    const login = await html(LoginPage(search({ next: '/o/acme/../acme/leads' })));
    expect(login).toContain('name="next" value="/o/acme/leads"');
    expect(login).toContain('href="/signup?next=%2Fo%2Facme%2Fleads"');
    expect(await html(LoginPage(search({ next: '/..//evil.com' })))).toContain('name="next" value="/"');
    const signup = await html(SignUpPage(search({})));
    expect(signup).toContain('name="next" value="/onboarding"');
    expect(await html(CheckEmailPage(search({ next: ['/o/x', '/o/y'] })))).toContain('href="/login?next=%2Fo%2Fx"');
    expect(renderToStaticMarkup(AuthErrorPage())).toContain('invalid or has expired');
    signIn(a.owner);
    expect(await outcome(LoginPage(search({ next: '/o/acme' })))).toBe('redirect:/o/acme');
  });

  it('renders onboarding for signed-in users', async () => {
    signIn(a.owner);
    const page = await html(OnboardingPage());
    expect(page).toContain('Create another organization');
    expect(page).toContain(`href="/o/${a.org.slug}"`);
    // Onboarding sets up no opening hours, and says so.
    expect(page).toContain('add your opening hours');
    expect(page).not.toContain('weekday hours');
    signIn(null);
    expect(await outcome(OnboardingPage())).toBe('redirect:/login');
  });
});

describe('organization pages', () => {
  it('renders the shell with navigation, switcher and account', async () => {
    signIn(a.owner);
    hoisted.state.pathname = `/o/${a.org.slug}/agents/${a.agent.id}`;
    const shell = await html(OrganizationLayout({ children: 'CHILD', ...params({ orgSlug: a.org.slug }) }));
    expect(shell).toContain('CHILD');
    expect(shell).toContain('Acme &lt;Plumbing&gt; &amp; Sons');
    expect(shell).toContain(a.owner.email);
    expect(shell).toMatch(/aria-current="page"[^>]*>Agents</);
    expect(shell).toContain('Sign out');
    signIn(b.owner);
    expect(await outcome(OrganizationLayout({ children: null, ...params({ orgSlug: a.org.slug }) }))).toBe('not-found');
  });

  it('renders the overview checklist and recent activity', async () => {
    signIn(a.owner);
    const page = await html(OverviewPage(params({ orgSlug: a.org.slug })));
    expect(page).toContain('4 of 4 setup steps done');
    expect(page).toContain('Jo &lt;Visitor&gt;');
    expect(page).toContain(`/o/${a.org.slug}/conversations/${conversationId}`);
  });

  it('leaves opening hours to do on the checklist of a newly onboarded organization', async () => {
    const owner = await createAuthUser(t.db);
    const { organization } = await createOrganization(t.db, { name: 'Fresh Start Heating', ownerUserId: owner.id });
    signIn(owner);
    const page = await html(OverviewPage(params({ orgSlug: organization.slug })));
    expect(page).toContain('1 of 4 setup steps done');
    expect(page).toContain('Business name added<span class="sr-only"> (done)</span>');
    expect(page).toContain('Opening hours set<span class="sr-only"> (to do)</span>');
  });

  it('renders the agents list, with the create form for admins only', async () => {
    signIn(a.owner);
    const page = await html(AgentsPage(params({ orgSlug: a.org.slug })));
    expect(page).toContain('Web chat published');
    expect(page).toContain('Create agent');
    signIn(member);
    expect(await html(AgentsPage(params({ orgSlug: a.org.slug })))).not.toContain('Create agent');
  });

  it('renders the agent page editable for admins and read-only for members', async () => {
    signIn(a.owner);
    const page = await html(AgentPage(params({ orgSlug: a.org.slug, agentId: a.agent.id })));
    expect(page).toContain('Save settings');
    expect(page).toContain('Acme Plumbing');
    expect(page).toContain('name="day-1-open-0"');
    expect(page).toContain('name="day-5-close-0" value="00:00"');
    expect(page).toContain(`&lt;script src=&quot;https://app.example.com/embed.js&quot; data-widget-key=&quot;${a.widgetKey}&quot; async&gt;&lt;/script&gt;`);
    expect(page).toContain(`href="/widget/${a.widgetKey}"`);
    expect(page).toContain('<option value="America/New_York">');
    signIn(member);
    const readOnly = await html(AgentPage(params({ orgSlug: a.org.slug, agentId: a.agent.id })));
    expect(readOnly).toContain('view-only access');
    expect(readOnly).not.toContain('Save settings');
    expect(readOnly).not.toContain('Rotate key');
    signIn(a.owner);
    expect(await outcome(AgentPage(params({ orgSlug: a.org.slug, agentId: 'nope' })))).toBe('not-found');
    expect(await outcome(AgentPage(params({ orgSlug: a.org.slug, agentId: b.agent.id })))).toBe('not-found');
  });

  it('renders knowledge with statuses, retry for failed and stuck sources, and admin-only forms', async () => {
    signIn(a.owner);
    const page = await html(KnowledgePage(params({ orgSlug: a.org.slug })));
    expect(page).toContain('Pricing &lt;b&gt;');
    expect(page).toContain('The embedding service is unavailable');
    expect(page).toContain('Processing was interrupted');
    expect(page.match(/>Retry</g)).toHaveLength(2);
    expect(page).toContain('File: faq.md (21 B)');
    expect(page).toContain('Upload file');
    signIn(member);
    const readOnly = await html(KnowledgePage(params({ orgSlug: a.org.slug })));
    expect(readOnly).not.toContain('Upload file');
    expect(readOnly).not.toContain('>Delete<');
  });

  it('renders conversations and a transcript with tool rows, safely', async () => {
    signIn(member);
    const list = await html(ConversationsPage(params({ orgSlug: a.org.slug })));
    expect(list).toContain('Jo &lt;Visitor&gt;');
    const page = await html(ConversationPage(params({ orgSlug: a.org.slug, conversationId })));
    expect(page).toContain('When are you open?\nThanks &lt;script&gt;');
    expect(page).toContain('Tool call: <code class="font-mono">getBusinessHours</code>');
    expect(page).toContain('raw arguments');
    expect(page).toContain('Answered by the escalation model');
    expect(page).toContain('Fallback reply');
    expect(page).toContain('The assistant could not respond');
    expect(page).toContain('System event: constructor');
    expect(page).toContain('A valid phone number or email address is required.');
    expect(page).toContain('1.5 s');
    expect(page).not.toContain('k'.repeat(41));
    expect(page).toContain('href="tel:+1 555 0100"');
    expect(await outcome(ConversationPage(params({ orgSlug: a.org.slug, conversationId: otherConversationId })))).toBe(
      'not-found',
    );
    expect(await outcome(ConversationPage(params({ orgSlug: a.org.slug, conversationId: 'x' })))).toBe('not-found');
  });

  it('renders leads', async () => {
    signIn(member);
    const page = await html(LeadsPage(params({ orgSlug: a.org.slug })));
    expect(page).toContain('jo@example.com');
    expect(page).toContain('Leaking tap.\nUrgent.');
    expect(page).toContain('View conversation');
    signIn(b.owner);
    const other = await html(LeadsPage(params({ orgSlug: b.org.slug })));
    expect(other).toContain('No leads yet');
    expect(other).not.toContain('jo@example.com');
  });

  it("shows each lead and conversation with what its visitor gave, even when another visitor reuses the phone number", async () => {
    // Someone else gives Jo's phone number with their own name and email address in a new chat.
    const malloryConversationId = (await createConversation(t.db, a.org.id, a.agent.id)).id;
    await t.service.run((sql) =>
      captureLead(sql, {
        organizationId: a.org.id,
        agentId: a.agent.id,
        conversationId: malloryConversationId,
        channel: 'web_chat',
        name: 'Mallory',
        phone: '+1 (555) 0100',
        email: 'mallory@attacker.example',
        summary: 'Email me the invoice.',
      }),
    );
    signIn(member);
    const pieces = (markup: string, tag: string) => markup.split(`<${tag}`).slice(1);

    // Leads: Jo's lead is unchanged; Mallory's shows Mallory's details, with Jo's contact as the linked record.
    const rows = pieces(await html(LeadsPage(params({ orgSlug: a.org.slug }))), 'tr');
    const joRow = rows.find((row) => row.includes('Leaking tap.'));
    expect(joRow).toContain('Jo &lt;Visitor&gt;');
    expect(joRow).toContain('jo@example.com');
    expect(joRow).not.toContain('Mallory');
    expect(joRow).not.toContain('attacker');
    expect(joRow).not.toContain('Linked contact');
    const malloryRow = rows.find((row) => row.includes('Email me the invoice.'));
    expect(malloryRow).toContain('>Mallory<');
    expect(malloryRow).toContain('mallory@attacker.example');
    expect(malloryRow).toContain('Linked contact: Jo &lt;Visitor&gt; · +1 555 0100 · jo@example.com');

    // Conversations: the contact card shows the details given in that chat first.
    const joPage = await html(ConversationPage(params({ orgSlug: a.org.slug, conversationId })));
    expect(joPage).toContain('href="mailto:jo@example.com"');
    expect(joPage).not.toContain('attacker');
    const malloryPage = await html(ConversationPage(params({ orgSlug: a.org.slug, conversationId: malloryConversationId })));
    expect(malloryPage).toContain('<span aria-current="page" class="text-slate-600">Mallory</span>');
    expect(malloryPage).toContain('href="mailto:mallory@attacker.example"');
    expect(malloryPage).toContain('href="tel:+1 (555) 0100"');
    expect(malloryPage).not.toContain('mailto:jo@example.com');
    expect(malloryPage).toContain('Linked contact: Jo &lt;Visitor&gt; · +1 555 0100 · jo@example.com');

    // Overview: the recent leads read the same way.
    const overview = await html(OverviewPage(params({ orgSlug: a.org.slug })));
    const leadItems = pieces(overview, 'li').filter((item) => item.includes('View conversation'));
    const joItem = leadItems.find((item) => item.includes(`/conversations/${conversationId}"`));
    expect(joItem).toContain('Jo &lt;Visitor&gt;');
    expect(joItem).not.toContain('attacker');
    const malloryItem = leadItems.find((item) => item.includes(`/conversations/${malloryConversationId}"`));
    expect(malloryItem).toContain('>Mallory<');
    expect(malloryItem).toContain('+1 (555) 0100 · mallory@attacker.example');
    expect(malloryItem).toContain('Linked contact: Jo &lt;Visitor&gt;');

    // Conversation lists (the Conversations page and the overview's recent conversations): each chat is listed under
    // what its visitor gave, so Mallory's chat is never listed under the name on the contact it is linked to.
    const linkTexts = (markup: string, id: string) =>
      [...markup.matchAll(new RegExp(`href="/o/${a.org.slug}/conversations/${id}"[^>]*>([^<]*)</a>`, 'g'))].map(
        (match) => match[1],
      );
    const conversationsList = await html(ConversationsPage(params({ orgSlug: a.org.slug })));
    expect(linkTexts(conversationsList, malloryConversationId)).toEqual(['Mallory']);
    expect(linkTexts(conversationsList, conversationId)).toEqual(['Jo &lt;Visitor&gt;']);
    // On the overview, each chat's link from its recent lead comes first, then the chat itself.
    expect(linkTexts(overview, malloryConversationId)).toEqual(['View conversation', 'Mallory']);
    expect(linkTexts(overview, conversationId)).toEqual(['View conversation', 'Jo &lt;Visitor&gt;']);
  });

  it('renders the not-found page', () => {
    expect(renderToStaticMarkup(OrganizationNotFound())).toContain('Not found');
  });
});

/** Duplicate ids, and visible controls without a label, aria-label or aria-labelledby. */
function a11yProblems(markup: string): string[] {
  const problems: string[] = [];
  const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) problems.push(`duplicate id ${id}`);
    seen.add(id);
  }
  const labelled = new Set([...markup.matchAll(/<label[^>]*\sfor="([^"]+)"/g)].map((match) => match[1]!));
  for (const match of markup.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const attributes = match[2]!;
    const type = /\stype="([^"]+)"/.exec(attributes)?.[1];
    if (type === 'hidden' || type === 'submit') continue;
    const id = /\sid="([^"]+)"/.exec(attributes)?.[1];
    if (/\saria-label(ledby)?="/.test(attributes)) continue;
    if (id === undefined || !labelled.has(id)) problems.push(`unlabelled ${match[1]} ${id ?? attributes.slice(0, 60)}`);
  }
  return problems;
}

describe('accessibility basics', () => {
  it('has unique ids and labelled controls on every page', async () => {
    signIn(null);
    for (const [name, markup] of [
      ['login', await html(LoginPage(search({})))],
      ['signup', await html(SignUpPage(search({})))],
    ] as const) {
      expect({ name, problems: a11yProblems(markup) }).toEqual({ name, problems: [] });
    }
    const pages: Array<[string, () => Promise<string>]> = [
      ['onboarding', () => html(OnboardingPage())],
      ['overview', () => html(OverviewPage(params({ orgSlug: a.org.slug })))],
      ['agents', () => html(AgentsPage(params({ orgSlug: a.org.slug })))],
      ['agent', () => html(AgentPage(params({ orgSlug: a.org.slug, agentId: a.agent.id })))],
      ['knowledge', () => html(KnowledgePage(params({ orgSlug: a.org.slug })))],
      ['conversation', () => html(ConversationPage(params({ orgSlug: a.org.slug, conversationId })))],
      ['leads', () => html(LeadsPage(params({ orgSlug: a.org.slug })))],
      ['layout', () => html(OrganizationLayout({ children: null, ...params({ orgSlug: a.org.slug }) }))],
    ];
    signIn(a.owner);
    for (const [name, render] of pages) {
      expect({ name, problems: a11yProblems(await render()) }).toEqual({ name, problems: [] });
    }
  });
});
