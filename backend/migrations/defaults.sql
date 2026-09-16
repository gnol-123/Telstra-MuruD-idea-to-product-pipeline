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

-- ---------------------------------------------------------------------------
-- ux_ui: fourth default agent.
-- ---------------------------------------------------------------------------
insert into public.agent_types (slug, name, description, system_prompt, model, sort_order)
values (
  'ux_ui',
  'UX/UI Design',
  'Turns a scoped feature into screens, flows and a component list.',
  'You are a product designer. Given a feature or product description, produce '
    || 'the user flows, the screens each flow needs, and a component list with '
    || 'states (empty, loading, error, success). Prefer established patterns over '
    || 'novel ones, name the pattern you are using, and say what you would test '
    || 'with users before building. Write for a developer who will implement it '
    || 'without a mockup: be concrete about layout, hierarchy and copy.',
  'gemini-3-flash-preview',
  40
)
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------------
-- Skill presets. text is loaded when the model calls the tool; description
-- is what it sees beforehand. on conflict do update so editing a skill here
-- and re-applying updates the library. Existing nodes keep their copy.
-- ---------------------------------------------------------------------------
insert into public.tool_presets (slug, tool_type_id, name, description, config, sort_order)
values
  (
    'scoping_brief',
    (select id from public.tool_types where slug = 'skill'),
    'Scoping Brief',
    'The structure of a good scope document.',
    jsonb_build_object(
      'description', 'Load before writing or revising a project scope.',
      'text',
      'Write the scope as these sections, in order, each as short as it can be:' || chr(10)
      || '1. Goal: one sentence, the outcome the user gets, not the feature.' || chr(10)
      || '2. Non-goals: what this deliberately does not do. At least three. This is the most useful section.' || chr(10)
      || '3. Deliverables: concrete things that will exist when done. Each must be checkable: a URL, a file, a passing test, a document.' || chr(10)
      || '4. Milestones: deliverables grouped in the order they unblock each other. Name what each milestone makes possible.' || chr(10)
      || '5. Dependencies: things outside this scope it needs (accounts, data, decisions, other work).' || chr(10)
      || '6. Open questions: what you had to guess. Ask these before inventing answers.' || chr(10)
      || chr(10)
      || 'Rules: no adjectives where a number will do. A deliverable that cannot be checked is a wish, rewrite it. If the user''s ask is larger than one scope, say so and propose the split before scoping the first piece.'
    ),
    20
  ),
  (
    'assumptions_ledger',
    (select id from public.tool_types where slug = 'skill'),
    'Assumptions Ledger',
    'How to surface and track unstated assumptions.',
    jsonb_build_object(
      'description', 'Load when a request has gaps you would otherwise fill by guessing.',
      'text',
      'Keep a running ledger of every assumption you make, as a table: Assumption | Why it matters | How to confirm | Confirmed?' || chr(10)
      || chr(10)
      || 'Add a row whenever you: pick a default the user did not state, infer the audience, infer the platform or stack, infer a budget or deadline, or decide something is out of scope.' || chr(10)
      || chr(10)
      || 'Show the ledger at the end of every substantial reply. Ask about the rows that change the plan most if wrong; leave the rest as stated defaults. Never silently resolve an assumption: if you later learn the answer, mark the row confirmed and say what changed.'
    ),
    21
  ),
  (
    'research_method',
    (select id from public.tool_types where slug = 'skill'),
    'Research Method',
    'How to run a market research pass with search and fetch.',
    jsonb_build_object(
      'description', 'Load at the start of any market or competitor research task.',
      'text',
      'Work in passes, and say which pass you are in.' || chr(10)
      || chr(10)
      || 'Pass 1, frame: restate the question as three to five specific sub-questions (who buys, how big, who else sells, what they charge, what is changing). Do not search yet.' || chr(10)
      || 'Pass 2, search: one search per sub-question, then one more for the strongest disagreement you found. Fetch the two or three most credible pages rather than reading snippets.' || chr(10)
      || 'Pass 3, extract: for each claim record the number, the source, the date, and how it was measured. A number with no date or method is a rumour.' || chr(10)
      || 'Pass 4, report: answer each sub-question in two or three sentences with its sources inline. Then a short section titled What we still do not know.' || chr(10)
      || chr(10)
      || 'Rules: prefer primary sources (company filings, pricing pages, official statistics) over articles about them. Quote prices and sizes with their date. When sources disagree, show both and say which you trust and why. Stop searching when new results repeat what you have; say so rather than padding.'
    ),
    22
  ),
  (
    'source_grading',
    (select id from public.tool_types where slug = 'skill'),
    'Source Grading',
    'How to rate and cite what you found.',
    jsonb_build_object(
      'description', 'Load before presenting findings that rest on web sources.',
      'text',
      'Grade every source you rely on, A to D, and show the grade next to the citation.' || chr(10)
      || 'A: primary and current. Official statistics, filings, the vendor''s own pricing page, a dated dataset.' || chr(10)
      || 'B: reputable secondary, dated, with its own sources named. Trade press, analyst summaries, well-known survey publishers.' || chr(10)
      || 'C: secondary with no visible sourcing, or older than two years for a fast-moving topic.' || chr(10)
      || 'D: forums, marketing copy, content farms, anything undated. Use only to find leads, never as the basis of a claim.' || chr(10)
      || chr(10)
      || 'Cite as: claim (Grade, publisher, date, URL). A conclusion that rests only on C and D sources must say so in the sentence that states it.'
    ),
    23
  ),
  (
    'coding_conventions',
    (select id from public.tool_types where slug = 'skill'),
    'Coding Conventions',
    'How to work inside someone else''s codebase.',
    jsonb_build_object(
      'description', 'Load before writing or changing code in the user''s project.',
      'text',
      'Before writing anything: read the files you will touch and two neighbours that do something similar. Match their naming, error handling, comment density and test style. The codebase''s conventions beat your preferences.' || chr(10)
      || chr(10)
      || 'Make the smallest change that solves the stated problem. No new abstraction for one use. No new dependency for what a few lines do. Do not refactor what you were not asked to touch; mention it instead.' || chr(10)
      || chr(10)
      || 'A bug fix goes where every caller routes through, not in the one caller that was reported. Grep the callers first.' || chr(10)
      || chr(10)
      || 'Comments say what, not why you were clever. Delete code before adding it. When you cut a real corner, mark it with a comment naming the ceiling and the upgrade path.' || chr(10)
      || chr(10)
      || 'Show the diff, then at most three lines: what you skipped and when it would matter.'
    ),
    30
  ),
  (
    'verify_before_done',
    (select id from public.tool_types where slug = 'skill'),
    'Verify Before Done',
    'What counts as evidence that a change works.',
    jsonb_build_object(
      'description', 'Load before claiming a task is finished, fixed, or passing.',
      'text',
      'Nothing is done until you have run it. Use the environment: run the tests, run the script, curl the endpoint, import the module. Paste the actual output, not a description of what it should print.' || chr(10)
      || chr(10)
      || 'If tests fail, say so and show the failure. If you could not run something, say that, not "this should work". If you changed behaviour, add or update the one check that would fail if it broke again.' || chr(10)
      || chr(10)
      || 'End with: what was run, what it printed, what was not verified and why.'
    ),
    31
  ),
  (
    'design_brief',
    (select id from public.tool_types where slug = 'skill'),
    'Design Brief',
    'The structure of a design handoff a developer can build from.',
    jsonb_build_object(
      'description', 'Load before producing screens, flows or a component list.',
      'text',
      'Deliver in this order:' || chr(10)
      || '1. Users and jobs: who, and the one thing each is trying to get done here.' || chr(10)
      || '2. Flows: numbered steps from entry to outcome. One flow per job. Name the decision points and what happens on each branch.' || chr(10)
      || '3. Screens: one per step that needs its own view. For each: purpose, primary action, secondary actions, what is above the fold, what the copy says.' || chr(10)
      || '4. Components: a list of reusable pieces with their states: empty, loading, error, success, disabled. Name the established pattern each follows.' || chr(10)
      || '5. Open questions and what you would test with users first.' || chr(10)
      || chr(10)
      || 'Rules: write for a developer with no mockup. Real copy, not lorem ipsum. Every screen has an empty state and an error state, decide them now. Prefer a boring known pattern over a novel one and say which you chose.'
    ),
    40
  ),
  (
    'accessibility_basics',
    (select id from public.tool_types where slug = 'skill'),
    'Accessibility Basics',
    'The accessibility floor every screen must meet.',
    jsonb_build_object(
      'description', 'Load when specifying any screen, form or interactive component.',
      'text',
      'Every design you hand off meets these, without being asked:' || chr(10)
      || 'Every action reachable by keyboard, in a sensible tab order, with a visible focus state.' || chr(10)
      || 'Text contrast at least 4.5:1 for body, 3:1 for large text and UI borders.' || chr(10)
      || 'Colour is never the only signal. Pair it with text, an icon or a pattern.' || chr(10)
      || 'Every image and icon-only button has a text alternative. Decorative images are marked as such.' || chr(10)
      || 'Every form field has a visible label, and errors say what is wrong and how to fix it, next to the field.' || chr(10)
      || 'Touch targets at least 44 by 44 points. Nothing depends on hover alone.' || chr(10)
      || 'Motion can be reduced; nothing flashes more than three times a second.' || chr(10)
      || chr(10)
      || 'When a requirement conflicts with these, say so and propose the accessible alternative first.'
    ),
    41
  )
on conflict (slug) do update set
  tool_type_id = excluded.tool_type_id,
  name         = excluded.name,
  description  = excluded.description,
  config       = excluded.config,
  sort_order   = excluded.sort_order;

-- ---------------------------------------------------------------------------
-- What each agent arrives with. coding has the scratch environment, so it
-- gets fetch for reading docs but not search.
-- ---------------------------------------------------------------------------
update public.agent_types set default_presets = array['brave_search', 'web_fetch', 'scoping_brief', 'assumptions_ledger']
  where slug = 'project_scoping';
update public.agent_types set default_presets = array['brave_search', 'web_fetch', 'research_method', 'source_grading']
  where slug = 'market_research';
update public.agent_types set default_presets = array['web_fetch', 'coding_conventions', 'verify_before_done']
  where slug = 'coding';
update public.agent_types set default_presets = array['brave_search', 'web_fetch', 'design_brief', 'accessibility_basics']
  where slug = 'ux_ui';

commit;
