"""The oauth2 connect flow: authorize builds the consent URL, callback lands it."""

from urllib.parse import urlencode
from uuid import UUID

from anyio import to_thread
from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from app.config import settings
from app.oauth import google
from app.oauth.base import InvalidStateError, sign_state, verify_state
from app.repositories.tool_repo import (
    get_tool_node_for_owner,
    load_node_secrets,
    secret_keys_for_owner,
    set_node_config_for_owner,
    set_node_secret_as,
    set_node_status_for_owner,
)
from app.routers.auth import CurrentAuth
from app.routers.deps import ToolRepo
from app.tools.base import ToolContext
from app.tools.oauth_refresh import TokenExchangeError, with_access_token
from app.tools.registry import get_spec

router = APIRouter(tags=["oauth"])

_CALLBACK_PATH = "/oauth/callback"


def _redirect_uri(request: Request) -> str:
    """Build from the request so it matches exactly what's registered at Google."""
    return str(request.url_for("oauth_callback"))


class AuthorizeResponse(BaseModel):
    url: str


@router.post(
    "/projects/{project_id}/nodes/{node_id}/authorize",
    response_model=AuthorizeResponse,
)
async def authorize(
    project_id: UUID,
    node_id: UUID,
    request: Request,
    tool_repo: ToolRepo,
    auth: CurrentAuth,
) -> AuthorizeResponse:
    """Build the Google consent URL for one oauth2 tool node. Does not redirect."""
    node = await to_thread.run_sync(tool_repo.get_tool_node, str(node_id))
    if node is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tool node not found")

    tool_type = await to_thread.run_sync(tool_repo.get_tool_type, node.tool_slug)
    if tool_type is None or tool_type.auth_kind != "oauth2":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="This tool does not use oauth2",
        )

    oauth_conf = tool_type.config_schema.get("oauth") or {}
    scopes = oauth_conf.get("scopes") or []
    if oauth_conf.get("provider") != "google" or not scopes:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Tool type has no oauth configuration",
        )

    state = sign_state(str(node_id), auth.user.id)
    url = google.consent_url(state, scopes, _redirect_uri(request))
    return AuthorizeResponse(url=url)


def _redirect_with_status(status_value: str, detail: str | None = None) -> RedirectResponse:
    params = {"oauth": status_value}
    if detail:
        params["detail"] = detail
    return RedirectResponse(f"{settings.frontend_url}?{urlencode(params)}")


@router.get(_CALLBACK_PATH, name="oauth_callback")
async def oauth_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
) -> RedirectResponse:
    """Google lands here. No bearer token: the signed state is the only trust."""
    if not code or not state:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing code or state")

    try:
        node_id, owner_id = verify_state(state)
    except InvalidStateError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    try:
        token_set = await google.exchange_code(code, _redirect_uri(request))
    except google.TokenExchangeError:
        return _redirect_with_status("error", "Could not complete sign-in with Google.")

    if not token_set.refresh_token:
        return _redirect_with_status(
            "error", "Google did not return a refresh token. Reconnect and approve access again."
        )

    refresh_token = token_set.refresh_token
    await to_thread.run_sync(
        lambda: set_node_secret_as(node_id, owner_id, "oauth_refresh_token", refresh_token)
    )

    await _verify_as_owner(node_id, owner_id)

    return _redirect_with_status("connected")


async def _verify_as_owner(node_id: str, owner_id: str) -> None:
    """Run verify with no caller JWT: the signed state already proved ownership.

    Same steps as projects._verify_tool_node, through the owner-scoped
    service-role helpers instead of a caller-scoped ToolRepo.
    """
    node = await to_thread.run_sync(get_tool_node_for_owner, node_id, owner_id)
    if node is None:
        return

    spec = get_spec(node.tool_slug)
    if spec is None:
        return

    keys = await to_thread.run_sync(secret_keys_for_owner, node.id, owner_id)
    secrets = await to_thread.run_sync(lambda: load_node_secrets(node.id, keys))

    try:
        secrets = await with_access_token(node.tool_slug, node.id, secrets)
    except TokenExchangeError:
        await to_thread.run_sync(
            lambda: set_node_status_for_owner(
                node.id, owner_id, "error", "Access was revoked. Reconnect the node."
            )
        )
        return

    result = await spec.verify(ToolContext(node.id, node.name, node.config, secrets))

    if result.discovered_tools is not None:
        merged_config = dict(node.config)
        merged_config["discovered_tools"] = result.discovered_tools
        await to_thread.run_sync(
            lambda: set_node_config_for_owner(node.id, owner_id, merged_config)
        )

    await to_thread.run_sync(
        lambda: set_node_status_for_owner(
            node.id, owner_id, "ready" if result.ok else "error", result.detail
        )
    )
