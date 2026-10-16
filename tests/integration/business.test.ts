import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getBusinessProfile,
  listBusinessHours,
  replaceBusinessHours,
  upsertBusinessProfile,
} from '@/server/domain/business/repository';
import { businessProfileSchema, type BusinessProfileInput } from '@/server/domain/business/schemas';
import type { HoursInterval } from '@/server/domain/business/types';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { addMember, createAgent, createAuthUser, createOrganization } from '../support/fixtures';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.close();
});

const PROFILE: BusinessProfileInput = businessProfileSchema.parse({
  businessName: 'Acme Plumbing',
  description: 'Family-run plumbers since 1999.',
  phone: '+1 (555) 010-0100',
  email: 'hello@acme.example',
  website: 'https://acme.example',
  address: '1 Main St, Springfield',
  serviceArea: 'Springfield and Shelbyville',
});

const interval = (dayOfWeek: number, opensAt: string, closesAt: string): HoursInterval => ({ dayOfWeek, opensAt, closesAt });
const WEEKDAYS = [1, 2, 3, 4, 5].map((day) => interval(day, '09:00', '17:00'));

/** A fresh organization with an owner, an admin, a member and one agent. */
async function createTenantWithRoles() {
  return t.service.run(async (sql) => {
    const org = await createOrganization(sql);
    const owner = await createAuthUser(sql);
    const admin = await createAuthUser(sql);
    const member = await createAuthUser(sql);
    await addMember(sql, org.id, owner.id, 'owner');
    await addMember(sql, org.id, admin.id, 'admin');
    await addMember(sql, org.id, member.id, 'member');
    const agent = await createAgent(sql, org.id);
    return { org, owner, admin, member, agent };
  });
}

/** Tenant with a profile and weekday hours already configured. */
async function createConfiguredTenant() {
  const tenant = await createTenantWithRoles();
  const configured = await t.service.run(async (sql) => ({
    profile: await upsertBusinessProfile(sql, tenant.org.id, tenant.agent.id, PROFILE),
    hours: await replaceBusinessHours(sql, tenant.org.id, tenant.agent.id, WEEKDAYS),
  }));
  return { ...tenant, ...configured };
}

