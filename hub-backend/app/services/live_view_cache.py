"""Short-lived, event-invalidated cache for expensive read-only live views.

The task trace and AI desk endpoints are assembled from many durable tables.  A
single renderer already coalesces refreshes, but several desktop windows can
still ask for the same immutable JSON snapshot at once.  This cache serializes
builders per scope, reuses a recent snapshot, and invalidates it whenever the
realtime hub publishes a task event.
"""
from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Any
from weakref import WeakValueDictionary


class _Generation:
    def __init__(self):
        self.revision = 0


_ENTRIES: dict[tuple[str, str, str, str, int], tuple[_Generation, int, float, Any]] = {}
_LOCKS: WeakValueDictionary = WeakValueDictionary()
_GENERATIONS: WeakValueDictionary[str, _Generation] = WeakValueDictionary()
_MAX_ENTRIES = 512


def _generation(client_id: str) -> _Generation:
    return _GENERATIONS.setdefault(client_id, _Generation())


def invalidate(client_id: str, event: dict | None = None) -> None:
    """Invalidate every live view for a device, including in-flight builders."""
    client_id = str(client_id or "")
    if not client_id:
        return
    generation = _GENERATIONS.get(client_id)
    if generation is not None:
        generation.revision += 1


def _prune(now: float) -> None:
    if len(_ENTRIES) <= _MAX_ENTRIES:
        return
    expired = [key for key, value in _ENTRIES.items() if value[2] <= now]
    for key in expired:
        _ENTRIES.pop(key, None)
        if len(_ENTRIES) <= _MAX_ENTRIES:
            return
    for key in list(_ENTRIES)[:max(0, len(_ENTRIES) - _MAX_ENTRIES)]:
        _ENTRIES.pop(key, None)


async def get_or_build(namespace: str, client_id: str, task_id: str,
                       builder: Callable[[], Awaitable[Any]],
                       ttl: float = 3.0, *, actor: Any = None) -> Any:
    """Return one current snapshot; builders for the same scope never overlap.

    The builder deliberately runs in the calling request while holding a keyed
    lock.  It may therefore use that request's ``AsyncSession`` safely.  Waiting
    requests keep their own sessions idle and consume the completed cache entry.
    """
    key = (str(namespace or "live"), str(client_id or ""), str(task_id or ""),
           str(getattr(actor, "user_ref", None) or ""),
           int(getattr(actor, "auth_version", 0) or 0))
    now = time.monotonic()
    # Cached snapshots and active builders own the token. Events for devices
    # with neither need no history, and evicting a view releases its token.
    generation = _generation(key[1])
    revision = generation.revision
    cached = _ENTRIES.get(key)
    if cached and cached[0] is generation and cached[1] == revision and cached[2] > now:
        return cached[3]

    lock = _LOCKS.setdefault(key, asyncio.Lock())
    async with lock:
        now = time.monotonic()
        revision = generation.revision
        cached = _ENTRIES.get(key)
        if cached and cached[0] is generation and cached[1] == revision and cached[2] > now:
            return cached[3]
        value = await builder()
        # A realtime event may arrive while the expensive snapshot is building.
        # Return that snapshot to the caller, but never publish it as a fresh hit.
        if generation.revision == revision:
            _ENTRIES[key] = (generation, revision, time.monotonic() + max(0.1, float(ttl)), value)
            _prune(time.monotonic())
        return value


def clear() -> None:
    """Invalidate snapshots without dropping locks held by in-flight builders."""
    _ENTRIES.clear()
    for generation in list(_GENERATIONS.values()):
        generation.revision += 1


def reset_for_tests() -> None:
    _ENTRIES.clear()
    _LOCKS.clear()
    _GENERATIONS.clear()
