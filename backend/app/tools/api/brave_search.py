"""Brave Search.

The signature and docstring below are the model's entire view of this tool.
"""

import re

import httpx
from pydantic_ai.toolsets import FunctionToolset

from app.tools.base import ToolContext, VerifyResult

_ENDPOINT = "https://api.search.brave.com/res/v1/web/search"
_TIMEOUT = 15.0

_SLUG_SAFE = re.compile(r"[^a-z0-9_]+")

_MAX_NAME = 64
_PREFIX = "brave_search_"


def tool_name(ctx: ToolContext) -> str:
    """Tool name for a Brave Search node, unique within a project.

    Mirrors skills.tool_name: the node id suffix keeps two nodes of this
    type from colliding. A duplicate name raises UserError from pydantic-ai
    and fails the whole turn.
    """
    suffix = _SLUG_SAFE.sub("", ctx.node_id.lower())[:8] or "node"
    room = _MAX_NAME - len(_PREFIX) - len(suffix) - 1
    stem = _PREFIX.rstrip("_")[:room]
    return f"{stem}_{suffix}"


def _headers(api_key: str) -> dict[str, str]:
    return {"Accept": "application/json", "X-Subscription-Token": api_key}


def build(ctx: ToolContext) -> FunctionToolset:
    api_key = ctx.secrets.get("api_key", "")

    async def brave_search(query: str, count: int = 5) -> str:
        """Search the web.

        Args:
            query: What to search for.
            count: How many results to return, 1 to 10.
        """
        count = max(1, min(count, 10))
        async with httpx.AsyncClient(timeout=_TIMEOUT) as http:
            response = await http.get(
                _ENDPOINT,
                headers=_headers(api_key),
                params={"q": query, "count": count},
            )
            response.raise_for_status()
            results = (response.json().get("web") or {}).get("results") or []

        if not results:
            return "No results."
        lines = []
        for r in results[:count]:
            lines.append(f"{r.get('title', '')}\n{r.get('url', '')}\n{r.get('description', '')}")
        return "\n\n".join(lines)

    toolset = FunctionToolset()
    toolset.add_function(
        brave_search,
        name=tool_name(ctx),
        description="Search the web with Brave Search.",
    )
    return toolset


async def verify(ctx: ToolContext) -> VerifyResult:
    """Ping Brave and Verify API works"""
    api_key = ctx.secrets.get("api_key", "")
    if not api_key:
        return VerifyResult(ok=False, detail="Missing API key.")
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as http:
            response = await http.get(
                _ENDPOINT, headers=_headers(api_key), params={"q": "ping", "count": 1}
            )
    except httpx.HTTPError as exc:
        return VerifyResult(ok=False, detail=f"Could not reach Brave Search: {type(exc).__name__}")
    if response.status_code == 401:
        return VerifyResult(ok=False, detail="API key rejected.")
    if response.status_code >= 400:
        return VerifyResult(ok=False, detail=f"Brave Search returned {response.status_code}.")
    return VerifyResult(ok=True, detail="Connected.")
