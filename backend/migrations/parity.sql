-- Agent parity: Context7 docs on a platform key, distilled process skills,
-- and the default lists that give each agent a standard agent's capabilities.
-- Apply after defaults.sql.
begin;

-- ---------------------------------------------------------------------------
-- context7: its own type row over the generic MCP handler, so a platform
-- token can attach to this slug without reaching user-added mcp_server boxes.
-- ---------------------------------------------------------------------------
insert into public.tool_types (slug, name, description, config_schema, secret_fields, sort_order)
values (
  'context7',
  'Context7',
  'Up-to-date library and framework documentation.',
  '{"default_url": "https://mcp.context7.com/mcp",
    "fields": [
      {"key": "auth_token", "label": "API key", "type": "password", "required": false,
       "help": "Optional. The platform key is used when this is empty."}
    ]}'::jsonb,
  array['auth_token'],
  12
)
on conflict (slug) do update set
  name          = excluded.name,
  description   = excluded.description,
  config_schema = excluded.config_schema,
  secret_fields = excluded.secret_fields,
  sort_order    = excluded.sort_order;

insert into public.tool_presets (slug, tool_type_id, name, description, config, sort_order)
values (
  'context7',
  (select id from public.tool_types where slug = 'context7'),
  'Context7',
  'Library docs lookup. Platform key by default.',
  '{}'::jsonb,
  12
)
on conflict (slug) do update set
  tool_type_id = excluded.tool_type_id,
  name         = excluded.name,
  description  = excluded.description,
  config       = excluded.config,
  sort_order   = excluded.sort_order;

