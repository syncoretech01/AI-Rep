-- Syncore AI Receptionist — Phase 1: web chat vertical slice.
--
-- organization -> agent config -> knowledge -> web chat -> tools -> lead capture
-- -> persisted conversation -> usage metering.

-- pgvector lives in the `extensions` schema on Supabase.
create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------------------
-- Agent channels (web chat publishing)
-- ---------------------------------------------------------------------------

create table public.agent_channels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  agent_id uuid not null,
  channel text not null check (channel in ('web_chat')),
  enabled boolean not null default false,
  -- Public, non-secret widget key. Maps a widget embed to exactly one agent.
  public_key text unique check (public_key ~ '^wk_[A-Za-z0-9]{24,64}$'),
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_id, channel),
  foreign key (agent_id, organization_id)
    references public.agents (id, organization_id) on delete cascade
);

create index agent_channels_organization_id_idx on public.agent_channels (organization_id);

create trigger agent_channels_touch_updated_at
  before update on public.agent_channels
  for each row execute function app_private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Knowledge: source -> document (normalized text) -> chunks (+ embeddings)
-- ---------------------------------------------------------------------------

create table public.knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- null = shared by every agent in the organization.
  agent_id uuid,
  kind text not null check (kind in ('text', 'file')),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'ready', 'failed')),
  error text check (char_length(error) <= 1000),
  file_name text check (char_length(file_name) <= 255),
  mime_type text check (char_length(mime_type) <= 100),
  byte_size integer check (byte_size >= 0),
  chunk_count integer not null default 0 check (chunk_count >= 0),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  foreign key (agent_id, organization_id)
    references public.agents (id, organization_id) on delete cascade
);

create index knowledge_sources_organization_id_idx on public.knowledge_sources (organization_id);

create trigger knowledge_sources_touch_updated_at
  before update on public.knowledge_sources
  for each row execute function app_private.touch_updated_at();

create table public.knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  source_id uuid not null,
  title text not null check (char_length(title) between 1 and 200),
  content text not null,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  char_count integer not null check (char_count >= 0),
  created_at timestamptz not null default now(),
  unique (id, organization_id),
  foreign key (source_id, organization_id)
    references public.knowledge_sources (id, organization_id) on delete cascade
);

create index knowledge_documents_source_id_idx on public.knowledge_documents (source_id);

-- Embedding dimension is fixed by the column type; AI_EMBEDDING_DIMENSIONS must match.
-- Retrieval is an exact (tenant-filtered) nearest-neighbour scan. An ANN index
-- (HNSW + iterative scans) can be added once per-tenant volumes require it.
create table public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  source_id uuid not null,
  document_id uuid not null,
  chunk_index integer not null check (chunk_index >= 0),
  content text not null check (char_length(content) > 0),
  token_count integer not null check (token_count > 0),
  embedding extensions.vector(1536) not null,
  embedding_model text not null check (char_length(embedding_model) between 1 and 128),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  unique (document_id, chunk_index),
  foreign key (source_id, organization_id)
    references public.knowledge_sources (id, organization_id) on delete cascade,
  foreign key (document_id, organization_id)
    references public.knowledge_documents (id, organization_id) on delete cascade
);

create index knowledge_chunks_scope_idx
  on public.knowledge_chunks (organization_id, embedding_model, source_id);

-- ---------------------------------------------------------------------------
-- CRM-lite: contacts and leads
-- ---------------------------------------------------------------------------

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text check (char_length(name) between 1 and 160),
  phone text check (char_length(phone) between 1 and 40),
  phone_normalized text check (phone_normalized ~ '^\+?[0-9]{7,15}$'),
  email text check (char_length(email) between 3 and 254),
  email_normalized text check (char_length(email_normalized) between 3 and 254),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  check (phone_normalized is not null or email_normalized is not null)
);

create unique index contacts_org_phone_key
  on public.contacts (organization_id, phone_normalized) where phone_normalized is not null;
create unique index contacts_org_email_key
  on public.contacts (organization_id, email_normalized) where email_normalized is not null;

create trigger contacts_touch_updated_at
  before update on public.contacts
  for each row execute function app_private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Conversations (channel-neutral) and messages
-- ---------------------------------------------------------------------------

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  agent_id uuid not null,
  channel text not null check (channel in ('web_chat')),
  status text not null default 'active' check (status in ('active', 'closed')),
  -- Anonymous web visitor id carried by the signed widget session token.
  visitor_id uuid,
  -- Set once the visitor is identified (anonymous session upgraded to a contact).
  contact_id uuid,
  summary text not null default '' check (char_length(summary) <= 8000),
  -- Messages with seq <= summary_through_seq are folded into `summary`.
  summary_through_seq bigint not null default 0,
  message_count integer not null default 0 check (message_count >= 0),
  -- Guards against concurrent turns in one conversation (double submit, two tabs).
  turn_locked_until timestamptz,
  last_message_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  check ((status = 'closed') = (closed_at is not null)),
  foreign key (agent_id, organization_id)
    references public.agents (id, organization_id),
  foreign key (contact_id, organization_id)
    references public.contacts (id, organization_id) on delete set null (contact_id)
);

