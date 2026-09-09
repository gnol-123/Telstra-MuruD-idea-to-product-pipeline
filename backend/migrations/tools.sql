-- Tools: per-call audit, the approval pause, and vault-backed secrets.
-- Apply after init.sql and rls.sql.
begin;

-- ---------------------------------------------------------------------------
-- tool_calls: one row per tool invocation. Serves the audit log, the
-- per-call status endpoint, and the parking space for a pending approval.
-- ---------------------------------------------------------------------------
create table if not exists public.tool_calls (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects (id)      on delete cascade,
  owner_id        uuid not null references auth.users (id)           on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  agent_node_id   uuid not null references public.nodes (id)         on delete cascade,
  tool_node_id    uuid not null references public.nodes (id)         on delete cascade,
  -- The model's own id for the call. Resume keys on it.
  tool_call_id    text not null,
  tool_name       text not null,
  arguments       jsonb not null default '{}'::jsonb,
  status          text not null,
  result          text,
  error           text,
  duration_ms     integer,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint tool_calls_status_valid
    check (status in ('pending_approval', 'running', 'ok', 'error', 'denied')),
  -- A resumed run must not record the same call twice.
  constraint tool_calls_unique_call
    unique (conversation_id, tool_call_id),
  constraint tool_calls_duration_sane
    check (duration_ms is null or duration_ms >= 0)
);

create index if not exists tool_calls_tool_node_id_idx
  on public.tool_calls (tool_node_id, created_at desc);
create index if not exists tool_calls_conversation_status_idx
  on public.tool_calls (conversation_id, status);
create index if not exists tool_calls_owner_id_idx on public.tool_calls (owner_id);

drop trigger if exists tool_calls_set_updated_at on public.tool_calls;
create trigger tool_calls_set_updated_at
  before update on public.tool_calls
  for each row execute function public.set_updated_at();

-- owner_id always comes from the parent project, never the client. Also
-- confirms conversation_id, agent_node_id and tool_node_id sit on the same
-- project, so a row cannot be repointed at another tenant's records.
create or replace function public.tool_calls_sync_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  project_owner   uuid;
  conv_project    uuid;
  agent_project   uuid;
  tool_project    uuid;
begin
  select p.owner_id into project_owner
  from public.projects p
  where p.id = new.project_id;

  if project_owner is null then
    raise exception 'project % not found', new.project_id
      using errcode = 'foreign_key_violation';
  end if;

  select c.project_id into conv_project
  from public.conversations c
  where c.id = new.conversation_id;

  select n.project_id into agent_project
  from public.nodes n
  where n.id = new.agent_node_id;

  select n.project_id into tool_project
  from public.nodes n
  where n.id = new.tool_node_id;

  if conv_project is null or agent_project is null or tool_project is null then
    raise exception 'tool call references must exist'
      using errcode = 'foreign_key_violation';
  end if;

  if conv_project <> new.project_id
     or agent_project <> new.project_id
     or tool_project <> new.project_id then
    raise exception 'tool call references must belong to the same project'
      using errcode = 'foreign_key_violation';
  end if;

  new.owner_id := project_owner;
  return new;
end;
$$;

drop trigger if exists tool_calls_sync_owner_trg on public.tool_calls;
create trigger tool_calls_sync_owner_trg
  before insert or update of
    project_id, owner_id, conversation_id, agent_node_id, tool_node_id
  on public.tool_calls
  for each row execute function public.tool_calls_sync_owner();

alter table public.tool_calls enable row level security;
alter table public.tool_calls force row level security;

drop policy if exists tool_calls_select_own on public.tool_calls;
create policy tool_calls_select_own on public.tool_calls
  for select to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists tool_calls_insert_own on public.tool_calls;
create policy tool_calls_insert_own on public.tool_calls
  for insert to authenticated
  with check (
    exists (
      select 1 from public.projects p
      where p.id = project_id and p.owner_id = (select auth.uid())
    )
  );

