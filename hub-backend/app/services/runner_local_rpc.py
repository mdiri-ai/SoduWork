"""Bounded desktop RPC lanes with per-session mutation ordering.

Transport timeouts do not terminate blocking workers. Keep their capacity owned
until they really finish, and reserve separate workers for reads and controls.
"""
from __future__ import annotations

import asyncio
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import contextvars
from dataclasses import dataclass
import functools
import json
import threading

_CURRENT = contextvars.ContextVar("runner_local_request", default=None)
_LIMITS = {"work": 8, "query": 8, "probe": 2, "control": 4}
_QUERIES = {"job.has", "job.status", "job.info", "job.session", "agent.job",
            "runtime.sessions", "runtime.content.read"}
_CONTROLS = {"job.stop", "job.permission", "runtime.ping", "runtime.shutdown",
             "desktop.capability.reply"}
_session_streams = None


@dataclass
class SessionSubscription:
    identity: str
    ref: str
    cursor: int
    owner: dict


class SessionStreams:
    """One private desktop pipe. Dirty refs are bounded; the journal owns the data."""

    def __init__(self, owner):
        self.owner = owner
        self.loop = asyncio.get_running_loop()
        self.wake = asyncio.Event()
        self.lock = threading.Lock()
        self.subscriptions = {}
        self.watched = Counter()
        self.changed = set()
        self.legacy = set()

    def configure(self, message):
        ref, identity = message.get("ref"), message.get("subscriptionId")
        if not all(isinstance(value, str) and 0 < len(value) <= 128 for value in (ref, identity)):
            return {"ok": False, "error": "Invalid session subscription"}
        existing = self.subscriptions.get(identity)
        if message["op"] == "job.session.unsubscribe":
            if existing and existing.ref == ref:
                self.remove(existing)
            return {"ok": True}
        cursor = message.get("since", 0)
        if type(cursor) is not int or not 0 <= cursor < 2**53 or existing or len(self.subscriptions) >= 256:
            return {"ok": False, "error": "Session subscription unavailable"}
        owner = self.owner(ref)
        if owner is None:
            # Admission can be queued before a native run is registered. The
            # existing job.session snapshot remains authoritative in that phase.
            return {"ok": False, "error": "Local session stream unavailable"}
        sub = SessionSubscription(identity, ref, cursor, owner)
        self.subscriptions[identity] = sub
        with self.lock:
            self.watched[ref] += 1
        self.publish(ref)  # Include edits made before the registration arrived.
        return {"ok": True}

    def remove(self, sub):
        self.subscriptions.pop(sub.identity)
        with self.lock:
            self.watched[sub.ref] -= 1
            if not self.watched[sub.ref]:
                del self.watched[sub.ref]
                self.changed.discard(sub.ref)

    def publish(self, ref, *, legacy=False):
        with self.lock:
            idle = not self.changed and not self.legacy
            if ref in self.watched:
                self.changed.add(ref)
            elif legacy and len(self.legacy) < 256:
                # Older desktops understand only Armonel ref notifications.
                self.legacy.add(ref)
            else:
                return
            if idle:
                try:
                    self.loop.call_soon_threadsafe(self.wake.set)
                except RuntimeError:
                    return  # The parent pipe has already closed.

    async def send(self, server):
        await server.send_packet({"kind": "session-events-ready", "version": 2})
        while True:
            await self.wake.wait()
            await asyncio.sleep(.016)  # Coalesce adjacent chunks, never tick while idle.
            with self.lock:
                refs, legacy = self.changed, self.legacy
                self.changed, self.legacy = set(), set()
                self.wake.clear()
            if legacy:
                await server.send_packet({"kind": "session-changed", "refs": sorted(legacy)})
            for sub in tuple(self.subscriptions.values()):
                if sub.ref in refs and self.subscriptions.get(sub.identity) is sub:
                    await self.send_update(server, sub)

    async def send_update(self, server, sub):
        from .runner_event_scope import is_local
        data = None
        if self.owner(sub.ref) is sub.owner:
            try:
                reply = await server.dispatch({"op": "job.session", "ref": sub.ref,
                                               "since": sub.cursor, "limit": 128})
                data = reply.get("data") if reply.get("ok") else None
            except Exception:
                pass  # The observer can recover using the ordinary snapshot RPC.
        if self.subscriptions.get(sub.identity) is not sub:
            return  # The desktop switched sessions while the worker read the page.
        packet = {"ref": sub.ref, "subscriptionId": sub.identity}
        if (not isinstance(data, dict) or not data.get("ok") or self.owner(sub.ref) is not sub.owner
                or data.get("ref") != sub.ref or not is_local(data, sub.ref)):
            data = None
        else:
            data = self.page(data, sub.cursor)
        if data is None:
            self.remove(sub)
            await server.send_packet({**packet, "kind": "session-reset"})
            return
        await server.send_packet({**packet, "kind": "session-update", "since": sub.cursor, "data": data})
        sub.cursor = data["last"]
        if sub.cursor < data["seq"]:
            self.publish(sub.ref)

    @staticmethod
    def page(data, cursor):
        items, head = data.get("items"), data.get("seq")
        if type(head) is not int or head < cursor or not isinstance(items, list):
            return None
        # Large tool outputs are not token-sized. Keep batches small but allow a
        # single existing event through intact, advancing only the delivered cursor.
        size, count = 0, 0
        for item in items:
            if cursor + count == head:
                break  # Archive reads can overlap appends after the metadata snapshot.
            if not isinstance(item, dict) or item.get("seq") != cursor + count + 1:
                return None
            size += len(json.dumps(item, ensure_ascii=False).encode("utf-8"))
            if count and size > 256 * 1024:
                break
            count += 1
        if not count and head > cursor:
            return None
        return {**data, "items": items[:count], "last": cursor + count}


