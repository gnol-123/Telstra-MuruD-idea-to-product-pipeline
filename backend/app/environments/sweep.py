"""Find and optionally kill E2B sandboxes with no live node behind them.

Nothing auto-deletes a paused sandbox, so an orphan bills forever until
something notices. This is that something.

    python -m app.environments.sweep            # report only
    python -m app.environments.sweep --apply    # kill every killable orphan

Cross-tenant by design: it uses the service-role client to see every owner's
nodes, which no other code path in this codebase does. Read-only against the
database either way; --apply only ever calls E2B's kill.
"""

import argparse
import asyncio
from dataclasses import dataclass

from e2b import AsyncSandbox, NotFoundException, SandboxQuery

from app.config import settings
from app.environments.sandboxes import APP_TAG
from app.services.supabase import get_service_client


@dataclass(frozen=True)
class Orphan:
    sandbox_id: str
    node_id: str | None
    reason: str
    killable: bool = True


def _api() -> dict:
    return {"api_key": settings.e2b_api_key} if settings.e2b_api_key else {}


def _list_sandboxes():
    return AsyncSandbox.list(SandboxQuery(metadata={"app": APP_TAG}), **_api())


def _all_nodes() -> list[dict]:
    """Every environment node's id and current sandbox_id, any owner.

    service_role bypasses RLS: this is the one place in the app that reads
    across tenants, and it exists only for this sweep.
    """
    db = get_service_client()
    rows = db.table("nodes").select("id, config").eq("kind", "environment").execute().data
    return rows or []


async def find_orphans() -> list[Orphan]:
    """Every murud-tagged sandbox with no live node pointing at it."""
    current_by_node = {
        row["id"]: (row.get("config") or {}).get("sandbox_id") for row in _all_nodes()
    }

    orphans: list[Orphan] = []
    paginator = _list_sandboxes()
    while True:
        batch = await paginator.next_items()
        for info in batch:
            node_id = info.metadata.get("node_id")
            if not node_id:
                orphans.append(
                    Orphan(info.sandbox_id, None, "no node_id in metadata", killable=False)
                )
                continue
            if node_id not in current_by_node:
                orphans.append(Orphan(info.sandbox_id, node_id, "no matching node"))
                continue
            if current_by_node[node_id] != info.sandbox_id:
                orphans.append(Orphan(info.sandbox_id, node_id, "superseded by a newer sandbox"))
        if not paginator.has_next:
            break
    return orphans


async def _kill(sandbox_id: str) -> None:
    try:
        await AsyncSandbox.kill(sandbox_id, **_api())
    except NotFoundException:
        pass


async def _run(apply: bool) -> None:
    orphans = await find_orphans()
    if not orphans:
        print("No orphaned sandboxes.")
        return

    print(f"{len(orphans)} orphaned sandbox(es):")
    for o in orphans:
        tag = "" if o.killable else "  (not auto-killable)"
        print(f"  {o.sandbox_id:24} node={str(o.node_id)[:12]:12} {o.reason}{tag}")

    if not apply:
        print("\nRe-run with --apply to kill the killable ones.")
        return

    for o in orphans:
        if not o.killable:
            continue
        await _kill(o.sandbox_id)
        print(f"killed  {o.sandbox_id}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="sweep", description=__doc__)
    parser.add_argument("--apply", action="store_true", help="kill every killable orphan")
    args = parser.parse_args(argv)
    asyncio.run(_run(args.apply))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
