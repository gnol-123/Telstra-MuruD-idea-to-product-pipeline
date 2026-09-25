"""Process-wide TTL cache for catalog rows: agent types, tool types, presets.

Global, not per user: the catalog is the same for everyone. Seed edits show
up within TTL_S. Misses (None) aren't stored, so junk slugs can't grow it.
"""

import threading
import time
from collections.abc import Callable

# ponytail: per-process, so each replica refreshes on its own clock.
TTL_S = 60.0

_lock = threading.Lock()
_entries: dict[tuple, tuple[float, object]] = {}


def cached[T](key: tuple, load: Callable[[], T]) -> T:
    now = time.monotonic()
    with _lock:
        hit = _entries.get(key)
    if hit is not None and now - hit[0] < TTL_S:
        return hit[1]  # type: ignore[return-value]
    value = load()
    if value is not None:
        with _lock:
            _entries[key] = (now, value)
    return value


def clear() -> None:
    with _lock:
        _entries.clear()
