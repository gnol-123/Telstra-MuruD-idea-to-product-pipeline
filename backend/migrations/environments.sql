-- Environments: the edge validation branch, one scratch space per project,
-- the config shape, and backfills so projects that predate this feature get
-- a scratch space and every agent gets an edge to it.
-- Apply after oauth.sql.
begin;

-- ---------------------------------------------------------------------------
-- tools.sql added the context and tool branches to edges_validate; this adds
-- environment (environment -> agent). The whole body is restated because
-- create or replace swaps the entire function.
-- ---------------------------------------------------------------------------
create or replace function public.edges_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  src_project uuid;
  src_owner   uuid;
  src_kind    text;
  tgt_project uuid;
  tgt_kind    text;
begin
  select n.project_id, n.owner_id, n.kind into src_project, src_owner, src_kind
  from public.nodes n where n.id = new.source_node_id;

  select n.project_id, n.kind into tgt_project, tgt_kind
  from public.nodes n where n.id = new.target_node_id;

  if src_project is null or tgt_project is null then
    raise exception 'edge endpoints must exist'
      using errcode = 'foreign_key_violation';
  end if;

  if src_project <> tgt_project then
    raise exception 'edge endpoints must belong to the same project'
      using errcode = 'check_violation';
  end if;

  if new.kind = 'context' and (src_kind <> 'agent' or tgt_kind <> 'agent') then
    raise exception 'context edges run agent to agent, not % to %', src_kind, tgt_kind
      using errcode = 'check_violation';
  end if;

  if new.kind = 'tool' and (src_kind <> 'tool' or tgt_kind <> 'agent') then
    raise exception 'tool edges run tool to agent, not % to %', src_kind, tgt_kind
      using errcode = 'check_violation';
  end if;

  if new.kind = 'environment' and (src_kind <> 'environment' or tgt_kind <> 'agent') then
    raise exception 'environment edges run environment to agent, not % to %', src_kind, tgt_kind
      using errcode = 'check_violation';
  end if;

  new.project_id := src_project;
  new.owner_id   := src_owner;
  return new;
end;
$$;


-- One scratch environment per project. A concurrent double create fails
-- loudly here rather than leaving two.
create unique index if not exists nodes_one_scratch_per_project
  on public.nodes (project_id)
  where kind = 'environment' and (config->>'role') = 'scratch';


-- An environment node carries its identity in config, so the shape is checked
-- here rather than by a foreign key to a catalog table.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'nodes_environment_config_valid'
  ) then
    alter table public.nodes add constraint nodes_environment_config_valid check (
      kind <> 'environment' or (
        (config->>'runtime') in ('e2b', 'local')
        and (config->>'role') in ('scratch', 'user')
      )
    );
  end if;
end
$$;


-- Backfill: a scratch node for every live project that lacks one.
-- owner_id is overwritten by nodes_sync_owner; supplied to satisfy not null.
insert into public.nodes (project_id, owner_id, kind, name, config, tool_policy, status)
select
  p.id,
  p.owner_id,
  'environment',
  'Scratch Space',
  jsonb_build_object(
    'runtime', 'e2b',
    'role', 'scratch',
    'sandbox_id', null,
    'template', 'base',
    'idle_timeout_s', 300,
    'preview_ports', '[]'::jsonb
  ),
  'auto',
  'pending'
from public.projects p
where p.archived_at is null
  and not exists (
    select 1 from public.nodes n
    where n.project_id = p.id
      and n.kind = 'environment'
      and (n.config->>'role') = 'scratch'
  );


-- Backfill: an environment edge from each project's scratch node to each of
-- its agents. edges_validate fills project_id and owner_id.
insert into public.edges (project_id, owner_id, source_node_id, target_node_id, kind)
select a.project_id, a.owner_id, s.id, a.id, 'environment'
from public.nodes a
join public.nodes s
  on s.project_id = a.project_id
 and s.kind = 'environment'
 and (s.config->>'role') = 'scratch'
where a.kind = 'agent'
on conflict (source_node_id, target_node_id, kind) do nothing;

commit;
