"""Skills: instruction text the model.
Build callable toolset and verify callable toolset
"""

import re

from pydantic_ai.toolsets import FunctionToolset

from app.tools.base import ToolContext, VerifyResult

_SLUG_SAFE = re.compile(r"[^a-z0-9_]+")

_MAX_NAME = 64
_PREFIX = "load_"


def tool_name(ctx: ToolContext) -> str:
    """Tool name for a skill node, unique within a project.

    The node id suffix gets sanitised so similarly named tools

    e.g "Code-Review" and "Code_Review!!"

    Do not collide. A duplicate name raises UserError from
    pydantic-ai and fails the whole turn.
    """
    stem = _SLUG_SAFE.sub("_", ctx.name.strip().lower()).strip("_") or "skill"
    suffix = _SLUG_SAFE.sub("", ctx.node_id.lower())[:8]
    room = _MAX_NAME - len(_PREFIX) - len(suffix) - 1
    return f"{_PREFIX}{stem[:room].rstrip('_')}_{suffix}"


def build(ctx: ToolContext) -> FunctionToolset:
    text = str(ctx.config.get("text") or "")
    description = str(ctx.config.get("description") or "Load these instructions before continuing.")

    def load_skill() -> str:
        return text

    toolset = FunctionToolset()

    toolset.add_function(load_skill, name=tool_name(ctx), description=description)
    return toolset


async def verify(ctx: ToolContext) -> VerifyResult:
    if not str(ctx.config.get("text") or "").strip():
        return VerifyResult(ok=False, detail="Skill text is empty.")
    return VerifyResult(ok=True, detail="Skill ready.")