-- ---------------------------------------------------------------------------
-- Coding skills. Distilled: the rules that change behaviour, loaded on demand.
-- Dollar-quoted so apostrophes and newlines are literal.
-- ---------------------------------------------------------------------------
insert into public.tool_presets (slug, tool_type_id, name, description, config, sort_order)
values
  (
    'plan_before_code',
    (select id from public.tool_types where slug = 'skill'),
    'Plan Before Code',
    'How to plan a change that touches more than one file.',
    jsonb_build_object(
      'description', 'Load before any change that touches more than one file.',
      'text', $t$Read before you plan. Open every file the change will touch and two neighbours that do something similar. Trace the real flow end to end: who calls what, where the data comes from, where it goes. A plan written before reading is a guess with a numbered list.

Then write the plan as steps, each one small enough to check on its own:
1. The file and the exact change.
2. The one check that proves it: a test, a command, a curl, a printed value.
3. What it unblocks.

Order steps so each one leaves the code working. Never a step that only makes sense once three later steps land.

Rules:
- Smallest diff that solves the stated problem. If a step exists "for later", delete it.
- Reuse what is already in the codebase before writing anything new. A helper three files over beats a fresh one.
- Name the risky step. Say what you will do if it fails.
- If you find the task is bigger than it looked, stop and say so before continuing. Do not quietly grow the plan.

Execute one step at a time. Run its check. If the check fails, stop at that step, fix it, re-run. Do not push on to the next step with a red check behind you.

When done, report: the steps taken, the checks run and what they printed, and anything you skipped.$t$
    ),
    50
  ),
  (
    'tdd',
    (select id from public.tool_types where slug = 'skill'),
    'Test Driven Development',
    'The red, green, refactor loop for any behaviour change.',
    jsonb_build_object(
      'description', 'Load before writing or changing code that has behaviour.',
      'text', $t$Write the test first. Then the code. In that order, every time there is behaviour to get right.

The loop:
1. RED: write one test for the next small piece of behaviour. Run it. It must fail, and fail for the right reason: "function not defined" or a wrong value, not a syntax error or a missing import. If it passes before you wrote the code, the test proves nothing. Fix the test.
2. GREEN: write the least code that makes it pass. Not the general solution, not the clean one. The least.
3. REFACTOR: now clean it, with the test as the safety net. Run the test again.
4. Next piece.

What a real test looks like:
- It calls the code and asserts on the result or the side effect. A test that only checks a mock was called tests the mock.
- It has a name that states the behaviour: test_expired_token_is_rejected, not test_auth_2.
- It covers the edge the code is most likely to get wrong: empty input, the boundary, the failure path.
- One behaviour per test. When it fails, the name says what broke.

Rules:
- Never write the implementation first and "add tests after". After means never, and the tests you add then only confirm what you already built.
- Never delete or weaken a failing test to get green. A failing test is information.
- Trivial one-liners with no branching need no test. Everything with an if, a loop, a parser, or a money or security path needs one.
- Run the whole relevant test file before saying done, and paste what it printed.$t$
    ),
    51
  ),
  (
    'systematic_debugging',
    (select id from public.tool_types where slug = 'skill'),
    'Systematic Debugging',
    'How to find a root cause instead of patching a symptom.',
    jsonb_build_object(
      'description', 'Load when something fails, errors, or behaves unexpectedly, before proposing any fix.',
      'text', $t$No fix before you understand the failure. Guessing at fixes is how a one-line bug becomes a three-file bug.

1. Reproduce it. Run the failing thing yourself and see the actual output. If you cannot reproduce it, you cannot know you fixed it.
2. Read the error. All of it. The stack trace names the file and line; the message names the value. Most bugs are stated plainly in the first error and buried under the ones it caused.
3. Form one hypothesis. Say it out loud: "X is None here because Y never sets it when Z". One, not three.
4. Test it with the cheapest probe: a print, an assert, a one-line script, a single test run. Do not rewrite code to test a hypothesis.
5. If the probe disproves it, go back to 3 with what you learned. If it confirms it, you have the cause.
6. Find where the cause lives. A symptom reported in one caller is usually a bug in the function every caller shares. Grep the callers before you edit. Fix it once, where all paths route through, not in the one path the report named.
7. Add the check that would have caught it: a test that fails on the old code and passes on the new.
8. Re-run the original reproduction. It must pass. Then run the surrounding tests: the fix must not break a neighbour.

Rules:
- Never fix two things at once. If you notice a second bug, note it and finish the first.
- Never "try a few things and see". Each change is a hypothesis with a prediction.
- If three hypotheses in a row fail, stop. Re-read the error from the top. You have misread something.
- Report: what failed, why, what you changed, and the test that now guards it.$t$
    ),
    52
  ),
  (
    'code_review',
    (select id from public.tool_types where slug = 'skill'),
    'Code Review',
    'How to review code for correctness first, then for what to delete.',
    jsonb_build_object(
      'description', 'Load before declaring code finished, or when asked to review a change.',
      'text', $t$Review in two passes, in this order.

Pass 1, correctness. Read the diff as if you will be paged when it breaks.
- Does it do what was asked, nothing missing, nothing extra?
- Every branch: what happens on the empty case, the error case, the boundary?
- Every external call: what if it times out, returns nothing, returns garbage?
- Every write: can it run twice? Can it half-complete?
- Do the tests exercise the behaviour, or just the mocks?

Pass 2, subtraction. Now hunt for what to delete.
- Code that re-implements the standard library or an existing helper in this codebase.
- An abstraction with one implementation. An interface with one caller. A config value that never changes.
- Flexibility nobody asked for: options, flags, parameters with one value ever passed.
- Comments that explain what the code plainly does.
- Anything "for later". Later can write its own code.

Report format, every finding:
- file:line
- what is wrong, in one sentence
- why it matters: what breaks, or what it costs to keep
- how to fix, if not obvious

Severity, honestly:
- Critical: wrong output, data loss, security. Must fix.
- Important: a missed requirement, a fragile path, or maintainability damage you would block a merge over.
- Minor: polish. Say so; do not dress it up.

Say what is done well, specifically, before the issues. Give a clear verdict at the end: ready, ready with fixes, or not ready. Never "looks good" without having read every line.$t$
    ),
    53
  ),
  (
    'security_basics',
    (select id from public.tool_types where slug = 'skill'),
    'Security Basics',
    'The floor every change that touches input, secrets, URLs, or shell must meet.',
    jsonb_build_object(
      'description', 'Load when code touches user input, auth, secrets, URLs, files, or shell commands.',
      'text', $t$These are not optional and are not simplified away, ever.

Input at a trust boundary:
- Validate shape and bounds at the edge (request body, CLI arg, file read), not deep inside. Reject, do not coerce, when it is wrong.
- Never build SQL, shell, or HTML by string concatenation with user data. Parameterise queries. Pass shell arguments as a list, never a joined string. Escape on output.

Secrets:
- Never log, print, echo, or return a secret, a token, or a password, including in error messages and test output. Log the key name, never the value.
- Never write a secret to a file the user did not name for that purpose, and never into anything that gets checkpointed or committed.
- Read secrets from the environment or a vault; never hardcode, never put a default value that is a real credential.

Network:
- A URL from the user or from a model is untrusted. Only http and https. Refuse loopback, private, and link-local addresses, including after redirects.
- Set timeouts on every outbound call. Cap response sizes.

Auth and access:
- Check ownership on every read and write, not just on create. A row id in a request is a claim, not proof.
- Least privilege: an elevated client or key is used at one named site, for one named reason, and nowhere else.

Files and shell:
- Resolve paths and confirm they stay inside the directory they should. ".." is an attack, not an edge case.
- Never run a command whose text came from outside without an allowlist.

When a requirement conflicts with one of these, say so and propose the safe alternative first. When you cut a corner elsewhere, this is the list you did not cut.$t$
    ),
    54
  ),
  (
    'working_in_a_repo',
    (select id from public.tool_types where slug = 'skill'),
    'Working in a Repo',
    'How to change a repository that has history without making a mess.',
    jsonb_build_object(
      'description', 'Load before changing a repository that has git history.',
      'text', $t$First, orient. Run git status and git log --oneline -20. Read the README and any CONTRIBUTING or AGENTS file. Look at how the last few commits were written. You are a guest in someone else's history.

Branching:
- Never commit directly to main or master. Create a branch named for the work: feature/short-description or fix/short-description.
- One branch, one purpose. Unrelated fixes you notice go in a note, not in this branch.

Commits:
- Small and whole: each commit leaves the code working and says one thing.
- Message in the imperative, first line under 72 characters, saying what and why, not how: "fix: reject expired tokens on refresh", not "changes to auth".
- Never commit secrets, .env files, build output, or anything the .gitignore excludes. Check git status before every commit and read what is staged.
- Never rewrite history that has been shared. No force push to a branch anyone else has.

Before saying the work is done:
- Run the project's tests and linter the way the project runs them. Paste what they printed.
- git diff main...HEAD and read your whole change once as a reviewer would.
- State plainly what you did not verify.

Handing off:
- Say which branch, what it changes, how you tested it, and what a reviewer should look at first.
- Do not merge, push to a shared branch, or open a pull request unless asked. Those are the user's calls.$t$
    ),
    55
  )
