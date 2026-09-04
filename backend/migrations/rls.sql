-- rls.sql
-- RLS security configuration
--
-- Backend filters by owner explicitly on every query; RLS is simply a precaution

begin;

alter table public.agent_types   enable row level security;
alter table public.projects      enable row level security;
alter table public.conversations enable row level security;
alter table public.messages      enable row level security;

-- Force RLS for table owners too, so a mistakenly owner-privileged connection
-- does not silently bypass every policy below. Note this does NOT constrain
-- service_role, which is BYPASSRLS: anything using the service key ignores all
-- of this and must rely on the backend's explicit owner filtering.
alter table public.projects      force row level security;
alter table public.conversations force row level security;
alter table public.messages      force row level security;


-- ---------------------------------------------------------------------------
-- agent_types: a public, read-only catalog.
--
-- No INSERT/UPDATE/DELETE policies. 
-- Agent_type seed in the SQL editor as postgres/service_role, which bypasses RLS.
-- ---------------------------------------------------------------------------
drop policy if exists agent_types_select on public.agent_types;
create policy agent_types_select
  on public.agent_types
  for select
  to authenticated
  using (is_active);


-- ---------------------------------------------------------------------------
-- projects
-- Index support: projects_owner_id_created_at_idx serves the predicate directly.
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
  -- The WITH CHECK blocks re-assigning a project to another user.
  with check (owner_id = (select auth.uid()));

drop policy if exists projects_delete on public.projects;
create policy projects_delete
  on public.projects
  for delete
  to authenticated
  using (owner_id = (select auth.uid()));


-- ---------------------------------------------------------------------------
-- conversations
-- Index support: conversations_owner_id_idx.
--
-- INSERT checks the parent PROJECT rather than the supplied owner_id, because
-- owner_id is trigger-assigned and so not yet trustworthy at check time. That
-- EXISTS hits projects' primary key once per inserted row (one row per
-- request), so it is a single index probe, not an N+1.
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
      from public.projects p
      where p.id = conversations.project_id
        and p.owner_id = (select auth.uid())
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
-- messages -- the hot table.
--
-- SELECT/DELETE use the denormalised owner_id: a bare indexed equality against
-- a column already on the row. Combined with messages_conversation_id_seq_idx,
-- replaying a conversation is one ordered index scan plus a cheap filter.
--
-- INSERT alone pays one EXISTS against conversations' primary key, for the same
-- reason as conversations above.
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

-- Messages are an append-only transcript, so there is deliberately no UPDATE
-- policy. The one legitimate mutation -- marking an assistant turn failed -- is
-- done by the backend at INSERT time, not by editing history.

drop policy if exists messages_delete on public.messages;
create policy messages_delete
  on public.messages
  for delete
  to authenticated
  using (owner_id = (select auth.uid()));

commit;
