"""No-client recovery with isolated storage and controlled external boundaries."""
import asyncio
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import threading
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("AUTH_SECRET", "isolated-cloud-recovery-not-a-real-secret")

import httpx
from fastapi import FastAPI, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models, automation_models as am
from app.api import cloud_conversations as cloud_api
from app.conversation_handoff_models import ConversationHandoff as Handoff
from app.db import Base
from app.services import (ai_exec, ai_remote, artifact_bytes, artifact_ingest, cloud_conversations, cloud_deliveries, cloud_recovery,
                          code_delivery, conversation_handoffs as handoffs,
                          dispatch_reconcile, execution_settlement, project_context,
                          storage, task_dispatch, terminal_recovery)


def managed_target(revision):
    return {"runnerId": "cloud", "runnerBootId": "boot", "managedModelSelection": {
        "provider": "synthetic", "model": "fixture-model", "configRevision": revision,
        "runtimeRevision": "fixture-runtime",
    }}


class CloudRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="smoke-cloud-recovery-")
        self.engine = create_async_engine("sqlite+aiosqlite:///" + self.temp.name.replace("\\", "/") + "/test.db")
        tables = {model.__table__ for model in (
            models.User, models.Client, models.Task, models.TaskEvent, models.Attachment,
            Handoff, am.ExecutionSession, am.ResourceLease, am.RunnerNode)}
        pending = list(tables)
        while pending:
            for foreign_key in pending.pop().foreign_keys:
                target = foreign_key.column.table
                if target not in tables:
                    tables.add(target)
                    pending.append(target)
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda conn: Base.metadata.create_all(conn, tables=list(tables)))
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        self.stack = ExitStack()
        self.stack.enter_context(patch.object(storage, "_LOCAL_DIR", str(Path(self.temp.name) / "uploads")))
        self.stack.enter_context(patch.object(cloud_recovery, "SessionLocal", self.sessions))
        self.stack.enter_context(patch.object(dispatch_reconcile, "SessionLocal", self.sessions))
        self.stack.enter_context(patch.object(terminal_recovery, "SessionLocal", self.sessions))
        self.stack.enter_context(patch.object(handoffs, "destination", AsyncMock(return_value={
            "runnerId": "cloud", "runnerBootId": "boot", "name": "Cloud", "host": "fixture"})))
        self.stack.enter_context(patch.object(handoffs, "targets", AsyncMock(return_value=[{
            "id": "runner:cloud:pi", "runnerId": "cloud", "agentId": "pi"}])))
        async with self.sessions() as session:
            session.add_all([models.User(id="owner", username="owner", is_active=True),
                             models.Client(id="device", user_ref="owner", auth_state="active")])
            await session.commit()

    async def asyncTearDown(self):
        self.stack.close()
        await self.engine.dispose()
        self.temp.cleanup()

    async def seed(self, key="request", *, submitted=True, phase="prepared", event=None, status="todo"):
        async with self.sessions() as session:
            row = Handoff(id=handoffs.identity("device", key), owner_client_id="device", owner_user_id="owner",
                transfer_id=key, task_id="task-" + key, phase=phase, sha256="", request_hash="hash",
                options={"assigneeId": "runner:cloud:pi", "agentId": "pi", "model": "", "instruction": "Work",
                         "inputs": []}, source={"entryKind": "cloud", "sessionId": key},
                submitted_at=datetime.now(timezone.utc) if submitted else None,
                commit_started_at=datetime.now(timezone.utc) - timedelta(minutes=3),
                receipt={"runnerId": "cloud", "runnerBootId": "boot"})
            session.add_all([row, models.Task(id=row.task_id, title="Work", status=status,
                                             origin="cloud-conversation", owner_client_id="device")])
            if event:
                session.add(models.TaskEvent(task_id=row.task_id, kind=event,
                    detail={"attemptId": handoffs.dispatch_id(row), "runnerId": "cloud", "runnerBootId": "boot"}))
            await session.commit()
            return row.id, row.task_id

    async def accepted(self, tid, body, client, session, *, handoff_claim):
        row = await session.scalar(select(Handoff).where(Handoff.task_id == tid))
        assert row.receipt[handoffs._CLAIM_ID] == handoff_claim
        ref = "ref-" + tid
        session.add(models.TaskEvent(task_id=tid, kind=ai_exec.EV_DISPATCHED,
                    detail={"attemptId": handoffs.dispatch_id(row), "ref": ref, "runnerId": "cloud"}))
        await session.commit()
        return {"ref": ref, "state": "running"}

    async def test_prepared_is_not_submission_and_public_abort_contract(self):
        draft, _ = await self.seed("draft", submitted=False)
        authorized, _ = await self.seed("submitted")
        dispatch = AsyncMock(side_effect=self.accepted)
        with patch.object(task_dispatch, "dispatch", dispatch):
            out = await cloud_recovery.recover_submissions()
            self.assertEqual(out.get("dispatched"), 1)
            self.assertEqual(dispatch.await_count, 1)
        async with self.sessions() as session:
            original = await session.get(Handoff, draft)
            self.assertEqual(original.phase, "prepared")
            self.assertFalse(handoffs.public(original)["accepted"])
            self.assertTrue(handoffs.public(original)["canAbort"])
            submitted = await session.get(Handoff, authorized)
            self.assertTrue(handoffs.public(submitted)["accepted"])
            self.assertFalse(handoffs.public(submitted)["canAbort"])

    async def test_delayed_confirmation_cannot_admit_a_replaced_snapshot(self):
        row_id, _ = await self.seed(submitted=False)
        old_target, new_target = managed_target("B"), managed_target("C")
        old_generation = "b" * 32
        async with self.sessions() as session:
            row = await session.get(Handoff, row_id)
            row.options = {**row.options, "managedModelSelection": old_target["managedModelSelection"],
                           handoffs._MODEL_CONFIRMATION: old_generation}
            await session.commit()
        selected, resume = asyncio.Event(), asyncio.Event()

        async def delayed_destination(*args):
            selected.set()
            await resume.wait()
            return old_target

        async def confirm():
            async with self.sessions() as session:
                client = await session.get(models.Client, "device")
                return await handoffs.commit(session, client, "request", "", confirmation_generation=old_generation)

        with patch.object(task_dispatch, "dispatch", AsyncMock(side_effect=self.accepted)) as dispatch, \
             patch.object(handoffs, "destination", side_effect=delayed_destination):
            older = asyncio.create_task(confirm())
            try:
                await asyncio.wait_for(selected.wait(), timeout=5)
                with patch.object(handoffs, "destination", AsyncMock(return_value=new_target)):
                    with self.assertRaises(HTTPException) as conflict:
                        await confirm()
                assert conflict.exception.status_code == 409
            finally:
                resume.set()
                old_result = await asyncio.wait_for(older, timeout=10)
            assert (old_result["phase"], old_result["accepted"], old_result["canAbort"]) == ("prepared", False, True)
            assert old_result["confirmationGeneration"] != old_generation
            dispatch.assert_not_awaited()
            async with self.sessions() as session:
                current = await session.get(Handoff, row_id)
                assert current.options["managedModelSelection"]["configRevision"] == "C"
                assert current.submitted_at is None

    async def test_cloud_version_conflict_waits_for_explicit_same_request_retry(self):
        app = FastAPI()
        app.include_router(cloud_api.router)

        async def isolated_session():
            async with self.sessions() as session:
                yield session

        async def isolated_client():
            async with self.sessions() as session:
                return await session.get(models.Client, "device")

        app.dependency_overrides.update({cloud_api.get_session: isolated_session,
                                         cloud_api.current_ai_client: isolated_client})
        route = "/api/v1/cloud-conversations/changed-version"
        body = {"sessionId": "new-cloud", "agentId": "pi", "text": "Make a report", "targetRunnerId": "cloud"}
        form = {"options": (None, json.dumps(body))}
        before, after = managed_target("B"), managed_target("C")
        with patch.object(handoffs, "destination", AsyncMock(side_effect=[before, after, after])), \
             patch.object(task_dispatch, "dispatch", AsyncMock(side_effect=self.accepted)) as dispatch:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://isolated") as client:
                conflict = await client.post(route, files=form)
                assert conflict.status_code == 409, conflict.text
                assert (await cloud_recovery.recover_submissions())["candidates"] == 0
                # The original POST first reaches the Hub after the new version
                # has already been saved. Its identical digest is not consent.
                repeated = await client.post(route, files=form)
                assert repeated.status_code == 200, repeated.text
                pending = repeated.json()
                assert (pending["phase"], pending["accepted"], pending["canAbort"]) == ("prepared", False, True)
                generation = pending["confirmationGeneration"]
                stale_generation = ("0" if generation[0] != "0" else "1") + generation[1:]
                assert (await client.post(route, files={**form, "confirmation_generation": (None, "invalid")})).status_code == 422
                stale = await client.post(route, files={**form, "confirmation_generation": (None, stale_generation)})
                assert stale.status_code == 200 and stale.json()["confirmationGeneration"] == generation
                confirmed = {**form, "confirmation_generation": (None, generation)}
                assert (await client.post(route + "-unrelated", files=confirmed)).status_code == 404
                changed = {**confirmed, "options": (None, json.dumps({**body, "text": "Different message"}))}
                assert (await client.post(route, files=changed)).status_code == 409
                dispatch.assert_not_awaited()
                accepted = await client.post(route, files=confirmed)
                assert accepted.status_code == 200, accepted.text
                receipt = accepted.json()
                assert (receipt["phase"], receipt["accepted"]) == ("committed", True)
                repeated = await client.post(route, files=confirmed)
                assert repeated.status_code == 200 and repeated.json()["ref"] == receipt["ref"]
            dispatch.assert_awaited_once()

    async def test_recovery_of_pre_dispatch_interruption_requires_new_confirmation(self):
        row_id, _ = await self.seed(phase="committing")
        async with self.sessions() as session:
            row = await session.get(Handoff, row_id)
            row.options = {**row.options, "managedModelSelection": managed_target("B")["managedModelSelection"]}
            await session.commit()
        with patch.object(handoffs, "destination", AsyncMock(return_value=managed_target("C"))), \
             patch.object(task_dispatch, "dispatch", AsyncMock()) as dispatch:
            assert (await cloud_recovery.recover_submissions()).get("awaitingConfirmation") == 1
            assert (await cloud_recovery.recover_submissions())["candidates"] == 0
            async with self.sessions() as session:
                row = await session.get(Handoff, row_id)
                state = handoffs.public(row)
                assert (state["phase"], state["accepted"], state["canAbort"]) == ("prepared", False, True)
                client = await session.get(models.Client, "device")
                aborted = await handoffs.abort(session, client, "request")
                assert aborted["phase"] == "aborted"
                repeated = await handoffs.commit(session, client, "request", "",
                                                 confirmation_generation=state["confirmationGeneration"])
                assert repeated["phase"] == "aborted"
            assert (await cloud_recovery.recover_submissions())["candidates"] == 0
            dispatch.assert_not_awaited()

    async def test_model_drift_after_claim_releases_that_unstarted_claim(self):
        row_id, _ = await self.seed(submitted=False)
        before, after = managed_target("B"), managed_target("C")
        async with self.sessions() as session:
            row = await session.get(Handoff, row_id)
            row.options = {**row.options, "managedModelSelection": before["managedModelSelection"]}
            await session.commit()
        late_conflict = handoffs.ModelConfirmationRequired(after["managedModelSelection"])
        with patch.object(handoffs, "destination", AsyncMock(return_value=before)), \
             patch.object(task_dispatch, "dispatch", AsyncMock(side_effect=late_conflict)):
            async with self.sessions() as session:
                client = await session.get(models.Client, "device")
                with self.assertRaises(HTTPException) as conflict:
                    await handoffs.commit(session, client, "request", "")
                assert conflict.exception.status_code == 409
        async with self.sessions() as session:
            row = await session.get(Handoff, row_id)
            status = handoffs.public(row)
            assert (status["phase"], status["accepted"], status["canAbort"]) == ("prepared", False, True)
            assert row.options["managedModelSelection"]["configRevision"] == "C"
        assert (await cloud_recovery.recover_submissions())["candidates"] == 0

    async def test_legacy_accepted_handoff_can_abort_after_model_confirmation_conflict(self):
        row_id, _ = await self.seed()
        async with self.sessions() as session:
            row = await session.get(Handoff, row_id)
            row.source = {"sessionId": "old-local-handoff"}
            await session.commit()
        with patch.object(handoffs, "destination", AsyncMock(return_value=managed_target("C"))), \
             patch.object(task_dispatch, "dispatch", AsyncMock()) as dispatch:
            async with self.sessions() as session:
                client = await session.get(models.Client, "device")
                with self.assertRaises(HTTPException) as conflict:
                    await handoffs.commit(session, client, "request", "")
                assert conflict.exception.status_code == 409
                row = await session.get(Handoff, row_id, populate_existing=True)
                assert handoffs.public(row)["canAbort"]
                assert "managedModelSelection" not in row.options
                assert (await handoffs.abort(session, client, "request"))["phase"] == "aborted"
            dispatch.assert_not_awaited()

    async def test_previous_failure_cannot_reopen_new_claim_and_recovery_can_still_continue(self):
        row_id, _ = await self.seed(event=ai_exec.EV_DISPATCH_FAILED)

        async def interrupt_before_launch(*args, **kwargs):
            async with self.sessions() as status_session:
                row = await status_session.get(Handoff, row_id)
                assert (await handoffs.refresh(status_session, row)).phase == "committing"
            raise asyncio.CancelledError

        with patch.object(task_dispatch, "dispatch", new=interrupt_before_launch):
            async with self.sessions() as session:
                client = await session.get(models.Client, "device")
                with self.assertRaises(asyncio.CancelledError):
                    await handoffs.commit(session, client, "request", "")
                row = await session.get(Handoff, row_id)
                row.commit_started_at = datetime.now(timezone.utc) - timedelta(minutes=3)
                await session.commit()
        with patch.object(task_dispatch, "dispatch", AsyncMock(side_effect=self.accepted)) as dispatch:
            assert (await cloud_recovery.recover_submissions()).get("dispatched") == 1
            assert (await cloud_recovery.recover_submissions())["candidates"] == 0
            dispatch.assert_awaited_once()

    async def test_submit_commit_crash_recovers_without_request_retry(self):
        body = {"sessionId": "new-cloud", "agentId": "pi", "text": "Make a report", "targetRunnerId": "cloud"}
        with patch.object(task_dispatch, "dispatch", AsyncMock(side_effect=asyncio.CancelledError)):
            async with self.sessions() as session:
                client = await session.get(models.Client, "device")
                with self.assertRaises(asyncio.CancelledError):
                    await cloud_conversations.create(session, client, "crashed", body, [])
        row_id = handoffs.identity("device", "crashed")
        async with self.sessions() as session:
            row = await session.get(Handoff, row_id)
            self.assertIsNotNone(row.submitted_at)
            self.assertEqual(row.phase, "committing")
            row.commit_started_at = datetime.now(timezone.utc) - timedelta(minutes=3)
            await session.commit()
        with patch.object(task_dispatch, "dispatch", AsyncMock(side_effect=self.accepted)) as dispatch:
            self.assertEqual((await cloud_recovery.recover_submissions()).get("dispatched"), 1)
            self.assertEqual(dispatch.await_count, 1)
            self.assertEqual((await cloud_recovery.recover_submissions())["candidates"], 0)
        async with self.sessions() as session:
            client = await session.get(models.Client, "device")
            with self.assertRaises(HTTPException) as failure:
                await cloud_conversations.create(session, client, "crashed", {**body, "text": "Different"}, [])
            self.assertEqual(failure.exception.status_code, 409)

    async def test_unconfirmed_started_never_relaunches_after_timeout(self):
        row_id, _ = await self.seed(phase="committing", event=ai_exec.EV_DISPATCH_STARTED)
        async with self.sessions() as session:
            row = await session.get(Handoff, row_id)
            row.commit_started_at = datetime.now(timezone.utc) - timedelta(minutes=15)
            await session.commit()
        with patch.object(dispatch_reconcile, "probe", AsyncMock(return_value={"state": "not-started"})), \
             patch.object(task_dispatch, "dispatch", AsyncMock()) as dispatch:
            out = await cloud_recovery.recover_submissions()
            self.assertEqual(out.get("uncertain"), 1)
            async with self.sessions() as session:
                client = await session.get(models.Client, "device")
                response = await handoffs.commit(session, client, "request", "")
                self.assertEqual(response["phase"], "committing")
            dispatch.assert_not_awaited()
        async with self.sessions() as session:
            row = await session.get(Handoff, row_id)
            self.assertEqual(row.phase, "committing")
            self.assertEqual(row.recovery_attempts, 1)
            self.assertIsNotNone(row.retry_after)
            self.assertIn("不会重复派发", row.error)
        self.assertEqual((await cloud_recovery.recover_submissions())["candidates"], 0)

    async def test_legacy_committing_receipts_reconcile_without_authorizing_replay(self):
        committed, _ = await self.seed("old-receipt", submitted=False, phase="committing",
                                       event=ai_exec.EV_DISPATCHED)
        pending, _ = await self.seed("old-unknown", submitted=False, phase="committing")
        with patch.object(task_dispatch, "dispatch", AsyncMock()) as dispatch:
            counts = await cloud_recovery.recover_submissions()
            self.assertEqual(counts.get("confirmed"), 1)
            self.assertEqual(counts.get("pending"), 1)
            dispatch.assert_not_awaited()
        async with self.sessions() as session:
            self.assertEqual((await session.get(Handoff, committed)).phase, "committed")
            self.assertEqual((await session.get(Handoff, pending)).phase, "committing")

    async def test_changed_device_owner_blocks_unattended_dispatch(self):
        await self.seed()
        async with self.sessions() as session:
            client = await session.get(models.Client, "device")
            client.user_ref = "another-owner"
            await session.commit()
        with patch.object(task_dispatch, "dispatch", AsyncMock()) as dispatch:
            self.assertEqual((await cloud_recovery.recover_submissions()).get("blocked"), 1)
            dispatch.assert_not_awaited()

    async def test_durable_same_boot_negative_reuses_original_dispatch_identity(self):
        row_id, tid = await self.seed(phase="committing", event=ai_exec.EV_DISPATCH_STARTED)
        async with self.sessions() as session:
            session.add(am.RunnerNode(id="cloud", owner_user_id="owner"))
            await session.commit()

        async def negative(op, payload, timeout):
            return {"ok": True, "data": {**payload, "has": False, "persisted": False,
                    "inflight": False, "admissionDurable": True, "bootId": "boot"}}

        runner = SimpleNamespace(id="cloud", boot_id="boot", client_id="", owner_user_id="owner",
                                 caps=["admit1"], alive=lambda: True, call=negative)
        with patch.object(dispatch_reconcile.runner_hub, "get", return_value=runner), \
             patch.object(task_dispatch, "dispatch", AsyncMock(side_effect=self.accepted)) as dispatch:
            self.assertEqual((await cloud_recovery.recover_submissions()).get("dispatched"), 1)
            self.assertEqual(dispatch.await_count, 1)
        async with self.sessions() as session:
            row = await session.get(Handoff, row_id)
            events = list(await session.scalars(select(models.TaskEvent).where(models.TaskEvent.task_id == tid)))
            self.assertEqual({event.detail["attemptId"] for event in events}, {handoffs.dispatch_id(row)})
            self.assertEqual(row.phase, "committed")

    async def test_two_workers_share_one_durable_claim(self):
        started, release = asyncio.Event(), asyncio.Event()
        calls = []
        async def operation():
            calls.append(1)
            started.set()
            await release.wait()
            return "finished"
        first = asyncio.create_task(cloud_recovery._leased("test", "one", operation))
        await started.wait()
        try:
            second = await cloud_recovery._leased("test", "one", operation)
            self.assertEqual(second, "busy")
            self.assertEqual(calls, [1])
        finally:
            release.set()
            self.assertEqual(await first, "finished")

    async def execution(self, *, settled=True, status="done"):
        _, tid = await self.seed(status=status, phase="committed")
        async with self.sessions() as session:
            meta = {"round": 1}
            if settled:
                meta["terminalSettlement"] = {"state": "done_no_output", "round": 1, "executionState": "done"}
            row = am.ExecutionSession(task_id=tid, ref="execution", state="done", metadata_=meta)
            session.add(row)
            await session.commit()
            return row.id, tid

    async def test_successful_settlement_never_saves_to_library_or_retries_an_old_save_failure(self):
        row_id, tid = await self.execution(status="done")
        async with self.sessions() as session:
            row = await session.get(am.ExecutionSession, row_id)
            await cloud_deliveries._mark(session, row, "failed", error="Previous save failed")
        with patch.object(cloud_deliveries, "archive_task", AsyncMock()) as save:
            self.assertEqual((await cloud_recovery.recover_deliveries()).get("done"), 1)
            self.assertEqual((await cloud_recovery.recover_deliveries())["candidates"], 0)
            save.assert_not_awaited()
        async with self.sessions() as session:
            row = await session.get(am.ExecutionSession, row_id)
            self.assertEqual(row.metadata_["deliverySync"]["state"], "failed")
            self.assertEqual(row.metadata_["terminalRecovery"]["state"], "done")
            self.assertEqual((await session.get(models.Task, tid)).status, "done")

    async def test_missing_terminal_marker_is_reconciled_without_viewer(self):
        row_id, _ = await self.execution(settled=False, status="done")
        with patch.object(ai_exec, "load", AsyncMock(return_value={})), \
             patch.object(ai_exec, "status_sync", return_value={"ok": True, "done": True}), \
             patch.object(code_delivery, "repo_for", AsyncMock(return_value=None)), \
             patch.object(project_context, "record_completion", AsyncMock()):
            self.assertEqual((await cloud_recovery.recover_deliveries()).get("done"), 1)
        async with self.sessions() as session:
            row = await session.get(am.ExecutionSession, row_id)
            self.assertEqual(row.metadata_["terminalSettlement"]["state"], "done_no_output")
            self.assertNotIn("deliverySync", row.metadata_)

    async def test_retry_metadata_cannot_overwrite_new_turn(self):
        row_id, _ = await self.execution()
        async def new_turn(session, *args, **kwargs):
            row = await session.get(am.ExecutionSession, row_id)
            row.metadata_ = {"round": 2, "sentinel": "preserve"}
            row.state = "running"
            await session.commit()
            return {"ok": True}
        with patch.object(execution_settlement, "settle_terminal", new_turn):
            self.assertEqual((await cloud_recovery.recover_deliveries()).get("stale"), 1)
        async with self.sessions() as session:
            row = await session.get(am.ExecutionSession, row_id)
            self.assertEqual(row.metadata_, {"round": 2, "sentinel": "preserve"})
            self.assertEqual(row.state, "running")

    async def test_terminal_rpc_cannot_settle_a_newer_turn(self):
        row_id, tid = await self.execution(settled=False)
        ready, release = asyncio.Event(), threading.Event()
        loop = asyncio.get_running_loop()

        def status(*args):
            loop.call_soon_threadsafe(ready.set)
            if not release.wait(10):
                raise TimeoutError("Fixture release was not signaled")
            return {"ok": True, "done": True}

        with patch.object(ai_exec, "load", AsyncMock(return_value={})), \
             patch.object(ai_exec, "status_sync", status), \
             patch.object(project_context, "record_completion", AsyncMock()) as completion:
            async with self.sessions() as session:
                work = asyncio.create_task(execution_settlement.settle_terminal(
                    session, tid, "execution", include_task=False))
                try:
                    await asyncio.wait_for(ready.wait(), 10)
                    async with self.sessions() as writer:
                        row = await writer.get(am.ExecutionSession, row_id)
                        row.metadata_, row.state = {"round": 2, "sentinel": "preserve"}, "running"
                        await writer.commit()
                finally:
                    release.set()
                self.assertEqual((await work)["reason"], "execution-advanced")
                completion.assert_not_awaited()
        async with self.sessions() as session:
            row = await session.get(am.ExecutionSession, row_id)
            self.assertEqual(row.metadata_, {"round": 2, "sentinel": "preserve"})

    async def test_delivery_rejection_is_visible_and_can_reconcile_without_reexecuting(self):
        row_id, tid = await self.execution(settled=False)
        with patch.object(ai_exec, "load", AsyncMock(return_value={})), \
             patch.object(ai_exec, "status_sync", return_value={"ok": True, "done": True, "attachments": [{"id": "page"}]}), \
             patch.object(ai_exec, "pull_artifacts", AsyncMock(return_value={"submissionError": "交付文件校验未通过"})) as pull, \
             patch.object(project_context, "record_completion", AsyncMock()):
            async with self.sessions() as session:
                blocked = await execution_settlement.settle_terminal(session, tid, "execution", include_task=False)
                self.assertFalse(blocked["ok"])
                self.assertEqual(blocked["settlement"]["state"], "incomplete")
                row = await session.get(am.ExecutionSession, row_id)
                self.assertEqual(row.metadata_["error"], "交付文件校验未通过")
                pull.return_value = {"files": 1}
                recovered = await execution_settlement.settle_terminal(session, tid, "execution", include_task=False)
                self.assertTrue(recovered["ok"])
                self.assertEqual(recovered["settlement"]["state"], "done")
                await session.refresh(row)
                self.assertEqual(row.metadata_["error"], "")
                self.assertEqual(row.state, "done")

    async def test_terminal_callers_commit_one_settlement_and_reload_persisted_receipt(self):
        row_id, tid = await self.execution(settled=False)
        ready, release = asyncio.Event(), threading.Event()
        loop = asyncio.get_running_loop()

        def status(*args):
            loop.call_soon_threadsafe(ready.set)
            if not release.wait(10):
                raise TimeoutError("Fixture release was not signaled")
            return {"ok": True, "done": True}

        with patch.object(ai_exec, "load", AsyncMock(return_value={})), \
             patch.object(ai_exec, "status_sync", side_effect=status) as rpc, \
             patch.object(code_delivery, "repo_for", AsyncMock(return_value=None)), \
             patch.object(project_context, "record_completion", AsyncMock()) as completion, \
             patch.object(cloud_deliveries, "archive_task", AsyncMock()):
            async with self.sessions() as first, self.sessions() as second:
                await second.get(am.ExecutionSession, row_id)
                work = asyncio.create_task(execution_settlement.settle_terminal(
                    first, tid, "execution", include_task=False))
                try:
                    await asyncio.wait_for(ready.wait(), 10)
                    concurrent = asyncio.create_task(execution_settlement.settle_terminal(
                        second, tid, "execution", include_task=False))
                    await asyncio.sleep(0.1)
                finally:
                    release.set()
                results = await asyncio.gather(work, concurrent)
                self.assertTrue(any(result["ok"] for result in results))
                repeated = await execution_settlement.settle_terminal(second, tid, "execution", include_task=False)
                self.assertTrue(repeated["idempotent"])
                self.assertEqual(completion.await_count, 1)

    async def test_unavailable_runner_reconciles_stored_outputs_only_from_the_current_round(self):
        row_id, tid = await self.execution(settled=False)
        async with self.sessions() as session:
            row = await session.get(am.ExecutionSession, row_id)
            row.metadata_ = {"round": 2}
            attachment = models.Attachment(task_id=tid, filename="result.md", content_type="text/markdown",
                storage_key="isolated-result", backend="local", size=10, role="output",
                uploaded_by="agent:runner", source_ref="execution", evidence_meta={"round": 1})
            session.add(attachment)
            await session.commit()
            with patch.object(ai_exec, "load", AsyncMock(return_value={})), \
                 patch.object(ai_exec, "status_sync", return_value={"ok": False, "error": "Runner offline"}), \
                 patch.object(ai_exec, "pull_artifacts", AsyncMock(return_value={"files": 0})) as pull, \
                 patch.object(project_context, "record_completion", AsyncMock()):
                stale = await execution_settlement.settle_terminal(session, tid, "execution", include_task=False)
                self.assertTrue(stale["retry"])
                pull.assert_not_awaited()
                attachment.evidence_meta = {"round": 2}
                await session.commit()
                recovered = await execution_settlement.settle_terminal(session, tid, "execution", include_task=False)
                self.assertTrue(recovered["ok"])
                self.assertEqual(recovered["settlement"]["state"], "done")
                self.assertEqual(pull.await_args.args[3]["round"], 2)
                self.assertTrue(pull.await_args.kwargs["settle"])

    async def artifact_fixture(self):
        _, tid = await self.execution(settled=False)
        async with self.sessions() as session:
            session.add(models.TaskEvent(task_id=tid, kind=ai_exec.EV_DISPATCHED,
                detail={"ref": "execution", "provider": "runner", "runnerId": "cloud"}))
            await session.commit()
        return tid, {"ok": True, "done": True, "round": 1,
                     "attachments": [{"filename": "report.md", "id": "report.md"}]}

    async def test_status_ingestion_and_terminal_settlement_share_durable_file_receipt(self):
        tid, status = await self.artifact_fixture()
        ready, release = asyncio.Event(), threading.Event()
        first_committed = threading.Event()
        fetch_lock = threading.Lock()
        fetch_count = 0
        loop = asyncio.get_running_loop()

        def fetch(*args):
            nonlocal fetch_count
            with fetch_lock:
                fetch_count += 1
                first_fetch = fetch_count == 1
            loop.call_soon_threadsafe(ready.set)
            if not release.wait(10):
                raise TimeoutError("Fixture release was not signaled")
            # This case asserts the status reader imports the file. Keep the
            # terminal reader concurrent, but do not let OS thread scheduling
            # choose the importer whose new-file count is asserted below.
            if not first_fetch and not first_committed.wait(10):
                raise TimeoutError("First ingestion did not commit")
            return b"# Verified report\nComplete result.\n"

        with patch.object(ai_remote, "fetch_attachment_for_sync", side_effect=fetch) as download, \
             patch.object(storage, "put", return_value="local"), \
             patch.object(ai_exec, "load", AsyncMock(return_value={})), \
             patch.object(ai_exec, "status_sync", return_value=status), \
             patch.object(code_delivery, "check", AsyncMock(return_value={"applies": True})), \
             patch.object(project_context, "record_completion", AsyncMock()), \
             patch.object(cloud_deliveries, "archive_task", AsyncMock()):
            async with self.sessions() as first, self.sessions() as second:
                one = asyncio.create_task(artifact_ingest.pull_artifacts(
                    first, tid, {}, status, "execution", settle=False))
                await asyncio.wait_for(ready.wait(), 10)
                two = asyncio.create_task(execution_settlement.settle_terminal(
                    second, tid, "execution", include_task=False))
                try:
                    await asyncio.sleep(0.1)
                finally:
                    release.set()
                try:
                    first_result = await one
                finally:
                    first_committed.set()
                self.assertEqual(first_result["files"], 1)
                self.assertTrue((await two)["ok"])
                self.assertIn(download.call_count, (1, 2))
        async with self.sessions() as session:
            files = list(await session.scalars(select(models.Attachment).where(models.Attachment.task_id == tid)))
            self.assertEqual([item.filename for item in files], ["report.md"])

    async def test_lost_ingestion_commit_ack_does_not_create_a_second_attachment(self):
        tid, status = await self.artifact_fixture()
        with patch.object(ai_remote, "fetch_attachment_for_sync", return_value=b"# Report\nComplete.\n") as download, \
             patch.object(storage, "put", return_value="local"):
            async with self.sessions() as session:
                original_commit = session.commit

                async def lost_ack():
                    await original_commit()
                    raise ConnectionError("Commit acknowledgement lost")

                with patch.object(session, "commit", side_effect=lost_ack):
                    with self.assertRaises(ConnectionError):
                        await artifact_ingest.pull_artifacts(session, tid, {}, status, "execution", settle=False)
            async with self.sessions() as session:
                retry = await artifact_ingest.pull_artifacts(session, tid, {}, status, "execution", settle=False)
                files = list(await session.scalars(select(models.Attachment).where(models.Attachment.task_id == tid)))
                self.assertEqual(retry["files"], 0)
                self.assertEqual(len(files), 1)
                self.assertEqual(download.call_count, 1)

    async def test_ingestion_preserves_outer_write_transaction_and_storage_failure_rollback(self):
        tid, status = await self.artifact_fixture()
        with patch.object(ai_remote, "fetch_attachment_for_sync", return_value=b"# Report\nComplete.\n"), \
             patch.object(storage, "put", side_effect=[OSError("Object store unavailable"), "local"]):
            async with self.sessions() as session:
                task = await session.get(models.Task, tid)
                task.title = "Uncommitted caller intent"
                await session.flush()
                with self.assertRaises(OSError):
                    await asyncio.wait_for(artifact_ingest.pull_artifacts(
                        session, tid, {}, status, "execution", settle=False), 3)
            async with self.sessions() as session:
                task = await session.get(models.Task, tid)
                self.assertEqual(task.title, "Work")
                self.assertEqual((await artifact_ingest.pull_artifacts(
                    session, tid, {}, status, "execution", settle=False))["files"], 1)
                files = list(await session.scalars(select(models.Attachment).where(models.Attachment.task_id == tid)))
                self.assertEqual(len(files), 1)

    async def test_partial_artifact_write_is_cleaned_and_same_turn_can_retry(self):
        tid, status = await self.artifact_fixture()
        status["attachments"].append({"filename": "second.md", "id": "second.md"})
        put = storage.put
        keys = []

        def write(key, data, content_type):
            keys.append(key)
            backend = put(key, data, content_type)
            if len(keys) == 2:
                raise OSError("Second object write interrupted")
            return backend

        with patch.object(ai_remote, "fetch_attachment_for_sync", return_value=b"# Report\nComplete.\n"):
            async with self.sessions() as session:
                with (patch.object(storage, "put", side_effect=write),
                      self.assertRaisesRegex(OSError, "Second object write interrupted")):
                    await artifact_ingest.pull_artifacts(session, tid, {}, status, "execution", settle=False)
                self.assertEqual(list(await session.scalars(select(models.Attachment))), [])
                for key in keys:
                    with self.assertRaises(FileNotFoundError):
                        storage.get(key, "local")
                result = await artifact_ingest.pull_artifacts(session, tid, {}, status, "execution", settle=False)
                self.assertEqual(result["files"], 2)
                rows = list(await session.scalars(select(models.Attachment)))
                self.assertEqual({row.filename for row in rows}, {"report.md", "second.md"})
                self.assertEqual([storage.get(row.storage_key, row.backend) for row in rows],
                                 [b"# Report\nComplete.\n"] * 2)

    async def test_over_limit_file_is_rejected_without_poisoning_same_turn_retry(self):
        tid, status = await self.artifact_fixture()
        content = b"# Report\nComplete.\n"
        with patch.object(ai_remote, "fetch_attachment_for_sync", return_value=content):
            async with self.sessions() as session:
                with patch.object(artifact_bytes, "MAX_BYTES", len(content) - 1):
                    rejected = await artifact_ingest.pull_artifacts(session, tid, {}, status, "execution", settle=False)
                self.assertEqual(rejected["files"], 0)
                self.assertEqual(list(await session.scalars(select(models.Attachment))), [])
                event = await session.scalar(select(models.TaskEvent).where(
                    models.TaskEvent.kind == "artifact.delivery_rejected"))
                self.assertEqual(event.detail["files"], ["report.md"])
                with patch.object(artifact_bytes, "MAX_BYTES", len(content)):
                    retry = await artifact_ingest.pull_artifacts(session, tid, {}, status, "execution", settle=False)
                self.assertEqual(retry["files"], 1)


if __name__ == "__main__":
    unittest.main()
