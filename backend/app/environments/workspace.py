"""The code preview's side of an environment: browse, download, serve.

The router's browsing endpoints call into this module. It keeps the E2B-facing
logic, and the scripts run inside the sandbox, out of the route handlers so
they can be tested without a network.

Two ideas run through it. A connection to a sandbox is reused for a short
while instead of being rebuilt per request, because a tree view clicks through
directories quickly and every fresh connect is two E2B round trips before the
real one. And anything that has to look at the sandbox as a whole (listening
ports, a zip of a folder) runs as one small Python script inside it, because
one command is one round trip where walking it from here would be hundreds.
"""

import json
import logging
import mimetypes
import posixpath
import shlex
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, TypeVar
from urllib.parse import quote

from e2b import (
    AsyncSandbox,
    CommandExitException,
    FileNotFoundException,
    InvalidArgumentException,
)

from app.environments import e2b
from app.environments.base import WORKSPACE_ROOT, EnvContext

logger = logging.getLogger(__name__)

T = TypeVar("T")

# -- connection reuse --------------------------------------------------------

# How long a connected sandbox is reused before connecting again. Connecting
# also pushes the E2B deadline, so this doubles as how often browsing keeps a
# sandbox awake: well under the smallest idle timeout (60s) an env may have.
_REUSE_SECONDS = 40.0

# Errors that describe the request, not the connection. Retrying them on a
# fresh connection would just fail the same way.
_SEMANTIC_ERRORS: tuple[type[BaseException], ...] = (
    FileNotFoundException,
    InvalidArgumentException,
    CommandExitException,
    UnicodeDecodeError,
    ValueError,
)


@dataclass
class _Held:
    sandbox: AsyncSandbox
    at: float


_HELD: dict[str, _Held] = {}


def _prune(now: float) -> None:
    for sandbox_id in [k for k, v in _HELD.items() if now - v.at >= _REUSE_SECONDS]:
        _HELD.pop(sandbox_id, None)


def forget(sandbox_id: str | None) -> None:
    """Drop a held connection. Called on stop, and after any failed call."""
    if sandbox_id:
        _HELD.pop(sandbox_id, None)


class Unreachable(Exception):
    """Connecting to the sandbox failed: it is gone, or E2B is down.

    Distinct from a call that failed on a live connection, because only this
    one is evidence the environment itself is broken and worth marking so.
    """


async def connected(ctx: EnvContext) -> AsyncSandbox:
    """A connected sandbox, reused if one was made in the last few seconds.

    Raises Unreachable if a fresh connect is needed and fails.
    """
    now = time.monotonic()
    _prune(now)
    sandbox_id = ctx.sandbox_id or ""
    held = _HELD.get(sandbox_id)
    if held is not None:
        return held.sandbox
    try:
        sandbox = await e2b.connect(ctx)
    except Exception as exc:
        raise Unreachable(f"{type(exc).__name__}: {exc}"[:500]) from exc
    _HELD[sandbox_id] = _Held(sandbox, now)
    return sandbox


async def with_sandbox(
    ctx: EnvContext,
    op: Callable[[AsyncSandbox], Awaitable[T]],
    *,
    passthrough: tuple[type[BaseException], ...] = (),
) -> T:
    """Run ``op`` on a held connection, retrying once on a fresh one.

    A held connection can go bad under us (the sandbox paused, or was killed
    from the CLI). The retry is what makes reuse safe: a stale handle costs
    one failed call, never a failed request. Semantic errors (a missing file)
    are raised straight through, never retried.

    Raises Unreachable when connecting fails; anything else ``op`` raises on
    the second attempt propagates unchanged. ``passthrough`` adds the
    caller's own "this is an answer, not a failure" exceptions.
    """
    sandbox = await connected(ctx)
    try:
        return await op(sandbox)
    except (*_SEMANTIC_ERRORS, *passthrough):
        raise
    except Exception:
        # Includes NotFoundException: from a file call it is a missing path,
        # from a dead sandbox it is the sandbox. Only a fresh connect can
        # tell them apart, and the retry does exactly that.
        logger.info("held connection to %s failed, reconnecting", ctx.sandbox_id)
        forget(ctx.sandbox_id)
        sandbox = await connected(ctx)
        return await op(sandbox)


# -- files ---------------------------------------------------------------------

# The *sandbox's* /tmp, never this process's: paths built from it are only
# ever handed to E2B, which is why the insecure-temp-file rules do not apply.
SANDBOX_TMP = "/tmp"  # noqa: S108  # nosec B108


def sandbox_temp(name: str) -> str:
    return posixpath.join(SANDBOX_TMP, name)


def content_type_for(path: str) -> str:
    guessed, _ = mimetypes.guess_type(posixpath.basename(path))
    return guessed or "application/octet-stream"


