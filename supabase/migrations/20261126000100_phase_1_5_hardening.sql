-- Syncore AI Receptionist — Phase 1.5: hardening.
--
-- * Conversation turn locks get an owner token (fencing): only the holder releases the lock, and writes made for
--   a turn are refused once another worker owns the conversation.
-- * Durable operation records for tools with EXTERNAL side effects (SMS, calendars, CRMs in later phases): one
--   row per operation identity with an explicit state machine, so an operation whose outcome is unknown is never
--   repeated blindly.
-- * Organization-level AI spending safeguards: daily spend totals maintained from usage_records, concurrency-safe
--   reservations, and per-organization limit overrides set by the platform operator.

-- ---------------------------------------------------------------------------
-- Conversation turn lock ownership
-- ---------------------------------------------------------------------------

-- Random per acquisition. Releasing and fenced writes match it; a new acquisition replaces it.
alter table public.conversations add column turn_lock_token uuid;

-- ---------------------------------------------------------------------------
-- Tool runs: an external call whose outcome could not be confirmed
-- ---------------------------------------------------------------------------

alter table public.tool_runs drop constraint tool_runs_status_check;
alter table public.tool_runs add constraint tool_runs_status_check
  check (status in ('running', 'succeeded', 'failed', 'rejected', 'unknown'));

-- ---------------------------------------------------------------------------
-- Durable operations (external side effects)
-- ---------------------------------------------------------------------------

-- System table (not exposed through the Data API): written only by the server's tool executor.
--   not_attempted: claimed, but the external call was never sent (may be claimed again)
--   in_progress:   claimed by one worker until claimed_until (a lapsed claim means the outcome is unknown)
--   succeeded:     confirmed success; repeats replay `result` instead of calling the provider again
--   failed:        confirmed failure (the provider refused it); may be claimed again
--   unknown:       sent, outcome not confirmed: never retried automatically, needs reconciliation
create table app_private.tool_operations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  agent_id uuid not null,
  conversation_id uuid,
  tool_name text not null check (char_length(tool_name) between 1 and 64),
  operation_key text not null check (char_length(operation_key) between 1 and 128),
  status text not null check (status in ('not_attempted', 'in_progress', 'succeeded', 'failed', 'unknown')),
  attempts integer not null default 1 check (attempts >= 1),
  claim_token uuid,
  claimed_until timestamptz,
  -- The most recent claim. Lets that worker record its confirmed outcome even after its lease lapsed and the
  -- operation was marked unknown (claim_expired) by another request.
  last_claim_token uuid,
  input jsonb not null default '{}'::jsonb,
  result jsonb,
  -- Provider-side id (e.g. a message SID) for reconciliation.
  external_reference text check (char_length(external_reference) <= 200),
  error_code text check (char_length(error_code) <= 64),
  reconciled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, operation_key),
  check ((status = 'in_progress') = (claim_token is not null and claimed_until is not null)),
  foreign key (agent_id, organization_id)
    references public.agents (id, organization_id) on delete cascade,
  foreign key (conversation_id, organization_id)
    references public.conversations (id, organization_id) on delete set null (conversation_id)
);

create index tool_operations_unresolved_idx
  on app_private.tool_operations (organization_id, updated_at)
  where status in ('in_progress', 'unknown');

create trigger tool_operations_touch_updated_at
  before update on app_private.tool_operations
  for each row execute function app_private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- AI spending safeguards
-- ---------------------------------------------------------------------------

-- Pricing snapshot each estimate was computed with (e.g. '2026-11-26'): estimates are never confused with
-- provider-confirmed billing, and a price change is traceable.
alter table public.usage_records add column pricing_version text check (char_length(pricing_version) <= 64);

-- Per-organization overrides of the platform defaults (AI_ORG_* settings). NULL = use the default.
-- Set by the platform operator, never by tenant users.
create table app_private.organization_limits (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  daily_ai_spend_usd numeric(12, 4) check (daily_ai_spend_usd >= 0),
  monthly_ai_spend_usd numeric(12, 4) check (monthly_ai_spend_usd >= 0),
  max_conversation_turns integer check (max_conversation_turns >= 1),
  updated_at timestamptz not null default now()
);

create trigger organization_limits_touch_updated_at
  before update on app_private.organization_limits
  for each row execute function app_private.touch_updated_at();

-- Estimated AI spend per organization and UTC day, maintained from usage_records (trigger below), so limit
-- checks read at most ~31 rows instead of scanning usage history.
create table app_private.usage_daily_totals (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  usage_date date not null,
  estimated_cost_usd numeric(16, 8) not null default 0 check (estimated_cost_usd >= 0),
  records integer not null default 0 check (records >= 0),
  primary key (organization_id, usage_date)
);

create or replace function app_private.add_usage_to_daily_totals()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into app_private.usage_daily_totals as t (organization_id, usage_date, estimated_cost_usd, records)
  values (new.organization_id, (new.created_at at time zone 'UTC')::date, new.estimated_cost_usd, 1)
  on conflict (organization_id, usage_date) do update
    set estimated_cost_usd = t.estimated_cost_usd + excluded.estimated_cost_usd,
        records = t.records + 1;
  return null;
end;
$$;

create trigger usage_records_daily_totals
  after insert on public.usage_records
  for each row execute function app_private.add_usage_to_daily_totals();

-- Existing records count from day one: without this backfill, spend before the deploy would read as $0.
insert into app_private.usage_daily_totals (organization_id, usage_date, estimated_cost_usd, records)
select organization_id, (created_at at time zone 'UTC')::date, sum(estimated_cost_usd), count(*)
from public.usage_records
group by organization_id, (created_at at time zone 'UTC')::date;

-- In-flight spend: reserved before a provider call (worst case), deleted once its usage is recorded. A crashed
-- worker's reservation stops counting at expires_at. `resource` leaves room for voice minutes, concurrent calls
-- and SMS segments in later phases.
create table app_private.usage_reservations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  resource text not null check (resource in ('ai_spend_usd')),
  amount numeric(16, 8) not null check (amount >= 0),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index usage_reservations_org_idx on app_private.usage_reservations (organization_id, resource, expires_at);

-- ---------------------------------------------------------------------------
-- Row level security: system tables, no access for API roles
-- ---------------------------------------------------------------------------

alter table app_private.tool_operations enable row level security;
alter table app_private.organization_limits enable row level security;
alter table app_private.usage_daily_totals enable row level security;
alter table app_private.usage_reservations enable row level security;

revoke all on table
  app_private.tool_operations,
  app_private.organization_limits,
  app_private.usage_daily_totals,
  app_private.usage_reservations
from anon, authenticated;
revoke all on function app_private.add_usage_to_daily_totals() from public;
