"""Shared MCP plumbing: build a transport, connect and list tools."""

from pydantic_ai.mcp import MCPToolset, StreamableHttpTransport

from app.tools.base import ToolContext, VerifyResult


def toolset(url: str, headers: dict[str, str]) -> MCPToolset:
    return MCPToolset(StreamableHttpTransport(url, headers=headers))


def toolset_from_ctx(ctx: ToolContext, *, token_key: str = "auth_token") -> MCPToolset:  # noqa: S107
    """Build a toolset from ctx.config['url'] plus a bearer token secret."""
    url = str(ctx.config.get("url") or "")
    headers: dict[str, str] = dict(ctx.config.get("headers") or {})
    token = ctx.secrets.get(token_key, "")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return toolset(url, headers)


async def verify_toolset(url: str, build_toolset) -> VerifyResult:
    """Connect and list tools. Shared by every MCP service's verify.

    Takes a zero-arg builder, not a built toolset, so a missing url is caught
    before StreamableHttpTransport ever gets a chance to reject it.
    """
    if not url.strip():
        return VerifyResult(ok=False, detail="Missing server URL.")
    built = build_toolset()
    try:
        async with built:
            tools = await built.list_tools()
    except Exception as exc:
        return VerifyResult(ok=False, detail=f"Could not connect: {type(exc).__name__}")
    names = sorted(t.name for t in tools)
    return VerifyResult(
        ok=True,
        detail=f"Connected. {len(names)} tools available.",
        discovered_tools=names,
    )