def content_disposition(filename: str) -> str:
    """An attachment header that survives non-ASCII names (RFC 6266)."""
    ascii_name = filename.encode("ascii", "replace").decode("ascii").replace('"', "")
    ascii_name = ascii_name.replace("?", "_") or "download"
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"


def archive_name(path: str) -> str:
    """workspace/app -> app.zip; / -> sandbox.zip."""
    base = posixpath.basename(posixpath.normpath(path).rstrip("/"))
    return f"{base or 'sandbox'}.zip"


# Folders that are rebuilt from a lockfile and dwarf the actual work. Skipped
# by default so "download the workspace" is the code, not 400MB of deps.
HEAVY_DIRS = ("node_modules", ".git", "__pycache__", ".venv", "venv", ".next", ".cache")

# Runs inside the sandbox: zip a directory to a temp file, print its size.
# Symlinks are skipped rather than followed, so a link to / cannot pull the
# whole machine in. Stdlib only: the base template has python3, not zip.
_ARCHIVE_SCRIPT = """
import os, sys, zipfile
root, out, skip = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
heavy = set(sys.argv[4].split(",")) if len(sys.argv) > 4 and sys.argv[4] else set()
base = os.path.dirname(root.rstrip("/")) or "/"
count = 0
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for dp, dns, fns in os.walk(root):
        if skip:
            dns[:] = [d for d in dns if d not in heavy]
        dns[:] = [d for d in dns if not os.path.islink(os.path.join(dp, d))]
        rel = os.path.relpath(dp, base)
        if not fns and not dns:
            z.writestr(rel.rstrip("/") + "/", "")
        for f in fns:
            p = os.path.join(dp, f)
            if os.path.islink(p) or not os.path.isfile(p) or p == out:
                continue
            z.write(p, os.path.relpath(p, base))
            count += 1
print(os.path.getsize(out), count)
"""


def archive_command(root: str, out: str, *, skip_heavy: bool) -> str:
    return " ".join(
        [
            "python3",
            "-c",
            shlex.quote(_ARCHIVE_SCRIPT),
            shlex.quote(root),
            shlex.quote(out),
            "1" if skip_heavy else "0",
            shlex.quote(",".join(HEAVY_DIRS)),
        ]
    )


def parse_archive_output(stdout: str) -> tuple[int, int]:
    """'<bytes> <files>' -> (bytes, files). Raises ValueError on anything else."""
    parts = stdout.strip().split()
    if len(parts) != 2:
        raise ValueError(f"unexpected archive output: {stdout[:200]!r}")
    return int(parts[0]), int(parts[1])


# -- ports -------------------------------------------------------------------

# E2B's own daemon. Always listening, never something a user wants to preview.
ENVD_PORT = 49983

# Runs inside the sandbox: every listening TCP port, with the process behind
# it where /proc lets us see it. One JSON line on stdout.
_PORTS_SCRIPT = """
import json, os
LOOPBACK = {"0100007F", "00000000000000000000000001000000", "0000000000000000FFFF00000100007F"}
def rows(path):
    try:
        lines = open(path).read().splitlines()[1:]
    except OSError:
        return []
    out = []
    for line in lines:
        f = line.split()
        if len(f) < 10 or f[3] != "0A":
            continue
        addr, port = f[1].rsplit(":", 1)
        out.append((addr, int(port, 16), f[9]))
    return out
socks = rows("/proc/net/tcp") + rows("/proc/net/tcp6")
owners = {}
for pid in os.listdir("/proc"):
    if not pid.isdigit():
        continue
    try:
        fds = os.listdir("/proc/%s/fd" % pid)
    except OSError:
        continue
    for fd in fds:
        try:
            t = os.readlink("/proc/%s/fd/%s" % (pid, fd))
        except OSError:
            continue
        if t.startswith("socket:["):
            owners.setdefault(t[8:-1], pid)
res = {}
for addr, port, inode in socks:
    pid = owners.get(inode)
    cmd = cwd = ""
    if pid:
        try:
            raw = open("/proc/%s/cmdline" % pid, "rb").read()
            cmd = raw.replace(b"\\0", b" ").decode("utf-8", "replace").strip()
        except OSError:
            pass
        try:
            cwd = os.readlink("/proc/%s/cwd" % pid)
        except OSError:
            cwd = ""
    local = addr in LOOPBACK
    e = res.setdefault(
        port, {"port": port, "pid": None, "command": "", "cwd": "", "local_only": True}
    )
    if not local:
        e["local_only"] = False
    if pid and e["pid"] is None:
        e["pid"] = int(pid)
        e["command"] = cmd
        e["cwd"] = cwd
print(json.dumps(sorted(res.values(), key=lambda r: r["port"])))
"""

