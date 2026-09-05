-- init.sql (DATABASE SCHEMA FOR MULTI-AGENT PROJECT CANVAS)
--
-- A project is a canvas of nodes (boxes) joined by edges (arrows), in the
-- Nodes are heterogeneous: agents, execution environments, 
-- and tools. Agent nodes each hold a conversation.
--
-- Does not touch the `dbos` schema, which DBOS manages for itself.

begin;

-- gen_random_uuid() lives in pgcrypto. 
create extension if not exists pgcrypto;


-- ---------------------------------------------------------------------------
-- Shared trigger function
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- ---------------------------------------------------------------------------
-- agent_types: the seeded catalog of agent TEMPLATES.
-- ---------------------------------------------------------------------------
create table if not exists public.agent_types (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  name          text not null,
  description   text,
  system_prompt text not null,
  model         text not null default 'gemini-3-flash-preview',
  -- Ordering in the "add an agent" palette; ties broken by name.
  sort_order    integer not null default 100,
  -- Is active to keep track of active agent sessions within the project.
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint agent_types_slug_format
    check (slug ~ '^[a-z][a-z0-9_]{1,48}[a-z0-9]$'),
  constraint agent_types_system_prompt_nonempty
    check (length(btrim(system_prompt)) > 0)
);

drop trigger if exists agent_types_set_updated_at on public.agent_types;
create trigger agent_types_set_updated_at
  before update on public.agent_types
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
-- tool_types: the seeded catalog of tool TEMPLATES (Brave Search, etc).
--
-- `config_schema` describes the necessary configuration for each tool call.
-- ---------------------------------------------------------------------------
create table if not exists public.tool_types (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  name          text not null,
  description   text,
  -- JSON Schema-ish description of the fields the user must fill in.
  config_schema jsonb not null default '{}'::jsonb,
  -- Which of those fields are secrets, so the API never echoes them back.
  secret_fields text[] not null default '{}',
  sort_order    integer not null default 100,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint tool_types_slug_format
    check (slug ~ '^[a-z][a-z0-9_]{1,48}[a-z0-9]$')
);

drop trigger if exists tool_types_set_updated_at on public.tool_types;
create trigger tool_types_set_updated_at
  before update on public.tool_types
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
-- projects - identified by UUID. User has their own list of projects.
-- ---------------------------------------------------------------------------
create table if not exists public.projects (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  name        text not null,
  description text,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint projects_name_nonempty check (length(btrim(name)) > 0),
  constraint projects_name_len      check (length(name) <= 200)
);

-- "List my projects", and the RLS predicate.
create index if not exists projects_owner_id_created_at_idx
  on public.projects (owner_id, created_at desc);

-- One project name per user. Two users may both have an "ab"; one user may not
-- have two. Partial, so archiving a project frees its name for reuse.
create unique index if not exists projects_owner_id_name_uniq
  on public.projects (owner_id, name)
  where archived_at is null;

drop trigger if exists projects_set_updated_at on public.projects;
create trigger projects_set_updated_at
  before update on public.projects
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
-- nodes: the boxes on the canvas.
--
--   agent       -> from agent_types; owns a conversation
--   environment -> an E2B microVM
--   tool        -> an external capability, e.g. Brave Search
--
-- One table with a `kind` discriminator so edges can point at any box.
-- Many nodes can share one agent_type, which is what allows teams.
-- ---------------------------------------------------------------------------
create table if not exists public.nodes (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects (id) on delete cascade,
  owner_id      uuid not null references auth.users (id)      on delete cascade,
  kind          text not null,
  -- Exactly one is set, per `kind`. See nodes_type_matches_kind.
  agent_type_id uuid references public.agent_types (id) on delete restrict,
  tool_type_id  uuid references public.tool_types (id)  on delete restrict,
  -- Label on the box, e.g. "Market Research (EU)".
  name          text not null,

  -- Canvas position.
  position_x    double precision not null default 0,
  position_y    double precision not null default 0,

  -- Per-instance settings: prompt/model overrides, E2B sandbox id,
  -- or a tool's non-secret config.
  config        jsonb not null default '{}'::jsonb,

  -- 'ask' suspends the turn for approval, 'auto' just runs.
  -- Agent nodes only.
  tool_policy   text not null default 'ask',

  -- Lifecycle, so the canvas can show a box as live, broken, or still coming up.
  --   agent       : ready
  --   environment : pending -> provisioning -> ready / error / stopped
  --   tool        : pending -> ready (verified) / error
  status        text not null default 'pending',
  status_detail text,
  last_checked_at timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint nodes_kind_valid
    check (kind in ('agent', 'environment', 'tool')),
  constraint nodes_status_valid
    check (status in ('pending', 'provisioning', 'ready', 'error', 'stopped')),
  constraint nodes_tool_policy_valid
    check (tool_policy in ('ask', 'auto')),
  constraint nodes_name_nonempty
    check (length(btrim(name)) > 0),
  -- Each kind points at its own catalog, and nothing else.
  constraint nodes_type_matches_kind check (
    (kind = 'agent'       and agent_type_id is not null and tool_type_id is null)
    or (kind = 'tool'     and tool_type_id  is not null and agent_type_id is null)
    or (kind = 'environment' and agent_type_id is null and tool_type_id is null)
  )
);

