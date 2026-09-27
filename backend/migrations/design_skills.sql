-- Design skills for the UX/UI and Scrutinizer agents: Design Taste, Impeccable
-- and Emil Design Engineering. Distilled from open-source agent skills, credited
-- in each body. Apply after runtime.sql. Re-runnable.
begin;

-- ---------------------------------------------------------------------------
-- The skills. Each one owns a lane so the three don't talk over each other:
-- Taste picks the direction and refuses the AI defaults, Impeccable holds the
-- craft floor, Emil tunes motion and interaction feel.
-- Dollar-quoted so apostrophes and newlines are literal.
-- ---------------------------------------------------------------------------
insert into public.tool_presets (slug, tool_type_id, name, description, config, sort_order)
values
  (
    'design_taste',
    (select id from public.tool_types where slug = 'skill'),
    'Design Taste',
    'Reads the brief, picks a design direction and avoids the looks every AI ships.',
    jsonb_build_object(
      'description', 'Load before choosing the look of a page, prototype or deck: layout, type, colour, imagery.',
      'text', $t$Adapted from taste-skill by Leon Lin (github.com/Leonxlnx/taste-skill, MIT).

Most generated design is bad because the model jumps to a default look instead of reading the brief. Read first, then decide.

Delivery rules from other skills win: if the deliverable is one self-contained HTML file with no installs, everything below happens inside that file. Interaction patterns stay familiar; the visual layer is where you commit.

1. Read the brief
Before any code, write one line: "Reading this as: <page kind> for <audience>, with a <vibe> language, leaning toward <aesthetic family>."
Signals: the kind of surface (landing page, app screen, pitch deck), the words the user used for the feel, products or references they named, the audience, brand assets that already exist, and quiet constraints (public sector, regulated, kids, accessibility-first). Quiet constraints override taste. The audience picks the aesthetic, not you.
If the read genuinely forks, ask one question. If you can infer it, don't ask.

2. Set three dials, 1 to 10
- Variance: 1 is perfect symmetry, 10 is asymmetric and art-directed.
- Motion: 1 is static, 10 is choreographed.
- Density: 1 is gallery-airy, 10 is cockpit-packed.
Defaults: marketing page 8/6/4, calm or minimal 5/3/3, trust-first or public sector 3/2/5, pitch deck 6/4/3, app screen 4/4/6. State the values you chose. Above variance 4, asymmetric layouts collapse to one column under 768px.

3. Refuse the AI defaults
Unless the brief asks for them by name:
- No purple or blue glow gradients, no neon outer glows, no gradient text on headings.
- No centred hero over a dark mesh. No row of three identical feature cards.
- No Inter as the automatic choice. No Fraunces or Instrument Serif. Serif only when the brand is genuinely editorial, luxury or heritage and you can say why this serif fits this brand. "Creative brief means serif" is the most tested AI tell.
- No warm cream background with brass, clay or oxblood accents and espresso text as the reflex for premium or craft products.
- No pure #000 or #fff. Use an off-black and an off-white.
- No emoji or unicode glyphs as icons. Use one icon set, inline SVG copied from a real library (Phosphor, Tabler), one stroke width throughout.
- No fake product screenshots built from div rectangles. Use a real screenshot, a real mini component, or none.
- No generic names or numbers: no Acme, no John Doe, no 99.99%. Invented demo data is labelled as sample.
- No filler verbs: elevate, seamless, unleash, next-gen, revolutionize.
- No em dashes anywhere visible. Use a comma, colon, full stop or hyphen.

4. Colour, type and shape locks
- One accent colour, used the same way on every section. Saturation under 80% unless the brand says otherwise.
- One theme per page. Sections don't flip from dark to light mid-scroll.
- One corner radius system: all sharp, all soft (12 to 16px), or pill buttons with a written rule for everything else.
- Pair type deliberately. Emphasis inside a headline uses the italic or bold of the same family, never a second family.
- Italic display type with descenders (g j p q y) needs line-height 1.1 or more, or the descenders clip.

5. Layout discipline
- The opening screen fits the viewport: headline at most 2 lines, subtext at most 20 words, the main action visible without scrolling.
- At most 4 text elements in a hero: optional small label, headline, subtext, actions (1 primary, at most 1 secondary).
- Small uppercase labels above headings: at most one per three sections.
- Never repeat a section layout family on one page. Never three image-plus-text zigzags in a row.
- Cards only when elevation means hierarchy. Otherwise group with space or a single divider.
- A grid has exactly as many cells as you have content. No empty tiles.
- More than 5 items is a different component (grouped columns, tabs, scroll-snap row), not a longer list.

6. States and contrast
Every interactive surface has loading, empty and error states, not just the happy path. Every button label passes 4.5:1 against its fill. Button labels fit on one line and one intent has one label across the page ("Get started" everywhere, not three variants).

7. Pre-flight
Before handing off, check: design read stated, dials stated, zero em dashes, one theme, one accent, one radius system, hero fits, label count, no repeated layout family, no default-AI tells from step 3, contrast on every button and input, states present. If any check fails, fix it before you reply.$t$
    ),
    71
  ),
  (
    'impeccable',
    (select id from public.tool_types where slug = 'skill'),
    'Impeccable',
    'Commits to a bold visual direction and holds a craft floor while building it.',
    jsonb_build_object(
      'description', 'Load before building or critiquing any interface, page or deck, and again before you call it done.',
      'text', $t$Adapted from Impeccable by Paul Bakaus (github.com/pbakaus/impeccable, Apache-2.0).

Approach every design task as an award-winning design director: a clear point of view, real understanding of the user, and finished craft. Safe and timid is the failure mode.

Principles
- Finish it. The deliverable is complete except for assets only the user can provide.
- The brief wins. Honour any pinned aesthetic, era, font or palette, even when it matches a pattern this skill warns about.
- Refinement keeps the existing identity, behaviour and copy. A redesign keeps the product's facts and function but replaces the old look rather than polishing it.
- Verify in bounded passes: build fully, inspect once at desktop and mobile width, fix everything in one batch, confirm once more, stop.

Pick the mode from the surface, not the product
- Persuade (landing pages, pitch decks): the visitor decides and acts. Earn attention, make the offer clear, show the main action.
- Operate (app screens, dashboards, settings): the visitor completes a task. Scanability, consistency and familiar controls outrank expression. Brand lives in precise details.
- Read (docs, reports, articles): the visitor understands something. Structure for comprehension, then make it worth staying in.
- Experience (portfolios, showcases): the work leads from the first screen; the interface recedes.

Commit to a world
- Name the product's one unique mechanism, the audience's real scene, and what this first screen must prove.
- Pick a colour strategy before colours: Restrained (neutrals plus one accent, the default for Operate and Read), Committed (one saturated colour carries 30 to 60% of the surface), Full palette (3 or 4 named roles), or Drenched (the surface is the colour). Persuade surfaces may take the bolder strategies.
- Light or dark is never a default. Write one sentence of physical scene (who uses this, where, under what light) and let it decide.
- Choose faces like objects from the subject's world. Operate and Read are well served by good system or workhorse UI faces. For Persuade, these defaults mean you stopped looking: Fraunces, Playfair Display, Cormorant, Lora, Syne, Space Grotesk, Space Mono, IBM Plex, DM Sans, Outfit, Plus Jakarta Sans, Inter as display. If the file must be self-contained, embed the face or use a deliberate system stack; never fall back to Arial by accident.
- Self-check: AI interfaces cluster on three looks: cream ground with a serif display and a terracotta accent; near-black with one neon accent and glowing edges; editorial hairlines with italic serif and tiny tracked mono labels. Where the brief leaves the look open, landing on one of these means rework.
- The first screen is a thesis, not a header. Show the mechanism at work. Prove, don't claim: specific content a competitor could not copy-paste. Claims (prices, customers, benchmarks) come from supplied facts only; illustrative data is labelled as sample.

Craft floor: check the built result, not the intention
- Contrast: body text 4.5:1, large text 3:1. On coloured surfaces tint secondary text from that hue, never plain grey.
- Depth: shadows have an offset and a soft blur. A zero-offset coloured halo is decoration.
- Spacing: tight inside groups, generous between them, more space above a heading than below it.
- Type: body line length 65 to 75 characters, display text at most 6rem, letter-spacing no tighter than -0.04em, obvious steps in size and weight.
- Motion: one authored moment, not the same fade-in on every section. Ease out from an already-visible default.
- States: hover, focus, disabled, loading, error, empty. Real content, working controls.
- Browser surfaces carry the design too: text selection colour, caret, focus rings, scrollbars, link underline offset, tabular numerals in data.
- Copy: controls name their action; errors name the problem and the recovery.
- Coverage: every requirement in the brief is present and findable within seconds.

Refuse unless the brief earns it
- Same-size cards of icon, heading and text as the page structure. Cards nested in cards.
- The hero-metric template: big number, small label, supporting stats.
- A small label above every heading. Section numbers like 01 / 02 / 03 unless the order is information.
- A modal for a task that needs no interruption.
- Gradient text. Glass and blur as decoration. Coloured left or right border stripes on cards and callouts.
- Hard offset block shadows outside a genuinely neo-brutalist world.
- Sparklines, progress rings and rounded rectangles standing in for real content.
- Monospace as a costume for "technical". Emoji or unicode as an icon system.
- Stripe or grid-line backgrounds with nothing measured underneath.

When torn between refined and committed, commit.$t$
    ),
    72
  ),
  (
    'emil_design_eng',
    (select id from public.tool_types where slug = 'skill'),
    'Emil Design Engineering',
    'Animation and interaction polish: when to animate, easing, timing, press feedback.',
    jsonb_build_object(
      'description', 'Load before adding any animation, transition or interactive feedback, and when reviewing how an interface feels.',
      'text', $t$Adapted from emil-design-eng by Emil Kowalski (github.com/emilkowalski/skills, MIT).

Unseen details compound. Most users never notice them consciously; together they are why an interface feels right. Beauty is leverage: good defaults and good motion are real differentiators.

Should this animate at all?
- Seen 100+ times a day (shortcuts, command palette): never animate.
- Tens of times a day (hover, list navigation): remove or drastically reduce.
- Occasional (modals, drawers, toasts): standard animation.
- Rare or first time (onboarding, celebrations): room for delight.
Never animate keyboard-initiated actions. Every animation needs a purpose: spatial consistency, state change, explanation, feedback, or preventing a jarring jump. "It looks cool" on something seen often is not a purpose.

Easing
- Entering or exiting: ease-out. Moving on screen: ease-in-out. Hover or colour change: ease. Constant motion: linear.
- Never ease-in for UI. It delays the first movement, the moment the user watches most.
- Built-in CSS curves are weak. Use custom ones:
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
  --ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);

Duration
Press feedback 100 to 160ms. Tooltips and small popovers 125 to 200ms. Dropdowns 150 to 250ms. Modals and drawers 200 to 500ms. UI animation stays under 300ms; a 180ms dropdown feels faster than a 400ms one. Exits are faster than entrances.

Component details
- Pressables scale to 0.97 on :active with a 160ms ease-out transform. Keep it between 0.95 and 0.98.
- Never animate from scale(0). Start at scale(0.95) with opacity 0.
- Popovers scale from their trigger, not the centre. Modals stay centred.
- Tooltips wait before the first one opens; once one is open, neighbours open instantly with no animation.
- Use transitions, not keyframes, for anything triggered rapidly. Transitions retarget mid-flight; keyframes restart from zero.
- When a crossfade still looks like two objects swapping, add filter: blur(2px) during the transition. Keep blur under 20px.
- Animate entry without JS using @starting-style.
- translateY(100%) moves an element by its own height, whatever that height is. Prefer percentages to hard-coded pixels.
- clip-path: inset() is a strong animation tool: reveals, hold-to-confirm fills, tab highlights, comparison sliders.
- Stagger groups by 30 to 80ms per item. Never block interaction while a stagger plays.
- Slow where the user is deciding (hold-to-delete: 2s linear), fast where the system responds (release: 200ms ease-out).
- Match motion to personality: a playful component can bounce a little (0.1 to 0.3), a professional tool should be crisp.

Drag and gesture
Dismiss on velocity, not only distance: a flick over about 0.11 px/ms is enough. Past a boundary, add friction instead of a hard stop. Capture the pointer once dragging starts. Ignore extra touch points mid-drag.

Performance
Animate only transform and opacity; padding, margin, width and height trigger layout. Update transform on the element directly rather than a CSS variable on a parent with many children. CSS animations stay smooth when the main thread is busy; JS frame loops drop frames.

Accessibility
Under prefers-reduced-motion, keep opacity and colour changes that aid understanding and remove movement. Gate hover effects behind @media (hover: hover) and (pointer: fine) so touch taps don't trigger them.

Review format
When reviewing UI, reply with one markdown table, columns Before | After | Why, one row per issue. Check for: transition: all, scale(0) entrances, ease-in on UI, centred popover origins, animated keyboard actions, UI durations over 300ms, ungated hover effects, keyframes on rapidly triggered elements, equal enter and exit speeds, and groups that appear all at once.$t$
    ),
    73
  )
