# API

Base URL is the deployed service, or `http://localhost:8000` locally.
Interactive docs are at `/docs`.

Authenticated endpoints take the access token from `POST /auth/login`:

```
Authorization: Bearer <access_token>
```

That token is also what scopes the database: it is passed through to Postgres,
so Row Level Security only ever returns the caller's own rows.

---

## Service

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/` | no | App name and environment |
| `GET` | `/health` | no | Liveness probe. Railway's healthcheck |

---

## Auth

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/auth/signup` | no | Register. Sends a confirmation email |
| `POST` | `/auth/login` | no | Exchange email + password for tokens |
| `POST` | `/auth/refresh` | no | New token pair from a refresh token |
| `GET` | `/auth/me` | **yes** | The current user |
| `POST` | `/auth/logout` | **yes** | Revoke the session |
| `POST` | `/auth/password-reset` | no | Send a reset email |
| `GET` | `/auth/login/google` | no | Returns the Google consent URL |

### `POST /auth/signup`
```json
{ "email": "you@example.com", "password": "min 8 chars" }
```
→ `201` with a message. **No tokens**: Supabase will not issue a session until
the email is confirmed, so send the user to the login page.

### `POST /auth/login`
```json
{ "email": "you@example.com", "password": "..." }
```
→ `200`
```json
{
  "access_token": "eyJ...",
  "refresh_token": "...",
  "token_type": "bearer",
  "expires_in": 3600,
  "user": { "id": "uuid", "email": "you@example.com" }
}
```
`401` for bad credentials. The message is deliberately vague and identical
whether the account exists or the password is wrong, so this cannot be used to
discover which emails are registered.

### `POST /auth/refresh`
```json
{ "refresh_token": "..." }
```
→ `200`, same shape as login.

### `GET /auth/me`
→ `200` `{ "id": "uuid", "email": "you@example.com" }`

### `POST /auth/logout`
→ `204`. Clients should still discard both tokens locally.

### `POST /auth/password-reset`
```json
{ "email": "you@example.com" }
```
→ `202`, always. Unknown addresses get the same response, again so the endpoint
cannot be used to enumerate accounts.

### `GET /auth/login/google`
Optional `?redirect_to=<url>`, otherwise `OAUTH_REDIRECT_URL`.

→ `200` `{ "url": "https://...", "provider": "google" }`

Send the browser to `url`. Google returns it to `redirect_to` with the session
in the URL **fragment** (`#access_token=...`), which only browser JavaScript
can read, so the redirect target must be a frontend route. Returns `500` if
`OAUTH_REDIRECT_URL` is unset and no `redirect_to` is given.

---

## Projects and nodes

A project is a canvas. Nodes are the boxes on it; an agent node owns one
conversation.

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/agent-types` | **yes** | The palette of agent templates |
| `POST` | `/projects` | **yes** | Create a project |
| `GET` | `/projects` | **yes** | List your projects |
| `DELETE` | `/projects/{project_id}` | **yes** | Delete a project and its canvas |
| `POST` | `/projects/{project_id}/nodes` | **yes** | Provision an agent node |
| `GET` | `/projects/{project_id}/nodes` | **yes** | List a project's agent nodes |
| `PATCH` | `/projects/{project_id}/nodes/{node_id}` | **yes** | Move, rename, set tool policy or model. **Agent nodes only** |
| `DELETE` | `/projects/{project_id}/nodes/{node_id}` | **yes** | Remove a node |
| `GET` | `/projects/{project_id}/nodes/{node_id}/messages` | **yes** | An agent node's transcript, for polling |
| `POST` | `/projects/{project_id}/edges` | **yes** | Draw an arrow between two nodes |
| `GET` | `/projects/{project_id}/edges` | **yes** | List a project's arrows |
| `POST` | `/projects/{project_id}/edges/{edge_id}/refresh` | **yes** | Regenerate an edge's summary |
| `DELETE` | `/projects/{project_id}/edges/{edge_id}` | **yes** | Remove an arrow |

### `GET /agent-types`
→ `200`
```json
[ { "id": "uuid", "slug": "market_research", "name": "Market Research",
    "default_presets": ["brave_search", "research_method"] } ]
