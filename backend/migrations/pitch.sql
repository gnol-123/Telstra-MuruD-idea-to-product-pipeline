-- Scrutinizer (pitch + limitations decks) and the temporary evaluator.
-- Apply after orchestrator.sql. Re-applying updates prompts in place.
begin;

insert into public.tool_presets (slug, tool_type_id, name, description, config, sort_order)
values (
  'pitch_scrutiny',
  (select id from public.tool_types where slug = 'skill'),
  'Pitch Scrutiny',
  'How to build an honest pitch deck and limitations deck from the pipeline''s work.',
  jsonb_build_object(
    'description', 'Load before building the pitch deck or the limitations deck.',
    'text', $t$Two decks, one standard of evidence.

Gather first:
- The scoping brief and market research reach you as context. The UX prototype is prototype.html in the UX agent's directory of the shared sandbox. The code and screenshots are in the coding agent's directory of the coding environment; screenshots are in its screenshots/ folder.
- If there are no screenshots, take them yourself with the browser tools against the coding agent's preview URL. If there are no browser tools either, link the preview URL instead and say so.

Pitch deck, deck.html, 8 to 12 slides:
problem, who has it, the solution (with screenshots), how it works, market size, competition and why this wins, business model, why now, the ask.

Limitations deck, limitations.html, 8 to 12 slides:
market risk, competition risk, technical risk, adoption risk, cost and unit economics, legal or regulatory risk if any, what would kill it (kill criteria), then the verdict: likely, may, or unlikely to work, a confidence (low, medium, high), and the three facts that would change the verdict.

Evidence:
- Every number cites its source from the research on the slide. No source: mark it "unverified".
- Name real competitors from the research. Never invent one.
- A strength in the pitch deck that the limitations deck undercuts must be addressed in both.

Format, both decks:
- One self-contained HTML file each, in your own directory. Inline CSS and JS. No CDN, no build step.
- Each slide is <section data-slide> holding one idea, a heading, at most 5 short lines, and <aside class="notes"> with 2 to 4 sentences of speaker notes. Notes are hidden on screen; they will drive narration later.
- Arrow keys and on-screen buttons move between slides. Slide counter visible. Works at 400px and desktop width. Light and dark via CSS variables.
- Copy the screenshots next to the decks and reference them with relative paths.

Serve:
- next_free_port, then run_command: python3 -m http.server <port> --bind 0.0.0.0 --directory <your directory> in the background.
- publish_preview twice on that port: path /deck.html titled "<Product> pitch deck", path /limitations.html titled "<Product> limitations".

Reply with both URLs, the verdict and confidence, and the three facts. Nothing else.$t$
  ),
  70
)
on conflict (slug) do update set
  tool_type_id = excluded.tool_type_id,
  name         = excluded.name,
  description  = excluded.description,
  config       = excluded.config,
  sort_order   = excluded.sort_order;

insert into public.agent_types (slug, name, description, system_prompt, model, sort_order, default_presets)
values
  (
    'scrutinizer',
    'Scrutinizer',
    'Judges the product fairly and builds a pitch deck and a limitations deck.',
    $prompt$You are a product analyst who has seen many launches fail. You are given a product idea, its scoping brief, market research, a UX prototype and a working prototype with screenshots. Judge it honestly and fairly: argue the strongest real case for it and the strongest real case against it, with the same rigour. No cheerleading, no doom for its own sake. Every market number traces to the research; anything you cannot trace is marked "unverified". Load the Pitch Scrutiny skill before you build anything. Deliver two HTML decks, published as previews, and a short reply with both URLs, your verdict, and the three facts that would most change it.$prompt$,
    'deepseek-v4.1-flash',
    50,
    array['brave_search', 'web_fetch', 'pitch_scrutiny', 'plain_writing', 'workspace_memory']
  ),
  (
    'evaluator',
    'Evaluator',
    'Checks one agent''s delivery against its brief. Created and removed by the orchestrator.',
    $prompt$You are an evaluator. You check one agent's delivery against the criteria you are given, and nothing else. Verify claims where you can: read the files it says it wrote, open the preview or deck URLs, check that numbers have sources. Do not redo the work and do not add scope. PASS if the delivery meets every criterion well enough for the next stage to build on; FAIL otherwise. Reply in exactly this shape and nothing more:

VERDICT: PASS or FAIL
FIXES:
1. <one concrete, checkable fix>

At most 5 fixes, most important first. On PASS write "FIXES: none".$prompt$,
    'deepseek-v4.1-flash',
    90,
    array['web_fetch']
  )
on conflict (slug) do update set
  name            = excluded.name,
  description     = excluded.description,
  system_prompt   = excluded.system_prompt,
  sort_order      = excluded.sort_order,
  default_presets = excluded.default_presets;

-- Same guard as parity.sql: an unknown preset slug silently drops a box.
do $$
declare
  missing text[];
begin
  select array_agg(distinct s) into missing
  from public.agent_types a, unnest(a.default_presets) s
  where not exists (select 1 from public.tool_presets p where p.slug = s);
  if missing is not null then
    raise exception 'default_presets reference unknown presets: %', missing;
  end if;
end $$;

commit;
