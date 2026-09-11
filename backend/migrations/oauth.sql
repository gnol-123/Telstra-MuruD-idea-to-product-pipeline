-- OAuth tool nodes: auth_kind on tool_types, and the gmail row as oauth2.
-- Apply after tools.sql.
begin;

-- ---------------------------------------------------------------------------
-- auth_kind: 'token' renders a password field, 'oauth2' renders a Connect
-- button. Column-then-constraint in a do block, so this file is re-runnable.
-- ---------------------------------------------------------------------------
alter table public.tool_types
  add column if not exists auth_kind text not null default 'token';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tool_types_auth_kind_valid'
  ) then
    alter table public.tool_types
      add constraint tool_types_auth_kind_valid
        check (auth_kind in ('token', 'oauth2'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Gmail, now oauth2. No fields: the user types nothing, the Connect button
-- does the work. Replaces the earlier stdio-bridge row from tools.sql.
-- ---------------------------------------------------------------------------
insert into public.tool_types
  (slug, name, description, config_schema, secret_fields, auth_kind, sort_order)
values (
  'gmail', 'Gmail',
  'Read, search and draft mail through Google''s hosted MCP server.',
  '{"default_url": "https://gmailmcp.googleapis.com/mcp/v1",
    "oauth": {"provider": "google",
              "scopes": ["https://www.googleapis.com/auth/gmail.readonly",
                         "https://www.googleapis.com/auth/gmail.compose"]},
    "fields": []}'::jsonb,
  array['oauth_refresh_token'], 'oauth2', 34
)
on conflict (slug) do update set
  name           = excluded.name,
  description    = excluded.description,
  config_schema  = excluded.config_schema,
  secret_fields  = excluded.secret_fields,
  auth_kind      = excluded.auth_kind,
  sort_order     = excluded.sort_order;

-- ---------------------------------------------------------------------------
-- The oauth callback has no user JWT: Google redirects the browser straight
-- to the backend. Ownership there rests on the signed state, not auth.uid(),
-- so set_node_secret (which checks auth.uid()) cannot be used. This twin
-- takes the owner explicitly and checks the node against it instead. Callable
-- only by service_role, and only after the backend has verified the state
-- signature itself.
-- ---------------------------------------------------------------------------
create or replace function public.set_node_secret_as(
  p_node_id  uuid,
  p_owner_id uuid,
  p_key      text,
  p_value    text
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

  if node_owner <> p_owner_id then
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
    update public.node_secrets
       set vault_secret_id = existing_id
     where node_id = p_node_id and key = p_key;
  end if;
end;
$$;

revoke all on function public.set_node_secret_as(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.set_node_secret_as(uuid, uuid, text, text) to service_role;

commit;