```
Seeded: `market_research`, `project_scoping`, `coding`, `ux_ui`, `orchestrator`.
Adding one is a SQL insert, not a deploy. See `backend/migrations/README.md`.

`default_presets` is a list of preset slugs this agent type comes pre-equipped
with.

### `POST /projects`
```json
{ "name": "My Startup", "description": "optional" }
```
→ `201` `{ "id": "uuid", "name": "My Startup" }`

### `GET /projects`
→ `200`, a list of the above. Archived projects are excluded.

### `DELETE /projects/{project_id}`
→ `204`. **Irreversible, and takes the whole canvas**: every node, edge,
conversation and message in the project is deleted with it. `404` if the
project is not yours or is already gone.

### `POST /projects/{project_id}/nodes`

`kind` is `"agent"` (default) or `"tool"`. Agent shape:

```json
{
  "agent_slug": "market_research",
  "name": "Market Research (EU)",
  "position_x": 240,
  "position_y": 120,
  "tool_policy": "auto"
}
```
Only `agent_slug` is required; `name` defaults to the template's name.
`tool_policy` is `"ask"` (default) or `"auto"`.

→ `201`
```json
{
  "id": "uuid",
  "project_id": "uuid",
  "name": "Market Research (EU)",
  "agent_slug": "market_research",
  "tool_policy": "ask",
  "position_x": 240,
  "position_y": 120,
  "kind": "agent"
}
```

The node's conversation is created at the same time, so it can be chatted with
immediately. **Several nodes may share one `agent_slug`**: that is how a
project holds a team rather than one agent of each kind.

**`kind='agent'` now provisions the agent type's `default_presets`**: one tool
node per preset, each with a `tool` edge into the new agent, placed to its
left. The response is still the agent's own node. Reload the canvas after
creating an agent; one call now creates several nodes and edges. Unknown or
failing presets are skipped and logged. The call is not idempotent: a retried or
double-sent request creates a second agent and a second set of default tools,
so clients must debounce.

**`kind='tool'` accepts `preset_slug`** as an alternative to `tool_slug`. The
preset's `config` is the base and the request's `config` overrides it.

`404` if the project is not yours or the slug is unknown. A missing project
returns `404` rather than `403`, since `403` would confirm it exists.

For `kind: "tool"`, see the Tools section below.

### `GET /projects/{project_id}/nodes`
→ `200`, a list of nodes, **agents and tools mixed together**. Tell them apart
by `kind`.

```json
[
  { "id": "uuid", "project_id": "uuid", "name": "Market Research (EU)",
    "agent_slug": "market_research", "tool_policy": "ask",
    "position_x": 240, "position_y": 120, "kind": "agent" },
  { "id": "uuid", "project_id": "uuid", "name": "GitHub",
    "tool_slug": "github", "config": {"url": "https://api.githubcopilot.com/mcp/"},
    "status": "ready", "status_detail": null, "secrets_set": ["auth_token"],
    "kind": "tool" }
]
```

`404` if the project is not yours.

### `PATCH /projects/{project_id}/nodes/{node_id}`

Every field optional; only what you send changes.

```json
{ "position_x": 340, "position_y": 180 }   // dropped after a drag
{ "name": "Market Research (EU)" }          // rename
{ "tool_policy": "auto" }                   // ask | auto
{ "model": "deepseek-v4-pro:0813" }         // per-node model override
{ "model": "" }                             // clear it: inherit the type's model
```

→ `200` with the updated node, including `model`: the node's own override if it
has one, otherwise its agent type's. An empty body is a no-op, not an error, so
a drag that ends where it started is harmless.

`model` is validated against `GET /models` before anything is written, so a
typo is a `422` naming the valid options rather than a turn that fails later.

**This route updates agent nodes only.** Each kind has its own:

| Node kind | Where to patch it |
|---|---|
| `agent` | here |
| `environment` | `PATCH /projects/{project_id}/environments/{node_id}` |
| `tool` | no patch route; re-check with `POST /projects/{project_id}/nodes/{node_id}/verify`, or delete and recreate to change config |

Sending the wrong kind here returns `404` whose `detail` names the route that
owns that node, so the mistake is self-correcting. A node that does not exist
returns `404 "Node not found"`.

**The conversation is untouched.** Moving a box does not affect its transcript.
Send this on drop rather than during the drag: one request per gesture.

`agent_type_id`, `project_id` and `owner_id` are **not** updatable. Swapping a
node's template mid-conversation would leave a transcript that no longer
matches the prompt that produced it.

`404` if the node is not yours. `422` for an invalid `tool_policy` or an empty
name.

### `DELETE /projects/{project_id}/nodes/{node_id}`
→ `200` `{ "deleted_node_ids": ["uuid", ...] }`. **Cascades**: the node's
conversation and its whole transcript go with it. Deleting an **agent** also
removes any tool node left with no edges, so the returned list can be longer
than one. `404` if the node is not yours or is already gone.

### `GET /projects/{project_id}/nodes/{node_id}/messages`
Optional `?after_seq=N` returns only messages with `seq > N`, for polling.

→ `200`, a list of messages, oldest first, same shape as `user_message` in
`POST /chat`. Up to 500. `404` if the project or agent node is not yours.

---

## Edges

Arrows between nodes. They do **not** execute a pipeline: an arrow makes one
agent's context available to another, and `/chat` picks it up automatically.

An `agent -> agent` arrow is `kind: "context"`. It carries a **summary** of the
source agent's conversation, injected into the target agent's prompt. Passing
whole transcripts would exhaust the token budget, so the summary is the payload.

A `tool -> agent` arrow is `kind: "tool"`: it makes the tool node's toolset
callable by that agent. Direction is fixed and enforced twice, by the router
(`422`) and by a database trigger, so a tool edge can never be drawn backwards.

An `environment -> agent` arrow is `kind: "environment"`: it gives that agent
a place to execute code. Like a tool edge, direction is fixed and enforced by
the router and by a database trigger.

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/projects/{project_id}/edges` | **yes** | Draw an arrow between two nodes |
| `GET` | `/projects/{project_id}/edges` | **yes** | List a project's arrows, with staleness |
| `POST` | `/projects/{project_id}/edges/{edge_id}/refresh` | **yes** | Regenerate a context edge's summary |
| `DELETE` | `/projects/{project_id}/edges/{edge_id}` | **yes** | Remove an arrow |

### `POST /projects/{project_id}/edges`
```json
{ "source_node_id": "uuid", "target_node_id": "uuid", "kind": "context" }
```
`kind` defaults to `"context"`. Use `"tool"` for a tool node to agent link.

→ `201`
```json
{
  "id": "uuid",
  "source_node_id": "uuid",
  "target_node_id": "uuid",
  "kind": "context",
  "is_stale": true,
  "messages_behind": null,
  "summarised_through_seq": null,
  "summary_updated_at": null
}
```

A new edge is always **stale**: it has no summary until you refresh it. All
three endpoints below return this same shape.

| Case | Status |
|---|---|
| That arrow already exists | `409` |
| A node linked to itself, or the two nodes are in different projects | `422` |
| Wrong node kinds for the edge kind (e.g. `context` between a tool and an agent) | `422` |
| Project or either node not yours | `404` |

The same two nodes may be joined by more than one arrow, as long as the kinds
differ.

### `GET /projects/{project_id}/edges`
→ `200`, a list of edges. This is what the canvas draws.

```json
[{
  "id": "uuid",
  "source_node_id": "uuid",
  "target_node_id": "uuid",
  "kind": "context",
  "is_stale": true,
  "messages_behind": 4,
  "summarised_through_seq": 3,
  "summary_updated_at": "2026-09-08T10:15:00Z"
}]
```

`messages_behind` is how far the summary lags: `0` when fresh, and **null**
when the edge has never been summarised, since "behind by N" is meaningless
then. It lets the UI distinguish one message behind from twenty, which warrant
different urgency.

`summary` itself is deliberately **not** returned: it is long, the canvas does
not render it, and it would bloat every canvas load.

### `POST /projects/{project_id}/edges/{edge_id}/refresh`

Regenerates the summary from the source agent's conversation.

→ `200` with the edge, `summarised_through_seq` set to the seq of the last
`complete` message summarised. Normally `is_stale: false`, `messages_behind: 0`;
if a turn completed while the summariser ran, the response already reports the
edge stale by that much rather than claiming a freshness it does not have.

