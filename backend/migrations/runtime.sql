-- Turn heartbeat for the startup sweep, and per agent type request limits.
-- Apply after pitch.sql. Re-runnable.
begin;

-- Bumped by the live driver every 20s. The sweep only fails rows whose
-- heartbeat (or created_at, before the first beat) is stale.
alter table public.messages add column if not exists heartbeat_at timestamptz;

create index if not exists messages_running_heartbeat_idx
  on public.messages (heartbeat_at)
  where status = 'running';

-- Model requests one turn may make. Null falls back to the backend setting.
alter table public.agent_types add column if not exists request_limit integer
  check (request_limit is null or request_limit > 0);

update public.agent_types set request_limit = 300
where slug in ('coding', 'ux_ui', 'scrutinizer');

commit;