create index conversations_org_recent_idx
  on public.conversations (organization_id, last_message_at desc nulls last);
create index conversations_agent_id_idx on public.conversations (agent_id);
-- One active conversation per visitor per agent.
create unique index conversations_active_visitor_key
  on public.conversations (agent_id, visitor_id)
  where status = 'active' and visitor_id is not null;

create trigger conversations_touch_updated_at
  before update on public.conversations
  for each row execute function app_private.touch_updated_at();

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  agent_id uuid not null,
  contact_id uuid not null,
  conversation_id uuid,
  channel text not null check (channel in ('web_chat')),
  status text not null default 'new' check (status in ('new', 'contacted', 'qualified', 'closed')),
  summary text check (char_length(summary) <= 2000),
  -- What the visitor gave in this conversation, as given. The contact row is the deduplicated identity and is
  -- never modified by unverified public input (see captureLead).
  captured_name text check (char_length(captured_name) between 1 and 160),
  captured_phone text check (char_length(captured_phone) between 1 and 40),
  captured_email text check (char_length(captured_email) between 3 and 254),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (agent_id, organization_id)
    references public.agents (id, organization_id),
  foreign key (contact_id, organization_id)
    references public.contacts (id, organization_id) on delete cascade,
  foreign key (conversation_id, organization_id)
    references public.conversations (id, organization_id) on delete set null (conversation_id)
);

create index leads_org_created_idx on public.leads (organization_id, created_at desc);
create index leads_contact_id_idx on public.leads (contact_id);
-- Duplicate-lead protection: one lead per conversation (repeat captures update it).
create unique index leads_conversation_key
  on public.leads (conversation_id) where conversation_id is not null;

create trigger leads_touch_updated_at
  before update on public.leads
  for each row execute function app_private.touch_updated_at();

-- Tool audit log: every tool request, including rejected ones.
create table public.tool_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  agent_id uuid not null,
  conversation_id uuid,
  channel text not null check (channel in ('web_chat')),
  tool_name text not null check (char_length(tool_name) between 1 and 64),
  provider_call_id text check (char_length(provider_call_id) <= 128),
  status text not null check (status in ('running', 'succeeded', 'failed', 'rejected')),
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  error_code text check (char_length(error_code) <= 64),
  error_message text check (char_length(error_message) <= 1000),
  idempotency_key text check (char_length(idempotency_key) <= 128),
  -- True when an identical earlier run was replayed instead of executing the side effect again.
  replayed boolean not null default false,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer check (duration_ms >= 0),
  unique (id, organization_id),
  foreign key (agent_id, organization_id)
    references public.agents (id, organization_id),
  foreign key (conversation_id, organization_id)
    references public.conversations (id, organization_id) on delete set null (conversation_id)
);

create index tool_runs_conversation_idx on public.tool_runs (conversation_id, started_at);
create index tool_runs_org_started_idx on public.tool_runs (organization_id, started_at desc);
create index tool_runs_idempotency_idx
  on public.tool_runs (organization_id, idempotency_key) where idempotency_key is not null;

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  conversation_id uuid not null,
  role text not null check (role in ('user', 'assistant', 'tool_call', 'tool_result', 'system')),
  content text not null default '' check (char_length(content) <= 20000),
  tool_name text check (char_length(tool_name) <= 64),
  tool_call_id text check (char_length(tool_call_id) <= 128),
  tool_run_id uuid,
  -- Compact structured payload (tool arguments / minimal result, flags). Never raw provider payloads.
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  created_at timestamptz not null default now(),
  check ((role in ('tool_call', 'tool_result')) = (tool_name is not null)),
  foreign key (conversation_id, organization_id)
    references public.conversations (id, organization_id) on delete cascade,
  foreign key (tool_run_id, organization_id)
    references public.tool_runs (id, organization_id) on delete set null (tool_run_id)
);

create index messages_conversation_seq_idx on public.messages (conversation_id, seq);

-- ---------------------------------------------------------------------------
-- Rate limiting (system table, not exposed through the Data API)
-- ---------------------------------------------------------------------------

create table app_private.rate_limit_buckets (
  bucket_key text not null check (char_length(bucket_key) <= 200),
  window_start timestamptz not null,
  hits integer not null default 0 check (hits >= 0),
  primary key (bucket_key, window_start)
);