The head is read **before** summarising, so a message that arrives mid-call is
not falsely claimed as covered: the edge correctly goes stale again for it.

**User-triggered on purpose.** Summarising costs an LLM call, so nothing
regenerates on its own. The canvas shows an edge as stale and the user
refreshes it when they want the downstream agent brought up to date. No
background spend, and it stays visible when an agent is working from older
information.

If the source agent has no conversation yet there is nothing to summarise, so
an empty summary is stored rather than erroring. Otherwise the edge would read
as stale forever and keep prompting a refresh that can never succeed.

`404` if the edge or project is not yours. `422` on a non-context edge.

### `DELETE /projects/{project_id}/edges/{edge_id}`
→ `204`. `404` if it is not yours or already gone.

### Staleness

`is_stale` is computed, not stored:

```
is_stale  =  summarised_through_seq is null           (never summarised)
             or summarised_through_seq < the source
                conversation's last complete seq      (it has moved on since)
```

Both sides count the same rows: the head is the largest `seq` among the source
conversation's `complete` messages, which is exactly what a refresh summarises
through. A `running`, `cancelled` or `failed` row does not move the head, so a
turn the user aborted does not leave the edge stale forever.

So an edge goes stale on its own the moment its source agent finishes saying
something new. Nothing polls; it is a comparison made when you list the edges.

`GET /edges` is the only place this is reported. **A chat turn injects whatever
summary exists without checking freshness**, deliberately: an old summary with
the arrow visibly marked stale beats no context at all. The canvas is where the
user sees that an agent is working from older information.

### How context reaches the model

On every `/chat` and `/chat/stream` turn, the API reads the arrows pointing at
that node and folds their summaries into the call:

```
Context from other agents in this project:

## Market Research
The target market is SMB fintech. Budget is 40k, deadline March...

## Project Scoping
...
```

Three things worth knowing:

- **Stale summaries are still injected.** An old summary with the arrow marked
  stale beats no context at all.
- **Edges with no summary yet are skipped**, so an unrefreshed arrow changes
  nothing.
- This is passed per call, not baked into the agent, so it does not fragment
  the agent cache.

### Summary length

Each edge carries `summary_max_words`, defaulting to 200 and constrained to
20-2000. A feeder with a long history can be given more room than a brief one.
There is no endpoint to change it yet; set it in SQL.

---

## Tools

A tool node is a box that gives an agent a capability: a skill's instructions,
an API call, or an MCP server's toolset. Draw a `tool` edge from it to an agent
to make it callable there.

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/tool-types` | **yes** | The catalog of tool templates |
| `GET` | `/tool-presets` | **yes** | The library of ready-to-instantiate tools |
| `POST` | `/projects/{project_id}/nodes` | **yes** | Provision a tool node (`kind: "tool"`) |
| `POST` | `/projects/{project_id}/nodes/{node_id}/verify` | **yes** | Re-run the connectivity check |
| `GET` | `/projects/{project_id}/nodes/{node_id}/tool-calls` | **yes** | Audit log for one tool node |

### `GET /tool-types`
→ `200`
```json
[
  {
    "id": "uuid",
    "slug": "github",
    "name": "GitHub",
    "description": "Issues, pull requests, code search and repository files.",
    "config_schema": {
      "default_url": "https://api.githubcopilot.com/mcp/",
      "fields": [
        { "key": "auth_token", "label": "Personal access token", "type": "password",
          "required": true,
          "help": "github.com > Settings > Developer settings > Personal access tokens" }
      ]
    },
    "secret_fields": ["auth_token"],
    "auth_kind": "token"
  }
]
```

**`config_schema.fields` drives the config form**: key, label, input type, and
whether it's required. `secret_fields` marks which of those keys are secrets.

**`auth_kind` decides how the client collects credentials.** `token` renders the
fields above. `oauth2` renders a Connect button instead: the user types nothing,
and `config_schema.fields` is empty. Currently only `gmail` is `oauth2`.

### `GET /tool-presets`
→ `200`
```json
[{"id": "uuid", "slug": "research_method", "name": "Research Method",
  "description": "How to research", "tool_slug": "skill",
  "config": {"text": "Do research.", "description": "Load first."}}]