PORTS_COMMAND = f"python3 -c {shlex.quote(_PORTS_SCRIPT)}"

# The fallback when python3 is missing: raw socket tables, parsed here.
PROC_NET_COMMAND = "cat /proc/net/tcp /proc/net/tcp6 2>/dev/null"

_LOOPBACK_HEX = {
    "0100007F",
    "00000000000000000000000001000000",
    "0000000000000000FFFF00000100007F",
}


@dataclass(frozen=True)
class ListeningPort:
    port: int
    pid: int | None
    command: str
    # Bound to loopback only. E2B forwards these too, but a server that
    # refuses the forwarded Host header is the usual reason a preview fails,
    # so the UI says so.
    local_only: bool
    # Working directory of the owning process, when /proc shows it.
    cwd: str = ""

    @property
    def process(self) -> str:
        """A short label: 'python3 -m http.server', 'node', 'next-server'."""
        if not self.command:
            return ""
        parts = self.command.split()
        head = posixpath.basename(parts[0])
        if len(parts) >= 3 and parts[1] == "-m":
            return f"{head} -m {parts[2]}"
        if head in ("node", "bun", "deno") and len(parts) >= 2:
            return f"{head} {posixpath.basename(parts[1])}"
        return head


def parse_ports_json(stdout: str) -> list[ListeningPort]:
    rows = json.loads(stdout.strip().splitlines()[-1]) if stdout.strip() else []
    return [
        ListeningPort(
            port=int(r["port"]),
            pid=r.get("pid"),
            command=str(r.get("command") or ""),
            local_only=bool(r.get("local_only")),
            cwd=str(r.get("cwd") or ""),
        )
        for r in rows
    ]


def parse_proc_net_tcp(text: str) -> list[ListeningPort]:
    """Listening ports from raw /proc/net/tcp{,6}, with no process info."""
    ports: dict[int, bool] = {}
    for line in text.splitlines():
        f = line.split()
        # Header lines start with 'sl'; state 0A is LISTEN.
        if len(f) < 4 or f[0] == "sl" or f[3] != "0A" or ":" not in f[1]:
            continue
        addr, hex_port = f[1].rsplit(":", 1)
        try:
            port = int(hex_port, 16)
        except ValueError:
            continue
        local = addr in _LOOPBACK_HEX
        ports[port] = ports.get(port, True) and local
    return [
        ListeningPort(port=p, pid=None, command="", local_only=local)
        for p, local in sorted(ports.items())
    ]


def previewable(ports: list[ListeningPort]) -> list[ListeningPort]:
    """Drop the sandbox's own plumbing, keep what a user could have started."""
    return [p for p in ports if p.port != ENVD_PORT and "envd" not in p.process]


async def listening_ports(sandbox: AsyncSandbox) -> list[ListeningPort]:
    """Every previewable listening port. Never raises on a sandbox without python3."""
    try:
        r = await sandbox.commands.run(PORTS_COMMAND, timeout=15, user="user")
        return previewable(parse_ports_json(r.stdout))
    except (CommandExitException, ValueError, KeyError, TypeError):
        logger.info("port script failed, falling back to /proc/net/tcp")
    r = await sandbox.commands.run(PROC_NET_COMMAND, timeout=15, user="user")
    return previewable(parse_proc_net_tcp(r.stdout))


# Runs inside the sandbox: which of the given ports answer HTTP. Any status
# counts; ssh, rpcbind and friends fail the parse and drop out.
_HTTP_PROBE_SCRIPT = """
import http.client, json, sys
from concurrent.futures import ThreadPoolExecutor
def ok(port):
    try:
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        c.request("GET", "/")
        c.getresponse()
        return port
    except Exception:
        return None
ports = [int(p) for p in sys.argv[1:]]
with ThreadPoolExecutor(max_workers=16) as ex:
    print(json.dumps([p for p in ex.map(ok, ports) if p is not None]))
"""


async def web_ports(sandbox: AsyncSandbox, ports: list[ListeningPort]) -> list[ListeningPort]:
    """The subset of ports that answer HTTP. Empty on any probe failure."""
    if not ports:
        return []
    cmd = " ".join(
        ["python3", "-c", shlex.quote(_HTTP_PROBE_SCRIPT), *(str(p.port) for p in ports)]
    )
    try:
        r = await sandbox.commands.run(cmd, timeout=15, user="user")
        answering = set(json.loads(r.stdout.strip().splitlines()[-1]))
    except (CommandExitException, ValueError, IndexError):
        return []
    return [p for p in ports if p.port in answering]


# -- static serving --------------------------------------------------------------

# Where a server started from the code preview lands. Above the ports agents
# are told to use (3000, 8080 is also theirs but we reuse ours by directory),
# and a small range so the preview tab lists them together.
SERVE_PORTS = tuple(range(8080, 8100))


