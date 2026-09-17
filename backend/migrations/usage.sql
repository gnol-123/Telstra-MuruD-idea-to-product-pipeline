-- Token usage tracking. Apply after provider.sql (ninth).
--
-- Two parts: the columns `_turn_from` was already reading off `RunUsage` but
-- had nowhere to put, and a per-(project, owner, model) rollup kept current by
-- a trigger, following the `conversations.message_count` precedent rather than
-- summing `messages` on every read. Per-user caps read it summed across
-- projects; the project view reads it filtered to one.
begin;

-- ---------------------------------------------------------------------------
-- Cached input is priced differently from fresh input on every provider that
-- offers it, so a cost calculation without these is wrong, not just partial.
-- `requests` disambiguates "tokens per turn": a turn that pauses for approval
-- or loops through tool calls issues several model requests under one row.
-- ---------------------------------------------------------------------------
alter table public.messages
  add column if not exists cache_read_tokens  integer,
  add column if not exists cache_write_tokens integer,
  add column if not exists requests           integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'messages_usage_nonneg'
  ) then
    alter table public.messages add constraint messages_usage_nonneg
      check (coalesce(cache_read_tokens, 0) >= 0
         and coalesce(cache_write_tokens, 0) >= 0
         and coalesce(requests, 0) >= 0);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Rollup, grouped by model.
--
-- Grouping by model is not optional: `nodes.model` is a per-node override, so
-- one project can run several models at once, and token counts are neither
-- comparable nor equally priced across them. A single per-project total would
-- be meaningless the moment someone overrides a node.
--
-- `output_tokens` INCLUDES reasoning on every provider (OpenAI/Ollama
-- `reasoning_tokens`, Anthropic `thinking_tokens`, Google `thoughts_tokens`
-- are all readable subsets). `reasoning_tokens` here is that same subset,
-- carried for attribution only. Never sum output + reasoning: that
-- double-counts.
--
-- Failed turns are counted. They consumed tokens and cost money, which is a
-- different question from whether `to_model_messages` replays them.
--
-- Keyed (project_id, owner_id, model), not (project_id, model). Projects are
-- single-owner today, so owner_id is functionally dependent on project_id and
-- the wider key costs nothing. The moment a project is shared it stops being
-- redundant: a per-project key would merge two users into one row and destroy
-- the per-user split at write time, which is unrecoverable after the fact.
-- Per-user caps are the point of this table, so that split has to exist.
--
-- CAVEAT for whoever adds sharing: `messages_before_insert` sets
-- `new.owner_id := conv_owner`, so owner_id is the CONVERSATION's owner, not
-- whoever sent the turn. Under single ownership those are the same user. Under
-- sharing they are not, and every row would bill the project owner. Fixing
-- that is a change to that trigger (carry the sender), not to this table.
-- ---------------------------------------------------------------------------
create table if not exists public.usage_totals (
  project_id         uuid not null references public.projects (id) on delete cascade,
  owner_id           uuid not null references auth.users (id)      on delete cascade,
  model              text not null,
  input_tokens       bigint not null default 0,
  output_tokens      bigint not null default 0,
  reasoning_tokens   bigint not null default 0,
  cache_read_tokens  bigint not null default 0,
  cache_write_tokens bigint not null default 0,
  requests           bigint not null default 0,
  message_count      bigint not null default 0,
  updated_at         timestamptz not null default now(),
  primary key (project_id, owner_id, model)
);

-- Covers the per-user rollup, which sums across projects and cannot use the
-- primary key's leading column.
create index if not exists usage_totals_owner_id_idx
  on public.usage_totals (owner_id);

-- ---------------------------------------------------------------------------
-- Maintained on insert AND update. Unlike message_count, a usage row is
-- written twice: the assistant row is inserted when a turn pauses for
-- approval and updated when it resumes, so insert-only would lose the
-- resumed half of every approval turn.
-- ---------------------------------------------------------------------------
create or replace function public.messages_usage_rollup()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d_input     bigint;
  d_output    bigint;
  d_reasoning bigint;
  d_cache_r   bigint;
  d_cache_w   bigint;
  d_requests  bigint;
  d_messages  bigint;
  target_project uuid;
