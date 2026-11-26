-- Syncore AI Receptionist — Phase 2: realtime browser voice (GPT-Live) proof of concept.
--
-- * The `web_voice` channel joins `web_chat` on the channel-neutral tables: voice conversations, tool runs and leads
--   use the same rows, domain services and audit as text.
-- * `voice_sessions`: one row per provider voice session (lifecycle, limits, metered seconds, estimated cost),
--   written only by the voice gateway; members read them.
-- * Voice usage is metered in seconds on usage_records; per-organization voice limits join organization_limits.

-- ---------------------------------------------------------------------------
-- Channels
-- ---------------------------------------------------------------------------

alter table public.conversations drop constraint conversations_channel_check;
alter table public.conversations add constraint conversations_channel_check check (channel in ('web_chat', 'web_voice'));

alter table public.leads drop constraint leads_channel_check;
alter table public.leads add constraint leads_channel_check check (channel in ('web_chat', 'web_voice'));

alter table public.tool_runs drop constraint tool_runs_channel_check;
alter table public.tool_runs add constraint tool_runs_channel_check check (channel in ('web_chat', 'web_voice'));

-- ---------------------------------------------------------------------------
-- Usage: voice session seconds
-- ---------------------------------------------------------------------------

alter table public.usage_records drop constraint usage_records_kind_check;
alter table public.usage_records add constraint usage_records_kind_check
  check (kind in ('text_generation', 'embedding', 'voice_session'));
alter table public.usage_records add column active_seconds numeric(12, 3) check (active_seconds >= 0);
alter table public.usage_records add column standby_seconds numeric(12, 3) check (standby_seconds >= 0);

-- ---------------------------------------------------------------------------
-- Voice sessions
-- ---------------------------------------------------------------------------

create table public.voice_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  agent_id uuid not null,
  conversation_id uuid not null,
  -- The signed-in user who started a developer test session (null for future visitor sessions).
  started_by uuid references auth.users (id) on delete set null,
  provider text not null check (char_length(provider) between 1 and 64),
  model text not null check (char_length(model) between 1 and 128),
  voice text check (char_length(voice) <= 64),
  delegation text not null check (delegation in ('responses', 'client')),
  provider_session_id text check (char_length(provider_session_id) <= 200),
  status text not null default 'creating' check (status in ('creating', 'active', 'ending', 'ended', 'failed')),
  end_reason text check (char_length(end_reason) <= 64),
  max_duration_seconds integer not null check (max_duration_seconds > 0),
  -- Which gateway process holds the sideband; a stale heartbeat lets another instance recover the session.
  gateway_instance text check (char_length(gateway_instance) <= 128),
  active_seconds numeric(12, 3) not null default 0 check (active_seconds >= 0),
  standby_seconds numeric(12, 3) not null default 0 check (standby_seconds >= 0),
  -- 'provider': seconds reported by the provider; 'estimated': derived from our own timestamps (e.g. after a crash).
  usage_source text check (usage_source in ('provider', 'estimated')),
  estimated_cost_usd numeric(14, 8) not null default 0 check (estimated_cost_usd >= 0),
  created_at timestamptz not null default now(),
  connected_at timestamptz,
  last_event_at timestamptz not null default now(),
  ended_at timestamptz,
  unique (id, organization_id),
  check ((status in ('ended', 'failed')) = (ended_at is not null)),
  foreign key (agent_id, organization_id)
    references public.agents (id, organization_id) on delete cascade,
  foreign key (conversation_id, organization_id)
    references public.conversations (id, organization_id) on delete cascade
);

create index voice_sessions_org_open_idx
  on public.voice_sessions (organization_id, last_event_at)
  where status in ('creating', 'active', 'ending');
create index voice_sessions_org_created_idx on public.voice_sessions (organization_id, created_at desc);
create unique index voice_sessions_provider_session_key
  on public.voice_sessions (provider_session_id) where provider_session_id is not null;

-- ---------------------------------------------------------------------------
-- Voice limits (platform operator overrides; NULL = the VOICE_* defaults)
-- ---------------------------------------------------------------------------

alter table app_private.organization_limits add column max_concurrent_voice_sessions integer
  check (max_concurrent_voice_sessions >= 0);
alter table app_private.organization_limits add column max_voice_session_seconds integer
  check (max_voice_session_seconds >= 1);

-- ---------------------------------------------------------------------------
-- Row level security: members read; only the server writes
-- ---------------------------------------------------------------------------

alter table public.voice_sessions enable row level security;
revoke all on table public.voice_sessions from anon, authenticated;
grant select on table public.voice_sessions to authenticated;

create policy voice_sessions_select on public.voice_sessions
  for select to authenticated
  using (organization_id in (select app_private.user_organization_ids()));
