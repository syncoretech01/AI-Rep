import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getBusinessHours } from '@/server/agent/tools/definitions';
import type { ToolContext } from '@/server/agent/tools/types';
import { findPublishedWidget, getWebChatChannel } from '@/server/domain/agents/repository';
import * as widgetKey from '@/server/domain/agents/widget-key';
import { recordAudit } from '@/server/domain/audit/service';
import { getBusinessProfile, listBusinessHours } from '@/server/domain/business/repository';
import { createOrganization, getMembershipBySlug, listMemberships } from '@/server/domain/organizations/service';
import { WIDGET_KEY_PATTERN } from '@/shared/widget-protocol';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { addMember, createAuthUser } from '../support/fixtures';

// Real implementation by default; one test pins the slug suffix. (Never stub the global
// crypto.getRandomValues here: PGlite draws gen_random_uuid() entropy from it too.)
vi.mock('@/server/domain/agents/widget-key', async (importOriginal) => {
  const actual = await importOriginal<typeof widgetKey>();
  return { ...actual, randomString: vi.fn(actual.randomString) };
});

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.close();
});

const unique = (name: string) => `${name} ${randomUUID().slice(0, 8)}`;
const newUser = () => t.service.run((sql) => createAuthUser(sql));

describe('createOrganization', () => {
  it('creates the organization, owner, first agent, profile, unpublished web chat and an audit entry', async () => {
    const owner = await newUser();
    const { organization, agent } = await createOrganization(t.db, {
      name: '  Zephyr Heating & Air  ',
      ownerUserId: owner.id,
    });

    expect(organization).toMatchObject({ name: 'Zephyr Heating & Air', slug: 'zephyr-heating-air' });
    expect(organization.createdAt).toBeInstanceOf(Date);
    expect(agent).toMatchObject({
      organizationId: organization.id,
      name: 'Receptionist',
      status: 'active',
      timezone: 'UTC',
      leadCapture: { enabled: true, requiredFields: ['name', 'phone'] },
    });

    const members = await t.db.query('select user_id, role from public.organization_members where organization_id = $1', [
      organization.id,
    ]);
    expect(members).toEqual([{ user_id: owner.id, role: 'owner' }]);

    const config = await t.service.run(async (sql) => ({
      profile: await getBusinessProfile(sql, organization.id, agent.id),
      hours: await listBusinessHours(sql, organization.id, agent.id),
      channel: await getWebChatChannel(sql, organization.id, agent.id),
    }));
    expect(config.profile).toMatchObject({ businessName: 'Zephyr Heating & Air', phone: null, email: null, website: null });
    // No placeholder opening hours: the owner has not entered any (see the next test).
    expect(config.hours).toEqual([]);
    expect(config.channel).toMatchObject({ agentId: agent.id, channel: 'web_chat', enabled: false });
    expect(config.channel?.publicKey).toMatch(WIDGET_KEY_PATTERN);
    // Nothing is public until the owner publishes the widget.
    expect(await t.service.run((sql) => findPublishedWidget(sql, config.channel!.publicKey!))).toBeNull();

    const audit = await t.db.query(
      `select actor_type, actor_id, action, target_type, target_id, metadata
       from public.audit_logs where organization_id = $1`,
      [organization.id],
    );
    expect(audit).toEqual([
      {
        actor_type: 'user',
        actor_id: owner.id,
        action: 'organization.created',
        target_type: 'organization',
        target_id: organization.id,
        metadata: { slug: 'zephyr-heating-air', agentId: agent.id },
      },
    ]);
  });

  it('leaves opening hours unset, so the new agent says they are not configured instead of inventing them', async () => {
    const owner = await newUser();
    const { organization, agent } = await createOrganization(t.db, { name: unique('Hours'), ownerUserId: owner.id });
    const context: ToolContext = {
      organizationId: organization.id,
      agent,
      conversationId: randomUUID(),
      channel: 'web_chat',
      now: new Date(),
      db: t.service,
      embedder: { model: 'unused', embed: () => Promise.reject(new Error('not used')) },
      retrieval: { maxChunks: 1, maxTokens: 100, minSimilarity: 0 },
    };

    expect(await getBusinessHours.handler({}, context)).toEqual({
      ok: true,
      data: { configured: false, note: 'Business hours are not configured.' },
    });
  });

  it('names the first agent from the input, treating a blank name as the default', async () => {
    const owner = await newUser();
    const named = await createOrganization(t.db, { name: unique('Named'), ownerUserId: owner.id, agentName: '  Ava  ' });
    expect(named.agent.name).toBe('Ava');
    const blank = await createOrganization(t.db, { name: unique('Blank'), ownerUserId: owner.id, agentName: '   ' });
    expect(blank.agent.name).toBe('Receptionist');
  });

  it('adds a random suffix when the slug is already taken', async () => {
    const owner = await newUser();
    const first = await createOrganization(t.db, { name: 'Bright Smile Dental', ownerUserId: owner.id });
    const second = await createOrganization(t.db, { name: 'Bright Smile Dental!', ownerUserId: owner.id });
    expect(first.organization.slug).toBe('bright-smile-dental');
    expect(second.organization).toMatchObject({ name: 'Bright Smile Dental!' });
    expect(second.organization.slug).toMatch(/^bright-smile-dental-[a-z0-9]{4}$/);
  });

  it('gives up with a conflict when no free slug is found', async () => {
    const owner = await newUser();
    await t.db.query(`insert into public.organizations (name, slug) values ('Busy Bee', 'busy-bee'), ('Busy Bee', 'busy-bee-aaaa')`);
    const suffix = vi.mocked(widgetKey.randomString).mockReset().mockReturnValue('aaaa');
    try {
      await expect(createOrganization(t.db, { name: 'Busy Bee', ownerUserId: owner.id })).rejects.toMatchObject({
        name: 'DomainError',
        code: 'conflict',
      });
      // The base slug plus five suffixed attempts.
      expect(suffix).toHaveBeenCalledTimes(5);
    } finally {
      suffix.mockReset();
    }
    const rows = await t.db.query('select slug from public.organizations where name = $1 order by slug', ['Busy Bee']);
    expect(rows).toEqual([{ slug: 'busy-bee' }, { slug: 'busy-bee-aaaa' }]);
  });

  it.each([
    ['a blank name', { name: '   ' }],
    ['a long name', { name: 'n'.repeat(121) }],
    ['a long agent name', { agentName: 'a'.repeat(81) }],
    ['a malformed user id', { ownerUserId: 'not-a-uuid' }],
  ])('rejects %s', async (_label, override) => {
    const owner = await newUser();
    const name = unique('Rejected');
    await expect(createOrganization(t.db, { name, ownerUserId: owner.id, ...override })).rejects.toMatchObject({
      name: 'DomainError',
      code: 'invalid',
    });
    expect(await t.db.query('select id from public.organizations where name = $1', [name])).toEqual([]);
  });

  it('rolls back every step when one fails', async () => {
    const name = unique('Ghost');
    // The owner does not exist in auth.users: the membership insert fails after the organization insert.
    await expect(createOrganization(t.db, { name, ownerUserId: randomUUID() })).rejects.toThrow();
    expect(await t.db.query('select id from public.organizations where name = $1', [name])).toEqual([]);
  });
});

