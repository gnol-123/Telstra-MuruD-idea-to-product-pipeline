-- Switch the default provider to Ollama, and let a single agent node override
-- the model its type specifies. Apply after parity.sql.
begin;

-- ---------------------------------------------------------------------------
-- nodes.model: a per-instance override. Null means inherit from
-- agent_types.model, so every existing node keeps working untouched and a
-- catalog change still moves every node that never overrode it.
--
-- A real column rather than a config key: config is otherwise unused for agent
-- nodes, and a column takes a check constraint.
-- ---------------------------------------------------------------------------
alter table public.nodes
  add column if not exists model text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'nodes_model_shape'
  ) then
    alter table public.nodes add constraint nodes_model_shape check (
      model is null or (length(btrim(model)) > 0 and length(model) <= 200)
    );
  end if;
end $$;

-- Only an agent node may carry one. A tool or environment box has no model.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'nodes_model_agents_only'
  ) then
    alter table public.nodes add constraint nodes_model_agents_only check (
      model is null or kind = 'agent'
    );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Point every agent type at the new default. Nodes that set their own model
-- are left alone, which is the whole point of the override.
-- ---------------------------------------------------------------------------
update public.agent_types set model = 'deepseek-v4.1-flash';

commit;