def serving_directory(port: ListeningPort) -> str | None:
    """The directory a `python3 -m http.server --directory X` process serves."""
    parts = port.command.split()
    if "http.server" not in parts:
        return None
    if "--directory" in parts:
        i = parts.index("--directory")
        if i + 1 < len(parts):
            return posixpath.normpath(" ".join(parts[i + 1 :]).split(" --")[0])
    return None


def pick_serve_port(ports: list[ListeningPort], directory: str) -> tuple[int, bool]:
    """(port, already_serving). Reuses a server on the same directory."""
    directory = posixpath.normpath(directory)
    for p in ports:
        if serving_directory(p) == directory:
            return p.port, True
    taken = {p.port for p in ports}
    for candidate in SERVE_PORTS:
        if candidate not in taken:
            return candidate, False
    raise ValueError("No free preview port between 8080 and 8099")


def serve_command(directory: str, port: int) -> str:
    """A static file server that outlives the command that started it."""
    log = sandbox_temp(f"murud-serve-{port}.log")
    return (
        f"nohup python3 -m http.server {port} --bind 0.0.0.0 "
        f"--directory {shlex.quote(directory)} > {log} 2>&1 &"
    )


def port_payload(sandbox: AsyncSandbox, p: ListeningPort) -> dict[str, Any]:
    return {
        "port": p.port,
        "url": f"https://{sandbox.get_host(p.port)}",
        "pid": p.pid,
        "process": p.process,
        "command": p.command[:300],
        "local_only": p.local_only,
        "serving": serving_directory(p),
    }


# -- agent previews ------------------------------------------------------------

# Where agents publish their own servers. Disjoint from SERVE_PORTS (8080-8099,
# the UI's own serve button) so the two never fight over a port.
AGENT_PORTS = range(3000, 3100)

PREVIEW_REGISTRY_FILE = "murud-previews.json"


def next_free(candidates: range, taken: set[int]) -> int | None:
    """The first candidate not in taken, or None if all are."""
    for port in candidates:
        if port not in taken:
            return port
    return None


async def read_registry(sandbox: AsyncSandbox) -> list[dict[str, Any]]:
    """Published previews, oldest to newest. Missing or corrupt file reads as empty."""
    try:
        raw = await sandbox.files.read(sandbox_temp(PREVIEW_REGISTRY_FILE), user="user")
        data = json.loads(raw)
        return data if isinstance(data, list) else []
    except (FileNotFoundException, ValueError, TypeError):
        return []


async def write_registry(sandbox: AsyncSandbox, entries: list[dict[str, Any]]) -> None:
    await sandbox.files.write(sandbox_temp(PREVIEW_REGISTRY_FILE), json.dumps(entries), user="user")


async def upsert_preview(sandbox: AsyncSandbox, entry: dict[str, Any]) -> None:
    """Add or replace the entry for entry['port']. Read-modify-write, not atomic.

    # ponytail: two agents publishing at once can race and drop one write.
    # Fine at today's scale (one coding agent per project); a file lock or a
    # DB row would fix it if concurrent publishes become real.
    """
    entries = await read_registry(sandbox)
    entries = [e for e in entries if e.get("port") != entry["port"]]
    entries.append(entry)
    await write_registry(sandbox, entries)


def fallback_title(p: ListeningPort) -> str | None:
    """Unpublished server name: its workspace folder, else its process."""
    folder = serving_directory(p) or p.cwd
    if folder.startswith(WORKSPACE_ROOT + "/"):
        return posixpath.basename(folder.rstrip("/"))
    return p.process or None


def merge_previews(
    registry: list[dict[str, Any]],
    listening: list[ListeningPort],
    host_fn: Callable[[int], str],
) -> list[dict[str, Any]]:
    """Live registry rows (newest first) then unregistered listening ports.

    A registered port that stopped listening is dropped: dead previews don't show.
    """
    live_ports = {p.port for p in listening}
    registered_ports = {e.get("port") for e in registry}

    rows = []
    for e in reversed(registry):
        port = e["port"]
        if port not in live_ports:
            continue
        rows.append(
            {
                "id": str(port),
                "title": e.get("title"),
                "port": port,
                "path": e.get("path") or "/",
                "url": host_fn(port),
                "live": port in live_ports,
                "published": True,
                "agent_node_id": e.get("agent_node_id"),
                "created_at": e.get("created_at"),
            }
        )
    for p in listening:
        if p.port in registered_ports:
            continue
        rows.append(
            {
                "id": str(p.port),
                "title": fallback_title(p),
                "port": p.port,
                "path": "/",
                "url": host_fn(p.port),
                "live": True,
                "published": False,
                "agent_node_id": None,
                "created_at": None,
            }
        )
    return rows