describe('memberships', () => {
  it("lists only the user's organizations, ordered by name, under RLS and service scope", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const zulu = await createOrganization(t.db, { name: unique('zulu'), ownerUserId: alice.id });
    const alpha = await createOrganization(t.db, { name: unique('Alpha'), ownerUserId: bob.id });
    await t.service.run((sql) => addMember(sql, alpha.organization.id, alice.id, 'member'));
    await createOrganization(t.db, { name: unique('Bravo'), ownerUserId: bob.id });

    for (const db of [t.asUser(alice.id), t.service]) {
      expect(await listMemberships(db, alice.id)).toEqual([
        { organization: alpha.organization, role: 'member' },
        { organization: zulu.organization, role: 'owner' },
      ]);
    }
  });

  it('resolves a slug only for a member of that organization', async () => {
    const alice = await newUser();
    const bob = await newUser();
    const orgA = await createOrganization(t.db, { name: unique('Alice Co'), ownerUserId: alice.id });
    const orgB = await createOrganization(t.db, { name: unique('Bob Co'), ownerUserId: bob.id });

    expect(await getMembershipBySlug(t.asUser(alice.id), alice.id, orgA.organization.slug)).toEqual({
      organization: orgA.organization,
      role: 'owner',
    });
    expect(await getMembershipBySlug(t.asUser(alice.id), alice.id, orgB.organization.slug)).toBeNull();
    expect(await getMembershipBySlug(t.service, alice.id, orgB.organization.slug)).toBeNull();
    // Asking about Bob from Alice's session reveals nothing either: RLS hides org B entirely.
    expect(await getMembershipBySlug(t.asUser(alice.id), bob.id, orgB.organization.slug)).toBeNull();
    expect(await getMembershipBySlug(t.asUser(bob.id), bob.id, orgB.organization.slug)).toMatchObject({ role: 'owner' });
  });

  it('returns nothing for malformed input', async () => {
    expect(await listMemberships(t.service, 'not-a-uuid')).toEqual([]);
    expect(await getMembershipBySlug(t.service, randomUUID(), 'Not A Slug')).toBeNull();
    expect(await getMembershipBySlug(t.service, 'not-a-uuid', 'acme')).toBeNull();
  });
});

describe('recordAudit', () => {
  it('writes through service scope only; owners read their own audit log, members and other tenants do not', async () => {
    const owner = await newUser();
    const member = await newUser();
    const outsider = await newUser();
    const { organization } = await createOrganization(t.db, { name: unique('Audited'), ownerUserId: owner.id });
    await t.service.run((sql) => addMember(sql, organization.id, member.id, 'member'));
    const other = await createOrganization(t.db, { name: unique('Elsewhere'), ownerUserId: outsider.id });

    await t.service.run((sql) =>
      recordAudit(sql, { organizationId: organization.id, actorType: 'system', action: 'test.recorded', metadata: { n: 1 } }),
    );
    const recorded = await t.db.query(
      `select actor_type, actor_id, target_type, target_id, metadata from public.audit_logs
       where organization_id = $1 and action = 'test.recorded'`,
      [organization.id],
    );
    expect(recorded).toEqual([{ actor_type: 'system', actor_id: null, target_type: null, target_id: null, metadata: { n: 1 } }]);

    // There is no user write grant: not even an owner can forge an audit entry.
    await expect(
      t.asUser(owner.id).run((sql) =>
        recordAudit(sql, { organizationId: organization.id, actorType: 'user', actorId: owner.id, action: 'forged' }),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    const ownerView = await t
      .asUser(owner.id)
      .run((sql) => sql.query<{ action: string }>('select action from public.audit_logs order by action'));
    expect(ownerView.map((row) => row.action)).toEqual(['organization.created', 'test.recorded']);
    expect(await t.asUser(member.id).run((sql) => sql.query('select id from public.audit_logs'))).toEqual([]);
    const outsiderView = await t
      .asUser(outsider.id)
      .run((sql) => sql.query<{ organization_id: string }>('select organization_id from public.audit_logs'));
    expect(outsiderView).toEqual([{ organization_id: other.organization.id }]);
  });
});