on conflict (slug) do update set
  tool_type_id = excluded.tool_type_id,
  name         = excluded.name,
  description  = excluded.description,
  config       = excluded.config,
  sort_order   = excluded.sort_order;

-- ---------------------------------------------------------------------------
-- Defaults. Direction first (taste), then the craft floor, then motion polish.
-- These overwrite the lists parity.sql and pitch.sql set, so keep them whole.
-- ---------------------------------------------------------------------------
update public.agent_types set default_presets = array[
  'brave_search', 'web_fetch',
  'brainstorming', 'design_brief', 'prototype_design',
  'design_taste', 'impeccable', 'emil_design_eng',
  'accessibility_basics', 'plain_writing', 'workspace_memory'
] where slug = 'ux_ui';

update public.agent_types set default_presets = array[
  'brave_search', 'web_fetch', 'pitch_scrutiny',
  'design_taste', 'impeccable', 'emil_design_eng',
  'plain_writing', 'workspace_memory'
] where slug = 'scrutinizer';

-- ---------------------------------------------------------------------------
-- Backfill the three skills onto existing UX/UI and Scrutinizer agents.
-- Scoped to these slugs only: parity.sql's backfill rewires every default,
-- which would resurrect boxes a user deleted.
--
-- Skills verify on non-empty text alone (app/tools/skills.py), so they land
-- 'ready' rather than 'pending'. Same CTE shape and caveat as parity.sql:
-- `wanted` is referenced twice so gen_random_uuid() stays stable per row.
-- ---------------------------------------------------------------------------
with wanted as (
  select
    gen_random_uuid() as tool_id,
    n.id              as agent_id,
    n.project_id,
    n.owner_id,
    n.position_x,
    n.position_y,
    p.tool_type_id,
    p.name            as preset_name,
    p.config          as preset_config,
    row_number() over (partition by n.id order by p.sort_order) - 1 as slot
  from public.nodes n
  join public.agent_types a on a.id = n.agent_type_id
  join public.tool_presets p
    on p.slug in ('design_taste', 'impeccable', 'emil_design_eng') and p.is_active
  where n.kind = 'agent'
    and a.slug in ('ux_ui', 'scrutinizer')
    and not exists (
      select 1
      from public.edges e
      join public.nodes tn on tn.id = e.source_node_id
      where e.target_node_id = n.id
        and e.kind = 'tool'
        and tn.name = p.name
    )
),
created as (
  insert into public.nodes
    (id, project_id, owner_id, kind, tool_type_id, name, config,
     position_x, position_y, status, status_detail, last_checked_at)
  select
    w.tool_id, w.project_id, w.owner_id, 'tool', w.tool_type_id,
    w.preset_name, w.preset_config,
    w.position_x - 260, w.position_y + w.slot * 90,
    'ready', 'Skill ready.', now()
  from wanted w
  returning id
)
insert into public.edges (project_id, owner_id, source_node_id, target_node_id, kind)
select w.project_id, w.owner_id, w.tool_id, w.agent_id, 'tool'
from wanted w
where w.tool_id in (select id from created)
on conflict (source_node_id, target_node_id, kind) do nothing;

-- Same guard as parity.sql: a default slug with no preset fails loudly here
-- instead of silently never appearing on new agents.
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
