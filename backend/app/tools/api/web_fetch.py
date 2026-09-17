"""Web fetch: URL in, readable text out. No key, no config.

The signature and docstring of ``web_fetch`` below are the model's entire
view of this tool.
"""

import html as html_lib
import ipaddress
import re
import socket
from urllib.parse import urlparse

import httpx
from pydantic_ai.toolsets import FunctionToolset

from app.tools.base import ToolContext, VerifyResult

_TIMEOUT = 15.0
_MAX_BYTES = 500_000
_MAX_CHARS = 20_000
_MAX_REDIRECTS = 5

_SLUG_SAFE = re.compile(r"[^a-z0-9_]+")
_MAX_NAME = 64
_PREFIX = "web_fetch_"

_DROP_BLOCKS = re.compile(r"<(script|style|noscript)\b.*?</\1\s*>", re.I | re.S)
_TAGS = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")


def tool_name(ctx: ToolContext) -> str:
    """Unique per node, mirrors skills.tool_name."""
    suffix = _SLUG_SAFE.sub("", ctx.node_id.lower())[:8] or "node"
    room = _MAX_NAME - len(_PREFIX) - len(suffix) - 1
    stem = _PREFIX.rstrip("_")[:room]
    return f"{stem}_{suffix}"


def to_text(html: str) -> str:
    """Strip scripts, styles and tags; collapse whitespace."""
    text = _DROP_BLOCKS.sub(" ", html)
    text = _TAGS.sub(" ", text)
    text = html_lib.unescape(text)
    return _WS.sub(" ", text).strip()


def _transport() -> httpx.AsyncBaseTransport | None:
    # Hook for tests to swap in a MockTransport.
    return None


def _is_public(url: str) -> bool:
    """False for anything that resolves to loopback, private, link-local or reserved space."""
    host = urlparse(url).hostname
    if not host:
        return False
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            return False
    return bool(infos)


def build(ctx: ToolContext) -> FunctionToolset:
    async def web_fetch(url: str) -> str:
        """Fetch a web page and return its readable text.

        Args:
            url: An http or https URL.
        """
        if not url.lower().startswith(("http://", "https://")):
            return "Only http and https URLs can be fetched."
        # ponytail: resolve-then-connect leaves a DNS rebinding window; pinning
        # the resolved IP needs a custom transport, add if this ever faces the internet.
        try:
            async with httpx.AsyncClient(
                timeout=_TIMEOUT, follow_redirects=False, transport=_transport()
            ) as http:
                for _ in range(_MAX_REDIRECTS + 1):
                    if not _is_public(url):
                        return "That address is not reachable from here."
                    async with http.stream("GET", url) as response:
                        if response.is_redirect:
                            target = response.headers.get("location", "")
                            url = str(response.url.join(target))
                            continue
                        if response.status_code >= 400:
                            return f"Fetch failed: HTTP {response.status_code}."
                        chunks: list[bytes] = []
                        size = 0
                        async for chunk in response.aiter_bytes():
                            if size + len(chunk) > _MAX_BYTES:
                                break
                            chunks.append(chunk)
                            size += len(chunk)
                        body = b"".join(chunks).decode(response.encoding or "utf-8", "replace")
                        break
                else:
                    return "Fetch failed: too many redirects."
        except httpx.HTTPError as exc:
            return f"Fetch failed: {type(exc).__name__}."

        text = to_text(body)
        if len(text) > _MAX_CHARS:
            return text[:_MAX_CHARS] + " [truncated]"
        return text or "The page had no readable text."

    toolset = FunctionToolset()
    toolset.add_function(
        web_fetch, name=tool_name(ctx), description="Fetch a web page and read its text."
    )
    return toolset


async def verify(ctx: ToolContext) -> VerifyResult:
    # Nothing to connect to and nothing to configure.
    return VerifyResult(ok=True, detail="Ready.")