```

The library of ready-to-instantiate tools and skills. Each entry names the
`tool_slug` it instantiates and the `config` copied onto a node created from it.

### `POST /projects/{project_id}/nodes/{node_id}/authorize`

Only for `auth_kind: "oauth2"` nodes. Returns a consent URL for the client to
open. It does not redirect.

→ `200`
```json
{ "url": "https://accounts.google.com/o/oauth2/v2/auth?..." }
```

`404` if the node is not yours. `422` if the tool type is not `oauth2`.

### `GET /oauth/callback`

Google redirects the browser here after consent. **Unauthenticated**: the user
arrives from Google with no bearer token, so a signed `state` parameter is the
only trust. It carries the node id and owner id, is signed with
`OAUTH_STATE_SECRET`, and expires in ten minutes.

The backend exchanges the code server-side, so the client secret never reaches
the browser, stores the refresh token in Supabase Vault, runs verify, and then
`302`s to `FRONTEND_URL` with an `oauth=connected` or `oauth=error` query param.

`400` for a missing, malformed, tampered or expired state.

### `POST /projects/{project_id}/nodes` (`kind: "tool"`)
```json
{
  "kind": "tool",
  "tool_slug": "github",
  "config": { "auth_token": "ghp_..." },
  "name": "GitHub"
}
```

- Any key in `secret_fields` is written to Supabase Vault, not `nodes.config`,
  and is **never returned by any endpoint**.
- A key that is in neither `config_schema.fields` nor `secret_fields` is `422`.
- If the catalog row has a non-empty `default_url` and the request doesn't set
  `url`, the default is copied into the node's own config at creation. The
  node stays correct even if the catalog's default later changes.
- Verify runs automatically as part of creation.

→ `201`
```json
{
  "id": "uuid",
  "project_id": "uuid",
  "name": "GitHub",
  "kind": "tool",
  "tool_slug": "github",
  "config": { "url": "https://api.githubcopilot.com/mcp/" },
  "status": "ready",
  "status_detail": null,
  "secrets_set": ["auth_token"]
}
```

`404` if the project is not yours or `tool_slug` is unknown. `422` if
`tool_slug` is missing, or for an unknown config key.

### `POST /projects/{project_id}/nodes/{node_id}/verify`

Re-runs the tool's readiness check and persists `status` and `status_detail`.
For an MCP-backed tool (`mcp_server`, `github`, `obsidian`, `gmail`), a
successful check also caches the server's tool list into
`config.discovered_tools`.

**Never raises.** A bad key, an unreachable server, anything: the response is
still `200`, with `status: "error"` and the reason in `status_detail`.

→ `200`, same shape as node creation. `404` if the node is not yours.

### `GET /projects/{project_id}/nodes/{node_id}/tool-calls`

The audit log for one tool node, newest first.

→ `200`
```json
[
  {
    "id": "uuid", "project_id": "uuid", "conversation_id": "uuid",
    "agent_node_id": "uuid", "tool_node_id": "uuid",
    "tool_call_id": "call_abc123", "tool_name": "search_issues",
    "arguments": { "query": "is:open" },
    "status": "ok", "result": "...", "error": null,
    "duration_ms": 412,
    "created_at": "2026-09-08T10:15:00Z", "updated_at": "2026-09-08T10:15:01Z"
  }
]
```

`status` is one of `pending_approval`, `running`, `ok`, `error`, `denied`.
`?limit=` caps the page, default 50, max 200. `404` if the node is not yours.

### The seeded tool types

| Slug | Needs from the user |
|---|---|
| `brave_search` | An API key |
| `web_fetch` | Just a URL; no credentials |
| `context7` | Optional API key; uses platform key by default |
| `skill` | Just instruction text, no credentials |
| `mcp_server` | A server URL, and an optional auth token |
| `github` | Just a personal access token: the endpoint is a real, public default |
| `obsidian` | **No public endpoint.** Obsidian's MCP server runs locally over stdio; the user must run a bridge and paste its HTTP URL themselves |
| `gmail` | **No public endpoint.** Needs a locally-run bridge holding Google OAuth credentials; same deal as Obsidian |

A node for `obsidian` or `gmail` with no bridge running stays in
`status: "error"` until one is reachable at the configured URL.

---

## Orchestrator

An `orchestrator` agent type. Create one like any agent
(`{"agent_slug": "orchestrator", "tool_policy": "auto"}`), then chat with it:
the prompt is the idea. It arrives with one tool box, **Canvas**, which lets
it create, wire and run the other agents on the same project.

What it does on a message: reads the canvas, creates `project_scoping`,
`market_research`, `ux_ui` and `coding` agents (reusing any that exist),
draws context edges between them, runs each in order with the idea and the
earlier decisions, and replies with a report. Each stage's full output is on
that agent's own conversation: `GET /projects/{id}/nodes/{node_id}/messages`.

**Context summaries stay current on their own** while the orchestrator drives
the pipeline: running a stage refreshes the summaries flowing out of it before
the next stage reads them. The exception is when **you** chat with a stage
agent directly, which moves its conversation past the summary downstream
agents hold. The orchestrator sees that as a stale edge and calls its
`refresh_context` tool to regenerate those summaries before running anything
that depends on them, so an edit you make by hand is not silently skipped.

**Mode** is the orchestrator node's `tool_policy`:

| `tool_policy` | Behaviour |
|---|---|
| `auto` | Unattended. One message, all stages, one report. |
| `ask` | Pauses before **each stage** with `approval_required`; `pending_calls` shows the target and the exact prompt. Approve or deny via `POST /chat/resume`. Creating and wiring never pauses. |

Agents the orchestrator creates have `tool_policy: auto`. Change one with
`PATCH .../nodes/{node_id}` if you want to see its tool calls.

The `run_agent` tool refuses a stage that is already running its own turn.
The refusal is a plain tool-result string handed back to the orchestrator, not
an HTTP status: two triggers cannot drive the same stage at once. Each
stage's own bubble persists progressively on its own conversation exactly
like any other chat turn, so `GET .../nodes/{stage_node_id}/messages` (or
`attach`) shows a stage filling in live while the orchestrator's own turn is
still running.

**Long runs.** An unattended run is minutes to tens of minutes. Use
`/chat/stream`: it emits `tool` events as each stage starts and finishes.
The turn is **detached**: if the stream drops, the run continues and the
report still lands on the orchestrator's conversation. Poll
`GET .../messages?after_seq=<last seen>` to pick it up. Turns run on
service-backed repositories bound to the verified user, so an unattended
run is not cut short by the access token expiring.

Every turn is capped at `TURN_REQUEST_LIMIT` model requests (default 100).

---

## Environments

An environment node is a real sandbox: a shell, a filesystem, and a URL for
whatever gets served on a port. Draw an `environment` edge from it to an agent
to make it callable there. Every project gets one automatically, a shared
scratch space every agent in that project can reach; provisioning more is
what this section covers.

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/projects/{project_id}/nodes` | **yes** | Provision an environment node (`kind: "environment"`) |
| `GET` | `/projects/{project_id}/environments/{node_id}` | **yes** | One environment, with its lifecycle state |
| `PATCH` | `/projects/{project_id}/environments/{node_id}` | **yes** | Rename, move, or change the approval policy |
| `POST` | `/projects/{project_id}/environments/{node_id}/start` | **yes** | Provision or restart the sandbox |
| `POST` | `/projects/{project_id}/environments/{node_id}/stop` | **yes** | Kill the sandbox. The filesystem is gone |
| `POST` | `/projects/{project_id}/environments/{node_id}/verify` | **yes** | Re-check that the sandbox is reachable |
| `GET` | `/projects/{project_id}/environments/{node_id}/files` | **yes** | List a directory, one level deep |
| `GET` | `/projects/{project_id}/environments/{node_id}/files/content` | **yes** | Read one text file |
| `POST` | `/projects/{project_id}/environments/{node_id}/files/list` | **yes** | Several directories in one request |
| `GET` | `/projects/{project_id}/environments/{node_id}/files/download` | **yes** | One file, any type, as a download |
| `GET` | `/projects/{project_id}/environments/{node_id}/files/archive` | **yes** | A directory as a `.zip` |
| `PUT` | `/projects/{project_id}/environments/{node_id}/files` | **yes** | Write one file from the raw body (upload, save) |
| `GET` | `/projects/{project_id}/environments/{node_id}/preview` | **yes** | A public URL for a port the sandbox is serving |
| `GET` | `/projects/{project_id}/environments/{node_id}/ports` | **yes** | Every port something is listening on, with its URL |
| `POST` | `/projects/{project_id}/environments/{node_id}/serve` | **yes** | Start (or reuse) a static server on a folder |
| `WS` | `/projects/{project_id}/environments/{node_id}/terminal` | **yes**, via `?token=` | A real shell, streamed both ways |

