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

commit;