create index rate_limit_buckets_window_idx on app_private.rate_limit_buckets (window_start);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.agent_channels enable row level security;
alter table public.knowledge_sources enable row level security;
alter table public.knowledge_documents enable row level security;
alter table public.knowledge_chunks enable row level security;
alter table public.contacts enable row level security;
alter table public.conversations enable row level security;
alter table public.leads enable row level security;
alter table public.tool_runs enable row level security;
alter table public.messages enable row level security;
alter table app_private.rate_limit_buckets enable row level security;

revoke all on table
  public.agent_channels,
  public.knowledge_sources,
  public.knowledge_documents,
  public.knowledge_chunks,
  public.contacts,
  public.conversations,
  public.leads,
  public.tool_runs,
  public.messages
from anon, authenticated;
revoke all on table app_private.rate_limit_buckets from anon, authenticated;

-- Widget keys are a global namespace: only the server generates them (channel creation and key rotation run in
-- service scope after the owner/admin check). API roles may toggle a channel but never choose its key, so a
-- tenant can never claim another tenant's retired key.
grant select, delete on table public.agent_channels to authenticated;
grant update (enabled, config) on table public.agent_channels to authenticated;
grant select, insert, update, delete on table
  public.knowledge_sources,
  public.knowledge_documents,
  public.knowledge_chunks
to authenticated;
-- Conversation records are written by the agent runtime (server) only.
grant select on table
  public.contacts,
  public.conversations,
  public.leads,
  public.tool_runs,
  public.messages
to authenticated;

-- Configuration/knowledge: members read, owners/admins write.
create policy agent_channels_select on public.agent_channels
  for select to authenticated
  using (organization_id in (select app_private.user_organization_ids()));
create policy agent_channels_update on public.agent_channels
  for update to authenticated
  using (organization_id in (select app_private.user_admin_organization_ids()))
  with check (organization_id in (select app_private.user_admin_organization_ids()));
create policy agent_channels_delete on public.agent_channels
  for delete to authenticated
  using (organization_id in (select app_private.user_admin_organization_ids()));

create policy knowledge_sources_select on public.knowledge_sources
  for select to authenticated
  using (organization_id in (select app_private.user_organization_ids()));
create policy knowledge_sources_insert on public.knowledge_sources
  for insert to authenticated
  with check (organization_id in (select app_private.user_admin_organization_ids()));
create policy knowledge_sources_update on public.knowledge_sources
  for update to authenticated
  using (organization_id in (select app_private.user_admin_organization_ids()))
  with check (organization_id in (select app_private.user_admin_organization_ids()));
create policy knowledge_sources_delete on public.knowledge_sources
  for delete to authenticated
  using (organization_id in (select app_private.user_admin_organization_ids()));

create policy knowledge_documents_select on public.knowledge_documents
  for select to authenticated
  using (organization_id in (select app_private.user_organization_ids()));
create policy knowledge_documents_insert on public.knowledge_documents
  for insert to authenticated
  with check (organization_id in (select app_private.user_admin_organization_ids()));
create policy knowledge_documents_update on public.knowledge_documents
  for update to authenticated
  using (organization_id in (select app_private.user_admin_organization_ids()))
  with check (organization_id in (select app_private.user_admin_organization_ids()));
create policy knowledge_documents_delete on public.knowledge_documents
  for delete to authenticated
  using (organization_id in (select app_private.user_admin_organization_ids()));

create policy knowledge_chunks_select on public.knowledge_chunks
  for select to authenticated
  using (organization_id in (select app_private.user_organization_ids()));
create policy knowledge_chunks_insert on public.knowledge_chunks
  for insert to authenticated
  with check (organization_id in (select app_private.user_admin_organization_ids()));
create policy knowledge_chunks_update on public.knowledge_chunks
  for update to authenticated
  using (organization_id in (select app_private.user_admin_organization_ids()))
  with check (organization_id in (select app_private.user_admin_organization_ids()));
create policy knowledge_chunks_delete on public.knowledge_chunks
  for delete to authenticated
  using (organization_id in (select app_private.user_admin_organization_ids()));

-- Operational records: members read.
create policy contacts_select on public.contacts
  for select to authenticated
  using (organization_id in (select app_private.user_organization_ids()));
create policy conversations_select on public.conversations
  for select to authenticated
  using (organization_id in (select app_private.user_organization_ids()));
create policy leads_select on public.leads
  for select to authenticated
  using (organization_id in (select app_private.user_organization_ids()));
create policy tool_runs_select on public.tool_runs
  for select to authenticated
  using (organization_id in (select app_private.user_organization_ids()));
create policy messages_select on public.messages
  for select to authenticated
  using (organization_id in (select app_private.user_organization_ids()));
