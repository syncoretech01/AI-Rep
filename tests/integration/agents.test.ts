import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ensureWebChatChannel,
  findPublishedWidget,
  getAgent,
  getWebChatChannel,
  insertAgent,
  listAgents,
  rotateWidgetKey,
  setWebChatEnabled,
  updateAgentSettings,
} from '@/server/domain/agents/repository';
import type { AgentSettings } from '@/server/domain/agents/schemas';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { addMember, createAgent, createAuthUser, createOrganization } from '../support/fixtures';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.close();
});

const SETTINGS: AgentSettings = {
  name: 'Evening Desk',
  status: 'active',
  greeting: 'Good evening! How can we help?',
  language: 'en-GB',
  timezone: 'Europe/London',
  instructions: 'Keep answers short.',
  leadCapture: { enabled: false, requiredFields: ['email'] },
};

/** A fresh organization with an owner, an admin, a member and one agent (no web chat channel yet). */
async function createTenantWithRoles() {
  const tenant = await t.service.run(async (sql) => {
    const org = await createOrganization(sql);
    const owner = await createAuthUser(sql);
    const admin = await createAuthUser(sql);
    const member = await createAuthUser(sql);
    await addMember(sql, org.id, owner.id, 'owner');
    await addMember(sql, org.id, admin.id, 'admin');
    await addMember(sql, org.id, member.id, 'member');
    return { org, owner, admin, member };
  });
  const agent = await t.service.run((sql) => insertAgent(sql, tenant.org.id, { name: 'Front Desk' }));
  return { ...tenant, agent };
}