### `POST /projects/{project_id}/nodes` (`kind: "environment"`)
```json
{
  "kind": "environment",
  "name": "Build Box",
  "config": { "idle_timeout_s": 900, "description": "the API repo" }
}
```

`config` accepts only `template`, `idle_timeout_s` (60-3600), `preview_ports`
(up to 10, each 1-65535) and `description` (up to 500 characters). Anything
else, `sandbox_id` included, is `422`. Creating an environment does **not**
provision it: the sandbox comes from `/start` or the first turn that reaches
it, so an unused box costs nothing.

→ `201`
```json
{
  "id": "uuid",
  "project_id": "uuid",
  "kind": "environment",
  "name": "Build Box",
  "runtime": "e2b",
  "role": "user",
  "status": "pending",
  "status_detail": null,
  "tool_policy": "ask",
  "position_x": 0,
  "position_y": 0,
  "sandbox_id": null,
  "template": "base",
  "idle_timeout_s": 900,
  "preview_ports": [],
  "description": "the API repo"
}
```

`role` is always `"user"` for one created this way: `"scratch"` is reserved
for the one node every project gets automatically and cannot be requested.

### `GET /projects/{project_id}/environments/{node_id}`

→ `200`, same shape as creation. `404` if the node is not yours or belongs to
a different project.

### `PATCH /projects/{project_id}/environments/{node_id}`
```json
{ "name": "Renamed", "tool_policy": "auto" }
```

`status`, `config` and `kind` are not client writable. An empty body is a
no-op. `404` if the node is not yours. `422` for an unknown `tool_policy`.

### `POST /projects/{project_id}/environments/{node_id}/start`

Provisions the sandbox, or restarts a stopped one. This is the **only** way a
stopped environment comes back: a turn deliberately leaves a stopped node
alone, since stopping destroyed its filesystem and only the user should choose
to pay for a new one.

**Always `200`.** Provisioning can fail; the client reads `status` and
`status_detail` to find out, the same way a tool node reports a failed verify.

→ `200`, same shape as creation, `status: "ready"` and `sandbox_id` set on
success.

### `POST /projects/{project_id}/environments/{node_id}/stop`

Kills the sandbox and clears `sandbox_id`. The filesystem is gone; the next
`/start` begins empty.

→ `200`. `409` if the environment is currently `provisioning`: its sandbox id
is not written back yet, so killing now would leak it. Retry in a moment.

### `POST /projects/{project_id}/environments/{node_id}/verify`

Re-checks that the recorded sandbox is actually reachable and persists
`status` and `status_detail`. **Never raises**, same contract as a tool node's
verify.

→ `200`, same shape as creation.

### `GET /projects/{project_id}/environments/{node_id}/files`
`?path=` (default the workspace root)

→ `200`
```json
{
  "path": "/home/user/workspace",
  "entries": [
    { "name": "app", "type": "dir", "path": "/home/user/workspace/app", "size": 0 },
    { "name": "notes.md", "type": "file", "path": "/home/user/workspace/notes.md", "size": 42,
      "modified": "2026-09-25T00:40:00+00:00", "symlink_target": null }
  ]
}
```

A relative `path` resolves against `/home/user/workspace`. `type` is `dir`, `file`, or `symlink`. `409` if the environment is not
`ready`, naming the actual status. `502` if the sandbox cannot be reached,
which also marks the node `error` so the canvas reflects it immediately. `404`
for a path that does not exist.

### `GET /projects/{project_id}/environments/{node_id}/files/content`
`?path=` (required)

→ `200`
```json
{ "path": "/home/user/workspace/notes.md", "content": "...", "truncated": false }
```

Capped at `environment_max_file_chars`; `truncated` says whether it was cut.
`404` if the file does not exist. `415` if it is not valid text.

### `POST /projects/{project_id}/environments/{node_id}/files/list`
```json
{ "paths": ["/home/user/workspace", "/home/user/workspace/<agent-id>"] }
```

Up to 20 directories, read in parallel on one sandbox connection. Built for
the code preview's live refresh, which re-reads every open folder every few
seconds. A folder that fails reports its own `error` instead of failing the
batch:

→ `200`
```json
{ "listings": [
  { "path": "/home/user/workspace", "entries": [ ... ], "error": null },
  { "path": "/home/user/workspace/gone", "entries": null, "error": "No such directory: ..." }
] }
```

### `GET /projects/{project_id}/environments/{node_id}/files/download`
`?path=` (required)

The file's raw bytes, streamed, with `Content-Disposition: attachment` and a
`Content-Type` guessed from the name. Any file type, unlike `/files/content`.
`404` if missing. `422` for a directory (use `/files/archive`).

### `GET /projects/{project_id}/environments/{node_id}/files/archive`
`?path=` (default the workspace root), `?include_dependencies=` (default `false`)

The directory as a `.zip`, built inside the sandbox and streamed out, then
deleted. `node_modules`, `.git`, `__pycache__`, `.venv`, `venv`, `.next` and
`.cache` are left out unless `include_dependencies=true`. Symlinks are
skipped. `413` over `environment_max_archive_bytes` (200 MB). `422` for a file.

### `PUT /projects/{project_id}/environments/{node_id}/files`
`?path=` (required). Body: the file's raw bytes (`application/octet-stream`).

Creates parent directories and overwrites. The code preview uses it for both
uploads and "save" in its editor. `413` over `environment_max_upload_bytes`
(25 MB).

→ `200` `{ "path": "/home/user/workspace/notes.md", "size": 42 }`

### `GET /projects/{project_id}/environments/{node_id}/preview`
`?port=` (required, 1-65535)