-- Canvas load.
create index if not exists nodes_project_id_idx on public.nodes (project_id);
-- RLS predicate.
create index if not exists nodes_owner_id_idx on public.nodes (owner_id);
-- Keeps `on delete restrict` cheap.
create index if not exists nodes_agent_type_id_idx on public.nodes (agent_type_id);
create index if not exists nodes_tool_type_id_idx  on public.nodes (tool_type_id);

drop trigger if exists nodes_set_updated_at on public.nodes;
create trigger nodes_set_updated_at
  before update on public.nodes
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
-- nodes.owner_id always comes from the parent project, never the client.
-- Stops anyone attaching a node to someone else's project.
-- ---------------------------------------------------------------------------
create or replace function public.nodes_sync_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  project_owner uuid;
begin
  select p.owner_id into project_owner
  from public.projects p
  where p.id = new.project_id;

  if project_owner is null then
    raise exception 'project % not found', new.project_id
      using errcode = 'foreign_key_violation';
  end if;

  new.owner_id := project_owner;
  return new;
end;
$$;

drop trigger if exists nodes_sync_owner_trg on public.nodes;
create trigger nodes_sync_owner_trg
  before insert or update of project_id, owner_id on public.nodes
  for each row execute function public.nodes_sync_owner();


-- ---------------------------------------------------------------------------
-- node_secrets: tool credentials, deliberately not on the node row so a
-- select on nodes can never leak an API key.
--
-- NOTE: `value` is stored as supplied. Encrypting at rest (pgsodium / Supabase
-- Vault) is a deliberate follow-up. 
-- ---------------------------------------------------------------------------
create table if not exists public.node_secrets (
  id         uuid primary key default gen_random_uuid(),
  node_id    uuid not null references public.nodes (id)  on delete cascade,
  owner_id   uuid not null references auth.users (id)    on delete cascade,
  key        text not null,
  value      text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint node_secrets_node_key_uniq unique (node_id, key),
  constraint node_secrets_key_nonempty check (length(btrim(key)) > 0)
);

create index if not exists node_secrets_owner_id_idx on public.node_secrets (owner_id);

drop trigger if exists node_secrets_set_updated_at on public.node_secrets;
create trigger node_secrets_set_updated_at
  before update on public.node_secrets
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
-- edges: the arrows. No pipeline execution -- they just make context and
-- capability available to whichever agent you are chatting with.
--
--   context     (agent -> agent)       : a summary + a retrieval tool
--   tool        (tool -> agent)        : a callable capability
--   environment (environment -> agent) : an execution target
--
-- Context edges go stale when the source conversation moves past
-- `summarised_through_seq`. The UI recolours the arrow; the user refreshes it.
-- Nothing regenerates on its own, so no surprise LLM bills.
-- ---------------------------------------------------------------------------
create table if not exists public.edges (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects (id) on delete cascade,
  owner_id       uuid not null references auth.users (id)      on delete cascade,
  source_node_id uuid not null references public.nodes (id)    on delete cascade,
  target_node_id uuid not null references public.nodes (id)    on delete cascade,
  kind           text not null,

  -- Context edges only.
  summary                text,
  summarised_through_seq bigint,
  summary_updated_at     timestamptz,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint edges_kind_valid
    check (kind in ('context', 'tool', 'environment')),
  -- One arrow per kind between two boxes.
  constraint edges_unique_link
    unique (source_node_id, target_node_id, kind),
  -- A box cannot feed itself.
  constraint edges_no_self_link
    check (source_node_id <> target_node_id),
  -- Summary is for context edges only.
  constraint edges_summary_only_on_context
    check (kind = 'context' or (summary is null and summarised_through_seq is null))
);

-- Canvas load.
create index if not exists edges_project_id_idx on public.edges (project_id);
-- RLS predicate.
create index if not exists edges_owner_id_idx on public.edges (owner_id);
-- "What feeds this agent?" -- hot lookup when building a turn.
create index if not exists edges_target_node_id_kind_idx
  on public.edges (target_node_id, kind);
create index if not exists edges_source_node_id_idx on public.edges (source_node_id);

