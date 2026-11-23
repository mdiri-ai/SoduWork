"""Three-layer red-green for the #1091 v2 fix: a read must agree with the database.

Maintainer-closed phenomenon (PR#1273 closed 2026-11-23): with the previous fix
(reconcile_runs kept inside list_runs, endpoint commit removed), GET returned the
in-memory aligned state (failed) while the DB row stayed running — a read disagreed
with the database. Reproduced by the maintainer as "API says failed, DB says running".

New fix (this PR):
- list_runs is fully read-only: the reconcile_runs call is REMOVED from list_runs.
- Run-state alignment happens only via the new explicit endpoint
  POST /ai-schedules/{sid}/refresh-runs (reconcile + commit).

Three layers (issue #1091 expectation followed literally):
- L1 structural: list_runs source contains no reconcile_runs call
- L2 in-memory: list_runs returns the DB state as-is (stale running stays running)
- L3 DB-final: the endpoint body (list_runs + return, no commit) leaves the DB
  unchanged AND the returned items equal a fresh re-read; only the explicit
  refresh path (reconcile + commit) aligns the DB, after which list_runs agrees.
"""
from __future__ import annotations

import inspect
import os
import unittest
from datetime import datetime, timedelta, timezone

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


class D_1091_V2_ThreeLayer(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from app import models
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.addAsyncCleanup(engine.dispose)
        base = [models.AiSchedule, models.AiScheduleRun, models.Task, models.OrgUnit,
                models.Project, models.Repo, models.Integration, models.Client,
                models.User, models.TaskEvent]
        async with engine.begin() as connection:
            for m in base:
                try:
                    await connection.run_sync(m.__table__.create)
                except Exception:
                    pass
        self.models = models
        self.engine = engine

    def _session(self):
        return async_sessionmaker(self.engine, expire_on_commit=False)()

    def _stale_run(self):
        from app.services.schedule_device_liveness import PROTOCOL
        models = self.models
        now = datetime.now(timezone.utc)
        return models.AiScheduleRun(
            id="run-legacy", idempotency_key="k1", schedule_id="sch1",
            state="running", trigger="manual",
            receipt={"executionMode": PROTOCOL},  # no leaseUntil -> stale
            started_at=now - timedelta(hours=2),
        )

    async def _fresh_run_state(self, run_id="run-legacy"):
        models = self.models
        async with self._session() as session:
            run = (await session.execute(
                select(models.AiScheduleRun).where(models.AiScheduleRun.id == run_id)
            )).scalar_one()
            return run.state

    # L1: structural — no reconcile call inside list_runs
    async def test_l1_list_runs_has_no_reconcile_call(self):
        from app.services import schedules as sch
        src = inspect.getsource(sch.list_runs)
        self.assertNotIn("await reconcile_runs", src,
                         "L1: list_runs must not call reconcile_runs (a read must not write)")
        self.assertIn("GET stays read-only", src)

    # L2: in-memory — list_runs returns the DB state as-is
    async def test_l2_list_runs_returns_db_state_asis(self):
        from app.services import schedules as sch
        async with self._session() as session:
            session.add(self._stale_run())
            await session.commit()
        async with self._session() as session:
            items = await sch.list_runs(session, "sch1")
        db_state = await self._fresh_run_state()
        self.assertEqual(db_state, "running", "L2: stale run must still be running in the DB")
        self.assertEqual(items[0]["state"], db_state,
                         "L2: the read must return the DB state (in-memory alignment is banned)")

    # L3: DB-final — endpoint read stays consistent; alignment only via explicit refresh
    async def test_l3_readonly_endpoint_agrees_with_db_then_refresh_aligns(self):
        from app.services import schedules as sch
        async with self._session() as session:
            session.add(self._stale_run())
            await session.commit()

        # endpoint body (admin_schedules.py GET runs): list_runs + return, no commit
        async with self._session() as session:
            items = await sch.list_runs(session, "sch1")
        db_state = await self._fresh_run_state()
        # the three-way agreement: returned state == DB state == running
        self.assertEqual(items[0]["state"], db_state,
                         "L3: GET response must agree with the database (returned == stored)")
        self.assertEqual(db_state, "running")

        # explicit refresh endpoint body: reconcile + commit — the only alignment entry
        async with self._session() as session:
            await sch.reconcile_runs(session, schedule_id="sch1")
            await session.commit()
        db_state2 = await self._fresh_run_state()
        self.assertNotEqual(db_state2, "running",
                            "L3: explicit refresh must align the stale run (DB finalized)")
        async with self._session() as session:
            items2 = await sch.list_runs(session, "sch1")
        self.assertEqual(items2[0]["state"], db_state2,
                         "L3: after explicit alignment, GET agrees with the database again")


if __name__ == "__main__":
    unittest.main()
