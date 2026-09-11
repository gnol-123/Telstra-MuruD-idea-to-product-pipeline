"""mcp_server: catch-all for any MCP endpoint, static auth_token."""

from pydantic_ai.mcp import MCPToolset

from app.tools.base import ToolContext, VerifyResult
from app.tools.mcp.base import toolset_from_ctx, verify_toolset


def build(ctx: ToolContext) -> MCPToolset:
    return toolset_from_ctx(ctx)


async def verify(ctx: ToolContext) -> VerifyResult:
    url = str(ctx.config.get("url") or "")
    return await verify_toolset(url, lambda: toolset_from_ctx(ctx))