@contextmanager
def session_streams(streams):
    global _session_streams
    previous, _session_streams = _session_streams, streams
    try:
        yield
    finally:
        _session_streams = previous


def session_changed(ref, run):
    streams = _session_streams
    if streams is not None:
        from .runner_event_scope import is_local
        # Always invalidate a watched ref, even if a replacement changed owners.
        streams.publish(ref, legacy=bool(run and run.get("cli") == "armonel" and is_local(run, ref)))


@dataclass
class Request:
    server: object
    lane: str
    key: str
    cancelled: bool = False
    admitted: bool = False


def admission_cancelled() -> bool:
    request = _CURRENT.get()
    return bool(request and request.cancelled and not request.admitted)


def admission_recorded() -> None:
    request = _CURRENT.get()
    if request:
        request.admitted = True


def background_context():
    context = contextvars.copy_context()
    context.run(_CURRENT.set, None)
    return context


async def to_thread(func, /, *args, **kwargs):
    request = _CURRENT.get()
    if request is None:
        return await asyncio.to_thread(func, *args, **kwargs)
    context = contextvars.copy_context()
    call = functools.partial(context.run, func, *args, **kwargs)
    future = asyncio.get_running_loop().run_in_executor(
        request.server.executors[request.lane], call)
    # Cancelling a coroutine cannot stop its thread. Drain it before releasing
    # this lane or letting another mutation of the same session proceed.
    cancelled = False
    while True:
        try:
            result = await asyncio.shield(future)
            break
        except asyncio.CancelledError:
            if future.cancelled():
                raise
            # A second timeout/shutdown cancellation must not release a worker
            # that is still running after the first cancellation was deferred.
            cancelled = True
        except Exception:
            if cancelled:
                raise asyncio.CancelledError from None
            raise
    if cancelled:
        raise asyncio.CancelledError
    return result


def request_key(message):
    op = str(message.get("op") or "")
    if op == "job.dispatch":
        from .dispatch_identity import execution_ref
        return execution_ref(message.get("dispatchId")) or "dispatch"
    return str(message.get("ref") or (message.get("data") or {}).get("ref")
               or message.get("key") or message.get("jobId") or op)


def rejected(code, message):
    return {"ok": False, "code": code, "error": message,
            "retryable": code == "RUNNER_RPC_BUSY", "uncertain": False}


@dataclass
class NetworkRequest(Request):
    operation: str = ""
    previous: tuple = ()
    completion: object = None
    finished: bool = False


class WorkerLanes:
    """Isolate remote blocking calls without granting desktop transport authority."""

    def __init__(self, pending=None, tails=None):
        self.pending = pending if pending is not None else {}
        self.tails = tails if tails is not None else {}
        self.executors = {lane: ThreadPoolExecutor(size, thread_name_prefix="runner-network-" + lane)
                          for lane, size in _LIMITS.items()}

    @staticmethod
    def lane_for(op):
        if op in _CONTROLS or op in {"ping", "term.close", "term.detach"}:
            return "control"
        if op in {"runner.probe", "runtime.detect", "agent.setup", "component.job"}:
            return "probe"
        return "query" if op in _QUERIES or op in {"job.file", "component.list"} else "work"

    def accept(self, lane, key, op):
        previous = ([self.tails.get(key), self.tails.get(("control", key))]
                    if lane == "work" else [self.tails.get(("control", key))]
                    if lane == "control" else [])
        request = NetworkRequest(self, lane, key, operation=op, previous=tuple(task for task in previous if task),
                                 completion=asyncio.get_running_loop().create_future())
        if op == "job.stop":
            for other in self.pending.values():
                if other.lane == "work" and other.key == key and not other.admitted:
                    other.cancelled = True
        self.pending[id(request)] = request
        if lane in {"work", "control"}:
            self.tails[key if lane == "work" else ("control", key)] = request.completion
        return request

    async def wait(self, request):
        if not request.previous:
            return
        joined = asyncio.gather(*(asyncio.shield(task) for task in request.previous),
                                return_exceptions=True)
        cancelled = False
        while not joined.done():
            try:
                await asyncio.shield(joined)
            except asyncio.CancelledError:
                # Keep an interrupted reservation in the serial chain until
                # its predecessors finish; a later mutation cannot jump them.
                cancelled = True
        joined.result()
        if cancelled:
            raise asyncio.CancelledError

    def finish(self, request):
        if request.finished:
            return
        request.finished = True
        self.pending.pop(id(request), None)
        def release(_=None):
            if request.completion.done() or any(not task.done() for task in request.previous):
                return
            request.completion.set_result(None)
            for key in [key for key, tail in self.tails.items() if tail is request.completion]:
                del self.tails[key]
        # A task can be cancelled before its coroutine enters the context.
        # Its reservation must still retain unfinished serial predecessors.
        for task in request.previous:
            if not task.done():
                task.add_done_callback(release)
        release()

    @contextmanager
    def context(self, request):
        token = _CURRENT.set(request)
        try:
            yield request
        finally:
            _CURRENT.reset(token)

    def close(self):
        for executor in self.executors.values():
            executor.shutdown(wait=False, cancel_futures=True)