describe('agents (service scope)', () => {
  it('creates agents with the column defaults or explicit settings', async () => {
    const { org } = await createTenantWithRoles();
    const plain = await t.service.run((sql) => insertAgent(sql, org.id, { name: '  Night Owl  ' }));
    expect(plain).toMatchObject({
      organizationId: org.id,
      name: 'Night Owl',
      status: 'active',
      greeting: 'Hi! How can I help you today?',
      language: 'en',
      timezone: 'UTC',
      instructions: '',
      leadCapture: { enabled: true, requiredFields: ['name', 'phone'] },
    });

    // The defaults match what the database fills in for a bare insert.
    const raw = await t.service.run(async (sql) => getAgent(sql, org.id, (await createAgent(sql, org.id)).id));
    expect(raw).toMatchObject({
      status: plain.status,
      greeting: plain.greeting,
      language: plain.language,
      timezone: plain.timezone,
      instructions: plain.instructions,
      leadCapture: plain.leadCapture,
    });

    const custom = await t.service.run((sql) => insertAgent(sql, org.id, SETTINGS));
    expect(custom).toMatchObject({ organizationId: org.id, ...SETTINGS });
  });

  it('rejects invalid settings', async () => {
    const { org, agent } = await createTenantWithRoles();
    await expect(t.service.run((sql) => insertAgent(sql, org.id, { name: '   ' }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      t.service.run((sql) => insertAgent(sql, org.id, { name: 'Desk', timezone: 'Mars/Phobos' })),
    ).rejects.toMatchObject({ code: 'invalid', message: 'Choose a valid time zone, e.g. America/New_York.' });
    await expect(
      t.service.run((sql) => updateAgentSettings(sql, org.id, agent.id, { ...SETTINGS, language: 'english' })),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(await t.service.run((sql) => getAgent(sql, org.id, agent.id))).toEqual(agent);
  });

  it('gets, lists (oldest first) and updates agents', async () => {
    const { org, agent } = await createTenantWithRoles();
    const second = await t.service.run((sql) => insertAgent(sql, org.id, { name: 'Second Desk' }));

    expect(await t.service.run((sql) => getAgent(sql, org.id, agent.id))).toEqual(agent);
    expect((await t.service.run((sql) => listAgents(sql, org.id))).map((item) => item.id)).toEqual([agent.id, second.id]);

    const updated = await t.service.run((sql) => updateAgentSettings(sql, org.id, agent.id, SETTINGS));
    expect(updated).toMatchObject({ id: agent.id, organizationId: org.id, ...SETTINGS });
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(agent.updatedAt.getTime());
    expect(await t.service.run((sql) => getAgent(sql, org.id, agent.id))).toEqual(updated);
  });

  it("never reads or changes another organization's agent", async () => {
    const a = await createTenantWithRoles();
    const b = await createTenantWithRoles();

    await t.service.run(async (sql) => {
      expect(await getAgent(sql, a.org.id, b.agent.id)).toBeNull();
      expect(await getWebChatChannel(sql, a.org.id, b.agent.id)).toBeNull();
      expect((await listAgents(sql, a.org.id)).map((agent) => agent.id)).toEqual([a.agent.id]);
    });
    const writes = [
      () => t.service.run((sql) => updateAgentSettings(sql, a.org.id, b.agent.id, SETTINGS)),
      () => t.service.run((sql) => ensureWebChatChannel(sql, a.org.id, b.agent.id)),
      () => t.service.run((sql) => setWebChatEnabled(sql, a.org.id, b.agent.id, true)),
      () => t.service.run((sql) => rotateWidgetKey(sql, a.org.id, b.agent.id)),
    ];
    for (const write of writes) await expect(write()).rejects.toMatchObject({ name: 'DomainError', code: 'not_found' });

    expect(await t.service.run((sql) => getAgent(sql, b.org.id, b.agent.id))).toEqual(b.agent);
    expect(await t.service.run((sql) => getWebChatChannel(sql, b.org.id, b.agent.id))).toBeNull();
  });

  it('treats malformed ids as not found instead of failing in Postgres', async () => {
    const { org, agent } = await createTenantWithRoles();
    await t.service.run(async (sql) => {
      expect(await getAgent(sql, org.id, 'not-a-uuid')).toBeNull();
      expect(await getAgent(sql, 'not-a-uuid', agent.id)).toBeNull();
      expect(await listAgents(sql, 'not-a-uuid')).toEqual([]);
      expect(await getWebChatChannel(sql, org.id, "'; drop table agents; --")).toBeNull();
    });
    await expect(t.service.run((sql) => updateAgentSettings(sql, org.id, '42', SETTINGS))).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(t.service.run((sql) => ensureWebChatChannel(sql, org.id, 'x'))).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.service.run((sql) => insertAgent(sql, 'x', { name: 'Desk' }))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reads a damaged lead_capture value leniently', async () => {
    const { org, agent } = await createTenantWithRoles();
    await t.db.query(`update public.agents set lead_capture = '{"enabled": false, "requiredFields": "phone"}' where id = $1`, [
      agent.id,
    ]);
    expect((await t.service.run((sql) => getAgent(sql, org.id, agent.id)))?.leadCapture).toEqual({
      enabled: false,
      requiredFields: ['name', 'phone'],
    });
  });
});

describe('web chat channel', () => {
  it('creates one unpublished channel with a widget key, idempotently', async () => {
    const { org, agent } = await createTenantWithRoles();
    const created = await t.service.run((sql) => ensureWebChatChannel(sql, org.id, agent.id));
    expect(created).toMatchObject({ organizationId: org.id, agentId: agent.id, channel: 'web_chat', enabled: false });
    expect(created.publicKey).toMatch(/^wk_[A-Za-z0-9]{32}$/);

    expect(await t.service.run((sql) => ensureWebChatChannel(sql, org.id, agent.id))).toEqual(created);
    expect(await t.service.run((sql) => getWebChatChannel(sql, org.id, agent.id))).toEqual(created);
    const count = await t.db.query('select count(*)::int as n from public.agent_channels where agent_id = $1', [agent.id]);
    expect(count).toEqual([{ n: 1 }]);
  });

  it('publishes the widget only while the channel is enabled and the agent is active', async () => {
    const { org, agent } = await createTenantWithRoles();
    const channel = await t.service.run((sql) => ensureWebChatChannel(sql, org.id, agent.id));
    const key = channel.publicKey!;
    const lookup = () => t.service.run((sql) => findPublishedWidget(sql, key));

    expect(await lookup()).toBeNull();

    const enabled = await t.service.run((sql) => setWebChatEnabled(sql, org.id, agent.id, true));
    expect(enabled).toMatchObject({ id: channel.id, enabled: true, publicKey: key });
    const published = await lookup();
    expect(published?.agent).toEqual(await t.service.run((sql) => getAgent(sql, org.id, agent.id)));
    expect(published?.channel).toEqual(enabled);

    await t.service.run((sql) => updateAgentSettings(sql, org.id, agent.id, { ...SETTINGS, status: 'paused' }));
    expect(await lookup()).toBeNull();

    await t.service.run((sql) => updateAgentSettings(sql, org.id, agent.id, SETTINGS));
    expect((await lookup())?.agent).toMatchObject({ id: agent.id, organizationId: org.id, name: SETTINGS.name });

    await t.service.run((sql) => setWebChatEnabled(sql, org.id, agent.id, false));
    expect(await lookup()).toBeNull();
  });

  it('only toggles an existing channel: publishing an agent without one creates nothing', async () => {
    const { org, agent } = await createTenantWithRoles();
    // Creating the channel writes a widget key, which takes ensureWebChatChannel (service scope).
    await expect(t.service.run((sql) => setWebChatEnabled(sql, org.id, agent.id, true))).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(t.service.run((sql) => setWebChatEnabled(sql, org.id, 'not-a-uuid', true))).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await t.service.run((sql) => getWebChatChannel(sql, org.id, agent.id))).toBeNull();

    await t.service.run((sql) => ensureWebChatChannel(sql, org.id, agent.id));
    const enabled = await t.service.run((sql) => setWebChatEnabled(sql, org.id, agent.id, true));
    expect(enabled).toMatchObject({ agentId: agent.id, enabled: true });
    expect((await t.service.run((sql) => findPublishedWidget(sql, enabled.publicKey!)))?.agent.id).toBe(agent.id);
  });

  it('rotating creates the channel when there is none', async () => {
    const { org, agent } = await createTenantWithRoles();
    const rotated = await t.service.run((sql) => rotateWidgetKey(sql, org.id, agent.id));
    expect(rotated).toMatchObject({ agentId: agent.id, enabled: false });
    expect(rotated.publicKey).toMatch(/^wk_[A-Za-z0-9]{32}$/);
    expect(await t.service.run((sql) => getWebChatChannel(sql, org.id, agent.id))).toEqual(rotated);
  });

  it.each([`wk_${'Z'.repeat(32)}`, 'not-a-key', '', `wk_${'a'.repeat(65)}`, "wk_' or 1=1 --"])(
    'finds no widget for the key %j',
    async (key) => {
      expect(await t.service.run((sql) => findPublishedWidget(sql, key))).toBeNull();
    },
  );

  it('rotating the widget key retires the old key immediately', async () => {
    const { org, agent } = await createTenantWithRoles();
    const before = await t.service.run(async (sql) => {
      await ensureWebChatChannel(sql, org.id, agent.id);
      return setWebChatEnabled(sql, org.id, agent.id, true);
    });
    const rotated = await t.service.run((sql) => rotateWidgetKey(sql, org.id, agent.id));

    expect(rotated).toMatchObject({ id: before.id, enabled: true });
    expect(rotated.publicKey).toMatch(/^wk_[A-Za-z0-9]{32}$/);
    expect(rotated.publicKey).not.toBe(before.publicKey);
    expect(await t.service.run((sql) => findPublishedWidget(sql, before.publicKey!))).toBeNull();
    expect((await t.service.run((sql) => findPublishedWidget(sql, rotated.publicKey!)))?.agent.id).toBe(agent.id);
  });
});

describe('row level security (user scope)', () => {
  it('lets members read agents and the web chat channel but not change them', async () => {
    const { org, member, agent } = await createTenantWithRoles();
    const channel = await t.service.run((sql) => ensureWebChatChannel(sql, org.id, agent.id));
    const asMember = t.asUser(member.id);

    expect(await asMember.run((sql) => getAgent(sql, org.id, agent.id))).toEqual(agent);
    expect((await asMember.run((sql) => listAgents(sql, org.id))).map((item) => item.id)).toEqual([agent.id]);
    expect(await asMember.run((sql) => getWebChatChannel(sql, org.id, agent.id))).toEqual(channel);
    expect(await asMember.run((sql) => ensureWebChatChannel(sql, org.id, agent.id))).toEqual(channel);

    await expect(asMember.run((sql) => updateAgentSettings(sql, org.id, agent.id, SETTINGS))).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(asMember.run((sql) => setWebChatEnabled(sql, org.id, agent.id, true))).rejects.toMatchObject({
      code: 'not_found',
    });
    // Widget keys are never written under user scope, whatever the role.
    await expect(asMember.run((sql) => rotateWidgetKey(sql, org.id, agent.id))).rejects.toMatchObject({ code: '42501' });
    await expect(asMember.run((sql) => insertAgent(sql, org.id, { name: 'Sneaky' }))).rejects.toMatchObject({ code: '42501' });

    expect(await t.service.run((sql) => getAgent(sql, org.id, agent.id))).toEqual(agent);
    expect(await t.service.run((sql) => getWebChatChannel(sql, org.id, agent.id))).toEqual(channel);
    expect(await t.service.run((sql) => listAgents(sql, org.id))).toHaveLength(1);
  });

  it('rejects a member creating the web chat channel and leaves nothing behind', async () => {
    const { org, member, agent } = await createTenantWithRoles();
    const asMember = t.asUser(member.id);
    // Creating the channel (directly or by rotating its key) is refused outright; toggling finds no channel.
    await expect(asMember.run((sql) => ensureWebChatChannel(sql, org.id, agent.id))).rejects.toMatchObject({ code: '42501' });
    await expect(asMember.run((sql) => rotateWidgetKey(sql, org.id, agent.id))).rejects.toMatchObject({ code: '42501' });
    await expect(asMember.run((sql) => setWebChatEnabled(sql, org.id, agent.id, true))).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await t.service.run((sql) => getWebChatChannel(sql, org.id, agent.id))).toBeNull();
  });

  it('lets owners and admins configure agents and publish or unpublish the widget', async () => {
    const { org, owner, admin, agent } = await createTenantWithRoles();
    for (const user of [owner, admin]) {
      const name = `Desk ${user.id.slice(0, 6)}`;
      const updated = await t.asUser(user.id).run((sql) => updateAgentSettings(sql, org.id, agent.id, { ...SETTINGS, name }));
      expect(updated.name).toBe(name);
    }

    // The server creates the channel and its key (service scope); owners and admins toggle it under RLS.
    const channel = await t.service.run((sql) => ensureWebChatChannel(sql, org.id, agent.id));
    const enabled = await t.asUser(owner.id).run((sql) => setWebChatEnabled(sql, org.id, agent.id, true));
    expect(enabled).toMatchObject({ id: channel.id, agentId: agent.id, enabled: true, publicKey: channel.publicKey });
    const disabled = await t.asUser(admin.id).run((sql) => setWebChatEnabled(sql, org.id, agent.id, false));
    expect(disabled).toMatchObject({ id: channel.id, enabled: false, publicKey: channel.publicKey });

    const created = await t.asUser(admin.id).run((sql) => insertAgent(sql, org.id, { name: 'Weekend Desk' }));
    expect(created.organizationId).toBe(org.id);
    expect(await t.asUser(owner.id).run((sql) => listAgents(sql, org.id))).toHaveLength(2);
  });

  it('never lets owners or admins create a web chat channel or choose its widget key', async () => {
    const { org, owner, admin, agent } = await createTenantWithRoles();
    const spare = await t.service.run((sql) => insertAgent(sql, org.id, { name: 'Spare Desk' }));
    const channel = await t.service.run((sql) => ensureWebChatChannel(sql, org.id, agent.id));
    const chosen = `wk_${'C'.repeat(32)}`;

    for (const user of [owner, admin]) {
      const asAdmin = t.asUser(user.id);
      await expect(asAdmin.run((sql) => rotateWidgetKey(sql, org.id, agent.id))).rejects.toMatchObject({ code: '42501' });
      await expect(asAdmin.run((sql) => ensureWebChatChannel(sql, org.id, spare.id))).rejects.toMatchObject({ code: '42501' });
      // Not with raw SQL either (the Data API runs as the same role): no UPDATE of the key, no INSERT at all.
      await expect(
        asAdmin.run((sql) =>
          sql.query('update public.agent_channels set public_key = $2 where organization_id = $1 returning id', [org.id, chosen]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        asAdmin.run((sql) =>
          sql.query(
            `insert into public.agent_channels (organization_id, agent_id, channel, enabled, public_key)
             values ($1, $2, 'web_chat', false, $3)`,
            [org.id, spare.id, chosen],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }

    expect(await t.service.run((sql) => getWebChatChannel(sql, org.id, agent.id))).toEqual(channel);
    expect(await t.service.run((sql) => getWebChatChannel(sql, org.id, spare.id))).toBeNull();
    expect(await t.db.query('select id from public.agent_channels where public_key = $1', [chosen])).toEqual([]);
  });

  it("cannot take over another organization's retired widget key", async () => {
    const a = await createTenantWithRoles();
    const b = await createTenantWithRoles();
    // B publishes its widget, then rotates the key: B's old embeds stay on pages and in caches for a while.
    const published = await t.service.run(async (sql) => {
      await ensureWebChatChannel(sql, b.org.id, b.agent.id);
      return setWebChatEnabled(sql, b.org.id, b.agent.id, true);
    });
    await t.service.run((sql) => rotateWidgetKey(sql, b.org.id, b.agent.id));
    const retiredKey = published.publicKey!;
    expect(await t.service.run((sql) => findPublishedWidget(sql, retiredKey))).toBeNull();

    // A's owner tries to bind that key to A's agents, so that B's stale embeds would serve A's agent.
    const channelA = await t.service.run((sql) => ensureWebChatChannel(sql, a.org.id, a.agent.id));
    const spareA = await t.service.run((sql) => insertAgent(sql, a.org.id, { name: 'Spare Desk' }));
    const asOwnerA = t.asUser(a.owner.id);
    await expect(
      asOwnerA.run((sql) =>
        sql.query('update public.agent_channels set public_key = $2, enabled = true where organization_id = $1', [
          a.org.id,
          retiredKey,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asOwnerA.run((sql) =>
        sql.query(
          `insert into public.agent_channels (organization_id, agent_id, channel, enabled, public_key)
           values ($1, $2, 'web_chat', true, $3)`,
          [a.org.id, spareA.id, retiredKey],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    expect(await t.service.run((sql) => findPublishedWidget(sql, retiredKey))).toBeNull();
    expect(await t.service.run((sql) => getWebChatChannel(sql, a.org.id, a.agent.id))).toEqual(channelA);
    expect(await t.service.run((sql) => getWebChatChannel(sql, a.org.id, spareA.id))).toBeNull();
  });

  it("shows another organization's agents to nobody outside it and rejects writes", async () => {
    const a = await createTenantWithRoles();
    const b = await createTenantWithRoles();
    const channelA = await t.service.run((sql) => ensureWebChatChannel(sql, a.org.id, a.agent.id));
    const spareA = await t.service.run((sql) => insertAgent(sql, a.org.id, { name: 'Spare Desk' }));
    const asOwnerB = t.asUser(b.owner.id);

    expect(await asOwnerB.run((sql) => getAgent(sql, a.org.id, a.agent.id))).toBeNull();
    expect(await asOwnerB.run((sql) => listAgents(sql, a.org.id))).toEqual([]);
    expect(await asOwnerB.run((sql) => getWebChatChannel(sql, a.org.id, a.agent.id))).toBeNull();
    await expect(asOwnerB.run((sql) => updateAgentSettings(sql, a.org.id, a.agent.id, SETTINGS))).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(asOwnerB.run((sql) => setWebChatEnabled(sql, a.org.id, a.agent.id, true))).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(asOwnerB.run((sql) => rotateWidgetKey(sql, a.org.id, a.agent.id))).rejects.toMatchObject({
      code: '42501',
    });
    // WITH CHECK rejects an agent that names another organization; channels cannot be inserted at all.
    await expect(asOwnerB.run((sql) => insertAgent(sql, a.org.id, { name: 'Intruder' }))).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      asOwnerB.run((sql) =>
        sql.query(
          `insert into public.agent_channels (organization_id, agent_id, channel, enabled, public_key)
           values ($1, $2, 'web_chat', true, $3)`,
          [a.org.id, spareA.id, `wk_${'P'.repeat(32)}`],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    expect(await t.service.run((sql) => getAgent(sql, a.org.id, a.agent.id))).toEqual(a.agent);
    expect(await t.service.run((sql) => getWebChatChannel(sql, a.org.id, a.agent.id))).toEqual(channelA);
    expect(await t.service.run((sql) => getWebChatChannel(sql, a.org.id, spareA.id))).toBeNull();
    expect((await t.service.run((sql) => listAgents(sql, a.org.id))).map((agent) => agent.id)).toEqual([a.agent.id, spareA.id]);
  });
});
