# Migrations

Plain SQL. Order matters: `rls.sql` policies reference tables that `init.sql`
creates, so run it second.

| File | What it does |
|---|---|
| `init.sql` | Tables, indexes, triggers, and the seeded catalogs. Run first. |
| `rls.sql` | Row Level Security policies. Run second. |
| `apply.py` | Runs both, in order, in one transaction. |

## Applying

### Script

From `backend/`, with `DBOS_DATABASE_URL` set in `.env`:

```
python migrations/apply.py --dry-run   # apply, report, then roll back
python migrations/apply.py             # apply for real
```

Both files run in one transaction, so a failure part-way rolls the whole thing
back rather than leaving the schema half-built. Use `--dry-run` first to see
what you would get.

### By hand

Or paste them into the Supabase **SQL Editor**, `init.sql` first. Run each and
confirm success before the next.

Either way, both files are safe to re-run: they use `if not exists`,
`create or replace`, `drop policy if exists`, and `on conflict do nothing`, so
applying twice is a no-op rather than an error.

They are separate files on purpose. Policies get iterated on far more often
than the schema, and a typo in a policy should not roll back your tables.

## After applying: verify tenant isolation

Nothing in CI exercises the policies against a real database, so check them
by hand at least once, and again after editing `rls.sql`.

Substitute two real ids from `select id from auth.users limit 2`:

```sql
-- Impersonate user A exactly as PostgREST does.
select set_config('request.jwt.claims', '{"sub":"<USER-A-UUID>","role":"authenticated"}', true);
select set_config('role', 'authenticated', true);

select count(*) from projects;   -- only A's rows
select count(*) from messages;   -- only A's rows

-- Now become user B. Both counts must exclude everything owned by A.
reset role;
select set_config('request.jwt.claims', '{"sub":"<USER-B-UUID>","role":"authenticated"}', true);
select set_config('role', 'authenticated', true);

select count(*) from projects;   -- zero of A's rows
```

Wrap the whole check in `begin; ... rollback;` if you seed test rows.

## The shape of it

A project is a **canvas**: `nodes` (boxes) joined by `edges` (arrows).

```
projects
   └── nodes ──< edges >── nodes
         │  kind: agent | environment | tool
         │
         └── conversations (agent nodes only) ──< messages
```

`agent_types` and `tool_types` are **catalogs of templates**. A node is an
*instance* provisioned from one, so a project can hold two "Market Research"
boxes as separate nodes with separate conversations. That is what makes teams
of agents possible.

Edges do not execute a pipeline. They make context and capability available to
whichever agent the user is chatting with:

| Edge kind | Direction | Carries |
|---|---|---|
| `context` | agent → agent | A summary of the source conversation, plus a retrieval tool |
| `tool` | tool → agent | A callable capability and its credentials |
| `environment` | environment → agent | An execution target |

### Stale context

A `context` edge stores `summary` and `summarised_through_seq`. When the source
conversation grows past that seq the edge is **stale**, and the UI colours it
differently until the user refreshes it. Nothing regenerates automatically, so
there are no background LLM calls and the user can see when a downstream agent
is working from older information.

```sql
select e.id, e.summarised_through_seq < c.message_count as is_stale
from edges e
join nodes n         on n.id = e.source_node_id
join conversations c on c.node_id = n.id
where e.kind = 'context';
```

## Adding an agent type

An insert, not a deploy:

```sql
insert into public.agent_types (slug, name, description, system_prompt, model, sort_order)
values ('legal_review', 'Legal Review', 'Flags contractual risk.',
        'You are a contracts analyst...', 'gemini-3-flash-preview', 40);
```

The slug must match `^[a-z][a-z0-9_]{1,48}[a-z0-9]$`.

**Retiring one is `is_active = false`, never `DELETE`.** Nodes reference the
catalogs with `on delete restrict` precisely so that removing a template cannot
cascade away user transcripts.

## Adding a tool type

Same idea. `config_schema` drives the form the user sees when they click the
box; `secret_fields` names the values that must go to `node_secrets` and never
be returned by the API.

```sql
insert into public.tool_types (slug, name, description, config_schema, secret_fields)
values ('github', 'GitHub', 'Read and write repositories.',
        '{"fields": [{"key": "token", "label": "Access token", "type": "password",
                      "required": true}]}'::jsonb,
        array['token']);
```

## Notes

- Everything lives in `public`. The `dbos` schema belongs to DBOS: leave it be.
- **Tool credentials are stored in plain text** in `node_secrets` today. They
  are isolated by RLS and kept out of the `nodes` row so a `select *` cannot
  leak them, but encryption at rest (pgsodium / Supabase Vault) is still an
  open follow-up.
- `RLS` is enforced only because `SUPABASE_KEY` is the publishable/anon key.
  A service-role key is `BYPASSRLS`, and every policy here would be silently
  inert. The backend also filters by owner on every query, which is the
  safety net if that ever changes.
