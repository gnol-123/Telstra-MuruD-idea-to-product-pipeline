-- turns.sql: progressive turn persistence. Apply after tools.sql.
begin;

-- messages: a turn in flight, and one the user stopped.
alter table public.messages drop constraint if exists messages_status_valid;
alter table public.messages add constraint messages_status_valid
  check (status in ('complete', 'failed', 'awaiting_approval', 'running', 'cancelled'));

alter table public.messages alter column tool_calls set default '[]'::jsonb;
update public.messages set tool_calls = '[]'::jsonb where tool_calls is null;

-- tool_calls: a call aborted by cancel.
alter table public.tool_calls drop constraint if exists tool_calls_status_valid;
alter table public.tool_calls add constraint tool_calls_status_valid
  check (status in ('pending_approval', 'running', 'ok', 'error', 'denied', 'cancelled'));

-- nodes: an agent box mid-turn.
alter table public.nodes drop constraint if exists nodes_status_valid;
alter table public.nodes add constraint nodes_status_valid
  check (status in ('pending', 'provisioning', 'ready', 'error', 'stopped', 'running'));

-- Realtime opt-in. Postgres Changes enforces RLS per subscriber, so the
-- select policies must exist before the tables are published.
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'nodes' and policyname = 'nodes_select')
     or not exists (select 1 from pg_policies where tablename = 'messages' and policyname = 'messages_select')
     or not exists (select 1 from pg_policies where tablename = 'tool_calls' and policyname = 'tool_calls_select_own') then
    raise exception 'apply rls.sql and tools.sql before turns.sql';
  end if;

  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and tablename = 'nodes') then
    alter publication supabase_realtime add table public.nodes;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and tablename = 'messages') then
    alter publication supabase_realtime add table public.messages;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and tablename = 'tool_calls') then
    alter publication supabase_realtime add table public.tool_calls;
  end if;
end
$$;

commit;
