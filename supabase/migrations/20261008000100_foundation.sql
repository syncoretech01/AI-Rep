-- Syncore AI Receptionist — Phase 0 foundation.
--
-- Tenancy (organizations + members), agent configuration (agents, business
-- profile, business hours) and the usage/audit foundations.
--
-- Conventions
-- * Every tenant-owned table carries organization_id.
-- * Agent-owned rows reference agents through a composite foreign key
--   (agent_id, organization_id) so a row can never point at another tenant's agent.
-- * RLS is enabled on every table. Members can read their organization's rows;
--   owners/admins can change configuration. System records (usage, audit) are
--   written only by the server's privileged connection.

create schema if not exists app_private;
revoke all on schema app_private from public;
grant usage on schema app_private to authenticated;

create or replace function app_private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Organizations and membership
-- ---------------------------------------------------------------------------

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger organizations_touch_updated_at
  before update on public.organizations
  for each row execute function app_private.touch_updated_at();

create table public.organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create index organization_members_user_id_idx on public.organization_members (user_id);

-- RLS helpers. SECURITY DEFINER so policies can read memberships without
-- recursing into organization_members' own policy. They live in a schema that
-- is not exposed through the Data API.
create or replace function app_private.user_organization_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.organization_id
  from public.organization_members m
  where m.user_id = (select auth.uid())
$$;

create or replace function app_private.user_admin_organization_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.organization_id
  from public.organization_members m
  where m.user_id = (select auth.uid())
    and m.role in ('owner', 'admin')
$$;

revoke all on function app_private.user_organization_ids() from public;
revoke all on function app_private.user_admin_organization_ids() from public;
grant execute on function app_private.user_organization_ids() to authenticated;
grant execute on function app_private.user_admin_organization_ids() to authenticated;

-- ---------------------------------------------------------------------------
-- Agents and business configuration
-- ---------------------------------------------------------------------------

create table public.agents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  status text not null default 'active' check (status in ('active', 'paused')),
  greeting text not null default 'Hi! How can I help you today?'
    check (char_length(btrim(greeting)) between 1 and 500),
  language text not null default 'en' check (language ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  timezone text not null default 'UTC' check (char_length(timezone) between 1 and 64),
  instructions text not null default '' check (char_length(instructions) <= 4000),
  lead_capture jsonb not null default '{"enabled": true, "requiredFields": ["name", "phone"]}'::jsonb
    check (jsonb_typeof(lead_capture) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id)
);

create index agents_organization_id_idx on public.agents (organization_id);

create trigger agents_touch_updated_at
  before update on public.agents
  for each row execute function app_private.touch_updated_at();

create table public.business_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  agent_id uuid not null unique,
  business_name text check (char_length(business_name) between 1 and 160),
  description text check (char_length(description) between 1 and 1000),
  phone text check (char_length(phone) between 1 and 40),
  email text check (char_length(email) between 3 and 254),
  website text check (char_length(website) between 1 and 300),
  address text check (char_length(address) between 1 and 500),
  service_area text check (char_length(service_area) between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (agent_id, organization_id)
    references public.agents (id, organization_id) on delete cascade
);

create index business_profiles_organization_id_idx on public.business_profiles (organization_id);

create trigger business_profiles_touch_updated_at
  before update on public.business_profiles
  for each row execute function app_private.touch_updated_at();

-- Weekly opening intervals in the agent's timezone. No row for a day = closed.
-- day_of_week: 0 = Sunday … 6 = Saturday. closes_at may be 24:00.
create table public.business_hours (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  agent_id uuid not null,
  day_of_week smallint not null check (day_of_week between 0 and 6),
  opens_at time not null,
  closes_at time not null,
  created_at timestamptz not null default now(),
  check (closes_at > opens_at),
  unique (agent_id, day_of_week, opens_at),
  foreign key (agent_id, organization_id)
    references public.agents (id, organization_id) on delete cascade
);

create index business_hours_organization_id_idx on public.business_hours (organization_id);

-- ---------------------------------------------------------------------------
-- Usage and audit foundations (append-only, written by the server only)
-- ---------------------------------------------------------------------------