on conflict (slug) do update set
  tool_type_id = excluded.tool_type_id,
  name         = excluded.name,
  description  = excluded.description,
  config       = excluded.config,
  sort_order   = excluded.sort_order;

-- ---------------------------------------------------------------------------
-- Cross-role skills.
-- ---------------------------------------------------------------------------
insert into public.tool_presets (slug, tool_type_id, name, description, config, sort_order)
values
  (
    'brainstorming',
    (select id from public.tool_types where slug = 'skill'),
    'Brainstorming',
    'How to turn a vague ask into an agreed design before building.',
    jsonb_build_object(
      'description', 'Load before designing or building anything new, before any implementation step.',
      'text', $t$Do not build yet. First find out what is actually wanted.

1. Classify the ask, out loud, so the user can correct you:
   - A question: answer it. No design needed.
   - A bounded change to something that exists: a few clarifying questions, then a short design in a few sentences, then wait for a yes.
   - Something new or a change to how pieces fit together: the full process below.
   When unsure between two, take the heavier one.

2. Ask questions one at a time. Multiple choice when you can. Focus on purpose, constraints, and what "done" looks like. Stop asking when the next question would not change the design.

3. If the ask is really several independent things, say so first and propose the split. Do not refine the details of something that needs to be broken up.

4. Propose two or three approaches with trade-offs. Lead with the one you recommend and say why. Cut anything from every approach that nobody asked for.

5. Present the design in sections sized to their complexity: a few sentences when simple, a short paragraph when not. Cover what it does, the pieces, how data moves, what happens on failure, how it is tested. Ask after each section whether it is right so far.

6. Get an explicit yes before any implementation. "Simple" tasks are where unexamined assumptions cost the most, so the approval never gets skipped; only the length of the design does.

Rules:
- Never start building while the user is still reading the design.
- If you discover mid-task that the thing is bigger than classified, stop and reclassify. Nothing downgrades mid-task.
- Prefer boring, known patterns. Name the pattern you chose.$t$
    ),
    60
  ),
  (
    'workspace_memory',
    (select id from public.tool_types where slug = 'skill'),
    'Workspace Memory',
    'How to remember across sessions with a notes file in your workspace.',
    jsonb_build_object(
      'description', 'Load at the start of a session in a project you may have worked in before.',
      'text', $t$Your memory between sessions is a file: NOTES.md in your own workspace directory. Nothing else persists. Treat it as the one place facts go to survive.

At the start of a session:
- list_files your workspace. If NOTES.md exists, read_file it before doing anything else. What it says was true when written; verify anything that matters before relying on it.

What goes in, as short dated entries, newest at the bottom:
- Decisions the user made, and why. "2026-09-14: target is SMB fintech, not enterprise; user said enterprise sales cycle is too slow."
- Constraints you learned: stacks, budgets, deadlines, things that must not change.
- What was tried and did not work, so it is not tried again.
- Where things are: files you created, URLs you were given, names that matter.
- Open questions the user has not answered.

What stays out:
- Anything the code or the transcript already records.
- Secrets, tokens, passwords. Never. Log the name of a secret, not its value.
- Narration of what you did. Facts, not a diary.

How to write:
- Append, never rewrite. If a fact changes, add a new entry that says it changed and why. History is the point.
- One fact per line, plain statements: "The API key lives in the environment", not "we discussed where keys should go".
- Keep it under a screen or two. When it grows past that, add a short summary section at the top and leave the log below.

Other agents in this project can read your directory. Write for them too: a note another agent can act on is worth more than one only you understand.$t$
    ),
    61
  ),
  (
    'prototype_design',
    (select id from public.tool_types where slug = 'skill'),
    'Prototype Design',
    'How to build a clickable HTML prototype in the workspace and serve it.',
    jsonb_build_object(
      'description', 'Load before building a screen, a page, or a clickable prototype.',
      'text', $t$A prototype is one HTML file the user can open and click. Not a framework, not a build step, not a design description.

Build it:
- One file, prototype.html, in your workspace directory, written with write_file. Inline CSS in a style tag, inline JS in a script tag. No package installs, no bundler.
- Real copy, not lorem ipsum. Real button labels, real error messages, real empty states.
- Every screen has its states: empty, loading, error, success. Fake the data; make the states real.
- Works at 400px wide and at desktop width. One outer wrapper with at least 16px side padding. Nothing scrolls sideways.
- Light and dark: define colours once as CSS variables on :root, override them under prefers-color-scheme: dark. Never a colour defined only in the dark block.
- Keyboard reachable: every action is a button or a link, focus is visible, tab order makes sense.
- Contrast at least 4.5:1 for text. Colour is never the only signal.
- Navigation between screens by showing and hiding sections with JS, so one file holds the whole flow.

Serve it:
- run_command: python3 -m http.server 8080 --directory <your workspace dir> in the background, and give the user the preview URL for port 8080. If a port is already serving, reuse it.
- Say which screens exist and how to move between them.

Hand it off:
- A short list: screens, the flow between them, the components a developer would extract, and what you would test with users first.
- Name the established pattern each screen follows. Prefer boring and known over novel.

Keep the file under a few hundred lines. If it grows past that, the prototype is trying to be the product; cut scope, do not add structure.$t$
    ),
    62
  ),
  (
    'dataviz',
    (select id from public.tool_types where slug = 'skill'),
    'Data Visualisation',
    'How to choose and draw a chart that answers the question asked.',
    jsonb_build_object(
      'description', 'Load before drawing any chart, graph, or table of numbers.',
      'text', $t$A chart answers one question. Decide the question before choosing the mark.

Pick the form from the question:
- Compare categories: horizontal bars, sorted by value, largest first.
- Show a trend over time: a line. Time on the x axis, left to right.
- Part of a whole: a stacked bar, or just the numbers. Avoid pies past three slices.
- Distribution: a histogram or a box plot.
- Relationship between two measures: a scatter.
- A single number that matters: print the number large, with its unit and its comparison ("up 12% vs last quarter").
If two forms fit, pick the simpler one.

Draw it honestly:
- Axes start at zero for bars. Label every axis with the unit. Title states the takeaway, not the topic: "Churn doubled after the price change", not "Churn by month".
- Source and date under the chart, always.
- Colour: one accent for the thing that matters, grey for everything else. Never more than five categorical colours. Never rely on colour alone; label directly on the chart where you can.
- No 3D, no gradients, no decorative gridlines. Every pixel that is not data should earn its place.
- Legible at 400px wide. If it is not, it is a table.

How to produce it in the workspace:
- One self-contained HTML file with an inline SVG or a canvas drawn by inline JS; no chart library installs. Serve it with python3 -m http.server and give the preview URL.
- Or, when the reader needs the numbers more than the shape, a markdown table with units in the header.

Before you show it: read the chart cold. Can someone get the point in five seconds without you explaining? If not, simplify until they can.$t$
    ),
    63
  ),
  (
    'plain_writing',
    (select id from public.tool_types where slug = 'skill'),
    'Plain Writing',
    'How to write prose that does not read as machine generated.',
    jsonb_build_object(
      'description', 'Load before writing any prose a person will read: a report, a summary, a brief, a message.',
      'text', $t$Write so a person who knows the subject would recognise their own voice. Three levels, and the third matters most.

Typography:
- No em dashes. Use a comma, a colon, parentheses, or two sentences. This is the strongest single tell.
- Sentence case in headings, not Title Case. Bold only where it buys clarity, not on every key term.
- Fewer than four items is prose, not a bullet list.

Words and phrases to cut:
- Inflated significance: stands as a testament, pivotal moment, indelible mark, setting the stage for, evolving landscape.
- AI vocabulary: delve, tapestry, intricate, interplay, crucial, showcase, underscore, vibrant, enhance, fostering, garner, and Additionally as a paragraph opener.
- Fancy substitutes for is and has: serves as, stands as, boasts, features.
- Negative parallelism: not just X but Y, it is not about X it is about Y. Say the thing directly.
- Promotional tone: nestled, breathtaking, groundbreaking, renowned, stunning, game-changing.
- Superficial -ing tails: highlighting the importance of, ensuring that, reflecting a broader, showcasing. Delete them, or replace with a real cause and a real source.
- Assistant chatter: I hope this helps, Let me know if, Of course, Certainly, Great question.
- Filler: in order to (use to), due to the fact that (use because), it is important to note that (delete), when it comes to (delete).

Structure, the part that gives it away:
- State the conclusion once. No closing paragraph that restates what was just read.
- Vary sentence and paragraph length. Three same-shaped paragraphs in a row reads as generated.
- Real specifics only. Never invent a number, a date, a name, or an example to add life. Studies show and most teams are tells and usually fabrications. Every claim traces to data, a stated assumption, marked judgment, or an admitted gap.
- Address the reader as you where the genre permits.
- Let an ending stay open when nothing resolves it. False resolution is a tell.
- Not every sentence carries maximum load. Uniform intensity is machine-like.
- Do not improve a plain construction a person would naturally write. Plain is the target.

Never change a fact, a quotation, an identifier, or an error string to make prose flow. If a fix would alter what is true, keep the truth and rephrase around it.$t$
    ),
    64
  )
