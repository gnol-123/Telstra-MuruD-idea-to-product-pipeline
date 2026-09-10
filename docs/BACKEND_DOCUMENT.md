# Backend Tech Stack

## Overview

The backend is a Python [FastAPI](https://fastapi.tiangolo.com/) service that exposes a small JSON API and wraps an LLM agent built with [Pydantic AI](https://ai.pydantic.dev/). It is packaged for deployment on [Railway](https://railway.com/) via Nixpacks.

## Core Stack

| Layer | Choice | Version | Role |
|---|---|---|---|
| Language | Python | 3.12 (deploy) / 3.13 (local venv) | Runtime |
| Web framework | FastAPI | 0.115.6 | Routing, validation, OpenAPI docs |
| ASGI server | Uvicorn (`[standard]`) | 0.34.0 | HTTP server; the `standard` extra adds uvloop/httptools |
| ASGI toolkit | Starlette | 0.41.3 | Underlies FastAPI (middleware, CORS, routing) |
| Validation | Pydantic | 2.13.4 | Request/response models |
| Configuration | pydantic-settings | 2.7.1 | Typed settings loaded from env / `.env` |
| Env loading | python-dotenv | 1.0.1 | Reads `.env` in local development |
| LLM framework | pydantic-ai-slim (`[google,mcp]` extras) | 2.32.1 | Agent definition, execution, MCP client |
| HTTP client | httpx | 0.28.1 | Async transport, and the Brave Search tool |

The `slim` distribution installs only the providers named in the extras rather than every supported LLM SDK, which keeps the deployed image small. The `mcp` extra pulls `fastmcp-slim`, which is why `python-dotenv` is pinned at 1.2.3: anything older resolves a `starlette` that breaks FastAPI.

## Project Layout

```
backend/
  app/
    __init__.py
    main.py          # FastAPI app, CORS, router mounting, GET /
    config.py        # Settings (pydantic-settings), reads .env
    services/
      agent.py       # Pydantic AI agent over GoogleModel (lazy, lru_cached)
      supabase.py    # user, anon and service-role clients
    tools/           # tool registry: skills, api handlers, MCP
    repositories/    # all PostgREST access
    routers/
      __init__.py
      health.py      # GET /health
      chat.py        # POST /chat
  requirements.txt   # Pinned dependencies
  Dockerfile         # Docker instructions file
  railway.json       # Railway build/deploy config
  .env               # Local secrets (gitignored)
  .env.example       # Committed template
  .gitignore
```

## API Surface

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | App name and current environment |
| `GET` | `/health` | Liveness probe; used as the Railway healthcheck |
| `POST` | `/chat` | Runs one agent turn. See `docs/API.md` for the full surface |

Interactive OpenAPI docs are served at `/docs` by FastAPI.

## Configuration

Settings are defined in `app/config.py` and read from environment variables, falling back to `.env` locally. `extra="ignore"` means unknown env vars are tolerated rather than raising.

| Variable | Default | Purpose |
|---|---|---|
| `APP_NAME` | `MuruDPipeline API` | Title shown in OpenAPI and `GET /` |
| `ENVIRONMENT` | `development` | Free-form environment label |
| `CORS_ORIGINS` | `*` | Comma-separated allowed origins |
| `GEMINI_API_KEY` | _(empty)_ | Credential for the Google provider |
| `GEMINI_MODEL` | `gemini-3-flash-preview` | Model ID used by the agent |
| `SUPABASE_URL` | _(empty)_ | Supabase project URL |
| `SUPABASE_KEY` | _(empty)_ | Publishable key. RLS applies |
| `DBOS_DATABASE_URL` | _(empty)_ | Postgres URL for DBOS checkpoints. Unset disables durability |
| `OAUTH_REDIRECT_URL` | _(empty)_ | Where Supabase returns the browser after Google sign-in |
| `SUPABASE_SERVICE_KEY` | _(empty)_ | Supabase `service_role` key. **Bypasses RLS entirely.** Used at exactly one call site, decrypting tool secrets from Supabase Vault. Must never reach the frontend |

`CORS_ORIGINS` is a comma-separated string, split into a list by the `cors_origin_list` property. Set it to the deployed frontend origin before going to production: the `*` default is a development convenience and is incompatible with credentialed cross-origin requests.

## LLM Agent

`app/services/agent.py` builds a Pydantic AI `Agent` backed by `GoogleModel`, with the provider constructed from `GEMINI_API_KEY`. Agents declare `output_type=[str, DeferredToolRequests]` so a tool call awaiting approval pauses the run instead of raising.

Built lazily behind `@lru_cache`, keyed on `(system_prompt, model)`. Constructing a provider without an API key raises `UserError`, so building at module scope would crash the app at startup, `/health` included. Lazy means the app boots without a key and only `/chat` fails. The cache key is catalog content, so editing a prompt in SQL yields a fresh agent on the next call.

## Deployment (Railway)

- **Builder:** Docker, configured in `railway.json`.
- **Root directory:** set the Railway service root to `backend`.
- **Start command:** `uvicorn app.main:app --host 0.0.0.0 --port $PORT`. Railway injects `$PORT`; binding to `0.0.0.0` is required.
- **Healthcheck path:** `/health`.
- **Restart policy:** `ON_FAILURE`.

The `Procfile` declares the same start command and serves as a fallback for buildpack-based platforms; `railway.json` is what Railway actually uses.

`GEMINI_API_KEY`, `SUPABASE_URL`, `SUPABASE_KEY` and `SUPABASE_SERVICE_KEY` must be set as Railway service variables: `.env` is gitignored and never deployed.

## Notes

- The local development virtualenv runs Python 3.13 while `runtime.txt` pins 3.12 for deployment. This gap is harmless for the current dependency set but is worth closing if version-sensitive behavior appears.
- The frontend is tracked separately in `frontend/` and is outside the scope of this document.
