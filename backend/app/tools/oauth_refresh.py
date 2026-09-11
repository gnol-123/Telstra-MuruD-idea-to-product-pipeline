"""Shared oauth2 secret step: exchange the stored refresh token before build/verify.

Called by both assembly.assemble() and projects._verify_tool_node() right after
load_node_secrets, so build() and verify() always see a live access token in
ctx.secrets and never touch the network themselves.
"""

from app.oauth import google
from app.tools.mcp import gmail

# tool_slug -> node-id-keyed access token cache module, one per oauth2 service.
_HANDLERS = {"gmail": gmail}


async def with_access_token(
    tool_slug: str, node_id: str, secrets: dict[str, str]
) -> dict[str, str]:
    """Add oauth_access_token to secrets for an oauth2 node. No-op otherwise.

    A failed refresh means revoked access: propagate the error rather than
    retrying, so the caller can write status='error'.
    """
    handler = _HANDLERS.get(tool_slug)
    refresh_token = secrets.get("oauth_refresh_token")
    if handler is None or not refresh_token:
        return secrets

    access_token = await handler.access_token_for(node_id, refresh_token)
    return {**secrets, "oauth_access_token": access_token}


# Re-exported so callers can catch a failed refresh without importing google directly.
TokenExchangeError = google.TokenExchangeError
