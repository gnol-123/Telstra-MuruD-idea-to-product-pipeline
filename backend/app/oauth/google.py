"""Google OAuth: consent URL and token exchange for the connect flow."""

import time
from urllib.parse import urlencode

import httpx

from app.config import settings
from app.oauth.base import TokenSet

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"  # noqa: S105  # nosec B105


class TokenExchangeError(Exception):
    """Google's token endpoint returned a non-200. Never carries the payload."""


def consent_url(state: str, scopes: list[str], redirect_uri: str) -> str:
    """Build the Google consent screen URL. offline+consent forces a refresh token."""
    params = {
        "client_id": settings.google_oauth_client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "access_type": "offline",
        "prompt": "consent",
        "scope": " ".join(scopes),
        "state": state,
    }
    return f"{AUTH_URL}?{urlencode(params)}"


def _to_token_set(payload: dict) -> TokenSet:
    expires_in = payload.get("expires_in", 3600)
    return TokenSet(
        access_token=payload["access_token"],
        refresh_token=payload.get("refresh_token"),
        expires_at=time.time() + expires_in,
    )


async def exchange_code(code: str, redirect_uri: str) -> TokenSet:
    """Exchange an authorization code for an access and refresh token."""
    async with httpx.AsyncClient() as client:
        response = await client.post(
            TOKEN_URL,
            data={
                "code": code,
                "client_id": settings.google_oauth_client_id,
                "client_secret": settings.google_oauth_client_secret,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            },
        )
    if response.status_code != 200:
        raise TokenExchangeError(f"code exchange failed: {response.status_code}")
    return _to_token_set(response.json())


async def refresh(refresh_token: str) -> TokenSet:
    """Exchange a refresh token for a new access token."""
    async with httpx.AsyncClient() as client:
        response = await client.post(
            TOKEN_URL,
            data={
                "refresh_token": refresh_token,
                "client_id": settings.google_oauth_client_id,
                "client_secret": settings.google_oauth_client_secret,
                "grant_type": "refresh_token",
            },
        )
    if response.status_code != 200:
        raise TokenExchangeError(f"refresh failed: {response.status_code}")
    return _to_token_set(response.json())