→ `200`
```json
{ "port": 3000, "url": "https://3000-<sandbox-id>.e2b.app" }
```

Connecting first resumes a paused sandbox, so the link works even if nothing
has touched the environment in a while.

### `GET /projects/{project_id}/environments/{node_id}/ports`

Every TCP port something is listening on, found from `/proc` inside the
sandbox, each with its preview URL. E2B's own daemon (49983) is left out. This
is how the code preview finds a dev server an agent started without anyone
typing a port.

→ `200`
```json
{ "ports": [
  { "port": 8080, "url": "https://8080-<sandbox-id>.e2b.app", "pid": 311,
    "process": "python3 -m http.server",
    "command": "python3 -m http.server 8080 --bind 0.0.0.0 --directory /home/user/workspace/<agent-id>",
    "local_only": false, "serving": "/home/user/workspace/<agent-id>" }
] }
```

`local_only` means it is bound to `127.0.0.1`; the first thing to check if its
preview won't load. `serving` is set for static servers.

### `POST /projects/{project_id}/environments/{node_id}/serve`
```json
{ "path": "/home/user/workspace/<agent-id>/index.html" }
```

Starts `python3 -m http.server` on the folder (or a file's folder) on the first
free port from 8080-8099, or reuses one already serving that folder. Waits up
to 5s for it to listen.

→ `200`: a `ports` entry plus `reused` and `open_url` (the port's URL plus the
file, if one was asked for). `404` for a missing path. `409` if 8080-8099 are
all taken.

The browsing endpoints above reuse one sandbox connection for ~40s instead of
reconnecting per request, and retry once on a fresh connection if it went
stale.

### `WS /projects/{project_id}/environments/{node_id}/terminal`
`?token=<access_token>&cols=&rows=`

A real shell. Browsers cannot set a bearer header on a WebSocket, so the token
travels in the query string instead, which is why this must be `wss://` in
anything but local development.

Send raw bytes for keystrokes, or a JSON text frame:
```json
{ "type": "input", "data": "ls\n" }
{ "type": "resize", "cols": 120, "rows": 40 }
```

Receives raw bytes for terminal output, and one final text frame when the
shell exits:
```json
{ "type": "exit", "code": 0 }
```

Closes with an application code rather than a generic failure:

| Code | Meaning |
|---|---|
| `4401` | Missing or invalid token |
| `4403` | Not `wss://` outside localhost |
| `4404` | Environment not found |
| `4409` | Environment is not `ready` |
| `4502` | Sandbox unreachable |

---

## Chat

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/chat` | **yes** | Send a message to an agent node |
| `POST` | `/chat/stream` | **yes** | The same, streamed as server-sent events |
| `POST` | `/chat/resume` | **yes** | Continue a turn paused for tool approval |
| `POST` | `/chat/cancel` | **yes** | Stop a running or parked turn |
| `GET`  | `/chat/attach` | **yes** | Re-join a running turn's event stream |

### `POST /chat`
```json
{
  "node_id": "uuid",
  "prompt": "What does the market look like?",
  "client_token": "optional-idempotency-key"
}
```

The node implies its project and its template, so one identifier is enough.

→ `200`
```json
{
  "node_id": "uuid",
  "conversation_id": "uuid",
  "output": "...",
  "user_message": {
    "id": "uuid", "role": "user", "content": "...",
    "seq": 1, "status": "complete", "created_at": "...", "tool_calls": []
  },
  "assistant_message": {
    "id": "uuid", "role": "assistant", "content": "...",
    "seq": 2, "status": "complete", "created_at": "...", "tool_calls": [...]
  }
}
```

**Message statuses.** `running` while the turn is in flight, then `complete`,
`failed` (with `error`), `cancelled` (stopped by the user, partial `content`
kept), or `awaiting_approval` (paused for a tool decision). Every message
carries `tool_calls`, an ordered list of the tool events behind that bubble:

```json
"tool_calls": [
  {"type": "call",   "tool_call_id": "c1", "name": "run_agent", "args": {"node_id": "..."}, "at": "..."},
  {"type": "result", "tool_call_id": "c1", "name": "run_agent", "status": "ok", "result_head": "...", "at": "..."}
]
```

Render a bubble by interleaving: the `call`/`result` pairs arrived in that
order relative to the text, and `content` is the text. `result.status` is one
of `ok`, `error` (the tool raised, or the turn died mid-call), `denied`
(refused at an approval prompt) or `cancelled` (in flight when the turn was
stopped, or parked when the pause was abandoned). On every terminal status a
`call` left open is closed with a synthetic `result`, so a call never spins
forever. The one exception is `awaiting_approval`: a parked call is genuinely
still pending, and gets its result when the turn resumes or is cancelled.

`args` is truncated past 2000 characters (`{"_truncated": "..."}`); the full
per-call record, with timings, is on `GET .../tool-calls`.

**One turn at a time.** `POST /chat`, `/chat/stream` and `/chat/resume`
return `409 {"detail": "Agent is already running a turn"}` while a turn is
in flight on that node.

Notes:

- **History replays automatically.** The node's transcript is loaded and passed
  to the model, so the agent remembers earlier turns in that conversation.
- **Context from inbound edges is injected automatically.** If another agent's
  arrow points at this node, its summary is added to the call. See Edges.
- **`client_token` is an idempotency key.** Resending the same token will not
  duplicate the message. Generate one per send if the client may retry.
- **A failed turn still returns `200`**, with `assistant_message.status` set to
  `"failed"`. The user's own message is already stored, so an orphaned turn
  with no reply would be worse than a visible failure.
- `404` if the node is not yours or does not exist, again in preference to
  `403`.
- `422` for a missing or empty prompt.

### `POST /chat/stream`

Same request body as `/chat`. Returns `text/event-stream`:

```
event: start   data: {"conversation_id": "...", "user_message": {...}, "assistant_message": {...}}
event: chunk   data: {"text": "The sea is"}
event: chunk   data: {"text": " a vast..."}
event: done    data: {"assistant_message": {...}}
```

`start` arrives before the model is called, so the client has the conversation
id, the persisted user message, and the `assistant_message` (status `running`,
empty content) whose `id` is the bubble that will fill in.

`tool` events carry one entry of the `tool_calls` list documented above: a
`call` when a tool is invoked, a `result` when it returns.

If the model fails part-way an `event: error` is emitted and the assistant
message is still written with `status: "failed"`. The HTTP status stays `200`,
because headers are sent before the model is called. `error` is not terminal:
a `done` event carrying that `failed` assistant row always follows it, so keep
reading until `done` rather than closing on `error`.

The turn is persisted exactly as `/chat` persists it, so idempotency, `seq`
ordering and history replay are unchanged. Unlike `/chat` it is **not**
DBOS-checkpointed: a step checkpoints a return value and a stream has none.

A `denied` or `cancelled` `result` is written to the row but not emitted as a
`tool` event: it is recorded as the turn settles, after the live stream has
closed. Re-read the row (`GET .../messages`) for the final list.

**Streams are detached and persisted as they go.** A dropped connection does
not cancel the turn. The assistant row is inserted at the start with
`status: "running"` and updated roughly every 1.5 s and on every tool event,
so a reload never loses more than a second or two of text. To pick a turn
back up after a reload: `GET .../messages`, and if the last row is `running`,
call `GET /chat/attach` (below) or keep polling until it isn't.

### `POST /chat/cancel`
```json
{ "node_id": "uuid" }
```
→ `202`
```json
{ "node_id": "uuid", "conversation_id": "uuid", "message_id": "uuid" }
```

Stops the turn in flight: the model request and any tool call are aborted.
Nothing is deleted. The bubble finalises as `status: "cancelled"` with the
text and tool events that had arrived; watch it land via `attach`, polling,
or Realtime. A cancelled reply is shown but never replayed to the model.

A call still in flight gets a synthetic `result` event with
`status: "cancelled"`, so the bubble has no half-finished call left on it.

Also works on a turn parked for approval: the pending calls are marked
`cancelled`, their `call` events get the same synthetic `result`, and the
bubble closes as `cancelled`.

Cancelling an **orchestrator** also cancels the stage agent it is currently
driving. Cancelling a **stage agent** on its own stops that stage and hands
the orchestrator a tool result saying so; the orchestrator decides what to
do next. To continue after a cancel, send the orchestrator a new prompt
("continue"): it re-reads the canvas and the stage conversations.

`404` unknown node, `409 {"detail": "Nothing running"}` if there is nothing
to stop (a second cancel gets this too).

### `GET /chat/attach?node_id=<uuid>`

Re-joins a running turn. `204` when nothing is running for that node.
Otherwise `text/event-stream` with the same events as `/chat/stream`, so the
same parser handles both:

```
event: start   data: {"conversation_id": "...", "assistant_message": {"id": "...", "status": "running", "content": "<everything so far>", "tool_calls": [...]}}
event: chunk   data: {"text": "..."}
event: tool    data: {...}
event: done    data: {"assistant_message": {...}}
```

`start` on attach carries `assistant_message`; use it rather than
`user_message` (present only when the run has one): paint the bubble from it,
then append. Any number of tabs may attach to one turn. A
consumer that stops reading is dropped (its stream ends without `done`);
re-attach for a fresh snapshot. Bearer token in the `Authorization` header as
usual; `fetch` with a header works, `EventSource` does not.

### Approval

When a node's `tool_policy` is `"ask"`, a tool call the agent wants to make
pauses the turn instead of running it.

**`POST /chat` returns `ApprovalRequiredResponse` instead of `ChatResponse`.**
A client tells them apart by the `paused` field, present and `true` only on
the paused shape:

```json
// ChatResponse
{
  "node_id": "uuid", "conversation_id": "uuid", "output": "...",
  "user_message": { "...": "..." }, "assistant_message": { "...": "..." }
}
```
```json
// ApprovalRequiredResponse
{
  "paused": true,
  "node_id": "uuid",
  "conversation_id": "uuid",
  "pending_calls": [
    { "tool_call_id": "call_abc123", "tool_name": "delete_issue",
      "arguments": { "issue_number": 4 } }
  ]
}
```

Note: this JSON body from `POST /chat` and `/chat/resume` has no
`assistant_message` field; read the paused bubble from `.../messages`. The
SSE `approval_required` event below (from `/chat/stream` and `/chat/attach`)
does carry it.

**`/chat/stream` emits `event: approval_required` and then ends the stream
with no `done` event.** This is the thing a frontend will break on if it
assumes every stream ends in `done`:

```
event: start              data: {"conversation_id": "...", "user_message": {...}, "assistant_message": {...}}
event: chunk               data: {"text": "I'll need to"}
event: approval_required   data: {"conversation_id": "...", "pending_calls": [...], "assistant_message": {...}}
```

### `POST /chat/resume`

Continues a paused turn. There is **no new user prompt**, only decisions on
the pending calls:

```json
{
  "node_id": "uuid",
  "approvals": { "call_abc123": true, "call_def456": false }
}
```

→ `200`, `ResumeResponse` (**no `user_message` field**: the prompt was already
persisted on the turn that paused):
```json
{
  "node_id": "uuid",
  "conversation_id": "uuid",
  "output": "...",
  "assistant_message": { "id": "uuid", "role": "assistant", "content": "...",
    "seq": 2, "status": "complete", "created_at": "...", "tool_calls": [...] }
}
```

**The resume reuses the paused bubble.** `assistant_message.id` and `.seq`
are the same row that was `awaiting_approval`, now carrying the full text and
`tool_calls` for the whole turn, call and resumed continuation together. No
second assistant row is written.

Denied calls are marked `status: "denied"` in the tool-calls log rather than
run, and their `call` event on the bubble gets a matching `result` with the
same status. `409` if there is nothing parked for that node, or the pause is more than
an hour old. `422` if an `approvals` key isn't a pending `tool_call_id` for
that conversation.

**A resumed run can pause again** (another `tool_policy: "ask"` call further
in the same turn): the response is then `ApprovalRequiredResponse`, same shape
as above, and resume again.

### Live status: agents and tool calls

State is on the rows, not on an endpoint:

| Question | Read |
|---|---|
| Is this agent running? | `nodes.status` is `running` (else `ready`) via `GET /projects/{id}/nodes` |
| Which tool call is executing? | `GET .../nodes/{tool_node_id}/tool-calls`, `status: "running"` |
| What has this bubble got so far? | `GET .../messages`, last row `running`, plus `attach` |

**Default: poll.** While any agent node on the canvas is `running`, refresh
`GET /projects/{id}/nodes` and the open node's `.../messages` every 2 to 3 s.
Stop when none is.

**Opt-in: Supabase Realtime.** The `nodes`, `messages` and `tool_calls`
tables are published, and Postgres Changes enforces RLS, so a subscriber only
receives their own rows. With the Supabase client the app already uses for
auth:

```ts
supabase.channel(`project:${projectId}`)
  .on("postgres_changes", { event: "*", schema: "public", table: "nodes",
       filter: `project_id=eq.${projectId}` }, (p) => patchNodeStatus(p.new))
  .on("postgres_changes", { event: "*", schema: "public", table: "tool_calls",
       filter: `project_id=eq.${projectId}` }, (p) => patchToolCall(p.new))
  .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages" },
       (p) => refetchMessages(p.new.conversation_id))
  .subscribe();
