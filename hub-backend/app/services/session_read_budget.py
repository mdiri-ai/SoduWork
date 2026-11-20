"""One cancellable deadline for HTTP session reads, including endpoint content."""
import asyncio
import re
from contextvars import ContextVar

from starlette.responses import JSONResponse


# Leave delivery time before the desktop's eight-second request timeout.
READ_SECONDS = 6.0
_deadline = ContextVar("session_read_deadline", default=None)
_PATH = re.compile(r"^/api/v1/(?:tasks/[^/]+/ai-session|cloud-execution-sync/[^/]+)/?$")


def remaining(default):
    """Cap cluster envelopes to this request's deadline, never extend a retry."""
    deadline = _deadline.get()
    if deadline is None:
        return default
    left = deadline - asyncio.get_running_loop().time()
    if left <= 0:
        raise TimeoutError("Session read deadline reached")
    return min(default, left)


class SessionReadBudgetMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if (scope["type"] != "http" or scope.get("method") != "GET"
                or not _PATH.fullmatch(scope.get("path", ""))):
            return await self.app(scope, receive, send)
        deadline = asyncio.get_running_loop().time() + READ_SECONDS
        token = _deadline.set(deadline)
        started = False

        async def tracked_send(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            async with asyncio.timeout_at(deadline):
                await self.app(scope, receive, tracked_send)
        except TimeoutError:
            if started:
                raise
            # No successful page/cursor is returned for an incomplete body.
            response = JSONResponse(status_code=504, headers={"Retry-After": "3"}, content={
                "detail": {"code": "SESSION_READ_TIMEOUT", "retryable": True,
                           "message": "会话同步暂时超时，已有内容已保留，请稍后重试"}})
            await response(scope, receive, send)
        finally:
            _deadline.reset(token)
