"""Browser tools for an environment with E2B's Playwright MCP server.

A curated subset of the Playwright MCP tools, as plain functions. Every tool
returns a string and never raises. Screenshots are written into the agent's
directory as PNG files; the model only ever sees text.

One MCP session per run: opened lazily on the first browser call, closed when
the run exits the toolset. Each session boots a fresh Playwright container
inside the sandbox, which takes 12 to 18s.
"""

import asyncio
import logging
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from e2b import AsyncSandbox
from pydantic_ai.messages import BinaryContent
from pydantic_ai.toolsets import FunctionToolset, WrapperToolset

from app.config import settings
from app.environments.base import EnvContext
from app.tools.mcp import base as mcp_base

logger = logging.getLogger(__name__)

BROWSER_TOOL_NAMES = (
    "browser_navigate",
    "browser_snapshot",
    "browser_click",
    "browser_type",
    "browser_wait_for",
    "browser_resize",
    "browser_screenshot",
)

# Gateway prefixes every tool with the server name.
_PREFIX = "playwright-"
_READY_S = 45.0
_RETRY_S = 1.0
_CLOSE_S = 10.0
# ponytail: kills every browser in this sandbox; per-session container ids if two agents ever browse the same sandbox at once
_PRUNE = "docker ps -q --filter ancestor=mcp/playwright | xargs -r docker rm -f"

_UNSAFE = re.compile(r"[^a-z0-9_-]+")


def safe_name(name: str, n: int) -> str:
    """Screenshot file stem: [a-z0-9_-], max 40 chars, shot-<n> when empty."""
    stem = _UNSAFE.sub("-", (name or "").lower()).strip("-_")[:40].rstrip("-_")
    return stem or f"shot-{n}"


def _text(result: Any, limit: int) -> str:
    """MCP result to text. Images are dropped: the model is text only."""
    parts = result if isinstance(result, list) else [result]
    out = "\n".join(
        "[image omitted]" if isinstance(p, BinaryContent) else str(p)
        for p in parts
        if p is not None
    )
    if len(out) > limit:
        out = out[:limit] + f"\n...[truncated {len(out) - limit} chars]"
    return out or "Done."


class _Session:
    """One MCP session, owned by a background task.

    The MCP client opens an anyio task group, which must exit in the task that
    entered it. Tool calls and the run's exit happen in different tasks, so a
    dedicated task holds the session open until stop is set.
    """

    def __init__(self, get_sandbox: Callable[[], Awaitable[AsyncSandbox]]) -> None:
        self._get_sandbox = get_sandbox
        self._lock = asyncio.Lock()
        self._mcp: Any = None
        self._error: str | None = None
        self._task: asyncio.Task | None = None
        self._ready = asyncio.Event()
        self._stop = asyncio.Event()
        self._last: Exception | None = None

    async def _hold(self, mcp: Any) -> None:
        while True:
            try:
                async with mcp:
                    # Calls raise until the Playwright container is up.
                    while True:
                        try:
                            await mcp.list_tools()
                            break
                        except Exception as exc:
                            self._last = exc
                            await asyncio.sleep(_RETRY_S)
                    self._ready.set()
                    await self._stop.wait()
                return
            except Exception as exc:
                if self._ready.is_set():
                    logger.warning("browser session ended with error: %s", exc)
                    return
                self._last = exc
                await asyncio.sleep(_RETRY_S)

    async def _prune(self, sbx: AsyncSandbox) -> None:
        try:
            await sbx.commands.run(_PRUNE, user="root", timeout=30)
        except Exception as exc:
            logger.warning("failed to prune playwright containers: %s", exc)

    async def get(self) -> tuple[AsyncSandbox, Any]:
        """The sandbox and a ready MCP toolset. Raises RuntimeError with a reason."""
        async with self._lock:
            if self._error is not None:
                raise RuntimeError(self._error)
            sbx = await self._get_sandbox()
            if self._mcp is not None:
                return sbx, self._mcp
            await self._prune(sbx)
            headers = {"Authorization": f"Bearer {await sbx.get_mcp_token()}"}
            mcp = mcp_base.toolset(sbx.get_mcp_url(), headers)
            self._task = asyncio.create_task(self._hold(mcp))
            try:
                await asyncio.wait_for(self._ready.wait(), _READY_S)
            except TimeoutError:
                last = f": {type(self._last).__name__}: {self._last}" if self._last else ""
                # Remembered for the run, so later calls fail fast.
                self._error = f"browser not ready after {_READY_S:g}s{last}"[:500]
                await self.close()
                raise RuntimeError(self._error) from None
            self._mcp = mcp
            return sbx, mcp

    async def close(self) -> None:
        task, self._task, self._mcp = self._task, None, None
        if task is None:
            return
        if self._ready.is_set():
            self._stop.set()
        else:
            task.cancel()
        await asyncio.wait({task}, timeout=_CLOSE_S)
        if not task.done():
            logger.warning("browser session did not close in %ss", _CLOSE_S)
            task.cancel()
        self._ready, self._stop = asyncio.Event(), asyncio.Event()

    async def end_run(self) -> None:
        await self.close()
        self._error = None