```

Treat a `messages` change as "re-fetch that conversation", not as data:
Realtime sends whole rows with a size cap, and a long `content` may arrive as
an `errors` field instead of a payload. Polling remains the fallback.

---

## Usage

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/usage` | **yes** | Your token totals across every project |
| `GET` | `/projects/{project_id}/usage` | **yes** | Your token totals in one project |

Both return the same shape, broken down by model. `project_id` is `null` on
the account-wide route.

### `GET /usage`

What a per-user cap reads: every project you own, re-aggregated by model.

→ `200`
```json
{
  "project_id": null,
  "by_model": [
    {
      "model": "deepseek-v4.1-flash",
      "input_tokens": 12400, "output_tokens": 88100,
      "reasoning_tokens": 61200,
      "cache_read_tokens": 9800, "cache_write_tokens": 1200,
      "requests": 143, "message_count": 96
    }
  ],
  "input_tokens": 12400,
  "output_tokens": 88100,
  "message_count": 96
}
```

### `GET /projects/{project_id}/usage`

The same, filtered to one project. `404` if the project is not yours.

### Reading these numbers

**`reasoning_tokens` is a subset of `output_tokens`, not an addend.** Every
provider bills thinking inside the output total (OpenAI and Ollama call it
`reasoning_tokens`, Anthropic `thinking_tokens`, Google `thoughts_tokens`), so
`output + reasoning` double-counts. It is broken out for attribution only: a
120-word reply can report 2000 output tokens with 1900 of them spent thinking.

