begin;

insert into workspaces(id, name) values
  ('00000000-0000-0000-0000-000000000001', 'Meet Agent Demo')
on conflict (id) do nothing;

insert into app_users(id, email, display_name) values
  ('00000000-0000-0000-0000-000000000002', 'ana@example.com', 'Ana'),
  ('00000000-0000-0000-0000-000000000003', 'bob@example.com', 'Bob')
on conflict (id) do nothing;

insert into workspace_members(workspace_id, user_id, role) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'owner'),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000003', 'member')
on conflict do nothing;

insert into meetings(id, workspace_id, title, started_at, ended_at, participants, status, created_by)
values (
  '10000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  'Planeación anterior',
  '2026-09-05T15:00:00Z',
  '2026-09-05T16:00:00Z',
  '["Ana","Rodrigo"]'::jsonb,
  'ended',
  '00000000-0000-0000-0000-000000000002'
) on conflict (id) do nothing;

insert into transcript_segments(id, meeting_id, sequence, speaker_id, text, ended_at, is_final)
values (
  '20000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  1,
  'Ana',
  'Ana entregará el informe el viernes.',
  '2026-09-05T15:15:00Z',
  true
) on conflict (meeting_id, sequence) do nothing;

insert into memory_nodes(
  id, workspace_id, project_id, content, summary, status, confidence,
  importance, observed_at, valid_from, created_by, metadata
) values (
  '30000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  'meet-ai',
  'Ana entregará el informe el viernes.',
  'La entrega del informe está prevista para el viernes.',
  'confirmed', 0.94, 0.85,
  '2026-09-05T15:15:00Z', '2026-09-05T15:15:00Z',
  'memory-curator',
  '{"semanticHint":"commitment","stage":"confirmed","relatedEntities":["Ana","informe"]}'::jsonb
) on conflict (id) do nothing;

insert into memory_sources(
  memory_id, source_type, source_id, meeting_id, transcript_segment_id,
  quoted_text, observed_at, permissions_snapshot
) values (
  '30000000-0000-0000-0000-000000000001',
  'transcript_segment',
  '20000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  'Ana entregará el informe el viernes.',
  '2026-09-05T15:15:00Z',
  '{"visibility":"workspace"}'::jsonb
) on conflict (memory_id, source_type, source_id) do nothing;

commit;