class Server:
    def __init__(self, dispatch, write, prefix, on_failure=None, pending=None, tails=None):
        self.dispatch, self.write, self.prefix = dispatch, write, prefix
        self.on_failure, self.failed = on_failure, False
        self.replies = set()
        self.tasks = set()
        self.requests = {}
        self.buckets = {}
        self.workers = WorkerLanes(pending, tails)
        self.counts = {lane: 0 for lane in _LIMITS}
        self.pending = {}
        self.semaphores = {lane: asyncio.Semaphore(size) for lane, size in _LIMITS.items()}
        self.writer = ThreadPoolExecutor(1, thread_name_prefix="runner-rpc-reply")
        self.write_lock = asyncio.Lock()

    async def reply(self, identity, result=None, error=None):
        packet = {"id": identity, "ok": error is None}
        packet.update({"error": error} if error is not None else {"result": result})
        await self.send_packet(packet)

    async def send_packet(self, packet):
        blob = self.prefix + json.dumps(packet, ensure_ascii=False, separators=(",", ":")) + "\n"
        try:
            async with self.write_lock:
                await asyncio.get_running_loop().run_in_executor(self.writer, self.write, blob)
        except Exception:
            self._fail()
            raise

    def _fail(self):
        if not self.failed:
            self.failed = True
            if self.on_failure:
                self.on_failure()

    def reject(self, identity, result=None, error=None):
        # A full lane must not make the input reader wait behind a slow output
        # pipe. If even bounded refusal receipts cannot drain, retire the pipe.
        if len(self.replies) >= 64 or self.failed:
            self._fail()
            return
        task = asyncio.create_task(self.reply(identity, result, error))
        self.replies.add(task)
        def done(value):
            self.replies.discard(value)
            if not value.cancelled():
                value.exception()
        task.add_done_callback(done)

    async def submit(self, identity, message):
        if self.failed:
            raise ConnectionError("Runner reply pipe is unavailable")
        op, key = str(message.get("op") or ""), request_key(message)
        lane = ("control" if op in _CONTROLS else "probe" if op == "runtime.detect"
                else "query" if op in _QUERIES else "work")
        bucket = (lane, key, op) if lane == "query" else (lane, key)
        # Bound retained request bodies without allowing slow work to consume
        # the control reserve. Repeated polls of one stuck session get no queue.
        per_key = 1 if lane in {"query", "probe"} else 8
        if self.counts[lane] >= _LIMITS[lane] * 4 or self.pending.get(bucket, 0) >= per_key:
            self.reject(identity, rejected("RUNNER_RPC_BUSY", "执行机正在处理此类请求，请稍后重试"))
            return
        request = self.workers.accept(lane, key, op)
        self.counts[lane] += 1
        self.pending[bucket] = self.pending.get(bucket, 0) + 1
        task = asyncio.create_task(self._run(identity, message, request))
        self.tasks.add(task)
        self.requests[task] = request
        self.buckets[task] = bucket
        task.add_done_callback(self._done)

    def _done(self, task):
        self.tasks.discard(task)
        request = self.requests.pop(task, None)
        if request is not None:
            self.workers.finish(request)
            bucket = self.buckets.pop(task)
            self.counts[request.lane] -= 1
            self.pending[bucket] -= 1
            if not self.pending[bucket]:
                del self.pending[bucket]
        # Observe transport failures; the parent pipe owns the Runner lifetime.
        if not task.cancelled():
            task.exception()

    async def _run(self, identity, message, request):
        with self.workers.context(request):
            try:
                await self.workers.wait(request)
                async with self.semaphores[request.lane]:
                    result = (rejected("RUNNER_REQUEST_CANCELLED", "本轮请求已停止，请重新发送")
                              if request.cancelled else await self.dispatch(message))
            except Exception as exc:
                result = None
                error = str(exc)[:600] or type(exc).__name__
            else:
                error = None
            # A reply failure is a transport failure, not another operation
            # error to send through the same broken pipe. Retain the request
            # bound until its reply drains as well as its worker.
            await self.reply(identity, result, error)

    async def close(self):
        for task in [*self.tasks, *self.replies]:
            task.cancel()
        await asyncio.gather(*self.tasks, *self.replies, return_exceptions=True)
        self.workers.close()
        self.writer.shutdown(wait=False, cancel_futures=True)
