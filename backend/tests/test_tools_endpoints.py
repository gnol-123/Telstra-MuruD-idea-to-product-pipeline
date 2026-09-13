"""
CI tests for:
  - unauthenticated requests returning 401
  - GET /tool-types (the "list tools" catalog endpoint)
  - POST /projects/{id}/nodes with kind='tool' (the "add tool" endpoint)

Written against dependency_overrides, since get_current_user / get_tool_repository
are FastAPI Depends() -- no real Supabase call needed for these three cases.
If your suite already has an auth fixture, use that instead of `fake_user` below;
the assertions are the part that matters
"""

from unittest.mock import AsyncMock, MagicMock

from app.main import app
from app.routers.auth import UserResponse, get_current_user
from app.routers.deps import get_chat_repository, get_tool_repository

# `client` fixture comes from conftest.py -- no need to redefine it here.

FAKE_USER = UserResponse(id="00000000-0000-0000-0000-000000000001", email="test@example.com")
FAKE_PROJECT_ID = "00000000-0000-0000-0000-0000000000aa"
FAKE_NODE_ID = "00000000-0000-0000-0000-0000000000cc"


def fake_user():
    return FAKE_USER


def mock_with_name(name: str, **attrs) -> MagicMock:
    """MagicMock(name=...) sets the mock's repr, not a real attribute --
    this sets `.name` as an actual attribute afterwards instead.
    """
    mock = MagicMock(**attrs)
    mock.name = name
    return mock


class TestUnauthenticated:
    """No Authorization header at all should always be a clean 401, not a 500."""

    def test_list_tool_types_requires_auth(self, client):
        response = client.get("/tool-types")
        assert response.status_code == 401

    def test_create_node_requires_auth(self, client):
        response = client.post(
            f"/projects/{FAKE_PROJECT_ID}/nodes",
            json={"kind": "tool", "tool_slug": "brave_search"},
        )
        assert response.status_code == 401

    def test_list_projects_requires_auth(self, client):
        response = client.get("/projects")
        assert response.status_code == 401


class TestListToolTypes:
    """GET /tool-types returns the catalog for the palette."""

    def test_returns_catalog_entries(self, client):
        mock_tool_type = mock_with_name(
            "Brave Search",
            id="00000000-0000-0000-0000-0000000000bb",
            slug="brave_search",
            description="Search the web",
            config_schema={"fields": []},
            secret_fields=["api_key"],
            auth_kind="token",
        )
        mock_repo = MagicMock()
        mock_repo.list_tool_types.return_value = [mock_tool_type]

        app.dependency_overrides[get_current_user] = fake_user
        app.dependency_overrides[get_tool_repository] = lambda: mock_repo
        try:
            response = client.get("/tool-types", headers={"Authorization": "Bearer fake-token"})
        finally:
            app.dependency_overrides.clear()

        assert response.status_code == 200
        body = response.json()
        assert len(body) == 1
        assert body[0]["slug"] == "brave_search"
        assert body[0]["name"] == "Brave Search"
        assert body[0]["auth_kind"] == "token"


class TestAddToolNode:
    """POST /projects/{id}/nodes with kind='tool' provisions and verifies a tool node."""

    def test_create_tool_node_success(self, client, monkeypatch):
        mock_chat_repo = MagicMock()
        mock_chat_repo.get_project.return_value = MagicMock(id=FAKE_PROJECT_ID)

        mock_tool_repo = MagicMock()
        mock_tool_repo.get_tool_type.return_value = mock_with_name(
            "Brave Search",
            id="00000000-0000-0000-0000-0000000000bb",
            slug="brave_search",
            config_schema={"fields": [{"key": "api_key"}], "default_url": None},
            secret_fields=["api_key"],
        )
        mock_tool_repo.create_tool_node.return_value = FAKE_NODE_ID
        mock_tool_repo.get_tool_node.return_value = mock_with_name(
            "Brave Search",
            id=FAKE_NODE_ID,
            project_id=FAKE_PROJECT_ID,
            tool_slug="brave_search",
            config={},
            status="pending",
            status_detail=None,
        )
        mock_tool_repo.secret_keys.return_value = ["api_key"]

        app.dependency_overrides[get_current_user] = fake_user
        app.dependency_overrides[get_chat_repository] = lambda: mock_chat_repo
        app.dependency_overrides[get_tool_repository] = lambda: mock_tool_repo
        # _verify_tool_node is `async def` -- an AsyncMock is required so the
        # route's `await` gets a coroutine back instead of a bare None.
        monkeypatch.setattr(
            "app.routers.projects._verify_tool_node",
            AsyncMock(return_value=None),
        )
        try:
            response = client.post(
                f"/projects/{FAKE_PROJECT_ID}/nodes",
                headers={"Authorization": "Bearer fake-token"},
                json={
                    "kind": "tool",
                    "tool_slug": "brave_search",
                    "config": {"api_key": "secret-value"},
                },
            )
        finally:
            app.dependency_overrides.clear()

        assert response.status_code == 201
        body = response.json()
        assert body["kind"] == "tool"
        assert body["tool_slug"] == "brave_search"
        # secrets never come back in the response
        assert "api_key" not in body.get("config", {})

    def test_create_tool_node_unknown_slug(self, client):
        mock_chat_repo = MagicMock()
        mock_chat_repo.get_project.return_value = MagicMock(id=FAKE_PROJECT_ID)
        mock_tool_repo = MagicMock()
        mock_tool_repo.get_tool_type.return_value = None

        app.dependency_overrides[get_current_user] = fake_user
        app.dependency_overrides[get_chat_repository] = lambda: mock_chat_repo
        app.dependency_overrides[get_tool_repository] = lambda: mock_tool_repo
        try:
            response = client.post(
                f"/projects/{FAKE_PROJECT_ID}/nodes",
                headers={"Authorization": "Bearer fake-token"},
                json={"kind": "tool", "tool_slug": "not_a_real_tool"},
            )
        finally:
            app.dependency_overrides.clear()

        assert response.status_code == 404
        