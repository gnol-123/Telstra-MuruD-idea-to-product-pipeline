"""The code preview endpoints: browse, download, archive, upload, ports, serve.

Every test runs against an in-memory fake sandbox patched in where E2B's
connect would be, so nothing here touches the network. The fake implements
only the calls the routes make.
"""

import json
import posixpath
from dataclasses import dataclass
from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock

import pytest
from e2b import CommandExitException, FileNotFoundException, FileType

from app.environments import workspace
from app.main import app
from app.repositories.environment_repo import EnvNode
from app.routers.auth import UserResponse, get_current_user
from app.routers.deps import get_environment_repository

USER = UserResponse(id="00000000-0000-0000-0000-000000000001", email="test@example.com")
PROJECT = "00000000-0000-0000-0000-0000000000aa"
NODE = "00000000-0000-0000-0000-0000000000ee"
ROOT = "/home/user/workspace"
AUTH = {"Authorization": "Bearer fake-token"}
BASE = f"/projects/{PROJECT}/environments/{NODE}"


@dataclass
class Entry:
    name: str
    type: FileType
    path: str
    size: int = 0
    modified_time: datetime | None = None
    symlink_target: str | None = None


class _Stream:
    def __init__(self, data: bytes) -> None:
        self._chunks = [data[i : i + 4] for i in range(0, len(data), 4)] or [b""]

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def __aiter__(self):
        return self

    async def __anext__(self) -> bytes:
        if not self._chunks:
            raise StopAsyncIteration
        return self._chunks.pop(0)


class FakeFiles:
    """A flat {path: bytes} store; directories are implied by their children."""

    def __init__(self, files: dict[str, bytes]) -> None:
        self.data = dict(files)
        self.removed: list[str] = []

    def _is_dir(self, path: str) -> bool:
        return any(p.startswith(path.rstrip("/") + "/") for p in self.data)

    async def list(self, path: str, depth: int = 1):
        if not self._is_dir(path):
            raise FileNotFoundException(path)
        seen: dict[str, Entry] = {}
        prefix = path.rstrip("/") + "/"
        for p, content in self.data.items():
            if not p.startswith(prefix):
                continue
            head = p[len(prefix) :].split("/")[0]
            full = prefix + head
            kind = FileType.DIR if full != p else FileType.FILE
            seen[head] = Entry(
                head,
                kind,
                full,
                len(content) if kind == FileType.FILE else 0,
                datetime(2026, 9, 1, tzinfo=UTC),
            )
        return list(seen.values())

    async def read(self, path: str, format: str = "text"):
        if path not in self.data:
            raise FileNotFoundException(path)
        raw = self.data[path]
        if format == "stream":
            return _Stream(raw)
        if format == "bytes":
            return bytearray(raw)
        return raw.decode("utf-8")

    async def get_info(self, path: str):
        if path in self.data:
            return Entry(posixpath.basename(path), FileType.FILE, path, len(self.data[path]))
        if self._is_dir(path):
            return Entry(posixpath.basename(path), FileType.DIR, path)
        raise FileNotFoundException(path)

    async def write(self, path: str, data):
        self.data[path] = data if isinstance(data, bytes) else data.encode()

    async def remove(self, path: str):
        self.removed.append(path)
        self.data.pop(path, None)


@dataclass
class Result:
    stdout: str
    stderr: str = ""
    exit_code: int = 0


class FakeSandbox:
    def __init__(self, files: dict[str, bytes], ports: list[dict] | None = None) -> None:
        self.files = FakeFiles(files)
        self.ports = ports or []
        self.commands = MagicMock()
        self.commands.run = AsyncMock(side_effect=self._run)
        self.ran: list[str] = []
        self.archive_bytes = b"PK\x03\x04fake-zip"

    def get_host(self, port: int) -> str:
        return f"{port}-sbx1.e2b.app"

    async def _run(self, cmd: str, timeout: float | None = None, **_):
        self.ran.append(cmd)
        if cmd == workspace.PORTS_COMMAND:
            return Result(json.dumps(self.ports))
        if "zipfile" in cmd:
            out = [a for a in cmd.split() if "murud-archive" in a][0].strip("'")
            self.files.data[out] = self.archive_bytes
            return Result(f"{len(self.archive_bytes)} 3\n")
        if cmd.startswith("nohup python3 -m http.server"):
            port = int(cmd.split()[4])
            directory = cmd.split("--directory ")[1].split(" >")[0].strip("'")
            self.ports.append(
                {
                    "port": port,
                    "pid": 99,
                    "command": f"python3 -m http.server {port} --bind 0.0.0.0 "
                    f"--directory {directory}",
                    "local_only": False,
                }
            )
            return Result("")
        return Result("")


