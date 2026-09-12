begin;

create table if not exists google_oauth_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references app_users(id) on delete cascade,
  provider text not null default 'google',
  token_ciphertext text not null,
  token_iv text not null,
  token_auth_tag text not null,
  scopes text[] not null default '{}',
  expiry_date bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, user_id, provider)
);

alter table google_oauth_connections enable row level security;
drop policy if exists google_oauth_connections_tenant_policy on google_oauth_connections;
create policy google_oauth_connections_tenant_policy on google_oauth_connections
  using (app_has_workspace_access(workspace_id) and user_id::text = current_setting('app.user_id', true))
  with check (app_has_workspace_access(workspace_id) and user_id::text = current_setting('app.user_id', true));

commit;
