-- rls.sql
-- Row Level Security. Apply after init.sql.
--
-- The backend filters by owner as well; these policies are the backstop.
--
-- Use `(select auth.uid())`, not bare `auth.uid()` -- the subquery is
-- evaluated once per query instead of once per row.

begin;

alter table public.agent_types   enable row level security;
alter table public.tool_types    enable row level security;
alter table public.projects      enable row level security;
alter table public.nodes         enable row level security;
alter table public.node_secrets  enable row level security;
alter table public.edges         enable row level security;
alter table public.conversations enable row level security;
alter table public.messages      enable row level security;

-- Force RLS for table owners too. Does not cover service_role, which is
-- BYPASSRLS -- anything using the service key relies on backend filtering.
alter table public.projects      force row level security;
alter table public.nodes         force row level security;
alter table public.node_secrets  force row level security;
alter table public.edges         force row level security;
alter table public.conversations force row level security;
alter table public.messages      force row level security;


-- ---------------------------------------------------------------------------
-- Catalogs: public, read-only.
-- No write policies, so writes are refused. Seeding runs as postgres.
-- ---------------------------------------------------------------------------
drop policy if exists agent_types_select on public.agent_types;
create policy agent_types_select
  on public.agent_types
  for select
  to authenticated
  using (is_active);

drop policy if exists tool_types_select on public.tool_types;
create policy tool_types_select
  on public.tool_types
  for select
  to authenticated
  using (is_active);


-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------
drop policy if exists projects_select on public.projects;
create policy projects_select
  on public.projects
  for select
  to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists projects_insert on public.projects;
create policy projects_insert
  on public.projects
  for insert
  to authenticated
  with check (owner_id = (select auth.uid()));

drop policy if exists projects_update on public.projects;
create policy projects_update
  on public.projects
  for update
  to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

drop policy if exists projects_delete on public.projects;
create policy projects_delete
  on public.projects
  for delete
  to authenticated
  using (owner_id = (select auth.uid()));


-- ---------------------------------------------------------------------------
-- nodes: the boxes.
-- INSERT checks the parent project, since owner_id is trigger-assigned and
-- not yet trustworthy at check time.
-- ---------------------------------------------------------------------------
drop policy if exists nodes_select on public.nodes;
create policy nodes_select
  on public.nodes
  for select
  to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists nodes_insert on public.nodes;
create policy nodes_insert
  on public.nodes
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.projects p
      where p.id = nodes.project_id
        and p.owner_id = (select auth.uid())
    )
  );

drop policy if exists nodes_update on public.nodes;
create policy nodes_update
  on public.nodes
  for update
  to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

drop policy if exists nodes_delete on public.nodes;
create policy nodes_delete
  on public.nodes
  for delete
  to authenticated
  using (owner_id = (select auth.uid()));


-- ---------------------------------------------------------------------------
-- node_secrets: tool credentials.
-- ---------------------------------------------------------------------------
drop policy if exists node_secrets_select on public.node_secrets;
create policy node_secrets_select
  on public.node_secrets
  for select
  to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists node_secrets_insert on public.node_secrets;
create policy node_secrets_insert
  on public.node_secrets
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.nodes n
      where n.id = node_secrets.node_id
        and n.owner_id = (select auth.uid())
    )
  );

drop policy if exists node_secrets_update on public.node_secrets;
create policy node_secrets_update
  on public.node_secrets
  for update
  to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

drop policy if exists node_secrets_delete on public.node_secrets;
create policy node_secrets_delete
  on public.node_secrets
  for delete
  to authenticated
  using (owner_id = (select auth.uid()));


-- ---------------------------------------------------------------------------
-- edges: the arrows.
-- INSERT checks the source node; a trigger in init.sql also refuses edges
-- spanning two projects. UPDATE is for refreshing a stale summary.
-- ---------------------------------------------------------------------------
drop policy if exists edges_select on public.edges;
create policy edges_select
  on public.edges
  for select
  to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists edges_insert on public.edges;
create policy edges_insert
  on public.edges
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.nodes n
      where n.id = edges.source_node_id
        and n.owner_id = (select auth.uid())
    )
  );

drop policy if exists edges_update on public.edges;
create policy edges_update
  on public.edges
  for update
  to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

drop policy if exists edges_delete on public.edges;
create policy edges_delete
  on public.edges
  for delete
  to authenticated
  using (owner_id = (select auth.uid()));


-- ---------------------------------------------------------------------------
-- conversations
-- ---------------------------------------------------------------------------
drop policy if exists conversations_select on public.conversations;
create policy conversations_select
  on public.conversations
  for select
  to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists conversations_insert on public.conversations;
create policy conversations_insert
  on public.conversations
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.nodes n
      where n.id = conversations.node_id
        and n.owner_id = (select auth.uid())
    )
  );

drop policy if exists conversations_update on public.conversations;
create policy conversations_update
  on public.conversations
  for update
  to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

drop policy if exists conversations_delete on public.conversations;
create policy conversations_delete
  on public.conversations
  for delete
  to authenticated
  using (owner_id = (select auth.uid()));


-- ---------------------------------------------------------------------------
-- messages.
-- UPDATE is only so a turn suspended on tool approval can be completed in
-- place. The transcript is otherwise append-only.
-- ---------------------------------------------------------------------------
drop policy if exists messages_select on public.messages;
create policy messages_select
  on public.messages
  for select
  to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists messages_insert on public.messages;
create policy messages_insert
  on public.messages
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.conversations c
      where c.id = messages.conversation_id
        and c.owner_id = (select auth.uid())
    )
  );

drop policy if exists messages_update on public.messages;
create policy messages_update
  on public.messages
  for update
  to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

drop policy if exists messages_delete on public.messages;
create policy messages_delete
  on public.messages
  for delete
  to authenticated
  using (owner_id = (select auth.uid()));

commit;
