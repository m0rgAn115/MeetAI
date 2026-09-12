begin;

-- Durable, developer-facing history for changes to the memory graph and for
-- retrievals, which cannot be observed by database row triggers.
create table if not exists memory_activity_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  event_type text not null,
  resource_type text not null,
  resource_id text,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists memory_activity_events_workspace_time_idx
  on memory_activity_events(workspace_id, occurred_at desc);
create index if not exists memory_activity_events_resource_idx
  on memory_activity_events(resource_type, resource_id, occurred_at desc);

create or replace function record_memory_graph_activity()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  event_workspace uuid;
  event_type_value text;
  resource_type_value text := tg_table_name;
  resource_id_value text;
  event_payload jsonb;
begin
  if tg_table_name = 'memory_nodes' then
    event_workspace := coalesce(new.workspace_id, old.workspace_id);
    resource_id_value := coalesce(new.id, old.id)::text;
    if tg_op = 'INSERT' then event_type_value := 'memory.created';
    elsif new.status = 'superseded' and old.status is distinct from new.status then event_type_value := 'memory.superseded';
    elsif new.status = 'confirmed' and old.status is distinct from new.status then event_type_value := 'memory.confirmed';
    elsif new.embedding is distinct from old.embedding then event_type_value := 'memory.embedding_updated';
    else event_type_value := 'memory.updated';
    end if;
  elsif tg_table_name = 'memory_edges' then
    event_workspace := coalesce(new.workspace_id, old.workspace_id);
    resource_id_value := coalesce(new.id, old.id)::text;
    event_type_value := case tg_op when 'INSERT' then 'edge.created' when 'DELETE' then 'edge.deleted' else 'edge.updated' end;
  else
    select workspace_id into event_workspace from memory_nodes where id = coalesce(new.memory_id, old.memory_id);
    resource_id_value := coalesce(new.id, old.id)::text;
    event_type_value := case tg_op when 'INSERT' then 'source.created' when 'DELETE' then 'source.deleted' else 'source.updated' end;
  end if;

  event_payload := jsonb_strip_nulls(jsonb_build_object(
    'operation', tg_op,
    'before', case when tg_op = 'INSERT' then null else to_jsonb(old) - 'embedding' end,
    'after', case when tg_op = 'DELETE' then null else to_jsonb(new) - 'embedding' end
  ));
  insert into memory_activity_events(workspace_id, event_type, resource_type, resource_id, payload)
    values(event_workspace, event_type_value, resource_type_value, resource_id_value, event_payload);
  return coalesce(new, old);
end;
$$;

drop trigger if exists memory_nodes_activity_trigger on memory_nodes;
create trigger memory_nodes_activity_trigger
after insert or update or delete on memory_nodes
for each row execute function record_memory_graph_activity();
drop trigger if exists memory_edges_activity_trigger on memory_edges;
create trigger memory_edges_activity_trigger
after insert or update or delete on memory_edges
for each row execute function record_memory_graph_activity();
drop trigger if exists memory_sources_activity_trigger on memory_sources;
create trigger memory_sources_activity_trigger
after insert or update or delete on memory_sources
for each row execute function record_memory_graph_activity();

create or replace function notify_memory_activity()
returns trigger language plpgsql as $$
begin
  perform pg_notify('memory_activity', new.id::text);
  return new;
end;
$$;

drop trigger if exists memory_activity_notify_trigger on memory_activity_events;
create trigger memory_activity_notify_trigger
after insert on memory_activity_events
for each row execute function notify_memory_activity();

alter table memory_activity_events enable row level security;
drop policy if exists memory_activity_events_tenant_policy on memory_activity_events;
create policy memory_activity_events_tenant_policy on memory_activity_events
  using (app_has_workspace_access(workspace_id))
  with check (app_has_workspace_access(workspace_id));

commit;
