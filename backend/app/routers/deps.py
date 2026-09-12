"""Shared route dependencies."""

from typing import Annotated

from fastapi import Depends

from app.repositories.chat_repo import ChatRepository
from app.repositories.environment_repo import EnvironmentRepository
from app.repositories.tool_repo import ToolRepository
from app.routers.auth import CurrentAuth
from app.services.supabase import get_user_client


def get_chat_repository(auth: CurrentAuth) -> ChatRepository:
    """Build a repository scoped to the caller.

    The client carries the caller's own token, so RLS applies to every query it
    makes. A dependency rather than a plain call so tests can override it.
    """
    return ChatRepository(get_user_client(auth.token), auth.user.id)


ChatRepo = Annotated[ChatRepository, Depends(get_chat_repository)]


def get_tool_repository(auth: CurrentAuth) -> ToolRepository:
    """Tool repository scoped to the caller, so RLS applies."""
    return ToolRepository(get_user_client(auth.token), auth.user.id)


ToolRepo = Annotated[ToolRepository, Depends(get_tool_repository)]


def get_environment_repository(auth: CurrentAuth) -> EnvironmentRepository:
    """Environment repository scoped to the caller, so RLS applies."""
    return EnvironmentRepository(get_user_client(auth.token), auth.user.id)


EnvRepo = Annotated[EnvironmentRepository, Depends(get_environment_repository)]