describe('business profile', () => {
  it('creates, reads and fully replaces the profile', async () => {
    const { org, agent } = await createTenantWithRoles();
    expect(await t.service.run((sql) => getBusinessProfile(sql, org.id, agent.id))).toBeNull();

    const created = await t.service.run((sql) => upsertBusinessProfile(sql, org.id, agent.id, PROFILE));
    expect(created).toMatchObject({ organizationId: org.id, agentId: agent.id, ...PROFILE });
    expect(created.updatedAt).toBeInstanceOf(Date);

    const replacement = businessProfileSchema.parse({ businessName: '  Acme Plumbing & Heating ', email: '' });
    const replaced = await t.service.run((sql) => upsertBusinessProfile(sql, org.id, agent.id, replacement));
    expect(replaced).toMatchObject({
      businessName: 'Acme Plumbing & Heating',
      description: null,
      phone: null,
      email: null,
      website: null,
      address: null,
      serviceArea: null,
    });
    expect(await t.service.run((sql) => getBusinessProfile(sql, org.id, agent.id))).toEqual(replaced);
    const rows = await t.db.query('select count(*)::int as n from public.business_profiles where agent_id = $1', [agent.id]);
    expect(rows).toEqual([{ n: 1 }]);
  });

  it('rejects values the schema does not allow', async () => {
    const { org, agent, profile } = await createConfiguredTenant();
    await expect(
      t.service.run((sql) => upsertBusinessProfile(sql, org.id, agent.id, { ...PROFILE, email: 'not-an-email' })),
    ).rejects.toMatchObject({ code: 'invalid', message: 'Enter a valid email address.' });
    await expect(
      t.service.run((sql) => upsertBusinessProfile(sql, org.id, agent.id, { ...PROFILE, website: 'javascript:alert(1)' })),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(await t.service.run((sql) => getBusinessProfile(sql, org.id, agent.id))).toEqual(profile);
  });
});

describe('business hours', () => {
  it('replaces the whole week and lists it sorted, with HH:MM times', async () => {
    const { org, agent } = await createTenantWithRoles();
    expect(await t.service.run((sql) => listBusinessHours(sql, org.id, agent.id))).toEqual([]);

    const week = [
      interval(5, '13:00', '17:00'),
      interval(1, '13:00', '17:00'),
      interval(6, '22:00', '24:00'),
      interval(1, '09:00', '12:00'),
      interval(0, '00:00', '06:00'),
    ];
    const expected = [
      interval(0, '00:00', '06:00'),
      interval(1, '09:00', '12:00'),
      interval(1, '13:00', '17:00'),
      interval(5, '13:00', '17:00'),
      interval(6, '22:00', '24:00'),
    ];
    expect(await t.service.run((sql) => replaceBusinessHours(sql, org.id, agent.id, week))).toEqual(expected);
    expect(await t.service.run((sql) => listBusinessHours(sql, org.id, agent.id))).toEqual(expected);

    expect(await t.service.run((sql) => replaceBusinessHours(sql, org.id, agent.id, WEEKDAYS))).toEqual(WEEKDAYS);
    expect(await t.service.run((sql) => replaceBusinessHours(sql, org.id, agent.id, []))).toEqual([]);
    expect(await t.service.run((sql) => listBusinessHours(sql, org.id, agent.id))).toEqual([]);
  });

  it('rejects overlapping hours and keeps the current week', async () => {
    const { org, agent } = await createConfiguredTenant();
    await expect(
      t.service.run((sql) =>
        replaceBusinessHours(sql, org.id, agent.id, [interval(2, '09:00', '13:00'), interval(2, '12:00', '17:00')]),
      ),
    ).rejects.toMatchObject({ code: 'invalid', message: 'Tuesday has overlapping opening hours.' });
    expect(await t.service.run((sql) => listBusinessHours(sql, org.id, agent.id))).toEqual(WEEKDAYS);
  });
});

describe('tenant scoping (service scope)', () => {
  it("never reads or changes another organization's profile or hours", async () => {
    const a = await createConfiguredTenant();
    const b = await createConfiguredTenant();

    await t.service.run(async (sql) => {
      expect(await getBusinessProfile(sql, a.org.id, b.agent.id)).toBeNull();
      expect(await listBusinessHours(sql, a.org.id, b.agent.id)).toEqual([]);
    });
    await expect(
      t.service.run((sql) => upsertBusinessProfile(sql, a.org.id, b.agent.id, { ...PROFILE, businessName: 'Hijacked' })),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.service.run((sql) => replaceBusinessHours(sql, a.org.id, b.agent.id, []))).rejects.toMatchObject({
      code: 'not_found',
    });

    expect(await t.service.run((sql) => getBusinessProfile(sql, b.org.id, b.agent.id))).toEqual(b.profile);
    expect(await t.service.run((sql) => listBusinessHours(sql, b.org.id, b.agent.id))).toEqual(WEEKDAYS);
  });

  it('treats malformed ids as not found', async () => {
    const { org, agent } = await createConfiguredTenant();
    await t.service.run(async (sql) => {
      expect(await getBusinessProfile(sql, org.id, 'not-a-uuid')).toBeNull();
      expect(await listBusinessHours(sql, 'not-a-uuid', agent.id)).toEqual([]);
    });
    await expect(t.service.run((sql) => upsertBusinessProfile(sql, 'x', agent.id, PROFILE))).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(t.service.run((sql) => replaceBusinessHours(sql, org.id, 'x', WEEKDAYS))).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('row level security (user scope)', () => {
  it('lets members read the profile and hours but not change them', async () => {
    const { org, member, agent, profile, hours } = await createConfiguredTenant();
    const asMember = t.asUser(member.id);

    expect(await asMember.run((sql) => getBusinessProfile(sql, org.id, agent.id))).toEqual(profile);
    expect(await asMember.run((sql) => listBusinessHours(sql, org.id, agent.id))).toEqual(hours);

    await expect(
      asMember.run((sql) => upsertBusinessProfile(sql, org.id, agent.id, { ...PROFILE, businessName: 'Renamed' })),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(asMember.run((sql) => replaceBusinessHours(sql, org.id, agent.id, []))).rejects.toMatchObject({
      code: 'not_found',
    });
    const deleted = await asMember.run((sql) =>
      sql.query('delete from public.business_hours where organization_id = $1 returning id', [org.id]),
    );
    expect(deleted).toEqual([]);

    expect(await t.service.run((sql) => getBusinessProfile(sql, org.id, agent.id))).toEqual(profile);
    expect(await t.service.run((sql) => listBusinessHours(sql, org.id, agent.id))).toEqual(hours);
  });

  it('lets owners and admins change the profile and hours', async () => {
    const { org, owner, admin, agent } = await createConfiguredTenant();

    const byOwner = await t
      .asUser(owner.id)
      .run((sql) => upsertBusinessProfile(sql, org.id, agent.id, { ...PROFILE, phone: '+1 555 0199' }));
    expect(byOwner.phone).toBe('+1 555 0199');
    const saturday = [...WEEKDAYS, interval(6, '10:00', '14:00')];
    expect(await t.asUser(owner.id).run((sql) => replaceBusinessHours(sql, org.id, agent.id, saturday))).toEqual(saturday);

    const byAdmin = await t
      .asUser(admin.id)
      .run((sql) => upsertBusinessProfile(sql, org.id, agent.id, { ...PROFILE, serviceArea: 'Statewide' }));
    expect(byAdmin).toMatchObject({ phone: PROFILE.phone, serviceArea: 'Statewide' });
    expect(await t.asUser(admin.id).run((sql) => replaceBusinessHours(sql, org.id, agent.id, WEEKDAYS))).toEqual(WEEKDAYS);
  });

  it('hides everything from other organizations and rejects their writes', async () => {
    const a = await createConfiguredTenant();
    const b = await createConfiguredTenant();
    const unconfigured = await t.service.run((sql) => createAgent(sql, a.org.id, { name: 'Second Desk' }));
    const asOwnerB = t.asUser(b.owner.id);

    expect(await asOwnerB.run((sql) => getBusinessProfile(sql, a.org.id, a.agent.id))).toBeNull();
    expect(await asOwnerB.run((sql) => listBusinessHours(sql, a.org.id, a.agent.id))).toEqual([]);
    await expect(asOwnerB.run((sql) => upsertBusinessProfile(sql, a.org.id, a.agent.id, PROFILE))).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(asOwnerB.run((sql) => replaceBusinessHours(sql, a.org.id, a.agent.id, []))).rejects.toMatchObject({
      code: 'not_found',
    });
    const updated = await asOwnerB.run((sql) =>
      sql.query("update public.business_profiles set business_name = 'Hijacked' where organization_id = $1 returning id", [
        a.org.id,
      ]),
    );
    expect(updated).toEqual([]);

    // WITH CHECK rejects rows that name another organization.
    await expect(
      asOwnerB.run((sql) =>
        sql.query('insert into public.business_profiles (organization_id, agent_id, business_name) values ($1, $2, $3)', [
          a.org.id,
          unconfigured.id,
          'Planted',
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asOwnerB.run((sql) =>
        sql.query(
          `insert into public.business_hours (organization_id, agent_id, day_of_week, opens_at, closes_at)
           values ($1, $2, 1, '09:00', '10:00')`,
          [a.org.id, unconfigured.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    expect(await t.service.run((sql) => getBusinessProfile(sql, a.org.id, a.agent.id))).toEqual(a.profile);
    expect(await t.service.run((sql) => listBusinessHours(sql, a.org.id, a.agent.id))).toEqual(WEEKDAYS);
    expect(await t.service.run((sql) => getBusinessProfile(sql, a.org.id, unconfigured.id))).toBeNull();
  });
});
