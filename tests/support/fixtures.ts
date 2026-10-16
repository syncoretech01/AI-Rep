import { randomUUID } from 'node:crypto';
import type { Sql } from '@/server/db/types';

/**
 * Raw-SQL fixtures for integration tests. They intentionally bypass domain
 * services so each module's tests only depend on the schema.
 */

export interface UserFixture {
  id: string;
  email: string;
}

export async function createAuthUser(sql: Sql, email = `user-${randomUUID().slice(0, 8)}@example.test`): Promise<UserFixture> {
  const id = randomUUID();
  await sql.query('insert into auth.users (id, email) values ($1, $2)', [id, email]);
  return { id, email };
}

export interface OrgFixture {
  id: string;
  slug: string;
  name: string;
}

export async function createOrganization(sql: Sql, name = `Org ${randomUUID().slice(0, 6)}`): Promise<OrgFixture> {
  const slug = `org-${randomUUID().slice(0, 8)}`;
  const rows = await sql.query<{ id: string }>(
    'insert into public.organizations (name, slug) values ($1, $2) returning id',
    [name, slug],
  );
  return { id: rows[0]!.id, slug, name };
}

export async function addMember(
  sql: Sql,
  organizationId: string,
  userId: string,
  role: 'owner' | 'admin' | 'member' = 'owner',
): Promise<void> {
  await sql.query('insert into public.organization_members (organization_id, user_id, role) values ($1, $2, $3)', [
    organizationId,
    userId,
    role,
  ]);
}

export interface AgentFixture {
  id: string;
  organizationId: string;
  name: string;
}

export async function createAgent(
  sql: Sql,
  organizationId: string,
  overrides: { name?: string; timezone?: string; status?: 'active' | 'paused'; instructions?: string } = {},
): Promise<AgentFixture> {
  const name = overrides.name ?? 'Front Desk';
  const rows = await sql.query<{ id: string }>(
    `insert into public.agents (organization_id, name, timezone, status, instructions)
     values ($1, $2, $3, $4, $5) returning id`,
    [organizationId, name, overrides.timezone ?? 'UTC', overrides.status ?? 'active', overrides.instructions ?? ''],
  );
  return { id: rows[0]!.id, organizationId, name };
}

export async function createWebChatChannel(
  sql: Sql,
  organizationId: string,
  agentId: string,
  options: { enabled?: boolean; publicKey?: string } = {},
): Promise<{ id: string; publicKey: string }> {
  const publicKey = options.publicKey ?? `wk_${randomUUID().replace(/-/g, '')}`;
  const rows = await sql.query<{ id: string }>(
    `insert into public.agent_channels (organization_id, agent_id, channel, enabled, public_key)
     values ($1, $2, 'web_chat', $3, $4) returning id`,
    [organizationId, agentId, options.enabled ?? true, publicKey],
  );
  return { id: rows[0]!.id, publicKey };
}

export async function createConversation(
  sql: Sql,
  organizationId: string,
  agentId: string,
  options: { visitorId?: string; status?: 'active' | 'closed' } = {},
): Promise<{ id: string; visitorId: string }> {
  const visitorId = options.visitorId ?? randomUUID();
  const status = options.status ?? 'active';
  const rows = await sql.query<{ id: string }>(
    `insert into public.conversations (organization_id, agent_id, channel, status, visitor_id, closed_at)
     values ($1, $2, 'web_chat', $3, $4, case when $3 = 'closed' then now() else null end) returning id`,
    [organizationId, agentId, status, visitorId],
  );
  return { id: rows[0]!.id, visitorId };
}

/** A tenant with an owner, one agent and an enabled web chat channel. */
export interface TenantFixture {
  org: OrgFixture;
  owner: UserFixture;
  agent: AgentFixture;
  widgetKey: string;
}

export async function createTenant(sql: Sql, name?: string): Promise<TenantFixture> {
  const owner = await createAuthUser(sql);
  const org = await createOrganization(sql, name);
  await addMember(sql, org.id, owner.id, 'owner');
  const agent = await createAgent(sql, org.id);
  const channel = await createWebChatChannel(sql, org.id, agent.id);
  return { org, owner, agent, widgetKey: channel.publicKey };
}
