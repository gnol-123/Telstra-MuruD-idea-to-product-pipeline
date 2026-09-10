"""Shared Supabase client.

Import ``get_client`` wherever you need database access; the client is created
once and reused, so there is no need to build one per module.
"""

from functools import lru_cache

from supabase import Client, ClientOptions, create_client

from app.config import settings


@lru_cache
def get_client() -> Client:
    if not settings.supabase_url or not settings.supabase_key:
        raise RuntimeError(
            "SUPABASE_URL and SUPABASE_KEY must be set; copy .env.example to .env and fill them in."
        )
    return create_client(settings.supabase_url, settings.supabase_key)


def get_user_client(jwt: str) -> Client:
    """Build a Supabase client that acts *as the signed-in user*.

    The bearer token is attached as the Authorization header, which PostgREST
    reads to populate ``auth.uid()``. So the RLS policies in
    ``migrations/rls.sql`` apply.

    Client is not cached, JWT is rotated per request,
    Caching would cause unbounded memory growth
    Could also lead to cross user data leakage if a JWT is reused for a different user.
    """
    if not settings.supabase_url or not settings.supabase_key:
        raise RuntimeError(
            "SUPABASE_URL and SUPABASE_KEY must be set; copy .env.example to .env and fill them in."
        )
    return create_client(
        settings.supabase_url,
        settings.supabase_key,
        options=ClientOptions(headers={"Authorization": f"Bearer {jwt}"}),
    )


@lru_cache
def get_service_client() -> Client:
    """Build a Supabase client that bypasses RLS.

    Used at one call site only: decrypting tool secrets, after the caller's
    own client has already proved they own the node.

    Secrets never reach DBOS checkpointing.
    Never exposed during a request, only decrypted in memory and returned to the caller.
    """
    if not settings.supabase_url or not settings.supabase_service_key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set to use tool secrets.")
    return create_client(settings.supabase_url, settings.supabase_service_key)
