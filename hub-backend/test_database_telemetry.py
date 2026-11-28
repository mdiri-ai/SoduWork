"""Real async pool/SQL behavior with isolated SQLite; no business database."""
import asyncio
import json
import os
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ.setdefault("ADMIN_PASS", "isolated-timing-fixture")
os.environ.setdefault("AUTH_SECRET", "isolated-timing-fixture-signing-key-not-for-deployment")

from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError, TimeoutError as PoolTimeout
from sqlalchemy.ext.asyncio import create_async_engine

from app.services import database_telemetry as telemetry


class DatabaseTelemetryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="soduwork-db-timing-")
        url = os.environ.get("SODUWORK_TEST_TIMING_DATABASE_URL")
        if url:
            parsed = make_url(url)
            self.assertEqual(parsed.database, "soduwork_timing_test")
            self.assertTrue(str(parsed.query.get("host", "")).startswith(tempfile.gettempdir() + "/soduwork-db-timing-"))
            self.assertFalse(parsed.host, "Only the owned local Unix socket is allowed")
        self.engine = create_async_engine(
            url or "sqlite+aiosqlite:///" + str(Path(self.directory.name) / "isolated.db"),
            poolclass=telemetry.ObservedAsyncAdaptedQueuePool,
            pool_size=1, max_overflow=0, pool_timeout=.15, pool_pre_ping=True)
        telemetry.install(self.engine)
        telemetry.install(self.engine)  # Installing twice must not double-count.
        telemetry.reset_for_test()

    async def asyncTearDown(self):
        await self.engine.dispose()
        self.directory.cleanup()
        self.assertIsNone(telemetry._current.get())

    async def observed(self, action, *, request_id="request-fixture", response_first=False):
        messages = []

        async def application(scope, receive, send):
            # Emulate routing and request-id assignment after outer middleware begins.
            scope["route"] = SimpleNamespace(path="/fixture/{item_id}")
            scope["state"] = {"request_id": request_id}
            start = {"type": "http.response.start", "status": 200,
                     "headers": [(b"server-timing", b"app;dur=1")]}
            if response_first:
                await send(start)
            await action()
            if not response_first:
                await send(start)
            await send({"type": "http.response.body", "body": b"ok"})

        async def send(message):
            messages.append(message)

        await telemetry.DatabaseTimingMiddleware(application)(
            {"type": "http", "method": "GET", "path": "/fixture/private-person",
             "query_string": b"token=private-value"}, None, send)
        return messages

    async def query(self):
        async with self.engine.connect() as connection:
            self.assertEqual(await connection.scalar(text("SELECT :private"), {"private": "secret-payload"}), "secret-payload")

    async def test_success_retains_existing_timing_and_counts_once_without_payloads(self):
        messages = await self.observed(self.query)
        row = telemetry._recent[-1]
        self.assertEqual(row["queries"], 1)
        self.assertEqual(row["acquisitions"], 1)
        self.assertEqual(row["requestId"], "request-fixture")
        self.assertGreaterEqual(row["holdMs"], row["sqlMs"])
        headers = dict(messages[0]["headers"])
        self.assertIn(b"app;dur=1, db-acquire;dur=", headers[b"server-timing"])
        self.assertIn(b"db-sql;dur=", headers[b"server-timing"])
        report = telemetry.summary(self.engine)
        self.assertEqual(report["pool"]["checkedout"], 0)
        self.assertEqual(report["routes"][0]["route"], "/fixture/{item_id}")
        for private in ("private-person", "private-value", "secret-payload", "SELECT", self.directory.name):
            self.assertNotIn(private, json.dumps(report))

    async def test_waiting_for_one_connection_is_separate_from_sql_execution(self):
        held = await self.engine.connect()
        pending = asyncio.create_task(self.observed(self.query))
        await asyncio.sleep(.04)
        await held.close()
        await pending
        row = telemetry._recent[-1]
        self.assertGreaterEqual(row["acquireMs"], 25)
        self.assertEqual(row["queries"], 1)
        self.assertEqual(row["poolTimeouts"], 0)

    async def test_concurrent_requests_keep_separate_acquisition_and_hold_times(self):
        entered, release = asyncio.Event(), asyncio.Event()

        async def first_query():
            async with self.engine.connect() as connection:
                await connection.execute(text("SELECT 1"))
                entered.set()
                await release.wait()

        first = asyncio.create_task(self.observed(first_query, request_id="request-first"))
        await asyncio.wait_for(entered.wait(), 1)
        second = asyncio.create_task(self.observed(self.query, request_id="request-second"))
        await asyncio.sleep(.04)
        release.set()
        await asyncio.gather(first, second)
        rows = {row["requestId"]: row for row in telemetry._recent}
        self.assertEqual(set(rows), {"request-first", "request-second"})
        self.assertGreaterEqual(rows["request-first"]["holdMs"], 25)
        self.assertGreaterEqual(rows["request-second"]["acquireMs"], 25)
        self.assertTrue(all(row["queries"] == 1 for row in rows.values()))

    async def test_pool_timeout_is_recorded_without_a_query_and_pool_still_recovers(self):
        async with self.engine.connect():
            with self.assertLogs("soduwork.database.performance", level="WARNING") as logs:
                with self.assertRaises(PoolTimeout):
                    await self.observed(self.query, request_id="request-timeout")
            row = telemetry._recent[-1]
            self.assertEqual(row["poolTimeouts"], 1)
            self.assertEqual(row["queries"], 0)
            self.assertGreaterEqual(row["acquireMs"], 100)
            self.assertIn("request-timeout", logs.output[0])
        await self.observed(self.query)
        self.assertEqual(telemetry._recent[-1]["poolTimeouts"], 0)

    async def test_driver_execution_delay_is_measured_as_sql_time(self):
        postgres = self.engine.dialect.name == "postgresql"
        if not postgres:
            async with self.engine.connect() as connection:
                raw = await connection.get_raw_connection()
                await raw.driver_connection.create_function("fixture_pause", 0, lambda: time.sleep(.03) or 1)

        async def slow_query():
            async with self.engine.connect() as connection:
                await connection.scalar(text("SELECT pg_sleep(0.03)" if postgres else "SELECT fixture_pause()"))

        await self.observed(slow_query)
        self.assertGreaterEqual(telemetry._recent[-1]["sqlMs"], 25)
        self.assertEqual(telemetry._recent[-1]["queries"], 1)

    async def test_sql_error_does_not_persist_statement_or_exception_text(self):
        async def invalid_query():
            async with self.engine.connect() as connection:
                await connection.execute(text("SELECT private_missing_column FROM private_missing_table"))

        with self.assertLogs("soduwork.database.performance", level="WARNING") as logs:
            with self.assertRaises(DBAPIError):
                await self.observed(invalid_query)
        row = telemetry._recent[-1]
        self.assertEqual(row["sqlErrors"], 1)
        self.assertEqual(row["queries"], 1)
        self.assertEqual(row["status"], 500)
        self.assertNotIn("private_missing", str(logs.output) + json.dumps(telemetry.summary(self.engine)))
        self.assertEqual(self.engine.pool.checkedout(), 0)

    async def test_cancel_returns_connection_and_resets_request_context(self):
        entered = asyncio.Event()

        async def held_query():
            async with self.engine.connect() as connection:
                await connection.execute(text("SELECT 1"))
                entered.set()
                await asyncio.Event().wait()

        pending = asyncio.create_task(self.observed(held_query, request_id="request-cancel"))
        await asyncio.wait_for(entered.wait(), 1)
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        self.assertEqual(self.engine.pool.checkedout(), 0)
        await self.observed(self.query, request_id="request-following")
        self.assertEqual([row["requestId"] for row in telemetry._recent], ["request-cancel", "request-following"])
        self.assertTrue(all(row["queries"] == 1 for row in telemetry._recent))
        self.assertFalse(telemetry._recent[0]["completed"])
        self.assertTrue(telemetry._recent[1]["completed"])

    async def test_body_and_dependency_cleanup_are_included_after_response_headers(self):
        await self.observed(self.query, response_first=True)
        self.assertEqual(telemetry._recent[-1]["queries"], 1)
        self.assertGreater(telemetry._recent[-1]["holdMs"], 0)

    async def test_invalidation_does_not_leave_observations_waiting_on_old_connections(self):
        async def invalidate():
            async with self.engine.connect() as connection:
                await connection.execute(text("SELECT 1"))
                await connection.invalidate()

        await self.observed(invalidate)
        self.assertEqual(len(telemetry._recent), 1)
        self.assertEqual(self.engine.pool.checkedout(), 0)
        await self.observed(self.query)
        self.assertEqual(len(telemetry._recent), 2)

    async def test_sample_capacity_and_time_window_are_bounded(self):
        now = time.time() * 1000
        for index in range(510):
            observation = telemetry.Observation(queries=1, ended=True, metadata={
                "at": now, "route": "/fixture/{item_id}", "method": "GET", "status": 200,
                "requestId": "request-" + str(index), "totalMs": 1})
            telemetry._publish(observation)
        self.assertEqual(telemetry.summary(self.engine)["samples"], 500)
        telemetry._recent[0]["at"] = now - 31 * 60 * 1000
        self.assertEqual(telemetry.summary(self.engine)["samples"], 499)

    async def test_logging_failure_cannot_break_database_observation(self):
        observation = telemetry.Observation(queries=1, sql_errors=1, ended=True,
                                            metadata={"at": time.time() * 1000})
        with patch.object(telemetry._log, "warning", side_effect=RuntimeError("sink unavailable")):
            telemetry._publish(observation)
        self.assertTrue(observation.published)

    async def test_connection_failure_is_counted_without_logging_its_message(self):
        async def unavailable():
            raise OSError("private-database-address")

        failing = create_async_engine("sqlite+aiosqlite://", async_creator=unavailable,
                                      poolclass=telemetry.ObservedAsyncAdaptedQueuePool)
        telemetry.install(failing)

        async def connect():
            async with failing.connect():
                pass

        try:
            with self.assertLogs("soduwork.database.performance", level="WARNING") as logs:
                with self.assertRaises(OSError):
                    await self.observed(connect)
            self.assertEqual(telemetry._recent[-1]["acquireErrors"], 1)
            self.assertEqual(telemetry._recent[-1]["queries"], 0)
            self.assertNotIn("private-database-address", str(logs.output))
        finally:
            await failing.dispose()

    async def test_production_middleware_keeps_request_id_and_operations_authentication(self):
        import httpx
        from app.main import app
        from app.db import engine
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture") as client:
            response = await client.get("/readyz", headers={"X-Request-ID": "request-production", "Origin": "null"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["x-request-id"], "request-production")
            self.assertEqual(set(response.headers["access-control-expose-headers"].split(", ")),
                             {"X-Request-ID", "Server-Timing", "X-Error-Code"})
            for field_name in ("app;dur=", "db-acquire;dur=", "db-sql;dur=", "db-hold;dur="):
                self.assertIn(field_name, response.headers["server-timing"])
            self.assertEqual(telemetry._recent[-1]["requestId"], "request-production")
            self.assertEqual(telemetry._recent[-1]["route"], "/readyz")
            self.assertEqual((await client.get("/api/v1/admin/operations/overview")).status_code, 401)
        await engine.dispose()


class ErrorRequestIdTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        import httpx
        from fastapi import APIRouter, HTTPException, Request
        from starlette.responses import StreamingResponse
        from app.main import app, AuthCacheUnavailable, TaskOwnershipChanged

        self.observed = {}
        router = APIRouter(prefix="/_request_id_fixture")

        @router.get("/unhandled/{case}")
        async def unhandled(case: str, request: Request):
            self.observed[case] = request.state.request_id
            await asyncio.sleep(0)  # Let concurrent requests overlap before failing.
            raise RuntimeError("synthetic-private-exception-detail")

        @router.get("/handled/{status}")
        async def handled(status: int):
            raise HTTPException(status, detail="synthetic handled error")

        @router.get("/validation")
        async def validation(value: int):
            return {"value": value}

        @router.get("/ownership")
        async def ownership():
            raise TaskOwnershipChanged("synthetic ownership change")

        @router.get("/cache")
        async def cache():
            raise AuthCacheUnavailable("synthetic cache unavailable")

        @router.get("/stream")
        async def stream():
            async def chunks():
                yield b"synthetic first chunk\n"
                raise RuntimeError("synthetic failure after headers")
            return StreamingResponse(chunks(), media_type="text/plain")

        # Exercise the production middleware stack without retaining fixture routes.
        routes = patch.object(app.router, "routes", list(app.router.routes))
        routes.start()
        self.addCleanup(routes.stop)
        app.include_router(router)
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
            base_url="http://fixture")
        self.addAsyncCleanup(self.client.aclose)

    def assert_error_id(self, response, expected):
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.headers.get("x-request-id"), expected)
        self.assertEqual(response.json(), {"detail": "服务器内部错误", "requestId": expected})
        self.assertRegex(expected, r"^[A-Za-z0-9._:-]{8,64}$")

    async def test_unhandled_errors_correlate_response_state_log_and_telemetry(self):
        from app.services import runtime_telemetry
        for index, offered in enumerate((None, "fixture-error:638", "bad id!", "short", "a" * 65)):
            with self.subTest(offered=offered):
                case = str(index)
                path = "/_request_id_fixture/unhandled/" + case
                headers = {} if offered is None else {"X-Request-ID": offered}
                with self.assertLogs("uvicorn.error", level="ERROR") as logs:
                    response = await self.client.get(path, headers=headers)
                request_id = self.observed[case]
                self.assert_error_id(response, request_id)
                self.assertTrue(any(record.args[:3] == (request_id, "GET", path)
                                    for record in logs.records))
                self.assertEqual(runtime_telemetry._recent_errors[0]["requestId"], request_id)
                if offered == "fixture-error:638":
                    self.assertEqual(request_id, offered)
                else:
                    self.assertRegex(request_id, r"^[0-9a-f]{32}$")
                    self.assertNotEqual(request_id, offered)

    async def test_concurrent_errors_keep_their_own_request_ids(self):
        offered = ["fixture-concurrent-" + str(i) if i % 2 else None for i in range(6)]
        paths = ["/_request_id_fixture/unhandled/concurrent-" + str(i) for i in range(6)]
        with self.assertLogs("uvicorn.error", level="ERROR") as logs:
            responses = await asyncio.gather(*(self.client.get(
                path, headers={"X-Request-ID": request_id} if request_id else {})
                for path, request_id in zip(paths, offered)))
        ids = []
        for index, response in enumerate(responses):
            request_id = self.observed["concurrent-" + str(index)]
            self.assert_error_id(response, request_id)
            self.assertTrue(any(record.args[:3] == (request_id, "GET", paths[index])
                                for record in logs.records))
            if offered[index]:
                self.assertEqual(request_id, offered[index])
            ids.append(request_id)
        self.assertEqual(len(set(ids)), len(ids))

    async def test_handler_without_request_id_generates_one_for_state_log_and_response(self):
        from fastapi import Request
        from app.main import global_exception_handler
        for state in ({}, {"request_id": ""}):
            with self.subTest(state=state.copy()):
                request = Request({"type": "http", "method": "GET", "path": "/fixture",
                                   "headers": [], "query_string": b"", "state": state})
                with self.assertLogs("uvicorn.error", level="ERROR") as logs:
                    response = await global_exception_handler(request, RuntimeError("synthetic-private"))
                request_id = response.headers.get("x-request-id")
                self.assertIsNotNone(request_id)
                self.assertRegex(request_id, r"^[0-9a-f]{32}$")
                self.assertEqual(request.state.request_id, request_id)
                self.assertEqual(logs.records[0].args[0], request_id)
                self.assertEqual(response.status_code, 500)
                self.assertEqual(json.loads(response.body),
                                 {"detail": "服务器内部错误", "requestId": request_id})

    async def test_handled_errors_keep_existing_status_body_and_request_header(self):
        cases = [("/_request_id_fixture/handled/" + str(status), status)
                 for status in (400, 403, 404, 500)]
        cases += [("/api/v1/admin/operations/overview", 401),
                  ("/_request_id_fixture/validation?value=bad", 422),
                  ("/_request_id_fixture/ownership", 409), ("/_request_id_fixture/cache", 503)]
        for path, status in cases:
            with self.subTest(path=path):
                response = await self.client.get(path, headers={"X-Request-ID": "fixture-handled-638"})
                self.assertEqual(response.status_code, status)
                self.assertEqual(response.headers.get("x-request-id"), "fixture-handled-638")
                self.assertEqual(set(response.json()), {"detail"})
                if "/handled/" in path:
                    self.assertEqual(response.json()["detail"], "synthetic handled error")

    async def test_failure_after_stream_headers_keeps_started_response(self):
        with self.assertLogs("uvicorn.error", level="ERROR"):
            response = await self.client.get("/_request_id_fixture/stream",
                                             headers={"X-Request-ID": "fixture-stream-638"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get("x-request-id"), "fixture-stream-638")
        self.assertEqual(response.text, "synthetic first chunk\n")


if __name__ == "__main__":
    unittest.main()
