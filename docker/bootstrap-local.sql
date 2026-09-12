begin;

insert into workspaces(id, name)
values ((:'workspace_id')::uuid, 'Local Meet Agent Workspace')
on conflict (id) do nothing;

insert into app_users(id, email, display_name)
values ((:'user_id')::uuid, :'user_email', 'Local Meet Agent User')
on conflict (id) do update set email = excluded.email;

insert into workspace_members(workspace_id, user_id, role)
values ((:'workspace_id')::uuid, (:'user_id')::uuid, 'owner')
on conflict (workspace_id, user_id) do nothing;

commit;
