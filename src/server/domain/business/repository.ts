import type { z } from 'zod';
import { maybeOne, pgTextArray, toDate, toNumber } from '@/server/db/sql';
import type { Sql } from '@/server/db/types';
import { DomainError } from '@/server/domain/types';
import { businessProfileSchema, weeklyHoursSchema, type BusinessProfileInput } from './schemas';
import type { BusinessProfile, HoursInterval } from './types';

/**
 * Business profile and weekly hours of an agent. Functions run inside the
 * caller's transaction: under user scope RLS applies (members read,
 * owners/admins write); under service scope the organization filters are the guard.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PROFILE_COLUMNS =
  'organization_id, agent_id, business_name, description, phone, email, website, address, service_area, updated_at';

interface ProfileRow {
  organization_id: string;
  agent_id: string;
  business_name: string | null;
  description: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  address: string | null;
  service_area: string | null;
  updated_at: Date | string;
}

interface HoursRow {
  day_of_week: number | string;
  opens_at: string;
  closes_at: string;
}

/** Ids may come from URLs or forms: malformed ones mean "not found", not a Postgres cast error. */
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function agentNotFound(): DomainError {
  return new DomainError('not_found', 'Agent not found.');
}

/** Typed input is re-validated here: email/website formats and non-overlapping hours are not database constraints. */
function validated<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new DomainError('invalid', result.error.issues[0]?.message ?? 'Invalid business details.');
}

function mapProfile(row: ProfileRow): BusinessProfile {
  return {
    organizationId: row.organization_id,
    agentId: row.agent_id,
    businessName: row.business_name,
    description: row.description,
    phone: row.phone,
    email: row.email,
    website: row.website,
    address: row.address,
    serviceArea: row.service_area,
    updatedAt: toDate(row.updated_at),
  };
}

export async function getBusinessProfile(
  sql: Sql,
  organizationId: string,
  agentId: string,
): Promise<BusinessProfile | null> {
  if (!isUuid(organizationId) || !isUuid(agentId)) return null;
  const row = maybeOne(
    await sql.query<ProfileRow>(
      `select ${PROFILE_COLUMNS} from public.business_profiles where organization_id = $1 and agent_id = $2`,
      [organizationId, agentId],
    ),
  );
  return row ? mapProfile(row) : null;
}

/** Creates or replaces the agent's profile (every field is written; null clears it). */
export async function upsertBusinessProfile(
  sql: Sql,
  organizationId: string,
  agentId: string,
  profile: BusinessProfileInput,
): Promise<BusinessProfile> {
  if (!isUuid(organizationId) || !isUuid(agentId)) throw agentNotFound();
  const valid = validated(businessProfileSchema, profile);
  // Selecting the agent inside the insert turns "not this organization's agent" into
  // zero rows instead of a foreign-key error that would abort the caller's transaction.
  const row = maybeOne(
    await sql.query<ProfileRow>(
      `insert into public.business_profiles
         (organization_id, agent_id, business_name, description, phone, email, website, address, service_area)
       select a.organization_id, a.id, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text, $9::text
       from public.agents a
       where a.id = $2 and a.organization_id = $1
       on conflict (agent_id) do update
         set business_name = excluded.business_name,
             description = excluded.description,
             phone = excluded.phone,
             email = excluded.email,
             website = excluded.website,
             address = excluded.address,
             service_area = excluded.service_area
         where business_profiles.organization_id = excluded.organization_id
       returning ${PROFILE_COLUMNS}`,
      [
        organizationId,
        agentId,
        valid.businessName,
        valid.description,
        valid.phone,
        valid.email,
        valid.website,
        valid.address,
        valid.serviceArea,
      ],
    ),
  );
  if (!row) throw agentNotFound();
  return mapProfile(row);
}

/** Sorted by day, then opening time. Times are 'HH:MM' ('24:00' = end of day). */
export async function listBusinessHours(sql: Sql, organizationId: string, agentId: string): Promise<HoursInterval[]> {
  if (!isUuid(organizationId) || !isUuid(agentId)) return [];
  const rows = await sql.query<HoursRow>(
    `select day_of_week, to_char(opens_at, 'HH24:MI') as opens_at, to_char(closes_at, 'HH24:MI') as closes_at
     from public.business_hours
     where organization_id = $1 and agent_id = $2
     order by day_of_week, business_hours.opens_at`,
    [organizationId, agentId],
  );
  return rows.map((row) => ({ dayOfWeek: toNumber(row.day_of_week), opensAt: row.opens_at, closesAt: row.closes_at }));
}

/** Replaces the agent's whole week (an empty list closes every day). */
export async function replaceBusinessHours(
  sql: Sql,
  organizationId: string,
  agentId: string,
  intervals: HoursInterval[],
): Promise<HoursInterval[]> {
  if (!isUuid(organizationId) || !isUuid(agentId)) throw agentNotFound();
  const valid = validated(weeklyHoursSchema, intervals);

  // Locking the agent row serializes concurrent replacements for one agent (otherwise
  // two delete+insert pairs could interleave). Under RLS only owners/admins get the row.
  const agent = await sql.query(
    'select id from public.agents where id = $1 and organization_id = $2 for no key update',
    [agentId, organizationId],
  );
  if (agent.length === 0) throw agentNotFound();

  await sql.query('delete from public.business_hours where organization_id = $1 and agent_id = $2', [
    organizationId,
    agentId,
  ]);
  if (valid.length > 0) {
    await sql.query(
      `insert into public.business_hours (organization_id, agent_id, day_of_week, opens_at, closes_at)
       select $1::uuid, $2::uuid, t.day_of_week, t.opens_at, t.closes_at
       from unnest($3::smallint[], $4::time[], $5::time[]) as t(day_of_week, opens_at, closes_at)`,
      [
        organizationId,
        agentId,
        pgTextArray(valid.map((interval) => String(interval.dayOfWeek))),
        pgTextArray(valid.map((interval) => interval.opensAt)),
        pgTextArray(valid.map((interval) => interval.closesAt)),
      ],
    );
  }
  return listBusinessHours(sql, organizationId, agentId);
}
