"""Sandbox control from the command line.

Lists and kills E2B sandboxes without going through the API, so a sandbox can
always be stopped even if the app is down or a node row was lost.

    python -m app.environments.sandboxes list
    python -m app.environments.sandboxes list --all
    python -m app.environments.sandboxes kill <sandbox_id> [<sandbox_id> ...]
    python -m app.environments.sandboxes kill-all
    python -m app.environments.sandboxes kill-all --yes

Reads E2B_API_KEY from the environment or backend/.env. Nothing here touches
the database: killing a sandbox leaves its node row pointing at a dead id,
which the next verify or turn reports as an error and a start recreates.
"""

import argparse
import asyncio
import pathlib
import sys

from dotenv import dotenv_values
from e2b import AsyncSandbox, NotFoundException, SandboxQuery

# Set on every sandbox this app creates, so a sweep can tell ours apart.
APP_TAG = "murud"

_ENV_PATH = pathlib.Path(__file__).resolve().parents[2] / ".env"


def _api_key() -> str:
    from app.config import settings

    key = settings.e2b_api_key or dotenv_values(_ENV_PATH).get("E2B_API_KEY") or ""
    if not key:
        print("E2B_API_KEY is not set. Nothing to do.", file=sys.stderr)
        raise SystemExit(2)
    return key


async def _fetch(key: str, *, ours_only: bool) -> list:
    """Every sandbox, paged. Paused ones are included: they still cost."""
    query = SandboxQuery(metadata={"app": APP_TAG}) if ours_only else None
    paginator = AsyncSandbox.list(query, api_key=key)
    items = []
    while True:
        items.extend(await paginator.next_items())
        if not paginator.has_next:
            break
    return items


def _describe(info) -> str:
    meta = getattr(info, "metadata", None) or {}
    node = meta.get("node_id", "-")
    state = getattr(info, "state", "?")
    started = getattr(info, "started_at", "")
    return f"{info.sandbox_id:24} {str(state):10} node={str(node)[:8]:8} started={started}"


async def _list(ours_only: bool) -> int:
    key = _api_key()
    items = await _fetch(key, ours_only=ours_only)
    scope = "murud" if ours_only else "all"
    if not items:
        print(f"No {scope} sandboxes.")
        return 0
    print(f"{len(items)} {scope} sandbox(es):")
    for info in items:
        print(" ", _describe(info))
    return 0


async def _kill(sandbox_ids: list[str]) -> int:
    key = _api_key()
    failed = 0
    for sandbox_id in sandbox_ids:
        try:
            killed = await AsyncSandbox.kill(sandbox_id, api_key=key)
            print(f"killed  {sandbox_id}" if killed else f"absent  {sandbox_id}")
        except NotFoundException:
            print(f"absent  {sandbox_id}")
        except Exception as exc:
            failed += 1
            print(f"FAILED  {sandbox_id}: {type(exc).__name__}: {exc}", file=sys.stderr)
    return 1 if failed else 0


async def _kill_all(ours_only: bool, assume_yes: bool) -> int:
    key = _api_key()
    items = await _fetch(key, ours_only=ours_only)
    if not items:
        print("Nothing to kill.")
        return 0

    print(f"About to kill {len(items)} sandbox(es):")
    for info in items:
        print(" ", _describe(info))

    if not assume_yes:
        answer = input("Type 'kill' to confirm: ").strip()
        if answer != "kill":
            print("Aborted.")
            return 1

    return await _kill([info.sandbox_id for info in items])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="sandboxes", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_list = sub.add_parser("list", help="show sandboxes, running and paused")
    p_list.add_argument(
        "--all", action="store_true", help="include sandboxes this app did not create"
    )

    p_kill = sub.add_parser("kill", help="kill sandboxes by id")
    p_kill.add_argument("sandbox_ids", nargs="+")

    p_kill_all = sub.add_parser("kill-all", help="kill every sandbox this app created")
    p_kill_all.add_argument(
        "--all", action="store_true", help="include sandboxes we did not create"
    )
    p_kill_all.add_argument("--yes", action="store_true", help="skip the confirmation prompt")

    args = parser.parse_args(argv)

    if args.command == "list":
        return asyncio.run(_list(ours_only=not args.all))
    if args.command == "kill":
        return asyncio.run(_kill(args.sandbox_ids))
    return asyncio.run(_kill_all(ours_only=not args.all, assume_yes=args.yes))


if __name__ == "__main__":
    raise SystemExit(main())