**The top-level totals sum only what is safely additive** across models:
`input_tokens`, `output_tokens`, `message_count`. There is deliberately no
grand total of reasoning, and no cost.

**These are token counts, never spend.** Prices differ per model, so a total
across models is not a bill. `nodes.model` is a per-node override, which is
why the breakdown is per model at all: one project can run several at once,
and their counts are neither comparable nor equally priced.

**Failed turns count.** They consumed tokens and cost money, which is separate
from whether they are replayed as history.

**Some calls are unmetered.** Context edge refreshes (`summarise_conversation`)
and tool `verify` calls run their own agents and their usage is discarded, so
a cap built on these numbers undercounts by whatever those cost.

### How a token reaches these endpoints

Four stages, and only the first is in the agent code:

1. **Capture.** pydantic-ai returns a `RunUsage` on every agent run.
   `_turn_from` in `app/workflows.py` lifts `input_tokens`, `output_tokens`,
   `cache_read_tokens`, `cache_write_tokens` and `requests` off it onto an
   `AgentTurn`. Reasoning has no typed field: each provider adapter puts it in
   `usage.details` under its own name, so `_reasoning_from` checks all three.

2. **Persist.** `repo.add_message(...)` writes those onto the `messages` row
   for that turn, alongside `model` and `status`. One row per assistant turn.

3. **Roll up.** A Postgres trigger, `messages_usage_rollup` in
   `migrations/usage.sql`, fires on that insert and adds the row's tokens into
   `usage_totals`, keyed `(project_id, owner_id, model)`. Nothing in Python
   maintains this table: the write is the insert in stage 2, and the database
   does the rest. This follows `conversations.message_count`, which is kept
   current the same way rather than counted per request.

4. **Read.** These endpoints select straight from `usage_totals`. No `sum()`
   over `messages` on the read path. `/usage` re-aggregates a user's rows by
   model in Python, since one model appears once per project.

The trigger also handles `UPDATE`, adding only the delta between old and new
values. Nothing in the current pipeline updates a `messages` row, so that
branch is unused today; it exists so that a future write path that revises a
row's token counts cannot silently double-count.

### Where a paused turn's tokens go

Nowhere, currently. A turn that pauses for tool approval has already made a
model request and spent tokens, but the row is finalised as
`awaiting_approval` with no `model`/token fields set, so that usage is
dropped. The resume reuses that same row (see `POST /chat/resume` above)
rather than writing a new one, but the resumed run starts a fresh `RunUsage`
of its own, so the tokens eventually written to the row on completion count
only the resumed request, not the original one that paused.

`requests` is captured to make this visible: a turn showing `requests: 1` after
an approval round-trip has lost the first request's tokens. Fixing it means
persisting the pause's usage at park time, which is a schema question (a row in
`awaiting_approval` with tokens but no content) rather than a capture one.

---

## Status codes

| Code | Meaning |
|---|---|
| `200` | OK |
| `201` | Created |
| `202` | Accepted (password reset, `/chat/cancel`) |
| `204` | No content (logout, `/chat/attach` with nothing running) |
| `401` | Missing, invalid or expired token; bad credentials |
| `404` | Not found, **or** not yours |
| `409` | Conflict: duplicate edge or project name, turn already running, nothing running to cancel, no pending approval, or approval expired |
| `422` | Request body failed validation |
| `500` | Server misconfiguration, e.g. `OAUTH_REDIRECT_URL` unset |

There is no `403`. Anything the caller does not own returns `404`, so the API
never confirms the existence of another tenant's data.

---

## Not implemented yet

The schema supports these; the API does not expose them:

- **The retrieval tool.** A context edge gives the downstream agent a summary,
  but no way to ask the upstream agent for detail the summary lost.
- Changing an edge's `summary_max_words` over the API
- Listing a conversation's history without sending a message