@dataclass
class BrowserToolset(WrapperToolset):
    """Closes the run's browser session when the run exits the toolset."""

    close: Callable[[], Awaitable[None]] = field(default=None, kw_only=True)  # type: ignore[assignment]

    async def __aexit__(self, *args: Any) -> bool | None:
        await self.close()
        return await super().__aexit__(*args)


def build(ctx: EnvContext, get_sandbox: Callable[[], Awaitable[AsyncSandbox]]) -> BrowserToolset:
    """The browser half of an mcp environment. get_sandbox is e2b.build's shared connection."""
    session = _Session(get_sandbox)
    limit = settings.environment_max_file_chars
    shots = {"n": 0}

    async def _call(tool: str, args: dict) -> str:
        try:
            _, mcp = await session.get()
        except Exception as exc:
            return f"Browser unavailable: {exc}"[:600]
        try:
            return _text(await mcp.direct_call_tool(_PREFIX + tool, args), limit)
        except Exception as exc:
            return f"Browser action failed: {type(exc).__name__}: {exc}"[:1000]

    async def browser_navigate(url: str) -> str:
        return await _call("browser_navigate", {"url": url})

    async def browser_snapshot() -> str:
        return await _call("browser_snapshot", {})

    async def browser_click(element: str, ref: str) -> str:
        return await _call("browser_click", {"element": element, "ref": ref})

    async def browser_type(element: str, ref: str, text: str, submit: bool = False) -> str:
        return await _call(
            "browser_type", {"element": element, "ref": ref, "text": text, "submit": submit}
        )

    async def browser_wait_for(text: str = "", time: float = 0) -> str:
        args: dict = {}
        if text:
            args["text"] = text
        if time:
            args["time"] = time
        if not args:
            return "Give text to wait for, or time in seconds."
        return await _call("browser_wait_for", args)

    async def browser_resize(width: int, height: int) -> str:
        return await _call("browser_resize", {"width": width, "height": height})

    async def browser_screenshot(name: str = "", full_page: bool = False) -> str:
        shots["n"] += 1
        path = f"{ctx.agent_dir}/screenshots/{safe_name(name, shots['n'])}.png"
        try:
            sbx, mcp = await session.get()
        except Exception as exc:
            return f"Browser unavailable: {exc}"[:600]
        try:
            # No filename: with one, the file stays inside the browser container.
            result = await mcp.direct_call_tool(
                _PREFIX + "browser_take_screenshot", {"type": "png", "fullPage": full_page}
            )
            parts = result if isinstance(result, list) else [result]
            image = next((p for p in parts if isinstance(p, BinaryContent)), None)
            if image is None:
                return f"Screenshot returned no image: {_text(result, 500)}"
            await sbx.files.write(path, image.data, user="user")
        except Exception as exc:
            return f"Screenshot failed: {type(exc).__name__}: {exc}"[:1000]
        return f"Saved screenshot: {path}"

    ts = FunctionToolset()
    ts.add_function(
        browser_navigate,
        name="browser_navigate",
        description=(
            "Open a URL in a headless browser. For a server started in this "
            "environment use http://172.17.0.1:<port>, never localhost. The first "
            "browser call of a turn takes up to 20s while the browser starts."
        ),
    )
    ts.add_function(
        browser_snapshot,
        name="browser_snapshot",
        description=(
            "Accessibility snapshot of the current page as text. This is how you "
            "see the page. Elements carry a ref for click and type."
        ),
    )
    ts.add_function(
        browser_click,
        name="browser_click",
        description="Click an element. element: short description; ref: from browser_snapshot.",
    )
    ts.add_function(
        browser_type,
        name="browser_type",
        description=(
            "Type text into an element. ref comes from browser_snapshot. "
            "submit=true presses Enter after."
        ),
    )
    ts.add_function(
        browser_wait_for,
        name="browser_wait_for",
        description="Wait for text to appear on the page, or for time seconds.",
    )
    ts.add_function(
        browser_resize,
        name="browser_resize",
        description="Resize the browser viewport, e.g. 1280x800 desktop or 390x844 phone.",
    )
    ts.add_function(
        browser_screenshot,
        name="browser_screenshot",
        description=(
            "Save a PNG screenshot of the current page to screenshots/<name>.png "
            "in your directory. name: short, like 'landing' or 'checkout-mobile'. "
            "Returns the saved path. You cannot see the image; use "
            "browser_snapshot to read the page."
        ),
    )
    return BrowserToolset(ts, close=session.end_run)
