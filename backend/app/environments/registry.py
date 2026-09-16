"""Runtime slug to spec.

Keyed on config.runtime, not on role: a scratch space and a user provisioned
environment are the same kind of sandbox and share every code path. An
unknown runtime is reported unavailable rather than crashing a turn.
"""

from app.environments import e2b
from app.environments.base import EnvSpec

_REGISTRY: dict[str, EnvSpec] = {
    "e2b": EnvSpec(
        runtime="e2b",
        provision=e2b.provision,
        build=e2b.build,
        verify=e2b.verify,
        teardown=e2b.teardown,
    ),
}


def get_spec(runtime: str) -> EnvSpec | None:
    return _REGISTRY.get(runtime)


def known_runtimes() -> list[str]:
    return sorted(_REGISTRY)
