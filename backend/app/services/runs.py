"""Registry of turns in flight, keyed by conversation.

Holds the in-memory partial (text and tool events) and fans events out to any
number of SSE subscribers, so /chat/stream and /chat/attach read one source.

ponytail: in-process. A second replica cannot see or cancel these; switch to a
DB flag polled by the driver if the backend ever scales out.
"""

import asyncio
import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import anyio
from anyio.streams.memory import MemoryObjectReceiveStream, MemoryObjectSendStream

from app.repositories.project_repo import Message

if TYPE_CHECKING:
    from app.workflows import AgentTurn

log = logging.getLogger(__name__)

SUBSCRIBER_BUFFER = 256


class TurnBusy(Exception):
    """The conversation already has a turn running."""


@dataclass(eq=False)
class RunningTurn:
    """eq=False: identity equality, so a RunningTurn can sit in a set (parent.children)."""

    conversation_id: str
    node_id: str
    project_id: str
    model: str
    task: asyncio.Task | None = None
    user_message: Message | None = None
    message: Message | None = None
    text: list[str] = field(default_factory=list)
    events: list[dict] = field(default_factory=list)
    subscribers: set[MemoryObjectSendStream] = field(default_factory=set)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    dbos_workflow_id: str | None = None
    children: "set[RunningTurn]" = field(default_factory=set)
    cancel_requested: bool = False
    result: "AgentTurn | None" = None
    final: tuple[str, dict] | None = None


_RUNS: dict[str, RunningTurn] = {}

# Shielded finalise tasks. Strong refs: asyncio holds only weak ones, and
# nobody awaits a finaliser. Shutdown must not race the last write.
_FINALISERS: set[asyncio.Task] = set()


def track_finaliser(task: asyncio.Task) -> None:
    _FINALISERS.add(task)
    task.add_done_callback(_FINALISERS.discard)


def register(run: RunningTurn) -> None:
    # No await between check and insert: two requests cannot both pass.
    if run.conversation_id in _RUNS:
        raise TurnBusy(run.conversation_id)
    _RUNS[run.conversation_id] = run


def unregister(conversation_id: str) -> None:
    _RUNS.pop(conversation_id, None)


def get(conversation_id: str) -> RunningTurn | None:
    return _RUNS.get(conversation_id)


def running_in_project(project_id: str) -> list[RunningTurn]:
    return [r for r in _RUNS.values() if r.project_id == project_id]


async def subscribe(run: RunningTurn) -> tuple[str, list[dict], MemoryObjectReceiveStream]:
    """Snapshot plus a stream of what follows, taken under one lock so no event
    lands between the two."""
    send, receive = anyio.create_memory_object_stream[tuple[str, dict]](SUBSCRIBER_BUFFER)
    async with run.lock:
        text = "".join(run.text)
        events = list(run.events)
        if run.final is not None:
            send.send_nowait(run.final)
            send.close()
        else:
            run.subscribers.add(send)
    return text, events, receive


def _fan_out(run: RunningTurn, item: tuple[str, dict]) -> None:
    for send in list(run.subscribers):
        try:
            send.send_nowait(item)
        except (anyio.WouldBlock, anyio.BrokenResourceError, anyio.ClosedResourceError):
            # A reader that stopped reading, or left. Drop it; it can re-attach.
            run.subscribers.discard(send)
            send.close()


async def emit(run: RunningTurn, event: str, payload: dict) -> None:
    async with run.lock:
        if event == "chunk":
            run.text.append(payload["text"])
        elif event == "tool":
            # Where in the text it landed, so a reader can split the bubble there.
            payload = {**payload, "offset": sum(map(len, run.text))}
            run.events.append(payload)
        _fan_out(run, (event, payload))


async def close(run: RunningTurn, event: str, payload: dict) -> None:
    async with run.lock:
        run.final = (event, payload)
        _fan_out(run, (event, payload))
        for send in list(run.subscribers):
            send.close()
        run.subscribers.clear()


def sweep_stale(client, *, min_age_s: float) -> dict[str, int]:
    """Repair rows a dead process left mid-turn, on backend startup.

    A running message is dead once its heartbeat (``created_at`` before the
    first beat) is older than the cutoff. The live driver beats every 20s, so
    another backend's long turn on the same DB is left alone.

    ponytail: heartbeat_at is stamped by each backend's own clock; skew between
    replicas eats into the 90s floor. Use a DB-side now() via RPC if it bites.
    """
    from datetime import UTC, datetime, timedelta

    # At least 3 missed heartbeats. Z suffix: a "+" would need quoting in or_.
    stale_s = max(min_age_s, 90)
    cutoff = (datetime.now(UTC) - timedelta(seconds=stale_s)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    counts = {}
    counts["messages"] = len(
        client.table("messages")
        .update({"status": "failed", "error": "backend restarted"})
        .eq("status", "running")
        .or_(f"heartbeat_at.lt.{cutoff},and(heartbeat_at.is.null,created_at.lt.{cutoff})")
        .execute()
        .data
    )
    # Whatever still runs after the sweep above is live somewhere.
    live = {
        r["conversation_id"]
        for r in client.table("messages")
        .select("conversation_id")
        .eq("status", "running")
        .execute()
        .data
    }
    # tool_calls has no message_id: a running call is dead when its
    # conversation has no live running message.
    # ponytail: live ids go in the URL; fine for tens of concurrent turns.
    q = (
        client.table("tool_calls")
        .update({"status": "error", "error": "backend restarted"})
        .eq("status", "running")
        .lt("created_at", cutoff)
    )
    if live:
        q = q.not_.in_("conversation_id", sorted(live))
    counts["tool_calls"] = len(q.execute().data)
    # The heartbeat re-touches its node, so only abandoned ones are this old.
    counts["nodes"] = len(
        client.table("nodes")
        .update({"status": "ready"})
        .eq("kind", "agent")
        .eq("status", "running")
        .lt("updated_at", cutoff)
        .execute()
        .data
    )
    return counts


async def join_detached(timeout: float) -> int:
    """Wait for running turns and their finalise writes at shutdown.

    Returns how many are still running.
    """
    pending = [r.task for r in _RUNS.values() if r.task is not None and not r.task.done()]
    pending += [t for t in _FINALISERS if not t.done()]
    if not pending:
        return 0
    await asyncio.wait(pending, timeout=timeout)
    still_running = sum(1 for t in pending if not t.done())
    if still_running:
        log.warning("%d turn(s) still running at shutdown", still_running)
    return still_running
