"""Shared Supabase client.

Import ``get_client`` wherever you need database access; the client is created
once and reused, so there is no need to build one per module.
"""

from functools import lru_cache

from supabase import Client, create_client

from app.config import settings


@lru_cache
def get_client() -> Client:
    if not settings.supabase_url or not settings.supabase_key:
        raise RuntimeError(
            "SUPABASE_URL and SUPABASE_KEY must be set; copy .env.example to .env and fill them in."
        )
    return create_client(settings.supabase_url, settings.supabase_key)
