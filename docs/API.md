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
| `PATCH` | `/projects/{project_id}/nodes/{node_id}` | **yes** | Move, rename, or set tool policy |
| `DELETE` | `/projects/{project_id}/nodes/{node_id}` | **yes** | Remove a node |
| `POST` | `/projects/{project_id}/edges` | **yes** | Draw an arrow between two nodes |
| `GET` | `/projects/{project_id}/edges` | **yes** | List a project's arrows |
| `POST` | `/projects/{project_id}/edges/{edge_id}/refresh` | **yes** | Regenerate an edge's summary |
| `DELETE` | `/projects/{project_id}/edges/{edge_id}` | **yes** | Remove an arrow |

### `GET /agent-types`
→ `200`
```json
[ { "id": "uuid", "slug": "market_research", "name": "Market Research" } ]
```
Seeded: `market_research`, `project_scoping`, `coding`. Adding one is a SQL
insert, not a deploy — see `backend/migrations/README.md`.

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
```json
{
  "agent_slug": "market_research",
  "name": "Market Research (EU)",
  "position_x": 240,
  "position_y": 120
}
```
Only `agent_slug` is required; `name` defaults to the template's name.

→ `201`
```json
{
  "id": "uuid",
  "project_id": "uuid",
  "name": "Market Research (EU)",
  "agent_slug": "market_research",
  "tool_policy": "ask"
}
```

The node's conversation is created at the same time, so it can be chatted with
immediately. **Several nodes may share one `agent_slug`** — that is how a
project holds a team rather than one agent of each kind.

`404` if the project is not yours or the slug is unknown. A missing project
returns `404` rather than `403`, since `403` would confirm it exists.

### `GET /projects/{project_id}/nodes`
→ `200`, a list of the above. `404` if the project is not yours.

### `PATCH /projects/{project_id}/nodes/{node_id}`

Every field optional; only what you send changes.

```json
{ "position_x": 340, "position_y": 180 }   // dropped after a drag
{ "name": "Market Research (EU)" }          // rename
{ "tool_policy": "auto" }                   // ask | auto
```

→ `200` with the updated node. An empty body is a no-op, not an error, so a
drag that ends where it started is harmless.

**The conversation is untouched.** Moving a box does not affect its transcript.
Send this on drop rather than during the drag: one request per gesture.

`agent_type_id`, `project_id` and `owner_id` are **not** updatable. Swapping a
node's template mid-conversation would leave a transcript that no longer
matches the prompt that produced it.

`404` if the node is not yours. `422` for an invalid `tool_policy` or an empty
name.

### `DELETE /projects/{project_id}/nodes/{node_id}`
→ `204`. **Cascades**: the node's conversation and its whole transcript go
with it. `404` if the node is not yours or is already gone.

---

## Edges

Arrows between nodes. They do **not** execute a pipeline: an arrow makes one
agent's context available to another, and `/chat` picks it up automatically.

An `agent -> agent` arrow is `kind: "context"`. It carries a **summary** of the
source agent's conversation, injected into the target agent's prompt. Passing
whole transcripts would exhaust the token budget, so the summary is the payload.

`tool` and `environment` kinds exist in the schema but are not yet accepted:
there are no tool or environment nodes to point at.

### `POST /projects/{project_id}/edges`
```json
{ "source_node_id": "uuid", "target_node_id": "uuid", "kind": "context" }
```
`kind` defaults to `"context"`.

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
| `kind` other than `"context"` | `422` |
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

→ `200` with the edge, now `is_stale: false`, `messages_behind: 0`, and
`summarised_through_seq` set to the message count at the moment of the call.

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
                conversation's message count          (it has moved on since)
```

So an edge goes stale on its own the moment its source agent says something
new. Nothing polls; it is a comparison made when you list the edges.

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

## Chat

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/chat` | **yes** | Send a message to an agent node |
| `POST` | `/chat/stream` | **yes** | The same, streamed as server-sent events |

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
    "seq": 1, "status": "complete", "created_at": "..."
  },
  "assistant_message": {
    "id": "uuid", "role": "assistant", "content": "...",
    "seq": 2, "status": "complete", "created_at": "..."
  }
}
```

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
event: start   data: {"conversation_id": "...", "user_message": {...}}
event: chunk   data: {"text": "The sea is"}
event: chunk   data: {"text": " a vast..."}
event: done    data: {"assistant_message": {...}}
```

`start` arrives before the model is called, so the client has the conversation
id and the persisted user message immediately.

If the model fails part-way an `event: error` is emitted and the assistant
message is still written with `status: "failed"`. The HTTP status stays `200`,
because headers are sent before the model is called.

The turn is persisted exactly as `/chat` persists it, so idempotency, `seq`
ordering and history replay are unchanged. Unlike `/chat` it is **not**
DBOS-checkpointed: a step checkpoints a return value and a stream has none. The
assembled text is written once the stream drains.

---

## Status codes

| Code | Meaning |
|---|---|
| `200` | OK |
| `201` | Created |
| `202` | Accepted (password reset) |
| `204` | No content (logout) |
| `401` | Missing, invalid or expired token; bad credentials |
| `404` | Not found, **or** not yours |
| `422` | Request body failed validation |
| `500` | Server misconfiguration, e.g. `OAUTH_REDIRECT_URL` unset |

There is no `403`. Anything the caller does not own returns `404`, so the API
never confirms the existence of another tenant's data.

---

## Not implemented yet

The schema supports these; the API does not expose them:

- **The retrieval tool.** A context edge gives the downstream agent a summary,
  but no way to ask the upstream agent for detail the summary lost.
- Tool and environment nodes, and tool credential configuration
- Changing an edge's `summary_max_words` over the API
- Listing a conversation's history without sending a message
- Node positions are stored but not returned by `GET .../nodes`, so a canvas
  cannot yet restore its layout