def _node(status: str = "ready", sandbox_id: str | None = "sbx1") -> EnvNode:
    return EnvNode(
        id=NODE,
        project_id=PROJECT,
        name="Build Box",
        config={"runtime": "e2b", "role": "user", "sandbox_id": sandbox_id},
        status=status,
        status_detail=None,
        tool_policy="ask",
        position_x=0,
        position_y=0,
    )


@pytest.fixture
def env(monkeypatch):
    """Wire a ready node and a fake sandbox. Yields (repo, sandbox)."""
    workspace._HELD.clear()
    repo = MagicMock()
    repo.get_environment_node.return_value = _node()
    sandbox = FakeSandbox(
        {
            f"{ROOT}/app/index.html": b"<h1>hi</h1>",
            f"{ROOT}/app/logo.png": b"\x89PNG\r\n\x1a\n\x00\xff",
            f"{ROOT}/notes.md": b"# notes",
        },
        ports=[
            {"port": 49983, "pid": 1, "command": "/usr/bin/envd", "local_only": False},
            {"port": 3000, "pid": 42, "command": "node server.js", "local_only": True},
        ],
    )
    connect = AsyncMock(return_value=sandbox)
    monkeypatch.setattr("app.environments.workspace.e2b.connect", connect)
    app.dependency_overrides[get_current_user] = lambda: USER
    app.dependency_overrides[get_environment_repository] = lambda: repo
    try:
        yield repo, sandbox, connect
    finally:
        app.dependency_overrides.clear()
        workspace._HELD.clear()


# -- browsing ----------------------------------------------------------------


def test_list_reuses_one_connection_across_requests(client, env):
    _, _, connect = env
    for path in (ROOT, f"{ROOT}/app"):
        r = client.get(f"{BASE}/files", params={"path": path}, headers=AUTH)
        assert r.status_code == 200
    assert connect.await_count == 1


