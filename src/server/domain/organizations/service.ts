import { z } from 'zod';
import type { ScopedDb } from '@/server/db/scope';
import { maybeOne, toDate } from '@/server/db/sql';
import type { Database, Sql } from '@/server/db/types';
import { ensureWebChatChannel, insertAgent } from '@/server/domain/agents/repository';
import type { Agent } from '@/server/domain/agents/types';
import { randomString } from '@/server/domain/agents/widget-key';
import { recordAudit } from '@/server/domain/audit/service';
import { upsertBusinessProfile } from '@/server/domain/business/repository';
import { DomainError, type MemberRole } from '@/server/domain/types';
import { SLUG_PATTERN, slugWithSuffix, slugify } from './slug';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
}

export interface Membership {
  organization: Organization;
  role: MemberRole;
}

export const createOrganizationInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Enter the organization name.')
    .max(120, 'Keep the organization name to 120 characters or fewer.'),
  // Optional form field: blank means "use the default name".
  agentName: z
    .string()
    .trim()
    .max(80, 'Keep the assistant name to 80 characters or fewer.')
    .nullish()
    .transform((value) => (value === '' || value === null ? undefined : value)),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_AGENT_NAME = 'Receptionist';
const SLUG_ATTEMPTS = 6;
const SLUG_SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  created_at: Date | string;
}

interface MembershipRow extends OrganizationRow {
  role: MemberRole;
}

function mapOrganization(row: OrganizationRow): Organization {
  return { id: row.id, name: row.name, slug: row.slug, createdAt: toDate(row.created_at) };
}

function mapMembership(row: MembershipRow): Membership {
  return { organization: mapOrganization(row), role: row.role };
}

/**
 * Creates an organization ready to configure: owner membership, a first agent
 * with a business profile and an unpublished web chat channel. No opening hours
 * are assumed: until the owner enters them, the agent says they are not configured.
 * One privileged transaction — the caller must already have authenticated
 * `ownerUserId` (organizations cannot be created through RLS).
 */
export async function createOrganization(
  db: Database,
  input: { name: string; ownerUserId: string; agentName?: string },
): Promise<{ organization: Organization; agent: Agent }> {
  const parsed = createOrganizationInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new DomainError('invalid', parsed.error.issues[0]?.message ?? 'Invalid organization details.');
  }
  if (!UUID_RE.test(input.ownerUserId)) throw new DomainError('invalid', 'Invalid user.');
  const { name, agentName } = parsed.data;

  return db.transaction(async (sql) => {
    const organization = await insertOrganization(sql, name);
    await sql.query(
      `insert into public.organization_members (organization_id, user_id, role) values ($1, $2, 'owner')`,
      [organization.id, input.ownerUserId],
    );
    const agent = await insertAgent(sql, organization.id, { name: agentName ?? DEFAULT_AGENT_NAME });
    await upsertBusinessProfile(sql, organization.id, agent.id, {
      businessName: organization.name,
      description: null,
      phone: null,
      email: null,
      website: null,
      address: null,
      serviceArea: null,
    });
    await ensureWebChatChannel(sql, organization.id, agent.id);
    await recordAudit(sql, {
      organizationId: organization.id,
      actorType: 'user',
      actorId: input.ownerUserId,
      action: 'organization.created',
      targetType: 'organization',
      targetId: organization.id,
      metadata: { slug: organization.slug, agentId: agent.id },
    });
    return { organization, agent };
  });
}

/** Inserts with the first free slug: the name's slug, then up to five random suffixes. */
async function insertOrganization(sql: Sql, name: string): Promise<Organization> {
  const base = slugify(name);
  for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt += 1) {
    const slug = attempt === 0 ? base : slugWithSuffix(base, randomString(SLUG_SUFFIX_ALPHABET, 4));
    // `do nothing` (rather than catching a unique violation) keeps the transaction usable.
    const row = maybeOne(
      await sql.query<OrganizationRow>(
        `insert into public.organizations (name, slug) values ($1, $2)
         on conflict (slug) do nothing
         returning id, name, slug, created_at`,
        [name, slug],
      ),
    );
    if (row) return mapOrganization(row);
  }
  throw new DomainError('conflict', 'Could not reserve a web address for this organization. Please try again.');
}

/** The user's organizations, ordered by name. Works under user scope (RLS) and service scope alike. */
export async function listMemberships(db: ScopedDb, userId: string): Promise<Membership[]> {
  if (!UUID_RE.test(userId)) return [];
  const rows = await db.run((sql) =>
    sql.query<MembershipRow>(
      `select o.id, o.name, o.slug, o.created_at, m.role
       from public.organization_members m
       join public.organizations o on o.id = m.organization_id
       where m.user_id = $1
       order by lower(o.name), o.name, o.id`,
      [userId],
    ),
  );
  return rows.map(mapMembership);
}

/** The user's membership in the organization with this slug, or null (never reveals other organizations). */
export async function getMembershipBySlug(db: ScopedDb, userId: string, slug: string): Promise<Membership | null> {
  if (!UUID_RE.test(userId) || !SLUG_PATTERN.test(slug)) return null;
  const rows = await db.run((sql) =>
    sql.query<MembershipRow>(
      `select o.id, o.name, o.slug, o.created_at, m.role
       from public.organization_members m
       join public.organizations o on o.id = m.organization_id
       where m.user_id = $1 and o.slug = $2`,
      [userId, slug],
    ),
  );
  const row = maybeOne(rows);
  return row ? mapMembership(row) : null;
}
