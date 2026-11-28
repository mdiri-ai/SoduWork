"""Real HTTP/RBAC + isolated SQL state for the shared requirement dispatcher.

Only the external Agent/workspace boundary is deterministic. No user data,
Runner process, model endpoint or real workspace is touched.
"""
import asyncio
import importlib
import os
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
import threading
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
import httpx
from fastapi import FastAPI, Request
from sqlalchemy import create_engine, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from app import models, automation_models as am
from app.api import admin, tasks
from app.auth import sign_token
from app.db import Base, get_session
from app.deps import current_client
from app.services import (
    ai_exec, autobatch, dispatch_identity, dispatch_reconcile, runner_hub, task_dispatch, task_events, task_status,
)

for model_file in (Path(__file__).parent / "app").glob("*models.py"):
    importlib.import_module("app." + model_file.stem)


class AdminRequirementDispatchTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="soduwork-admin-dispatch-")
        self.addCleanup(self.tmp.cleanup)
        database = (Path(self.tmp.name).resolve() / "fixture.db").as_posix()
        # Build the complete fresh schema synchronously before opening async
        # sessions; hundreds of DDL thread handoffs can exhaust Windows CI's
        # module deadline. Each test still owns an independent database.
        schema_engine = create_engine("sqlite:///" + database)
        try:
            Base.metadata.create_all(schema_engine)
        finally:
            schema_engine.dispose()
        self.engine = create_async_engine("sqlite+aiosqlite:///" + database)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.sessions() as session:
            session.add_all([models.OrgUnit(id="team", name="Team"), models.OrgUnit(id="outside", name="Outside"),
                models.Role(id="operator", name="Operator", permissions=["task.view", "task.dispatch", "plugin.run"]),
                models.Role(id="reader", name="Reader", permissions=["task.view"])])
            for uid, org, role in (("admin", "team", "operator"), ("reader", "team", "reader"),
                                   ("owner", "team", "reader"), ("outside", "outside", "operator")):
                session.add(models.User(id=uid, username=uid, display_name=uid, org_id=org, role_id=role,
                                        is_active=True, auth_version=1))
                session.add(models.Client(id=uid, user_ref=uid, auth_state="active"))
            session.add(models.Project(id="project", name="Project", org_id="team"))
            await session.commit()
        self.app = FastAPI()
        self.app.include_router(admin.router)
        self.app.include_router(tasks.router)

        async def db():
            async with self.sessions() as session:
                yield session

        async def device(request: Request):
            async with self.sessions() as session:
                return await session.get(models.Client, request.headers.get("X-Test-Device", "owner"))

        self.app.dependency_overrides[get_session] = db
        self.app.dependency_overrides[current_client] = device
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://isolated")
        self.calls = []

        def dispatch(ctx, task, files, picked, extra):
            self.calls.append({"task": task.id, "ctx": ctx, "extra": extra})
            return {"ok": True, "issueId": dispatch_identity.execution_ref(extra["dispatchId"]),
                    "provider": "local", "assigneeId": "local:pi", "assigneeCli": "pi", "state": "running"}

        self.prepare = AsyncMock(side_effect=lambda session, client, ctx, *a: (ctx, {"owner": client.id}))
        self.git = AsyncMock(side_effect=lambda session, ctx, task, **kw: {**ctx, "owner": task.owner_client_id})
        self.resolve_default = ai_exec.resolve_default_sync
        self.patches = [
            patch("app.realtime.hub.publish", new_callable=AsyncMock),
            patch("app.services.zero_work_route.try_route", new=AsyncMock(return_value=None)),
            patch.object(ai_exec, "load", new=AsyncMock(return_value={"provider": "local"})),
            patch.object(ai_exec, "with_task_git", new=self.git),
            patch.object(ai_exec, "resolve_default_sync", return_value={"id": "local:pi", "cli": "pi", "name": "Pi"}),
            patch("app.services.task_execution_model.prepare", new=self.prepare),
            patch.object(ai_exec, "with_project_context", new=AsyncMock(side_effect=lambda session, extra, *a: extra)),
            patch.object(ai_exec, "dispatch_sync", side_effect=dispatch),
            patch.object(task_dispatch, "_settle_work_dir", new=AsyncMock(return_value={"ok": True, "dir": "isolated"})),
            patch.object(task_dispatch, "_attach_skills", new=AsyncMock()),
        ]
        for item in self.patches:
            item.start()

    async def asyncTearDown(self):
        for item in reversed(self.patches):
            item.stop()
        await self.http.aclose()
        await self.engine.dispose()

    async def create(self, tid="requirement", **kwargs):
        async with self.sessions() as session:
            task = models.Task(id=tid, title=tid, owner_client_id=kwargs.pop("owner_client_id", "owner"),
                               status=kwargs.pop("status", "todo"), **kwargs)
            session.add(task)
            await session.commit()
        return tid

    async def post(self, tid, who="admin"):
        return await self.http.post(f"/api/v1/admin/tasks/{tid}/ai-dispatch",
                                    headers={"Authorization": "Bearer " + sign_token(who, 1)})

    async def test_admin_task_creation_validates_title_type(self):
        headers = {"Authorization": "Bearer " + sign_token("admin", 1)}
        for path in ("/api/v1/admin/users/owner/tasks", "/api/v1/admin/inbox"):
            for invalid in (123, False, [], {}):
                with self.subTest(path=path, title=invalid):
                    response = await self.http.post(path, json={"title": invalid}, headers=headers)
                    self.assertEqual(response.status_code, 422, response.text)
            blank = await self.http.post(path, json={"title": "  "}, headers=headers)
            self.assertEqual(blank.status_code, 400)

    async def test_admin_and_device_share_one_attempt_owner_context_admin_audit(self):
        tid = await self.create()
        first = await self.post(tid)
        self.assertEqual(first.status_code, 200, first.text)
        second = await self.post(tid)
        device = await self.http.post(f"/api/v1/tasks/{tid}/ai-dispatch", json={})
        self.assertEqual(second.status_code, 200, second.text)
        self.assertTrue(second.json()["already"])
        self.assertEqual(first.json()["issueId"], device.json()["issueId"])
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0]["ctx"]["owner"], "owner")
        self.assertEqual(self.calls[0]["extra"]["agentExecution"]["owner"], "owner")
        async with self.sessions() as session:
            logs = (await session.execute(select(models.AuditLog).where(models.AuditLog.action == "task.ai_dispatch"))).scalars().all()
            self.assertEqual([row.actor_id for row in logs], ["admin"])
            rows = (await session.execute(select(am.ExecutionSession))).scalars().all()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0].task_id, tid)

    async def test_runner_dispatch_correlates_only_the_authorized_queue_turn(self):
        scope = {"conversationId": "chat", "turnId": "turn"}
        tid = await self.create(work_routing={"conversationTurn": {
            **scope, "executor": "dispatch", "state": "running"}})
        response = await self.http.post(f"/api/v1/tasks/{tid}/ai-dispatch", json={
            "conversationTurn": {**scope, "note": "Never copy arbitrary fields"},
            "executionContext": {"strategy": "direct"}})
        self.assertEqual(response.status_code, 200, response.text)
        async with self.sessions() as session:
            events = (await session.scalars(select(models.TaskEvent).where(
                models.TaskEvent.task_id == tid, models.TaskEvent.kind == "ai.dispatched"))).all()
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0].detail["conversationTurn"], scope)
        from app.services.dispatch_instructions import confirmed_turn
        task = models.Task(work_routing={"conversationTurn": {**scope, "executor": "dispatch", "state": "running"}})
        for claimed in (None, {**scope, "turnId": "stale"}, {**scope, "conversationId": "other"}):
            self.assertEqual(confirmed_turn(task, claimed), {})
        task.work_routing = {"conversationTurn": {**scope, "executor": "dispatch", "state": "completed"}}
        self.assertEqual(confirmed_turn(task, scope), {})

    async def test_terminal_unclarified_and_active_conversation_are_not_dispatched(self):
        cases = [dict(archived_at=datetime.now(timezone.utc)), dict(triage_stage="intake"),
                 dict(triage_stage="clarifying"), dict(status="cancel"), dict(status="done"),
                 dict(work_routing={"conversationTurn": {"state": "running", "turnId": "turn"}})]
        for index, fields in enumerate(cases):
            tid = await self.create(str(index), **fields)
            with self.subTest(fields=fields):
                result = await self.post(tid)
                self.assertIn(result.status_code, (400, 409), result.text)
                result = await self.http.post(f"/api/v1/tasks/{tid}/ai-dispatch", json={})
                self.assertIn(result.status_code, (400, 409), result.text)
        self.assertFalse(self.calls)

    async def test_permissions_and_device_ownership_remain_distinct(self):
        tid = await self.create()
        self.assertEqual((await self.post(tid, "reader")).status_code, 403)
        self.assertEqual((await self.post(tid, "outside")).status_code, 403)
        self.assertEqual((await self.http.post(f"/api/v1/tasks/{tid}/ai-dispatch", json={},
                            headers={"X-Test-Device": "admin"})).status_code, 404)
        async with self.sessions() as session:
            owner = await session.get(models.Client, "owner")
            owner.auth_state = "revoked"
            await session.commit()
        self.assertEqual((await self.post(tid)).status_code, 409)
        self.assertFalse(self.calls)

    async def test_managed_project_cannot_fall_back_to_direct(self):
        tid = await self.create(project_id="project")
        result = await self.post(tid)
        self.assertEqual(result.status_code, 409, result.text)
        self.assertFalse(self.calls)
        async with self.sessions() as session:
            session.add(am.WorkflowRun(id="managed-run", task_id=tid, state="running",
                plugin_id="historical-plugin", plugin_version_id="historical-version", binding_id="historical-binding"))
            await session.commit()
        result = await self.post(tid)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["runId"], "managed-run")
        self.assertTrue(result.json()["reused"])
        self.assertFalse(self.calls)

    async def test_uncertain_ack_does_not_start_second_execution(self):
        tid = await self.create()
        with patch.object(ai_exec, "dispatch_sync", return_value={"ok": False, "uncertain": True, "error": "lost ACK"}) as dispatch:
            first = await self.post(tid)
            second = await self.post(tid)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertTrue(first.json()["pending"])
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(second.json()["issueId"], first.json()["issueId"])
        self.assertEqual(dispatch.call_count, 1)

    async def test_active_unmanaged_workflow_cannot_be_downgraded_or_duplicated(self):
        tid = await self.create()
        async with self.sessions() as session:
            session.add(am.WorkflowRun(id="existing", task_id=tid, state="running",
                plugin_id="historical", plugin_version_id="historical", binding_id="historical"))
            await session.commit()
        for endpoint, body in (("admin/", {}), ("", {"executionContext": {"strategy": "direct"}})):
            result = await self.http.post(f"/api/v1/{endpoint}tasks/{tid}/ai-dispatch", json=body,
                headers={"Authorization": "Bearer " + sign_token("admin", 1)})
            self.assertEqual(result.status_code, 200, result.text)
            self.assertEqual(result.json()["runId"], "existing")
        self.assertFalse(self.calls)

    async def test_explicit_direct_choice_replaces_unstarted_workflow_selection(self):
        tid = await self.create(work_routing={
            'selectedStrategy': 'workflow', 'workflowBindingId': 'previous-binding',
            'executionContext': {'strategy': 'workflow', 'workflowBindingId': 'previous-binding'},
        })
        result = await self.http.post(f'/api/v1/tasks/{tid}/ai-dispatch',
                                     json={'executionContext': {'strategy': 'direct'}})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(len(self.calls), 1)
        async with self.sessions() as session:
            task = await session.get(models.Task, tid)
            self.assertEqual(task.work_routing['selectedStrategy'], 'direct')
            self.assertEqual(task.work_routing['workflowBindingId'], '')
            self.assertEqual(task.work_routing['executionContext']['strategy'], 'direct')

    async def test_starting_workflow_lease_prevents_direct_dispatch(self):
        from datetime import timedelta
        tid = await self.create()
        async with self.sessions() as session:
            session.add(am.ResourceLease(resource_kind="workflow-start", resource_key=tid, token="fixture",
                lease_until=datetime.now(timezone.utc) + timedelta(minutes=2)))
            await session.commit()
        result = await self.post(tid)
        self.assertEqual(result.status_code, 409, result.text)
        self.assertFalse(self.calls)

    async def test_admin_list_preserves_history_and_reports_real_execution_failure(self):
        tid = await self.create("failed")
        await self.create("archive", project_id="project", archived_at=datetime.now(timezone.utc))
        await self.create("cancel", project_id="project", status="cancel")
        await self.create("done", project_id="project", status="done")
        await self.create("intake", project_id="project", triage_stage="intake")
        async with self.sessions() as session:
            session.add(models.TaskEvent(task_id=tid, kind=ai_exec.EV_DISPATCH_FAILED, detail={"error": "blocked"}))
            await session.commit()
        headers = {"Authorization": "Bearer " + sign_token("admin", 1)}
        result = await self.http.get("/api/v1/admin/tasks", headers=headers)
        self.assertEqual(result.status_code, 200, result.text)
        rows = {row["id"]: row for row in result.json()}
        self.assertTrue(rows["archive"]["archivedAt"])
        self.assertEqual(rows["failed"]["ai"]["state"], "failed")
        self.assertTrue(rows["failed"]["canViewExecution"])
        project = (await self.http.get("/api/v1/admin/projects", headers=headers)).json()[0]
        self.assertEqual((project["total"], project["done"], project["closed"]), (2, 1, 2))
        detail = (await self.http.get("/api/v1/admin/projects/project", headers=headers)).json()
        self.assertEqual(len(detail["tasks"]), 4)

    async def test_project_creation_can_enter_intake_without_implicit_dispatch(self):
        result = await self.http.post("/api/v1/admin/projects/project/tasks", json={
            "title": "A requirement needing clarification", "target": "owner", "triageStage": "intake"},
            headers={"Authorization": "Bearer " + sign_token("admin", 1)})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["triageStage"], "intake")
        self.assertEqual((await self.post(result.json()["id"])).status_code, 409)
        self.assertFalse(self.calls)

    async def test_batch_lost_receipt_reuses_committed_admission_and_reconciles(self):
        ids = [await self.create("first"), await self.create("second")]
        body = {"taskIds": ids, "assigneeId": "runner:remote:pi"}
        loop = asyncio.get_running_loop()
        received = loop.create_future()
        release_reply = threading.Event()
        accepted = []

        def lose_reply(ctx, task, files, picked, extra):
            accepted.append((task.id, extra["dispatchId"]))
            loop.call_soon_threadsafe(received.set_result, True)
            release_reply.wait(60)
            return {"ok": False, "uncertain": True, "error": "lost ACK",
                    "runnerId": "remote", "runnerBootId": "boot"}

        with patch.object(ai_exec, "dispatch_sync", side_effect=lose_reply), \
             patch.object(ai_exec, "resolve_requested_sync", return_value={
                 "id": body["assigneeId"], "runnerId": "remote", "runnerBootId": "boot"}), \
             patch.object(tasks, "_push_task", new=AsyncMock()), \
             patch.object(tasks, "_settle_work_dir", new=AsyncMock(return_value={"ok": True})), \
             patch.object(tasks, "_attach_skills", new=AsyncMock()):
            pending = asyncio.create_task(self.http.post("/api/v1/tasks/batch-dispatch", json=body))
            try:
                await asyncio.wait({received, pending}, return_when=asyncio.FIRST_COMPLETED)
                if pending.done():
                    self.fail(f"Transport was not reached: {pending.result().text}")
                batch_id, attempt_id = accepted[0]
                async with self.sessions() as session:
                    self.assertIsNotNone(await session.get(models.Task, batch_id))
                    milestones = list(await session.scalars(select(models.Milestone).where(
                        models.Milestone.task_id == batch_id).order_by(models.Milestone.seq)))
                    self.assertEqual([m.src_task_id for m in milestones], ids)
                    stale = await dispatch_reconcile.candidates(
                        session, now=datetime.now(timezone.utc) + timedelta(minutes=11))
                    self.assertEqual([(c.attempt_id, c.runner_boot_id) for c in stale], [(attempt_id, "boot")])
                    self.assertTrue(stale[0].detail["awaitingDispatchReply"])
                alternate = await self.http.post("/api/v1/tasks/batch-dispatch", json={**body, "title": "Other batch"})
                self.assertEqual(alternate.status_code, 409, alternate.text)
                overlap = await self.http.post("/api/v1/tasks/batch-dispatch", json=body)
                self.assertEqual(overlap.status_code, 200, overlap.text)
                self.assertTrue(overlap.json()["pending"])
            finally:
                release_reply.set()
                first = await pending
            self.assertEqual(first.status_code, 200, first.text)
            self.assertTrue(first.json()["pending"])
            self.assertEqual(first.json()["batchId"], overlap.json()["batchId"])
            later = datetime.now(timezone.utc) + timedelta(minutes=2)
            async with self.sessions() as session:
                candidate, = await dispatch_reconcile.candidates(session, now=later)
                self.assertEqual(candidate.runner_boot_id, "boot")
                self.assertEqual(candidate.expected_ref, dispatch_identity.execution_ref(attempt_id))
                with patch.object(dispatch_reconcile, "probe_result_current", new=AsyncMock(return_value=True)):
                    state, _ = await dispatch_reconcile.apply_probe(
                        session, candidate, {"state": "confirmed", "runnerOnline": True}, now=later)
                self.assertEqual(state, "confirmed")
                await session.commit()
            replay = await self.http.post("/api/v1/tasks/batch-dispatch", json=body)
            self.assertEqual(replay.status_code, 200, replay.text)
            self.assertEqual(replay.json()["batchId"], batch_id)
            self.assertFalse(replay.json()["pending"])
            self.assertEqual(accepted, [(batch_id, attempt_id)])
            self.prepare.assert_awaited_once()

    async def test_batch_first_receipt_and_replay_show_the_same_queued_state(self):
        ids = [await self.create(tid) for tid in ("a", "b")]
        body = {"taskIds": ids, "assigneeId": "runner:remote:pi"}
        route = {"id": body["assigneeId"], "runnerId": "remote", "runnerBootId": "boot"}

        def dispatch(ctx, task, files, picked, extra):
            ref = dispatch_identity.execution_ref(extra["dispatchId"])
            return {**route, "ok": True, "issueId": ref, "state": "queued",
                    "admissionKey": "dispatch:" + ref, "provider": "runner"}

        with patch.object(ai_exec, "dispatch_sync", side_effect=dispatch) as send, \
             patch.object(ai_exec, "resolve_requested_sync", return_value=route), \
             patch.object(tasks, "_push_task", new=AsyncMock()), \
             patch.object(tasks, "_settle_work_dir", new=AsyncMock(return_value={"ok": True})), \
             patch.object(tasks, "_attach_skills", new=AsyncMock()):
            first = await self.http.post("/api/v1/tasks/batch-dispatch", json=body)
            replay = await self.http.post("/api/v1/tasks/batch-dispatch", json=body)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertEqual(first.json()["state"], "queued")
        self.assertEqual(replay.json()["state"], "queued")
        self.assertEqual(first.json()["batchId"], replay.json()["batchId"])
        self.assertEqual(send.call_count, 1)

    async def test_batch_without_assignee_selects_default_on_the_current_device(self):
        ids = [await self.create(tid) for tid in ("a", "b")]
        route = {"id": "runner:current:pi", "runnerId": "current", "clientId": "owner", "cli": "pi"}
        with patch.object(runner_hub, "for_client", return_value=SimpleNamespace(id="current")), \
             patch.object(ai_exec, "resolve_default_sync", new=self.resolve_default), \
             patch.object(ai_exec, "list_assignees_sync", return_value={"agents": [route]}), \
             patch.object(ai_exec, "resolve_assignee_sync", return_value=route), \
             patch.object(ai_exec, "dispatch_sync", wraps=ai_exec.dispatch_sync) as send, \
             patch.object(tasks, "_push_task", new=AsyncMock()), \
             patch.object(tasks, "_settle_work_dir", new=AsyncMock(return_value={"ok": True})), \
             patch.object(tasks, "_attach_skills", new=AsyncMock()):
            response = await self.http.post("/api/v1/tasks/batch-dispatch", json={"taskIds": ids})
        self.assertEqual(response.status_code, 200, response.text)
        ctx, _, _, picked, extra = send.call_args.args
        self.assertEqual(ctx["_runnerAllowedRunners"], ["current"])
        self.assertEqual(picked["id"], route["id"])
        self.assertEqual(extra["dispatchId"], response.json()["attemptId"])

    async def test_batch_requires_an_available_assignee_on_the_current_device(self):
        ids = [await self.create(tid) for tid in ("a", "b")]
        peer = {"id": "runner:peer:pi", "runnerId": "peer", "clientId": "outside"}
        with patch.object(ai_exec, "resolve_default_sync", new=self.resolve_default), \
             patch.object(ai_exec, "list_assignees_sync", return_value={"agents": []}), \
             patch.object(ai_exec, "resolve_assignee_sync", return_value=peer):
            explicit = await self.http.post("/api/v1/tasks/batch-dispatch", json={
                "taskIds": ids, "assigneeId": peer["id"],
            })
            implicit = await self.http.post("/api/v1/tasks/batch-dispatch", json={"taskIds": ids})
        self.assertEqual(explicit.status_code, 400, explicit.text)
        self.assertEqual(implicit.status_code, 409, implicit.text)
        self.assertEqual(self.calls, [])
        async with self.sessions() as session:
            self.assertEqual(set(await session.scalars(select(models.Task.id))), set(ids))
            self.assertEqual(list(await session.scalars(select(models.TaskEvent))), [])

    async def test_autobatch_dispatches_only_ready_tasks_on_the_current_accounts_runner(self):
        async with self.sessions() as session:
            session.add(models.Repo(id="repo", project_id="project", ai_work_dir="runner-work"))
            await session.commit()
        common = {"repo_id": "repo", "project_id": "project", "integration_id": "import"}
        ids = [await self.create(tid, **common) for tid in ("a", "b")]
        await self.create("pending", triage_stage="clarifying", **common)
        await self.create("previous-account", **common)
        async with self.sessions() as session:
            # Persist the historical account binding left behind after a device changes accounts.
            previous = await session.get(models.Task, "previous-account")
            previous.owner_user_id = "outside"
            await session.commit()
        route = {"id": "runner:current:pi", "runnerId": "current", "clientId": "owner",
                 "cli": "pi", "online": True}
        settings = SimpleNamespace(autobatch_enabled=True, autobatch_min=2, autobatch_wait_min=60,
                                   autobatch_assignee="", autobatch_plugin_key="")
        with patch.object(autobatch, "get_settings", return_value=settings), \
             patch.object(runner_hub, "for_client", return_value=SimpleNamespace(id="current")), \
             patch.object(ai_exec, "list_assignees_sync", return_value={"agents": [route]}), \
             patch.object(ai_exec, "resolve_assignee_sync", return_value=route), \
             patch.object(ai_exec, "dispatch_sync", wraps=ai_exec.dispatch_sync) as send, \
             patch.object(tasks, "_push_task", new=AsyncMock()), \
             patch.object(tasks, "_settle_work_dir", new=AsyncMock(return_value={"ok": True})), \
             patch.object(tasks, "_attach_skills", new=AsyncMock()):
            async with self.sessions() as session:
                result = await autobatch.run_once(session)
            outcome, = result["results"]
        self.assertTrue(outcome["dispatched"], outcome)
        self.assertEqual(outcome["taskIds"], ids)
        self.assertEqual(send.call_args.args[3]["id"], route["id"])
        async with self.sessions() as session:
            batch = await session.get(models.Task, outcome["batchId"])
            self.assertEqual(batch.repo_id, "repo")
            self.assertEqual(batch.owner_user_id, "owner")
            self.assertEqual((await session.get(models.Task, "pending")).status, "todo")
            self.assertEqual((await session.get(models.Task, "previous-account")).status, "todo")

    async def test_batch_nonstart_releases_only_owned_transitions_and_unblocks_repo(self):
        async with self.sessions() as session:
            session.add(models.Repo(id="repo", project_id="project", ai_work_dir="work"))
            await session.commit()
        common = dict(repo_id="repo", integration_id="import")
        ids = [await self.create(tid, **common) for tid in ("one", "two", "changed")]
        await self.create("collecting", triage_stage="intake", **common)
        await self.create("clarifying", triage_stage="clarifying", **common)
        await self.create("archived", archived_at=datetime.now(timezone.utc), **common)
        async with self.sessions() as session:
            group, = await autobatch.group(session)
            self.assertEqual(set(group["taskIds"]), set(ids))
        body = {"taskIds": ids, "assigneeId": "runner:remote:pi"}
        route = {"id": body["assigneeId"], "runnerId": "remote", "runnerBootId": "boot"}
        with patch.object(ai_exec, "dispatch_sync", return_value={
                **route, "ok": False, "uncertain": True, "error": "lost ACK"}), \
             patch.object(ai_exec, "resolve_requested_sync", return_value=route), \
             patch.object(tasks, "_push_task", new=AsyncMock()), \
             patch.object(tasks, "_settle_work_dir", new=AsyncMock(return_value={"ok": True})), \
             patch.object(tasks, "_attach_skills", new=AsyncMock()):
            first = await self.http.post("/api/v1/tasks/batch-dispatch", json=body)
            self.assertTrue(first.json()["pending"], first.text)
            async with self.sessions() as session:
                changed = await session.get(models.Task, "changed")
                await task_status.mark(session, changed, "todo")
                await task_status.mark(session, changed, "doing")
                await session.commit()
                candidate, = await dispatch_reconcile.candidates(
                    session, now=datetime.now(timezone.utc) + timedelta(minutes=2))
                with patch.object(dispatch_reconcile, "probe_result_current", new=AsyncMock(return_value=True)):
                    state, shell = await dispatch_reconcile.apply_probe(session, candidate, {"state": "not-started"})
                await session.commit()
                self.assertEqual((state, shell.status), ("released", "cancel"))
                self.assertEqual(changed.status, "doing")
                self.assertNotIn("repo", await autobatch._busy_repos(session))
                group, = await autobatch.group(session)
                self.assertEqual(set(group["taskIds"]), {"one", "two"})
                state, _ = await dispatch_reconcile.apply_probe(session, candidate, {"state": "not-started"})
                self.assertEqual(state, "stale")

    async def test_recovery_releases_legacy_batch_with_persisted_nonstart(self):
        await self.create("shell", status="doing")
        await self.create("member")
        async with self.sessions() as session:
            shell = await session.get(models.Task, "shell")
            member = await session.get(models.Task, "member")
            session.add(models.Milestone(task_id=shell.id, src_task_id=member.id, seq=0, title="one"))
            receipt = {"attemptId": shell.id, "batchId": shell.id}
            task_events.record(session, member.id, "ai.batch_requested", receipt)
            task_events.record(session, member.id, "ai.batched", receipt)
            await task_status.mark(session, member, "doing")
            await task_status.mark(session, shell, "todo")
            task_events.record(session, shell.id, ai_exec.EV_DISPATCH_FAILED,
                               {**receipt, "confirmedNotStarted": True, "expectedRef": "old"})
            await session.commit()
            later = datetime.now(timezone.utc) + timedelta(minutes=2)
            old, = await dispatch_reconcile.candidates(session, now=later)
            result = await dispatch_reconcile.probe(old)
            action, _ = await dispatch_reconcile.apply_probe(session, old, result)
            await session.commit()
            self.assertEqual((action, shell.status, member.status), ("released", "cancel", "todo"))
            self.assertEqual(await dispatch_reconcile.candidates(session, now=later), [])

    async def test_failed_legacy_shell_without_admission_does_not_use_a_recovery_slot(self):
        await self.create("shell")
        await self.create("member", status="doing")
        async with self.sessions() as session:
            session.add(models.Milestone(task_id="shell", src_task_id="member", seq=0, title="Member"))
            task_events.record(session, "member", "ai.batched", {"batchId": "shell"})
            task_events.record(session, "shell", ai_exec.EV_DISPATCH_FAILED,
                               {"attemptId": "shell", "confirmedNotStarted": True})
            await session.commit()
            later = datetime.now(timezone.utc) + timedelta(minutes=2)
            self.assertEqual(await dispatch_reconcile.candidates(session, now=later, limit=1), [])
            self.assertEqual((await session.get(models.Task, "member")).status, "doing")

    async def test_rejected_batch_leaves_sources_available_for_a_new_attempt(self):
        ids = [await self.create("a"), await self.create("b")]
        body = {"taskIds": ids, "assigneeId": "runner:remote:pi"}
        accepted = []

        def dispatch(ctx, task, files, picked, extra):
            accepted.append(extra["dispatchId"])
            if len(accepted) == 1:
                return {"ok": False, "error": "Runner declined"}
            return {"ok": True, "issueId": dispatch_identity.execution_ref(extra["dispatchId"]),
                    "runnerId": "remote", "assigneeCli": "pi", "provider": "runner"}

        with patch.object(ai_exec, "dispatch_sync", side_effect=dispatch), \
             patch.object(ai_exec, "resolve_requested_sync", return_value={"id": body["assigneeId"]}), \
             patch.object(tasks, "_push_task", new=AsyncMock()), \
             patch.object(tasks, "_settle_work_dir", new=AsyncMock(return_value={"ok": True})), \
             patch.object(tasks, "_attach_skills", new=AsyncMock()):
            rejected = await self.http.post("/api/v1/tasks/batch-dispatch", json=body)
            self.assertEqual(rejected.status_code, 502, rejected.text)
            async with self.sessions() as session:
                self.assertEqual((await session.get(models.Task, ids[0])).status, "todo")
                shell = await session.get(models.Task, rejected.json()["detail"]["batchId"])
                self.assertEqual(shell.status, "cancel")
            retry = await self.http.post("/api/v1/tasks/batch-dispatch", json=body)
            self.assertEqual(retry.status_code, 200, retry.text)
            replay = await self.http.post("/api/v1/tasks/batch-dispatch", json=body)
            self.assertEqual(replay.json()["attemptId"], retry.json()["attemptId"])
            self.assertEqual(len(set(accepted)), 2)
            self.assertEqual(len(accepted), 2)

            # Complete the real batch lifecycle. An HTTP replay after terminal
            # settlement and a new round after an explicit reopen are distinct.
            async with self.sessions() as session:
                batch = await session.get(models.Task, retry.json()["batchId"])
                await task_status.mark(session, batch, "done", engine=True, allow_incomplete=True)
                await session.commit()
            completed = await self.http.post("/api/v1/tasks/batch-dispatch", json=body)
            self.assertEqual(completed.json()["batchId"], retry.json()["batchId"])
            for tid in ids:
                reopened = await self.http.patch(f"/api/v1/tasks/{tid}", json={"status": "todo"})
                self.assertEqual(reopened.status_code, 200, reopened.text)
            new_round = await self.http.post("/api/v1/tasks/batch-dispatch", json=body)
            self.assertEqual(new_round.status_code, 200, new_round.text)
            self.assertNotEqual(new_round.json()["batchId"], completed.json()["batchId"])
            repeated = await self.http.post("/api/v1/tasks/batch-dispatch", json=body)
            self.assertEqual(repeated.json()["batchId"], new_round.json()["batchId"])
            self.assertEqual(len(accepted), 3)

    async def test_ineligible_batch_member_rejects_whole_plan_and_survives_late_completion(self):
        await self.create("ready")
        for tid, state in (("archived", {"archived_at": datetime.now(timezone.utc)}),
                           ("intake", {"triage_stage": "intake"}),
                           ("clarifying", {"triage_stage": "clarifying"})):
            await self.create(tid, **state)
            result = await self.http.post("/api/v1/tasks/batch-dispatch", json={"taskIds": ["ready", tid]})
            self.assertEqual(result.status_code, 409, result.text)
        async with self.sessions() as session:
            self.assertEqual(list(await session.scalars(select(models.Milestone))), [])
            self.assertEqual(list(await session.scalars(select(models.TaskEvent))), [])
            batch = models.Task(id="older-batch", title="Earlier batch", owner_client_id="owner", status="doing")
            session.add(batch)
            session.add(models.Milestone(task_id=batch.id, seq=0, title="Archived source", src_task_id="archived"))
            await session.flush()
            await task_status._close_batch_members(session, batch, engine=False)
            archived = await session.get(models.Task, "archived")
            self.assertEqual(archived.status, "todo")
            self.assertIsNotNone(archived.archived_at)
        self.assertFalse(self.calls)


    async def test_released_batch_notification_continues_after_one_member_publish_fails(self):
        for tid in ("shell", "a", "b"):
            await self.create(tid, status="cancel" if tid == "shell" else "todo")
        await self.create("other-account", owner_client_id="outside", owner_user_id="outside")
        sent = []

        async def publish(session, row, kind, payload):
            sent.append((row.id, kind))
            if row.id == "a":
                raise RuntimeError("synthetic disconnected subscriber")

        async with self.sessions() as session:
            shell = await session.get(models.Task, "shell")
            for seq, tid in enumerate(("a", "b", "other-account")):
                session.add(models.Milestone(task_id=shell.id, src_task_id=tid, seq=seq, title=tid))
            await session.commit()
            with patch.object(dispatch_reconcile, "publish_task", side_effect=publish), \
                 patch.object(dispatch_reconcile.notify, "notify_task", new=AsyncMock()) as notice:
                await dispatch_reconcile._publish(session, shell, "released")
            self.assertEqual(sent, [(tid, "task.updated") for tid in ("shell", "a", "b")])
            self.assertEqual(notice.await_args.kwargs["extra"], {"kind": "dispatch-released"})


def test_prepare_execution_has_one_runtime_route_and_preserved_openapi():
    endpoint_path = "/api/v1/tasks/{tid}/prepare-execution"
    handlers = [route.endpoint.__name__ for route in tasks.router.routes
                if getattr(route, "path", None) == endpoint_path and "POST" in route.methods]
    app = FastAPI()
    app.include_router(tasks.router)
    operation = app.openapi()["paths"][endpoint_path]["post"]["operationId"]
    assert handlers == ["prepare_task_execution"]
    assert operation == "prepare_task_execution_api_v1_tasks__tid__prepare_execution_post"


if __name__ == "__main__":
    unittest.main()