drop policy if exists tool_calls_update_own on public.tool_calls;
create policy tool_calls_update_own on public.tool_calls
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

drop policy if exists tool_calls_delete_own on public.tool_calls;
create policy tool_calls_delete_own on public.tool_calls
  for delete to authenticated
  using (owner_id = (select auth.uid()));


-- ---------------------------------------------------------------------------
-- The approval pause. `messages` stores plain text and cannot round-trip a
-- model response carrying tool call parts, so the history is parked here.
-- ---------------------------------------------------------------------------
alter table public.conversations
  add column if not exists pending_run    jsonb,
  add column if not exists pending_run_at timestamptz;


-- ---------------------------------------------------------------------------
-- Secrets move into Supabase Vault. node_secrets becomes a pointer table:
-- ciphertext lives in vault.secrets, whose key is held outside it.
-- ---------------------------------------------------------------------------
alter table public.node_secrets add column if not exists vault_secret_id uuid;
alter table public.node_secrets drop column if exists value;

-- Write a secret. The caller may set a key they can never read back.
create or replace function public.set_node_secret(
  p_node_id uuid,
  p_key     text,
  p_value   text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  node_owner  uuid;
  existing_id uuid;
  secret_name text;
begin
  select n.owner_id into node_owner
  from public.nodes n
  where n.id = p_node_id;

  if node_owner is null then
    raise exception 'node % not found', p_node_id
      using errcode = 'foreign_key_violation';
  end if;

  if node_owner <> auth.uid() then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  select ns.vault_secret_id into existing_id
  from public.node_secrets ns
  where ns.node_id = p_node_id and ns.key = p_key;

  secret_name := 'node:' || p_node_id::text || ':' || p_key;

  if existing_id is null then
    insert into public.node_secrets (node_id, owner_id, key, vault_secret_id)
    values (
      p_node_id,
      node_owner,
      p_key,
      vault.create_secret(p_value, secret_name, 'tool node secret')
    );
  else
    perform vault.update_secret(existing_id, p_value, secret_name, 'tool node secret');
    -- No-op on the value itself, but this keeps updated_at current via the trigger.
    update public.node_secrets
       set vault_secret_id = existing_id
     where node_id = p_node_id and key = p_key;
  end if;
end;
$$;

-- Read a secret. Deliberately granted to no one: the backend calls this
-- through the service role, after ownership has been checked under RLS.
create or replace function public.get_node_secret(
  p_node_id uuid,
  p_key     text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  secret_value text;
begin
  select ds.decrypted_secret into secret_value
  from public.node_secrets ns
  join vault.decrypted_secrets ds on ds.id = ns.vault_secret_id
  where ns.node_id = p_node_id and ns.key = p_key;

  return secret_value;
end;
$$;

revoke all on function public.set_node_secret(uuid, text, text) from public, anon;
grant execute on function public.set_node_secret(uuid, text, text) to authenticated;

revoke all on function public.get_node_secret(uuid, text) from public, anon, authenticated;
grant execute on function public.get_node_secret(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Vault cleanup. vault.secrets sits in another schema with no foreign key
-- back to node_secrets, so the cascade that removes a pointer row cannot
-- reach the ciphertext. This trigger deletes it, leaving no orphans behind
-- when a tool node is removed.
-- ---------------------------------------------------------------------------
create or replace function public.node_secrets_delete_vault_secret()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.vault_secret_id is not null then
    delete from vault.secrets where id = old.vault_secret_id;
  end if;
  return old;
end;
$$;

drop trigger if exists node_secrets_delete_vault_secret_trg on public.node_secrets;
create trigger node_secrets_delete_vault_secret_trg
  after delete on public.node_secrets
  for each row execute function public.node_secrets_delete_vault_secret();

-- Rotating a secret replaces the row's pointer. Drop the ciphertext the old
-- pointer referenced.
create or replace function public.node_secrets_replace_vault_secret()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.vault_secret_id is not null
     and old.vault_secret_id is distinct from new.vault_secret_id then
    delete from vault.secrets where id = old.vault_secret_id;
  end if;
  return new;
end;
$$;

drop trigger if exists node_secrets_replace_vault_secret_trg on public.node_secrets;
create trigger node_secrets_replace_vault_secret_trg
  after update of vault_secret_id on public.node_secrets
  for each row execute function public.node_secrets_replace_vault_secret();

-- ---------------------------------------------------------------------------
-- Seed the skill tool type. Instruction text an agent can load on demand,
-- needs no network and no credentials.
-- ---------------------------------------------------------------------------
insert into public.tool_types (slug, name, description, config_schema, secret_fields, sort_order)
values
  (
    'skill',
    'Skill',
    'Instruction text an agent can load on demand.',
    '{"fields": [
        {"key": "text", "label": "Instructions", "type": "textarea", "required": true},
        {"key": "description", "label": "When to use it", "type": "text", "required": false}
      ]}'::jsonb,
    array[]::text[],
    20
  )
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------------
-- Seed the MCP server tool type. Tools are whatever the remote server
-- reports at connect time, so config is just a URL and an optional token.
-- ---------------------------------------------------------------------------
insert into public.tool_types (slug, name, description, config_schema, secret_fields, sort_order)
values
  (
    'mcp_server',
    'MCP Server',
    'Connect to an MCP server and use whatever tools it offers.',
    '{"fields": [
        {"key": "url", "label": "Server URL", "type": "text", "required": true},
        {"key": "auth_token", "label": "Auth token", "type": "password", "required": false}
      ]}'::jsonb,
    array['auth_token'],
    30
  )
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------------
-- MCP service catalog.
--
-- Every row below resolves to the same `mcp_server` handler in the Python
-- registry. They differ only in what the user is asked for: a row carrying
-- `default_url` pre-fills the endpoint, so the user supplies just a token.
--
-- To add a service: copy a row, set the slug, name, default_url and fields,
-- then run `python migrations/apply.py`. No Python change is needed.
--
-- `default_url` is empty for servers that have no public endpoint. Those run
-- locally over stdio, so the user must expose one through an HTTP bridge and
-- paste its URL. The box stays in error until they do.
-- ---------------------------------------------------------------------------
insert into public.tool_types (slug, name, description, config_schema, secret_fields, sort_order)
values
  (
    'github',
    'GitHub',
    'Issues, pull requests, code search and repository files.',
    '{"default_url": "https://api.githubcopilot.com/mcp/",
      "fields": [
        {"key": "auth_token", "label": "Personal access token", "type": "password",
         "required": true,
         "help": "github.com > Settings > Developer settings > Personal access tokens"}
      ]}'::jsonb,
    array['auth_token'],
    31
  ),
  (
    'obsidian',
    'Obsidian',
    'Read and search an Obsidian vault. Needs a local MCP bridge.',
    '{"default_url": "",
      "fields": [
        {"key": "url", "label": "Bridge URL", "type": "text", "required": true,
         "help": "Obsidian MCP servers run locally over stdio. Expose one over HTTP and paste its URL."},
        {"key": "auth_token", "label": "Auth token", "type": "password", "required": false}
      ]}'::jsonb,
    array['auth_token'],
    32
  ),
  (
    'gmail',
    'Gmail',
    'Read, search and send mail. Needs a local MCP bridge with Google OAuth.',
    '{"default_url": "",
      "fields": [
        {"key": "url", "label": "Bridge URL", "type": "text", "required": true,
         "help": "No public Gmail MCP endpoint exists. Run a server that holds your Google OAuth credentials and expose it over HTTP."},
        {"key": "auth_token", "label": "Auth token", "type": "password", "required": false}
      ]}'::jsonb,
    array['auth_token'],
    33
  )
on conflict (slug) do nothing;

commit;
