"""Shared Supabase client.

Import ``get_client`` wherever you need database access; the client is created
once and reused, so there is no need to build one per module.
"""

from functools import lru_cache

import httpx
from supabase import Client, ClientOptions, create_client

from app.config import settings

# supabase-py defaults to one HTTP/2 client. Repository calls run on anyio's
# worker threads (up to 40 of them), and one HTTP/2 connection shared across
# threads interleaves frames: reads fail with WinError 10035 or a disconnect.
# HTTP/1.1 gives each thread its own pooled connection instead, and the cap
# keeps us under the Supabase pooler's client limit.
_POOL = httpx.Limits(max_connections=10, max_keepalive_connections=5)
_TIMEOUT = httpx.Timeout(30.0, connect=10.0)


def _http(limits: httpx.Limits = _POOL) -> httpx.Client:
    """A thread-safe HTTP/1.1 pool, one per Supabase client (or per user_client family)."""
    return httpx.Client(http2=False, limits=limits, timeout=_TIMEOUT, follow_redirects=True)


# One pool for every per-request user client. A fresh pool per request paid a
# new TCP+TLS handshake each time (~250-900ms vs ~20ms reused). Safe to share:
# the user's Authorization header lives on the Supabase client and is sent per
# request, never set on this transport.
@lru_cache
def _user_http() -> httpx.Client:
    return _http(httpx.Limits(max_connections=20, max_keepalive_connections=10))


@lru_cache
def get_client() -> Client:
    if not settings.supabase_url or not settings.supabase_key:
        raise RuntimeError(
            "SUPABASE_URL and SUPABASE_KEY must be set; copy .env.example to .env and fill them in."
        )
    return create_client(
        settings.supabase_url,
        settings.supabase_key,
        options=ClientOptions(httpx_client=_http()),
    )


def get_user_client(jwt: str) -> Client:
    """Build a Supabase client that acts *as the signed-in user*.

    The bearer token is attached as the Authorization header, which PostgREST
    reads to populate ``auth.uid()``. So the RLS policies in
    ``migrations/rls.sql`` apply.

    Client is not cached, JWT is rotated per request,
    Caching would cause unbounded memory growth
    Could also lead to cross user data leakage if a JWT is reused for a different user.
    Only the connection pool underneath is shared (see _user_http).
    """
    if not settings.supabase_url or not settings.supabase_key:
        raise RuntimeError(
            "SUPABASE_URL and SUPABASE_KEY must be set; copy .env.example to .env and fill them in."
        )
    return create_client(
        settings.supabase_url,
        settings.supabase_key,
        options=ClientOptions(
            headers={"Authorization": f"Bearer {jwt}"}, httpx_client=_user_http()
        ),
    )


@lru_cache
def get_service_client() -> Client:
    """Build a Supabase client that bypasses RLS.

    Used for tool secrets and for turn repositories, which outlive the
    caller's token.

    Secrets never reach DBOS checkpointing.
    Never exposed during a request, only decrypted in memory and returned to the caller.
    """
    if not settings.supabase_url or not settings.supabase_service_key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set to use tool secrets.")
    return create_client(
        settings.supabase_url,
        settings.supabase_service_key,
        options=ClientOptions(httpx_client=_http()),
    )
