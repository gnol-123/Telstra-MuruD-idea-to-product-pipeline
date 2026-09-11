"""Gmail's hosted MCP server. oauth2: refresh happens before build, never inside it."""

import time

from pydantic_ai.mcp import MCPToolset

from app.oauth import google
from app.oauth.base import TokenSet
from app.tools.base import ToolContext, VerifyResult
from app.tools.mcp.base import toolset, verify_toolset

# node_id -> cached access token. In memory only, never the vault.
_CACHE: dict[str, TokenSet] = {}

_EXPIRY_MARGIN_SECONDS = 60


async def access_token_for(node_id: str, refresh_token: str) -> str:
    """Cached access token, refreshing if absent or near expiry."""
    cached = _CACHE.get(node_id)
    if cached and cached.expires_at > time.time() + _EXPIRY_MARGIN_SECONDS:
        return cached.access_token

    token_set = await google.refresh(refresh_token)
    _CACHE[node_id] = token_set
    return token_set.access_token


def build(ctx: ToolContext) -> MCPToolset:
    url = str(ctx.config.get("url") or "")
    headers: dict[str, str] = dict(ctx.config.get("headers") or {})
    access_token = ctx.secrets.get("oauth_access_token", "")
    if access_token:
        headers["Authorization"] = f"Bearer {access_token}"
    return toolset(url, headers)


async def verify(ctx: ToolContext) -> VerifyResult:
    refresh_token = ctx.secrets.get("oauth_refresh_token", "")
    if not refresh_token:
        return VerifyResult(ok=False, detail="Node needs connecting. Use the Connect button.")

    try:
        access_token = await access_token_for(ctx.node_id, refresh_token)
    except google.TokenExchangeError:
        return VerifyResult(ok=False, detail="Access was revoked. Reconnect the node.")

    url = str(ctx.config.get("url") or "")
    with_token = ToolContext(
        node_id=ctx.node_id,
        name=ctx.name,
        config=ctx.config,
        secrets={**ctx.secrets, "oauth_access_token": access_token},
    )
    return await verify_toolset(url, lambda: build(with_token))