drop trigger if exists edges_set_updated_at on public.edges;
create trigger edges_set_updated_at
  before update on public.edges
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
-- Edges inherit owner from their source node, and both endpoints must sit
-- on the same canvas -- otherwise you could wire into another project.
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
  tgt_project uuid;
begin
  select n.project_id, n.owner_id into src_project, src_owner
  from public.nodes n where n.id = new.source_node_id;

  select n.project_id into tgt_project
  from public.nodes n where n.id = new.target_node_id;

  if src_project is null or tgt_project is null then
    raise exception 'edge endpoints must exist'
      using errcode = 'foreign_key_violation';
  end if;

  if src_project <> tgt_project then
    raise exception 'edge endpoints must belong to the same project'
      using errcode = 'check_violation';
  end if;

  new.project_id := src_project;
  new.owner_id   := src_owner;
  return new;
end;
$$;

drop trigger if exists edges_validate_trg on public.edges;
create trigger edges_validate_trg
  before insert or update of source_node_id, target_node_id, project_id, owner_id
  on public.edges
  for each row execute function public.edges_validate();


-- ---------------------------------------------------------------------------
-- conversations: one per agent node.
--
-- Keyed on the node, not (project, agent_type), so two "Market Research"
-- boxes get two separate conversations.
-- ---------------------------------------------------------------------------
create table if not exists public.conversations (
  id              uuid primary key default gen_random_uuid(),
  node_id         uuid not null references public.nodes (id)    on delete cascade,
  project_id      uuid not null references public.projects (id) on delete cascade,
  owner_id        uuid not null references auth.users (id)      on delete cascade,
  title           text,
  -- Kept current by a trigger on messages, to avoid counting rows.
  message_count   integer not null default 0,
  last_message_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- One conversation per agent box.
  constraint conversations_node_uniq unique (node_id),
  constraint conversations_message_count_nonneg check (message_count >= 0)
);

create index if not exists conversations_project_id_idx
  on public.conversations (project_id);
create index if not exists conversations_owner_id_idx
  on public.conversations (owner_id);

drop trigger if exists conversations_set_updated_at on public.conversations;
create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
-- Conversations inherit project/owner from their node, and only agent
-- nodes get one -- there is nothing to talk to on a tool or a microVM.
-- ---------------------------------------------------------------------------
create or replace function public.conversations_sync_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  node_project uuid;
  node_owner   uuid;
  node_kind    text;
begin
  select n.project_id, n.owner_id, n.kind
    into node_project, node_owner, node_kind
  from public.nodes n
  where n.id = new.node_id;

  if node_project is null then
    raise exception 'node % not found', new.node_id
      using errcode = 'foreign_key_violation';
  end if;

  if node_kind <> 'agent' then
    raise exception 'conversations may only attach to agent nodes, not %', node_kind
      using errcode = 'check_violation';
  end if;

  new.project_id := node_project;
  new.owner_id   := node_owner;
  return new;
end;
$$;

drop trigger if exists conversations_sync_owner_trg on public.conversations;
create trigger conversations_sync_owner_trg
  before insert or update of node_id, project_id, owner_id on public.conversations
  for each row execute function public.conversations_sync_owner();


-- ---------------------------------------------------------------------------
-- messages: the transcript. Append-only.
-- owner_id is denormalised so RLS here is a column compare, not a join.
-- ---------------------------------------------------------------------------
create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  owner_id        uuid not null references auth.users (id)           on delete cascade,
  role            text not null,
  content         text not null,
  -- Which model actually answered, and what it cost. Models change.
  model           text,
  input_tokens    integer,
  -- output_tokens INCLUDES reasoning. Gemini 3 spends most of its output budget
  -- thinking: a 120-word reply can report ~2000 output tokens, 1900 of them
  -- reasoning. Store both so cost can be attributed honestly.
  output_tokens   integer,
  reasoning_tokens integer,
  -- 'failed' once the agent gives up retrying.
  -- 'awaiting_approval' is a turn suspended on a tool call.
  status          text not null default 'complete',
  error           text,
  -- What was called, with what args, and whether it was approved.
  tool_calls      jsonb,
  -- Idempotency key. A resend or a retried step converges on one row.
  client_token    text,
  -- Ordering. Assigned by trigger -- created_at is not safe, two inserts
  -- can share a timestamp.
  seq             bigint not null,
  created_at      timestamptz not null default now(),
  constraint messages_role_valid
    check (role in ('user', 'assistant', 'system')),
  constraint messages_status_valid
    check (status in ('complete', 'failed', 'awaiting_approval')),
  -- Empty content only allowed on a failed or waiting turn.
  constraint messages_content_nonempty
    check (status <> 'complete' or length(content) > 0),
  -- Error text only on failed rows.
  constraint messages_error_iff_failed
    check ((status = 'failed') or (error is null)),
  constraint messages_tokens_nonneg
    check (coalesce(input_tokens, 0) >= 0 and coalesce(output_tokens, 0) >= 0
           and coalesce(reasoning_tokens, 0) >= 0)
);

