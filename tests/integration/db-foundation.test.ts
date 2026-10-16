import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { addMember, createAgent, createAuthUser, createOrganization } from '../support/fixtures';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.close();
});

describe('schema invariants', () => {
  it('enables row level security on every application table', async () => {
    const rows = await t.db.query<{ table_name: string; rls: boolean }>(
      `select n.nspname || '.' || c.relname as table_name, c.relrowsecurity as rls
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where c.relkind = 'r' and n.nspname in ('public', 'app_private')`,
    );
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.filter((row) => !row.rls).map((row) => row.table_name)).toEqual([]);
  });

  it('scopes every tenant-owned table by organization_id', async () => {
    const rows = await t.db.query<{ table_name: string }>(
      `select c.relname as table_name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where c.relkind = 'r' and n.nspname = 'public' and c.relname <> 'organizations'
         and not exists (
           select 1 from pg_attribute a
           where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped
         )`,
    );
    expect(rows.map((row) => row.table_name)).toEqual([]);
  });

  it('never grants the anon role access to application tables', async () => {
    const rows = await t.db.query<{ table_name: string }>(
      `select table_schema || '.' || table_name as table_name
       from information_schema.role_table_grants
       where grantee = 'anon' and table_schema in ('public', 'app_private')`,
    );
    expect(rows).toEqual([]);
  });

  it('stores and compares 1536-dimension vectors', async () => {
    const rows = await t.db.query<{ distance: number }>(
      `select ($1::extensions.vector <=> $1::extensions.vector)::float8 as distance`,
      [`[${new Array(1536).fill(0.5).join(',')}]`],
    );
    expect(rows[0]?.distance).toBeCloseTo(0, 6);
  });
});

describe('row level security (user scope)', () => {
  it('lets a user see only organizations and agents they belong to', async () => {
    const alice = await t.service.run((sql) => createAuthUser(sql));
    const bob = await t.service.run((sql) => createAuthUser(sql));
    const orgA = await t.service.run((sql) => createOrganization(sql, 'Alpha'));
    const orgB = await t.service.run((sql) => createOrganization(sql, 'Bravo'));
    await t.service.run(async (sql) => {
      await addMember(sql, orgA.id, alice.id, 'owner');
      await addMember(sql, orgB.id, bob.id, 'owner');
      await createAgent(sql, orgA.id, { name: 'Alpha desk' });
      await createAgent(sql, orgB.id, { name: 'Bravo desk' });
    });

    const visible = await t.asUser(alice.id).run(async (sql) => ({
      orgs: await sql.query<{ id: string }>('select id from public.organizations'),
      agents: await sql.query<{ organization_id: string }>('select organization_id from public.agents'),
    }));
    expect(visible.orgs.map((row) => row.id)).toEqual([orgA.id]);
    expect(new Set(visible.agents.map((row) => row.organization_id))).toEqual(new Set([orgA.id]));

    // Explicitly asking for the other tenant's rows returns nothing.
    const foreign = await t
      .asUser(alice.id)
      .run((sql) => sql.query('select id from public.agents where organization_id = $1', [orgB.id]));
    expect(foreign).toEqual([]);
  });

  it('rejects writes into another organization', async () => {
    const alice = await t.service.run((sql) => createAuthUser(sql));
    const orgA = await t.service.run((sql) => createOrganization(sql));
    const orgB = await t.service.run((sql) => createOrganization(sql));
    await t.service.run((sql) => addMember(sql, orgA.id, alice.id, 'owner'));
    const agentB = await t.service.run((sql) => createAgent(sql, orgB.id));

    await expect(
      t.asUser(alice.id).run((sql) => sql.query('insert into public.agents (organization_id, name) values ($1, $2)', [orgB.id, 'x'])),
    ).rejects.toMatchObject({ code: '42501' });

    const updated = await t
      .asUser(alice.id)
      .run((sql) => sql.query<{ id: string }>("update public.agents set name = 'hijacked' where id = $1 returning id", [agentB.id]));
    expect(updated).toEqual([]);

    const deleted = await t
      .asUser(alice.id)
      .run((sql) => sql.query<{ id: string }>('delete from public.agents where id = $1 returning id', [agentB.id]));
    expect(deleted).toEqual([]);
  });

  it('gives members read-only access to configuration', async () => {
    const member = await t.service.run((sql) => createAuthUser(sql));
    const org = await t.service.run((sql) => createOrganization(sql));
    await t.service.run((sql) => addMember(sql, org.id, member.id, 'member'));
    const agent = await t.service.run((sql) => createAgent(sql, org.id));

    const rows = await t.asUser(member.id).run((sql) => sql.query('select id from public.agents where id = $1', [agent.id]));
    expect(rows).toHaveLength(1);

    const updated = await t
      .asUser(member.id)
      .run((sql) => sql.query("update public.agents set name = 'renamed' where id = $1 returning id", [agent.id]));
    expect(updated).toEqual([]);
  });

  it('bounds statements in both scopes and reverts the limit after the transaction', async () => {
    const user = await t.service.run((sql) => createAuthUser(sql));
    const read = (sql: { query: TestDatabase['db']['query'] }) =>
      sql.query<{ timeout: string }>("select current_setting('statement_timeout') as timeout");
    expect((await t.service.run(read))[0]?.timeout).toBe('15s');
    expect((await t.asUser(user.id).run(read))[0]?.timeout).toBe('15s');
    expect((await t.db.query<{ timeout: string }>("select current_setting('statement_timeout') as timeout"))[0]?.timeout).toBe('0');
  });

  it('reverts to the privileged role after a user-scoped transaction', async () => {
    const user = await t.service.run((sql) => createAuthUser(sql));
    await t.asUser(user.id).run((sql) => sql.query('select 1'));
    const rows = await t.db.query<{ role: string; claims: string | null }>(
      "select current_user as role, nullif(current_setting('request.jwt.claims', true), '') as claims",
    );
    expect(rows[0]).toEqual({ role: 'postgres', claims: null });
  });
});