on conflict (slug) do update set
  tool_type_id = excluded.tool_type_id,
  name         = excluded.name,
  description  = excluded.description,
  config       = excluded.config,
  sort_order   = excluded.sort_order;

-- ---------------------------------------------------------------------------
-- What each agent arrives with. Tools first, then skills in the order the
-- model should reach for them.
-- ---------------------------------------------------------------------------
update public.agent_types set default_presets = array[
  'brave_search', 'web_fetch',
  'brainstorming', 'scoping_brief', 'assumptions_ledger', 'plain_writing',
  'workspace_memory'
] where slug = 'project_scoping';

update public.agent_types set default_presets = array[
  'brave_search', 'web_fetch',
  'research_method', 'source_grading', 'dataviz', 'plain_writing',
  'workspace_memory'
] where slug = 'market_research';

update public.agent_types set default_presets = array[
  'web_fetch', 'context7',
  'plan_before_code', 'coding_conventions', 'tdd', 'systematic_debugging',
  'code_review', 'security_basics', 'verify_before_done', 'working_in_a_repo',
  'plain_writing', 'workspace_memory'
] where slug = 'coding';

update public.agent_types set default_presets = array[
  'brave_search', 'web_fetch',
  'brainstorming', 'design_brief', 'prototype_design', 'accessibility_basics',
  'plain_writing', 'workspace_memory'
] where slug = 'ux_ui';

commit;
