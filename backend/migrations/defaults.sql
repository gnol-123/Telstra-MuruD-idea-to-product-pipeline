-- Tool presets: the library of ready-to-instantiate tools and skills, and
-- the list of presets each agent type is wired to on creation.
-- Apply after environments.sql.
begin;

-- ---------------------------------------------------------------------------
-- tool_presets: one row per hand-built tool or skill. config is copied into
-- nodes.config on create, so a preset edit never changes an existing node.
-- Secrets are never here: platform keys come from settings, user keys from
-- the vault.
-- ---------------------------------------------------------------------------
create table if not exists public.tool_presets (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  tool_type_id  uuid not null references public.tool_types (id) on delete restrict,
  name          text not null,
  description   text,
  config        jsonb not null default '{}'::jsonb,
  is_active     boolean not null default true,
  sort_order    integer not null default 100,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint tool_presets_slug_format
    check (slug ~ '^[a-z][a-z0-9_]{1,48}[a-z0-9]$')
);

drop trigger if exists tool_presets_set_updated_at on public.tool_presets;
create trigger tool_presets_set_updated_at
  before update on public.tool_presets
  for each row execute function public.set_updated_at();

alter table public.tool_presets enable row level security;
alter table public.tool_presets force row level security;

-- Read-only catalog, same as tool_types. Seeding runs as postgres.
drop policy if exists tool_presets_select on public.tool_presets;
create policy tool_presets_select
  on public.tool_presets
  for select
  to authenticated
  using (is_active);

-- ---------------------------------------------------------------------------
-- agent_types.default_presets: preset slugs wired on agent creation. Slugs,
-- not ids, so an unbuilt preset is skipped at provision time rather than
-- failing the seed.
-- ---------------------------------------------------------------------------
alter table public.agent_types
  add column if not exists default_presets text[] not null default '{}';

-- ---------------------------------------------------------------------------
-- web_fetch: URL in, readable text out. No key, no config.
-- ---------------------------------------------------------------------------
insert into public.tool_types (slug, name, description, config_schema, secret_fields, sort_order)
values (
  'web_fetch',
  'Web Fetch',
  'Fetch a web page and read its text.',
  '{"fields": []}'::jsonb,
  array[]::text[],
  11
)
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------------
-- API presets. Empty config: the key is the platform's unless the user sets
-- one on the node.
-- ---------------------------------------------------------------------------
insert into public.tool_presets (slug, tool_type_id, name, description, config, sort_order)
values
  (
    'brave_search',
    (select id from public.tool_types where slug = 'brave_search'),
    'Brave Search',
    'Web search. Platform key by default.',
    '{}'::jsonb,
    10
  ),
  (
    'web_fetch',
    (select id from public.tool_types where slug = 'web_fetch'),
    'Web Fetch',
    'Read the text of a web page.',
    '{}'::jsonb,
    11
  )
on conflict (slug) do update set
  tool_type_id = excluded.tool_type_id,
  name         = excluded.name,
  description  = excluded.description,
  config       = excluded.config,
  sort_order   = excluded.sort_order;

commit;
