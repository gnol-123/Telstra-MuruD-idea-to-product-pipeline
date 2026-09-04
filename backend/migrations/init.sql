-- init.sql (DATABASE SCHEMA FOR MULTI-AGENT PROJECT CHATS)
-- Multi-agent project chats: projects, agent catalog, conversations, messages.
-- Safe to re-run: every object uses `if not exists` / `on conflict do nothing`,
-- Does not touch the `dbos` schema, which DBOS manages for itself.

begin;

-- gen_random_uuid() lives in pgcrypto. 
create extension if not exists pgcrypto;


-- ---------------------------------------------------------------------------
-- Shared trigger function: keep updated_at honest.
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
-- agent_types: the seeded catalog. So agent-types configurations are inserted 
-- rather than deployed.
-- ---------------------------------------------------------------------------
create table if not exists public.agent_types (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  name          text not null,
  description   text,
  system_prompt text not null,
  model         text not null default 'gemini-3-flash-preview',
  -- Ordering for UI tabs; ties broken by name.
  sort_order    integer not null default 100,
  -- Soft-disable an agent type without breaking FKs from existing conversations.
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
-- projects: owned by an auth.users row.
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

-- Drives "list my projects", and supports the RLS predicate on projects.
create index if not exists projects_owner_id_created_at_idx
  on public.projects (owner_id, created_at desc);

drop trigger if exists projects_set_updated_at on public.projects;
create trigger projects_set_updated_at
  before update on public.projects
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
-- conversations: exactly one per (project, agent_type).
--
-- owner_id is denormalised from projects so RLS on messages can be a plain
-- indexed equality instead of a nested subquery. A trigger keeps it honest --
-- the client never gets to assert it.
-- ---------------------------------------------------------------------------
create table if not exists public.conversations (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects (id)    on delete cascade,
  agent_type_id   uuid not null references public.agent_types (id) on delete restrict,
  owner_id        uuid not null references auth.users (id)         on delete cascade,
  title           text,
  -- Maintained by a trigger on messages, so listing conversations needs no
  -- aggregate over the transcript.
  message_count   integer not null default 0,
  last_message_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- One ongoing conversation per project-agent pair. This is also what lets
  -- the get-or-create upsert resolve `on_conflict` safely under concurrency.
  constraint conversations_project_agent_uniq unique (project_id, agent_type_id),
  constraint conversations_message_count_nonneg check (message_count >= 0)
);

-- Listing a project's conversations, and the parent lookup for messages RLS.
create index if not exists conversations_project_id_idx
  on public.conversations (project_id);
-- RLS predicate support.
create index if not exists conversations_owner_id_idx
  on public.conversations (owner_id);
-- Keeps `on delete restrict` cheap, and answers "which projects use agent X".
create index if not exists conversations_agent_type_id_idx
  on public.conversations (agent_type_id);

drop trigger if exists conversations_set_updated_at on public.conversations;
create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
-- Keep conversations.owner_id equal to the owning project's owner_id.
--
-- Enforced server-side so a compromised client cannot insert a conversation
-- pointing at someone else's project while claiming its own owner_id, which
-- would otherwise satisfy a naive RLS WITH CHECK.
-- ---------------------------------------------------------------------------
create or replace function public.conversations_sync_owner()
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

drop trigger if exists conversations_sync_owner_trg on public.conversations;
create trigger conversations_sync_owner_trg
  before insert or update of project_id, owner_id on public.conversations
  for each row execute function public.conversations_sync_owner();


-- ---------------------------------------------------------------------------
-- messages: the transcript. Append-only.
--
-- owner_id is denormalised again, so RLS on this hot table is a column
-- compare with no subquery at all.
-- ---------------------------------------------------------------------------
create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  owner_id        uuid not null references auth.users (id)           on delete cascade,
  role            text not null,
  content         text not null,
  -- Provenance and cost accounting. agent_types.model can change over the life
  -- of a conversation, so record what actually produced each answer.
  model           text,
  input_tokens    integer,
  output_tokens   integer,
  -- Turn lifecycle. User rows are always complete; an assistant row is written
  -- complete on success, or failed once the agent has given up retrying.
  status          text not null default 'complete',
  error           text,
  -- Idempotency key, unique per conversation. Lets a retried DBOS step or a
  -- double-submitted request converge on one row instead of duplicating.
  client_token    text,
  -- Monotonic per-conversation ordering, assigned by trigger. created_at alone
  -- is unsafe: two inserts can share a timestamptz, and clocks move.
  seq             bigint not null,
  created_at      timestamptz not null default now(),
  constraint messages_role_valid
    check (role in ('user', 'assistant', 'system')),
  constraint messages_status_valid
    check (status in ('complete', 'failed')),
  -- Content may only be empty when the turn failed.
  constraint messages_content_nonempty
    check (status = 'failed' or length(content) > 0),
  -- Error text only belongs on failed rows.
  constraint messages_error_iff_failed
    check ((status = 'failed') or (error is null)),
  constraint messages_tokens_nonneg
    check (coalesce(input_tokens, 0) >= 0 and coalesce(output_tokens, 0) >= 0)
);

-- Primary read path: replay a conversation in order. Unique so that a bypassed
-- trigger errors rather than silently corrupting message order.
create unique index if not exists messages_conversation_id_seq_idx
  on public.messages (conversation_id, seq);
-- RLS predicate support.
create index if not exists messages_owner_id_idx
  on public.messages (owner_id);
-- Idempotency: at most one row per (conversation, client_token). Partial, so
-- the common client_token IS NULL case costs nothing.
create unique index if not exists messages_conversation_client_token_uniq
  on public.messages (conversation_id, client_token)
  where client_token is not null;


-- ---------------------------------------------------------------------------
-- messages: assign seq, inherit owner_id from the parent conversation.
--
-- The FOR UPDATE lock serialises concurrent inserts into the same conversation,
-- so seq is gap-free and collision-free. Contention is per-conversation, which
-- means per-user -- inserts into different conversations still run in parallel.
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
  -- Lock the parent first. This serialises concurrent inserts into the same
  -- conversation, so the max(seq) read below cannot race.
  select c.owner_id into conv_owner
  from public.conversations c
  where c.id = new.conversation_id
  for update;

  if conv_owner is null then
    raise exception 'conversation % not found', new.conversation_id
      using errcode = 'foreign_key_violation';
  end if;

  -- Derive seq from the transcript itself rather than conversations.message_count.
  -- A multi-row INSERT ... VALUES (a),(b) fires this trigger once per row inside
  -- a single statement, and the AFTER trigger that maintains message_count has
  -- not run yet -- so reading the counter would hand both rows the same seq.
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
-- Agent catalog.
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

commit;
