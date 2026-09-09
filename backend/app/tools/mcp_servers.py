"""MCP servers.

Fethces MCP tools from MCP server;
Builds toolset for Agent Call
Verfies MCP server connection and tool availability
"""

from pydantic_ai.mcp import MCPToolset, StreamableHttpTransport

from app.tools.base import ToolContext, VerifyResult


def _toolset(ctx: ToolContext) -> MCPToolset:
    url = str(ctx.config.get("url") or "")
    headers: dict[str, str] = dict(ctx.config.get("headers") or {})
    token = ctx.secrets.get("auth_token", "")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return MCPToolset(StreamableHttpTransport(url, headers=headers))


def build(ctx: ToolContext) -> MCPToolset:
    return _toolset(ctx)


async def verify(ctx: ToolContext) -> VerifyResult:
    if not str(ctx.config.get("url") or "").strip():
        return VerifyResult(ok=False, detail="Missing server URL.")
    toolset = _toolset(ctx)
    try:
        async with toolset:
            tools = await toolset.list_tools()
    except Exception as exc:
        return VerifyResult(ok=False, detail=f"Could not connect: {type(exc).__name__}")
    names = sorted(t.name for t in tools)
    return VerifyResult(
        ok=True,
        detail=f"Connected. {len(names)} tools available.",
        discovered_tools=names,
    )