begin
  -- Only assistant rows carry usage; user rows never do.
  if new.role <> 'assistant' then
    return null;
  end if;

  if tg_op = 'UPDATE' then
    d_input     := coalesce(new.input_tokens, 0)       - coalesce(old.input_tokens, 0);
    d_output    := coalesce(new.output_tokens, 0)      - coalesce(old.output_tokens, 0);
    d_reasoning := coalesce(new.reasoning_tokens, 0)   - coalesce(old.reasoning_tokens, 0);
    d_cache_r   := coalesce(new.cache_read_tokens, 0)  - coalesce(old.cache_read_tokens, 0);
    d_cache_w   := coalesce(new.cache_write_tokens, 0) - coalesce(old.cache_write_tokens, 0);
    d_requests  := coalesce(new.requests, 0)           - coalesce(old.requests, 0);
    d_messages  := 0;
  else
    d_input     := coalesce(new.input_tokens, 0);
    d_output    := coalesce(new.output_tokens, 0);
    d_reasoning := coalesce(new.reasoning_tokens, 0);
    d_cache_r   := coalesce(new.cache_read_tokens, 0);
    d_cache_w   := coalesce(new.cache_write_tokens, 0);
    d_requests  := coalesce(new.requests, 0);
    d_messages  := 1;
  end if;

  -- A row with no usage at all and no new message changes nothing.
  if d_input = 0 and d_output = 0 and d_reasoning = 0 and d_cache_r = 0
     and d_cache_w = 0 and d_requests = 0 and d_messages = 0 then
    return null;
  end if;

  select c.project_id into target_project
    from public.conversations c
   where c.id = new.conversation_id;

  if target_project is null then
    return null;
  end if;

  insert into public.usage_totals as t (
    project_id, owner_id, model,
    input_tokens, output_tokens, reasoning_tokens,
    cache_read_tokens, cache_write_tokens, requests, message_count
  )
  values (
    target_project, new.owner_id, coalesce(new.model, 'unknown'),
    d_input, d_output, d_reasoning, d_cache_r, d_cache_w, d_requests, d_messages
  )
  on conflict (project_id, owner_id, model) do update
     set input_tokens       = t.input_tokens       + excluded.input_tokens,
         output_tokens      = t.output_tokens      + excluded.output_tokens,
         reasoning_tokens   = t.reasoning_tokens   + excluded.reasoning_tokens,
         cache_read_tokens  = t.cache_read_tokens  + excluded.cache_read_tokens,
         cache_write_tokens = t.cache_write_tokens + excluded.cache_write_tokens,
         requests           = t.requests           + excluded.requests,
         message_count      = t.message_count      + excluded.message_count,
         updated_at         = now();
  return null;
end;
$$;

drop trigger if exists messages_usage_rollup_trg on public.messages;
create trigger messages_usage_rollup_trg
  after insert or update of input_tokens, output_tokens, reasoning_tokens,
                            cache_read_tokens, cache_write_tokens, requests
  on public.messages
  for each row execute function public.messages_usage_rollup();

-- ---------------------------------------------------------------------------
-- Backfill from existing rows, so the table is correct on first apply rather
-- than only counting turns that happen after the migration.
-- ---------------------------------------------------------------------------
insert into public.usage_totals (
  project_id, owner_id, model,
  input_tokens, output_tokens, reasoning_tokens,
  cache_read_tokens, cache_write_tokens, requests, message_count
)
select c.project_id,
       m.owner_id,
       coalesce(m.model, 'unknown'),
       sum(coalesce(m.input_tokens, 0)),
       sum(coalesce(m.output_tokens, 0)),
       sum(coalesce(m.reasoning_tokens, 0)),
       sum(coalesce(m.cache_read_tokens, 0)),
       sum(coalesce(m.cache_write_tokens, 0)),
       sum(coalesce(m.requests, 0)),
       count(*)
  from public.messages m
  join public.conversations c on c.id = m.conversation_id
 where m.role = 'assistant'
 group by c.project_id, m.owner_id, coalesce(m.model, 'unknown')
on conflict (project_id, owner_id, model) do nothing;

-- ---------------------------------------------------------------------------
-- RLS: read-only to the owner. Writes come from the trigger, which is
-- security definer, so no insert/update policy is needed.
-- ---------------------------------------------------------------------------
alter table public.usage_totals enable row level security;

drop policy if exists usage_totals_select on public.usage_totals;
create policy usage_totals_select
  on public.usage_totals
  for select
  to authenticated
  using (owner_id = (select auth.uid()));

commit;
