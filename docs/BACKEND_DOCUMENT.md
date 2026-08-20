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
| LLM framework | pydantic-ai-slim (`[anthropic]` extra) | 2.32.1 | Agent definition and execution |
| LLM SDK | anthropic | 0.125.0 | Transitive; the Anthropic provider used by Pydantic AI |
| HTTP client | httpx | 0.28.1 | Transitive; async transport for the Anthropic SDK |

The `slim` distribution of Pydantic AI is used deliberately: it installs only the Anthropic provider rather than every supported LLM SDK, which keeps the deployed image small.

## Project Layout

```
backend/
  app/
    __init__.py
    main.py          # FastAPI app, CORS, router mounting, GET /
    config.py        # Settings (pydantic-settings), reads .env
    agent.py         # Pydantic AI agent over AnthropicModel (lazy init)
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
| `POST` | `/chat` | Runs the agent — `{"prompt": "..."}` → `{"output": "..."}` |

Interactive OpenAPI docs are served at `/docs` by FastAPI.

## Configuration

Settings are defined in `app/config.py` and read from environment variables, falling back to `.env` locally. `extra="ignore"` means unknown env vars are tolerated rather than raising.

| Variable | Default | Purpose |
|---|---|---|
| `APP_NAME` | `MuruDPipeline API` | Title shown in OpenAPI and `GET /` |
| `ENVIRONMENT` | `development` | Free-form environment label |
| `CORS_ORIGINS` | `*` | Comma-separated allowed origins |
| `ANTHROPIC_API_KEY` | _(empty)_ | Credential for the Anthropic provider |
| `ANTHROPIC_MODEL` | `claude-opus-5` | Model ID used by the agent |

`CORS_ORIGINS` is a comma-separated string, split into a list by the `cors_origin_list` property. Set it to the deployed frontend origin before going to production — the `*` default is a development convenience and is incompatible with credentialed cross-origin requests.

## LLM Agent

`app/agent.py` builds a Pydantic AI `Agent` backed by `AnthropicModel`, with the provider constructed explicitly from `ANTHROPIC_API_KEY`.

The agent is created lazily behind `@lru_cache` rather than at import time. This is deliberate: Pydantic AI raises a `UserError` when the Anthropic provider is constructed without an API key, so building the agent at module scope would crash the entire application at startup — including `/health` — whenever the key is unset. With lazy construction the app boots cleanly without a key, the Railway healthcheck passes, and only `/chat` fails until the key is configured. The cache means the agent is built once, on first request, and reused thereafter.

## Deployment (Railway)

- **Builder:** Docker, configured in `railway.json`.
- **Root directory:** set the Railway service root to `backend`.
- **Start command:** `uvicorn app.main:app --host 0.0.0.0 --port $PORT` — Railway injects `$PORT`; binding to `0.0.0.0` is required.
- **Healthcheck path:** `/health`.
- **Restart policy:** `ON_FAILURE`.

The `Procfile` declares the same start command and serves as a fallback for buildpack-based platforms; `railway.json` is what Railway actually uses.

`ANTHROPIC_API_KEY` must be set as a Railway service variable — `.env` is gitignored and never deployed.

## Notes

- The local development virtualenv runs Python 3.13 while `runtime.txt` pins 3.12 for deployment. This gap is harmless for the current dependency set but is worth closing if version-sensitive behavior appears.
- The frontend is tracked separately in `frontend/` and is outside the scope of this document.