-- Columns added after the table first shipped. `create table if not exists`
-- above is a no-op on an existing database, so add them explicitly.
alter table public.messages add column if not exists reasoning_tokens integer;


-- Replaying a conversation. Unique, so a bypassed trigger errors instead
-- of quietly corrupting the order.
create unique index if not exists messages_conversation_id_seq_idx
  on public.messages (conversation_id, seq);
-- RLS predicate.
create index if not exists messages_owner_id_idx
  on public.messages (owner_id);
-- Partial, so the usual NULL client_token costs nothing.
create unique index if not exists messages_conversation_client_token_uniq
  on public.messages (conversation_id, client_token)
  where client_token is not null;


-- ---------------------------------------------------------------------------
-- messages: assign seq, inherit owner_id from the conversation.
-- The FOR UPDATE lock serialises inserts into one conversation so seq is
-- gap-free. Contention is per-conversation, so per-user.
-- ---------------------------------------------------------------------------
create or replace function public.messages_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  conv_owner uuid;
begin
  -- Lock the parent so the max(seq) below cannot race.
  select c.owner_id into conv_owner
  from public.conversations c
  where c.id = new.conversation_id
  for update;

  if conv_owner is null then
    raise exception 'conversation % not found', new.conversation_id
      using errcode = 'foreign_key_violation';
  end if;

  -- Read max(seq) rather than conversations.message_count: a multi-row
  -- insert fires this once per row before the AFTER trigger bumps the
  -- counter, so both rows would land on the same seq.
  select coalesce(max(m.seq), 0) + 1 into new.seq
  from public.messages m
  where m.conversation_id = new.conversation_id;

  new.owner_id := conv_owner;
  return new;
end;
$$;

drop trigger if exists messages_before_insert_trg on public.messages;
create trigger messages_before_insert_trg
  before insert on public.messages
  for each row execute function public.messages_before_insert();


create or replace function public.messages_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.conversations
     set message_count   = message_count + 1,
         last_message_at = new.created_at,
         updated_at      = now()
   where id = new.conversation_id;
  return null;
end;
$$;

drop trigger if exists messages_after_insert_trg on public.messages;
create trigger messages_after_insert_trg
  after insert on public.messages
  for each row execute function public.messages_after_insert();


-- ---------------------------------------------------------------------------
-- Seed the agent catalog.
-- ---------------------------------------------------------------------------
insert into public.agent_types (slug, name, description, system_prompt, model, sort_order)
values
  (
    'market_research',
    'Market Research',
    'Sizes the market, maps competitors, and surfaces customer segments.',
    'You are a market research analyst. Given a project description, identify the '
      || 'target market, comparable products, competitive positioning, and the main '
      || 'risks to demand. Prefer concrete, checkable claims over adjectives, and '
      || 'state plainly when something needs primary research to confirm.',
    'gemini-3-flash-preview',
    10
  ),
  (
    'project_scoping',
    'Project Scoping',
    'Turns an idea into milestones, deliverables, and an explicit non-goals list.',
    'You are a project scoping assistant. Convert the user''s goal into a scoped '
      || 'plan: deliverables, milestones, dependencies, and an explicit list of '
      || 'non-goals. Call out unstated assumptions, and ask for the specific detail '
      || 'you need rather than inventing it.',
    'gemini-3-flash-preview',
    20
  ),
  (
    'coding',
    'Coding',
    'Writes and reviews implementation code.',
    'You are a senior software engineer. Produce correct, idiomatic code that '
      || 'matches the conventions already present in the user''s project. Explain '
      || 'trade-offs briefly, flag the risky parts, and prefer the smallest change '
      || 'that solves the stated problem.',
    'gemini-3-flash-preview',
    30
  )
on conflict (slug) do nothing;


-- ---------------------------------------------------------------------------
-- Seed the tool catalog. `config_schema` drives the config form;
-- `secret_fields` names what goes to node_secrets instead.
-- ---------------------------------------------------------------------------
insert into public.tool_types (slug, name, description, config_schema, secret_fields, sort_order)
values
  (
    'brave_search',
    'Brave Search',
    'Web search via the Brave Search API.',
    '{"fields": [{"key": "api_key", "label": "API key", "type": "password", "required": true}]}'::jsonb,
    array['api_key'],
    10
  )
on conflict (slug) do nothing;

commit;
