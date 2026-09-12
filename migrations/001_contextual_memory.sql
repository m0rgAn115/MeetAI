begin;

create extension if not exists pgcrypto;
create extension if not exists vector;

create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  display_name text,
  created_at timestamptz not null default now()
);

create table if not exists workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references app_users(id) on delete cascade,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists meetings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  title text not null default 'Google Meet',
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  participants jsonb not null default '[]'::jsonb,
  status text not null default 'active',
  rolling_summary text not null default '',
  live_state jsonb not null default '{"currentTopic":null,"activeDecisions":[],"commitments":[],"openQuestions":[],"referencedDocuments":[],"participants":[],"relevantEntities":[],"rollingSummary":""}'::jsonb,
  intervention_count integer not null default 0,
  created_by uuid references app_users(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists transcript_segments (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references meetings(id) on delete cascade,
  sequence bigint not null,
  speaker_id text,
  text text not null,
  started_at timestamptz,
  ended_at timestamptz,
  is_final boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (meeting_id, sequence)
);

create table if not exists memory_nodes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id text,
  content text not null,
  summary text not null,
  embedding vector(1536),
  status text not null default 'active',
  confidence real not null check (confidence between 0 and 1),
  importance real not null check (importance between 0 and 1),
  observed_at timestamptz not null,
  valid_from timestamptz,
  valid_until timestamptz,
  created_by text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists memory_edges (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  from_memory_id uuid not null references memory_nodes(id) on delete cascade,
  to_memory_id uuid not null references memory_nodes(id) on delete cascade,
  relation_label text not null,
  explanation text not null default '',
  confidence real not null check (confidence between 0 and 1),
  valid_from timestamptz,
  valid_until timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (workspace_id, from_memory_id, to_memory_id, relation_label)
);

create table if not exists memory_sources (
  id uuid primary key default gen_random_uuid(),
  memory_id uuid not null references memory_nodes(id) on delete cascade,
  source_type text not null,
  source_id text not null,
  meeting_id uuid references meetings(id) on delete set null,
  transcript_segment_id uuid references transcript_segments(id) on delete set null,
  document_uri text,
  quoted_text text not null,
  observed_at timestamptz not null,
  permissions_snapshot jsonb not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (memory_id, source_type, source_id)
);

create table if not exists meeting_signals (
  id text primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  meeting_id uuid not null references meetings(id) on delete cascade,
  segment_sequence bigint not null,
  signal_type text not null,
  payload jsonb not null,
  confidence real not null,
  urgency real not null,
  novelty real not null,
  evidence_segment_ids jsonb not null default '[]'::jsonb,
  related_entities jsonb not null default '[]'::jsonb,
  should_retrieve_context boolean not null default false,
  retrieval_query text,
  correlation_id text not null,
  reaction text,
  feedback jsonb,
  created_at timestamptz not null default now()
);

create table if not exists proposed_actions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  meeting_id uuid not null references meetings(id) on delete cascade,
  memory_id uuid references memory_nodes(id) on delete set null,
  action_type text not null,
  proposal jsonb not null,
  preview jsonb not null,
  status text not null default 'awaiting_confirmation',
  confirmed_by uuid references app_users(id),
  confirmed_at timestamptz,
  idempotency_key text not null,
  result jsonb,
  error text,
  execution_evidence jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key)
);

create table if not exists memory_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  meeting_id uuid references meetings(id) on delete cascade,
  event_type text not null,
  correlation_id text not null,
  idempotency_key text not null,
  payload jsonb not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (workspace_id, idempotency_key)
);

create table if not exists mutation_batches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  correlation_id text not null,
  idempotency_key text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key)
);

create index if not exists transcript_segments_meeting_sequence_idx
  on transcript_segments(meeting_id, sequence desc);
create index if not exists memory_nodes_workspace_valid_idx
  on memory_nodes(workspace_id, status, valid_until);
create index if not exists memory_nodes_text_idx
  on memory_nodes using gin(to_tsvector('simple', content || ' ' || summary));
create index if not exists memory_nodes_embedding_idx
  on memory_nodes using hnsw (embedding vector_cosine_ops);
create index if not exists memory_edges_from_idx on memory_edges(workspace_id, from_memory_id);
create index if not exists memory_edges_to_idx on memory_edges(workspace_id, to_memory_id);
create index if not exists memory_sources_memory_idx on memory_sources(memory_id);
create index if not exists memory_jobs_pending_idx on memory_jobs(status, available_at);

alter table meetings enable row level security;
alter table transcript_segments enable row level security;
alter table memory_nodes enable row level security;
alter table memory_edges enable row level security;
alter table memory_sources enable row level security;
alter table meeting_signals enable row level security;
alter table proposed_actions enable row level security;

create or replace function app_has_workspace_access(target_workspace uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from workspace_members wm
    where wm.workspace_id = target_workspace
      and wm.user_id::text = nullif(current_setting('app.user_id', true), '')
  );
$$;

drop policy if exists meetings_tenant_policy on meetings;
create policy meetings_tenant_policy on meetings
  using (app_has_workspace_access(workspace_id))
  with check (app_has_workspace_access(workspace_id));
drop policy if exists transcript_segments_tenant_policy on transcript_segments;
create policy transcript_segments_tenant_policy on transcript_segments
  using (exists (select 1 from meetings m where m.id = meeting_id and app_has_workspace_access(m.workspace_id)))
  with check (exists (select 1 from meetings m where m.id = meeting_id and app_has_workspace_access(m.workspace_id)));
drop policy if exists memory_nodes_tenant_policy on memory_nodes;
create policy memory_nodes_tenant_policy on memory_nodes
  using (app_has_workspace_access(workspace_id))
  with check (app_has_workspace_access(workspace_id));
drop policy if exists memory_edges_tenant_policy on memory_edges;
create policy memory_edges_tenant_policy on memory_edges
  using (app_has_workspace_access(workspace_id))
  with check (app_has_workspace_access(workspace_id));
drop policy if exists memory_sources_acl_policy on memory_sources;
create policy memory_sources_acl_policy on memory_sources
  using (
    exists (
      select 1 from memory_nodes n
      where n.id = memory_id
        and app_has_workspace_access(n.workspace_id)
        and (
          coalesce(permissions_snapshot->>'visibility', 'workspace') = 'workspace'
          or coalesce(permissions_snapshot->'allowedUserIds', '[]'::jsonb)
             ? current_setting('app.user_id', true)
        )
    )
  );
drop policy if exists meeting_signals_tenant_policy on meeting_signals;
create policy meeting_signals_tenant_policy on meeting_signals
  using (app_has_workspace_access(workspace_id))
  with check (app_has_workspace_access(workspace_id));
drop policy if exists proposed_actions_tenant_policy on proposed_actions;
create policy proposed_actions_tenant_policy on proposed_actions
  using (app_has_workspace_access(workspace_id))
  with check (app_has_workspace_access(workspace_id));

commit;