create table public.usage_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  agent_id uuid,
  conversation_id uuid,
  kind text not null check (kind in ('text_generation', 'embedding')),
  purpose text not null check (char_length(purpose) between 1 and 64),
  provider text not null check (char_length(provider) between 1 and 64),
  model text not null check (char_length(model) between 1 and 128),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  cached_input_tokens integer not null default 0 check (cached_input_tokens >= 0),
  cache_write_tokens integer not null default 0 check (cache_write_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  reasoning_tokens integer not null default 0 check (reasoning_tokens >= 0),
  tool_calls integer not null default 0 check (tool_calls >= 0),
  duration_ms integer check (duration_ms >= 0),
  estimated_cost_usd numeric(14, 8) not null default 0 check (estimated_cost_usd >= 0),
  pricing_known boolean not null default true,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

create index usage_records_org_created_idx on public.usage_records (organization_id, created_at desc);
create index usage_records_conversation_idx on public.usage_records (conversation_id)
  where conversation_id is not null;

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  actor_type text not null check (actor_type in ('user', 'agent', 'system')),
  actor_id text check (char_length(actor_id) <= 128),
  action text not null check (char_length(action) between 1 and 100),
  target_type text check (char_length(target_type) <= 64),
  target_id text check (char_length(target_id) <= 128),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

create index audit_logs_org_created_idx on public.audit_logs (organization_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.agents enable row level security;
alter table public.business_profiles enable row level security;
alter table public.business_hours enable row level security;
alter table public.usage_records enable row level security;
alter table public.audit_logs enable row level security;

-- Explicit grants (Supabase no longer auto-grants new tables to API roles, and
-- older projects granted ALL). The app never uses `anon` for data access.
revoke all on table
  public.organizations,
  public.organization_members,
  public.agents,
  public.business_profiles,
  public.business_hours,
  public.usage_records,
  public.audit_logs
from anon, authenticated;

grant select, update on table public.organizations to authenticated;
grant select on table public.organization_members to authenticated;
grant select, insert, update, delete on table
  public.agents,
  public.business_profiles,
  public.business_hours
to authenticated;
grant select on table public.usage_records, public.audit_logs to authenticated;

create policy organizations_select on public.organizations
  for select to authenticated
  using (id in (select app_private.user_organization_ids()));

create policy organizations_update on public.organizations
  for update to authenticated
  using (id in (select app_private.user_admin_organization_ids()))
  with check (id in (select app_private.user_admin_organization_ids()));

create policy organization_members_select on public.organization_members
  for select to authenticated
  using (organization_id in (select app_private.user_organization_ids()));

-- Configuration tables: members read, owners/admins write.
create policy agents_select on public.agents
  for select to authenticated
  using (organization_id in (select app_private.user_organization_ids()));
create policy agents_insert on public.agents
  for insert to authenticated
  with check (organization_id in (select app_private.user_admin_organization_ids()));
create policy agents_update on public.agents
  for update to authenticated
  using (organization_id in (select app_private.user_admin_organization_ids()))
  with check (organization_id in (select app_private.user_admin_organization_ids()));
create policy agents_delete on public.agents
  for delete to authenticated
  using (organization_id in (select app_private.user_admin_organization_ids()));

create policy business_profiles_select on public.business_profiles
  for select to authenticated
  using (organization_id in (select app_private.user_organization_ids()));
create policy business_profiles_insert on public.business_profiles
  for insert to authenticated
  with check (organization_id in (select app_private.user_admin_organization_ids()));
create policy business_profiles_update on public.business_profiles
  for update to authenticated
  using (organization_id in (select app_private.user_admin_organization_ids()))
  with check (organization_id in (select app_private.user_admin_organization_ids()));
create policy business_profiles_delete on public.business_profiles
  for delete to authenticated
  using (organization_id in (select app_private.user_admin_organization_ids()));

create policy business_hours_select on public.business_hours
  for select to authenticated
  using (organization_id in (select app_private.user_organization_ids()));
create policy business_hours_insert on public.business_hours
  for insert to authenticated
  with check (organization_id in (select app_private.user_admin_organization_ids()));
create policy business_hours_update on public.business_hours
  for update to authenticated
  using (organization_id in (select app_private.user_admin_organization_ids()))
  with check (organization_id in (select app_private.user_admin_organization_ids()));
create policy business_hours_delete on public.business_hours
  for delete to authenticated
  using (organization_id in (select app_private.user_admin_organization_ids()));

-- System records: readable by members (audit: owners/admins); no user writes.
create policy usage_records_select on public.usage_records
  for select to authenticated
  using (organization_id in (select app_private.user_organization_ids()));

create policy audit_logs_select on public.audit_logs
  for select to authenticated
  using (organization_id in (select app_private.user_admin_organization_ids()));