def test_list_reports_entries_with_modified_time(client, env):
    r = client.get(f"{BASE}/files", params={"path": "app"}, headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    # A relative path resolves against the workspace root.
    assert body["path"] == f"{ROOT}/app"
    names = {e["name"]: e for e in body["entries"]}
    assert names["index.html"]["type"] == "file"
    assert names["index.html"]["modified"].startswith("2026-09-01")


def test_list_many_reads_folders_in_one_request_and_isolates_failures(client, env):
    r = client.post(f"{BASE}/files/list", json={"paths": [ROOT, "app", "gone"]}, headers=AUTH)
    assert r.status_code == 200
    listings = {x["path"]: x for x in r.json()["listings"]}
    assert {e["name"] for e in listings[ROOT]["entries"]} == {"app", "notes.md"}
    assert {e["name"] for e in listings[f"{ROOT}/app"]["entries"]} == {"index.html", "logo.png"}
    assert listings[f"{ROOT}/gone"]["entries"] is None
    assert "No such directory" in listings[f"{ROOT}/gone"]["error"]


def test_list_many_caps_the_batch(client, env):
    r = client.post(f"{BASE}/files/list", json={"paths": ["a"] * 21}, headers=AUTH)
    assert r.status_code == 422


def test_not_ready_environment_is_409(client, env):
    repo, _, _ = env
    repo.get_environment_node.return_value = _node(status="stopped", sandbox_id=None)
    r = client.get(f"{BASE}/files", headers=AUTH)
    assert r.status_code == 409
    assert "stopped" in r.json()["detail"]


def test_unreachable_sandbox_marks_node_error_and_502s(client, env, monkeypatch):
    repo, _, _ = env
    monkeypatch.setattr(
        "app.environments.workspace.e2b.connect", AsyncMock(side_effect=RuntimeError("gone"))
    )
    r = client.get(f"{BASE}/files", headers=AUTH)
    assert r.status_code == 502
    repo.set_status.assert_called_once()
    assert repo.set_status.call_args.args[1] == "error"


def test_stale_held_connection_is_retried_on_a_fresh_one(client, env, monkeypatch):
    _, sandbox, _ = env
    dead = FakeSandbox({})
    dead.files.list = AsyncMock(side_effect=RuntimeError("sandbox paused"))
    connect = AsyncMock(side_effect=[dead, sandbox])
    monkeypatch.setattr("app.environments.workspace.e2b.connect", connect)
    r = client.get(f"{BASE}/files", headers=AUTH)
    assert r.status_code == 200
    assert connect.await_count == 2


def test_missing_file_is_404_without_reconnecting(client, env):
    _, _, connect = env
    r = client.get(f"{BASE}/files/content", params={"path": "nope.txt"}, headers=AUTH)
    assert r.status_code == 404
    assert connect.await_count == 1


# -- downloads ---------------------------------------------------------------


def test_download_streams_binary_untouched(client, env):
    r = client.get(f"{BASE}/files/download", params={"path": "app/logo.png"}, headers=AUTH)
    assert r.status_code == 200
    assert r.content == b"\x89PNG\r\n\x1a\n\x00\xff"
    assert r.headers["content-type"] == "image/png"
    assert 'filename="logo.png"' in r.headers["content-disposition"]


def test_download_of_a_directory_points_at_archive(client, env):
    r = client.get(f"{BASE}/files/download", params={"path": "app"}, headers=AUTH)
    assert r.status_code == 422
    assert "archive" in r.json()["detail"]


def test_archive_builds_in_sandbox_streams_and_cleans_up(client, env):
    _, sandbox, _ = env
    r = client.get(f"{BASE}/files/archive", params={"path": "app"}, headers=AUTH)
    assert r.status_code == 200
    assert r.content == sandbox.archive_bytes
    assert r.headers["content-type"] == "application/zip"
    assert 'filename="app.zip"' in r.headers["content-disposition"]
    zip_cmd = next(c for c in sandbox.ran if "zipfile" in c)
    # Dependencies are skipped unless asked for.
    assert "node_modules" in zip_cmd and " 1 " in zip_cmd
    assert any("murud-archive" in p for p in sandbox.files.removed)


def test_archive_over_the_cap_is_413_and_removed(client, env, monkeypatch):
    _, sandbox, _ = env
    monkeypatch.setattr("app.routers.environments.settings.environment_max_archive_bytes", 4)
    r = client.get(f"{BASE}/files/archive", headers=AUTH)
    assert r.status_code == 413
    assert any("murud-archive" in p for p in sandbox.files.removed)


def test_archive_failure_is_502_with_the_reason(client, env):
    _, sandbox, _ = env

    async def boom(cmd, timeout=None, **_):
        raise CommandExitException(stderr="python3: not found", stdout="", exit_code=127, error="")

    sandbox.commands.run = AsyncMock(side_effect=boom)
    r = client.get(f"{BASE}/files/archive", headers=AUTH)
    assert r.status_code == 502
    assert "python3: not found" in r.json()["detail"]


# -- upload ------------------------------------------------------------------


def test_upload_writes_raw_bytes(client, env):
    _, sandbox, _ = env
    r = client.put(
        f"{BASE}/files", params={"path": "app/data.bin"}, content=b"\x00\x01\x02", headers=AUTH
    )
    assert r.status_code == 200
    assert r.json() == {"path": f"{ROOT}/app/data.bin", "size": 3}
    assert sandbox.files.data[f"{ROOT}/app/data.bin"] == b"\x00\x01\x02"


def test_upload_over_the_cap_is_413(client, env, monkeypatch):
    monkeypatch.setattr("app.routers.environments.settings.environment_max_upload_bytes", 2)
    r = client.put(f"{BASE}/files", params={"path": "big.bin"}, content=b"abcd", headers=AUTH)
    assert r.status_code == 413


# -- ports and serving -------------------------------------------------------


def test_ports_hide_envd_and_carry_preview_urls(client, env):
    r = client.get(f"{BASE}/ports", headers=AUTH)
    assert r.status_code == 200
    ports = r.json()["ports"]
    assert [p["port"] for p in ports] == [3000]
    assert ports[0]["url"] == "https://3000-sbx1.e2b.app"
    assert ports[0]["process"] == "node server.js"
    assert ports[0]["local_only"] is True


def test_ports_fall_back_to_proc_net_when_python_is_missing(client, env):
    _, sandbox, _ = env
    proc = (
        "  sl  local_address rem_address   st\n"
        "   0: 00000000:1F90 00000000:0000 0A 0 0 0 0 0 0 1234\n"
        "   1: 0100007F:C2CF 00000000:0000 0A 0 0 0 0 0 0 1\n"
    )

    async def run(cmd, timeout=None, **_):
        if cmd == workspace.PORTS_COMMAND:
            raise CommandExitException(
                stderr="python3: not found", stdout="", exit_code=127, error=""
            )
        return Result(proc)

    sandbox.commands.run = AsyncMock(side_effect=run)
    r = client.get(f"{BASE}/ports", headers=AUTH)
    assert r.status_code == 200
    # 0xC2CF is 49871, not envd; 0x1F90 is 8080.
    assert [p["port"] for p in r.json()["ports"]] == [8080, 49871]


def test_serve_a_file_starts_a_server_on_its_directory(client, env):
    _, sandbox, _ = env
    r = client.post(f"{BASE}/serve", json={"path": "app/index.html"}, headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["port"] == 8080
    assert body["reused"] is False
    assert body["serving"] == f"{ROOT}/app"
    assert body["open_url"] == "https://8080-sbx1.e2b.app/index.html"
    assert any(c.startswith("nohup python3 -m http.server 8080") for c in sandbox.ran)


def test_serve_reuses_a_server_already_on_that_directory(client, env):
    _, sandbox, _ = env
    client.post(f"{BASE}/serve", json={"path": "app"}, headers=AUTH)
    starts = sum(c.startswith("nohup") for c in sandbox.ran)
    r = client.post(f"{BASE}/serve", json={"path": "app/index.html"}, headers=AUTH)
    assert r.json()["reused"] is True
    assert sum(c.startswith("nohup") for c in sandbox.ran) == starts


def test_serve_missing_path_is_404(client, env):
    r = client.post(f"{BASE}/serve", json={"path": "nope"}, headers=AUTH)
    assert r.status_code == 404


def test_stop_forgets_the_held_connection(client, env, monkeypatch):
    repo, _, connect = env
    client.get(f"{BASE}/files", headers=AUTH)
    assert "sbx1" in workspace._HELD
    monkeypatch.setattr(
        "app.routers.environments.lifecycle.stop", AsyncMock(return_value=_node("stopped", None))
    )
    r = client.post(f"{BASE}/stop", headers=AUTH)
    assert r.status_code == 200
    assert "sbx1" not in workspace._HELD


# -- pure helpers --------------------------------------------------------------


def test_process_labels():
    lp = workspace.ListeningPort
    assert lp(1, 1, "python3 -m http.server 8080", False).process == "python3 -m http.server"
    assert lp(1, 1, "/usr/bin/node /app/node_modules/.bin/vite", False).process == "node vite"
    assert lp(1, None, "", True).process == ""


def test_serving_directory_reads_the_flag():
    lp = workspace.ListeningPort
    p = lp(8080, 1, "python3 -m http.server 8080 --bind 0.0.0.0 --directory /w/a", False)
    assert workspace.serving_directory(p) == "/w/a"
    assert workspace.serving_directory(lp(3000, 1, "node server.js", False)) is None


def test_pick_serve_port_skips_taken_ports():
    lp = workspace.ListeningPort
    taken = [lp(8080, 1, "node x", False), lp(8081, 1, "node y", False)]
    assert workspace.pick_serve_port(taken, "/w") == (8082, False)


def test_content_disposition_survives_unicode():
    header = workspace.content_disposition("résumé.pdf")
    assert 'filename="r_sum_.pdf"' in header
    assert "filename*=UTF-8''r%C3%A9sum%C3%A9.pdf" in header
