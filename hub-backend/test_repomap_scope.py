"""Authenticated HTTP regressions for repository mapping and automatic dispatch scope."""
import os
import secrets
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("AUTH_SECRET", secrets.token_hex(32))
os.environ.setdefault("ADMIN_PASS", secrets.token_urlsafe(32))

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models
from app.api import tasks as tasks_api
from app.auth import sign_token
from app.config import get_settings
from app.db import get_session
from app.main import app
from app.services import autobatch, rbac
from tests.sqlite_schema import create_fresh_sqlite_schema


class RepoMapScopeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.addAsyncCleanup(self.engine.dispose)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await create_fresh_sqlite_schema(connection, models.Base.metadata)
        async with self.sessions() as session:
            session.add_all([
                models.OrgUnit(id="a", name="Department A"),
                models.OrgUnit(id="a-child", parent_id="a", name="A child"),
                models.OrgUnit(id="b", name="Department B"),
                models.Role(id="custom", name="Mapping operator",
                            permissions=["binding.manage", "task.dispatch"]),
                models.Role(id="dept", name="Department administrator",
                            permissions=rbac._DEPT_ADMIN_PERMS, is_system=True),
                models.Integration(id="integration", name="Synthetic integration"),
            ])
            for uid, org, role, superuser in (
                ("custom-a", "a", "custom", False), ("dept-a", "a", "dept", False),
                ("member-a", "a", None, False), ("member-child", "a-child", None, False),
                ("member-b", "b", None, False), ("unbound", None, None, False),
                ("super", None, None, True),
            ):
                session.add(models.User(id=uid, username=uid, org_id=org,
                                        role_id=role, is_super=superuser, is_active=True))
            await session.flush()
            for cid, uid in (("ca", "member-a"), ("cc", "member-child"),
                             ("cb", "member-b"), ("cu", "unbound"), ("unassigned", None)):
                session.add(models.Client(id=cid, user_ref=uid))
            for rid, org in (("ra", "a"), ("ra2", "a"), ("rc", "a-child"),
                             ("rb", "b"), ("shared", None)):
                session.add(models.Repo(id=rid, project_id="project-" + rid, name=rid,
                                        org_id=org, ai_work_dir="/synthetic/" + rid))
            await session.commit()

        async def isolated_session():
            async with self.sessions() as session:
                yield session

        old = dict(app.dependency_overrides)
        app.dependency_overrides[get_session] = isolated_session
        self.addCleanup(lambda: (app.dependency_overrides.clear(), app.dependency_overrides.update(old)))
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://isolated")
        self.addAsyncCleanup(self.http.aclose)
        settings = patch.multiple(get_settings(), autobatch_enabled=False,
                                  autobatch_min=2, autobatch_plugin_key="")
        settings.start()
        self.addCleanup(settings.stop)

    async def request(self, method, path, who="custom-a", **kwargs):
        headers = {"Authorization": "Bearer " + sign_token(who)} if who else {}
        return await self.http.request(method, "/api/v1/admin/" + path, headers=headers, **kwargs)

    async def seed_task(self, tid, client="ca", ext="external", repo="", **kwargs):
        async with self.sessions() as session:
            session.add(models.Task(id=tid, title=tid, owner_client_id=client,
                                    integration_id="integration", ext_repo=ext,
                                    repo_id=repo, status="todo", origin="test", **kwargs))
            await session.commit()

    async def bind(self, external="external", repo="ra", who="custom-a"):
        return await self.request("POST", "repo-bindings", who=who, json={
            "integrationId": "integration", "externalRepo": external, "repoId": repo})

    async def test_authentication_and_builtin_permission_matrix(self):
        for method, path in (("GET", "repo-bindings/pending"), ("GET", "autobatch"),
                             ("POST", "repo-bindings"), ("POST", "autobatch")):
            self.assertEqual((await self.request(method, path, who=None)).status_code, 401)
            self.assertEqual((await self.request(method, path, who="member-a")).status_code, 403)
        self.assertEqual((await self.request("GET", "repo-bindings/pending", who="dept-a")).status_code, 403)
        self.assertEqual((await self.bind(who="dept-a")).status_code, 403)
        self.assertEqual((await self.request("GET", "autobatch", who="dept-a")).status_code, 200)

    async def test_both_old_and_new_mapping_targets_are_authorized_before_writes(self):
        await self.seed_task("foreign-pending", client="cb")
        async with self.sessions() as session:
            session.add(models.RepoBinding(id="foreign", integration_id="integration",
                                           external_repo=" EXTERNAL ", repo_id="rb", note="keep"))
            await session.commit()
        self.assertEqual((await self.bind(external="external")).status_code, 403)
        self.assertEqual((await self.bind(external="new", repo="rb")).status_code, 403)
        self.assertEqual((await self.request("DELETE", "repo-bindings/foreign")).status_code, 403)
        async with self.sessions() as session:
            binding = await session.get(models.RepoBinding, "foreign")
            self.assertEqual((binding.repo_id, binding.note), ("rb", "keep"))
            self.assertFalse((await session.get(models.Task, "foreign-pending")).repo_id)
            self.assertEqual(len((await session.execute(select(models.RepoBinding))).scalars().all()), 1)

    async def test_cross_scope_backfill_rejects_new_and_existing_mapping_atomically(self):
        await self.seed_task("local-pending")
        await self.seed_task("foreign-pending", client="cb")
        self.assertEqual((await self.bind()).status_code, 403)
        async with self.sessions() as session:
            self.assertEqual(list((await session.execute(select(models.RepoBinding))).scalars()), [])
            session.add(models.RepoBinding(id="own", integration_id="integration",
                                           external_repo="external", repo_id="ra", note="keep"))
            await session.commit()
        self.assertEqual((await self.bind(repo="ra2")).status_code, 403)
        async with self.sessions() as session:
            self.assertEqual((await session.get(models.RepoBinding, "own")).repo_id, "ra")
            for tid in ("local-pending", "foreign-pending"):
                self.assertFalse((await session.get(models.Task, tid)).repo_id)

    async def test_normal_mapping_backfill_and_superuser_repair(self):
        await self.seed_task("local-pending", ext=" EXTERNAL ")
        await self.seed_task("child-pending", client="cc", project_id="manual-project")
        await self.seed_task("already-mapped", repo="ra2")
        response = await self.bind()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["backfilled"], 2)
        async with self.sessions() as session:
            self.assertEqual((await session.get(models.Task, "child-pending")).project_id, "manual-project")
            self.assertEqual((await session.get(models.Task, "already-mapped")).repo_id, "ra2")
        self.assertEqual((await self.bind(repo="ra2")).json()["backfilled"], 0)
        await self.seed_task("foreign-pending", client="cb")
        response = await self.bind(repo="rb", who="super")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["backfilled"], 1)
        async with self.sessions() as session:
            self.assertEqual((await session.get(models.Task, "foreign-pending")).repo_id, "rb")

    async def test_pending_filters_samples_and_counts_with_existing_unbound_policy(self):
        for tid, cid in (("local", "ca"), ("child", "cc"), ("foreign", "cb"),
                         ("no-org-account", "cu"), ("unassigned-device", "unassigned"),
                         ("ownerless", None)):
            await self.seed_task(tid, client=cid)
        response = await self.request("GET", "repo-bindings/pending")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["total"], 3)
        self.assertEqual(body["items"][0]["count"], 3)
        self.assertEqual({x["id"] for x in body["items"][0]["samples"]},
                         {"local", "child", "unassigned-device"})
        self.assertEqual({x["id"] for x in body["repos"]}, {"ra", "ra2", "rc", "shared"})
        self.assertEqual((await self.request("GET", "repo-bindings/pending", who="super")).json()["total"], 6)

    async def test_account_switch_does_not_make_foreign_tasks_visible_or_mutable(self):
        await self.seed_task("foreign-frozen", client="cb")
        async with self.sessions() as session:
            (await session.get(models.Client, "cb")).user_ref = "member-a"
            await session.commit()
        self.assertEqual((await self.request("GET", "repo-bindings/pending")).json()["total"], 0)
        self.assertEqual((await self.bind()).status_code, 403)

    async def seed_batches(self):
        for prefix, client, repo in (("local", "ca", "ra"), ("foreign", "cb", "rb"),
                                     ("foreign-repo", "ca", "rb")):
            for number in range(2):
                await self.seed_task(prefix + str(number), client=client, repo=repo)

    async def test_scoped_preview_and_legacy_get_are_read_only(self):
        await self.seed_batches()
        get_settings().autobatch_enabled = True
        with patch.object(tasks_api, "batch_dispatch", new_callable=AsyncMock) as dispatch:
            for who in ("custom-a", "dept-a"):
                response = await self.request("GET", "autobatch?run=true", who=who)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertTrue(response.json()["dry"])
                self.assertEqual(response.json()["groups"], 1)
                self.assertEqual(response.json()["all"][0]["taskIds"], ["local0", "local1"])
                self.assertNotIn("foreign", response.text)
            dispatch.assert_not_awaited()
        self.assertEqual((await self.request("GET", "autobatch", who="super")).json()["groups"], 3)

    async def test_post_dispatch_is_scoped_and_respects_global_switch_for_both_paths(self):
        await self.seed_batches()
        with patch.object(autobatch, "pick_assignee", new=AsyncMock(return_value=(
                {"id": "local:fixture", "type": "agent"}, "fixture"))), patch.object(
                tasks_api, "batch_dispatch", new=AsyncMock(return_value={"ok": True, "batchId": "fixture"})) as dispatch:
            response = await self.request("POST", "autobatch", who="dept-a")
            self.assertTrue(response.json()["dry"])
            dispatch.assert_not_awaited()
            get_settings().autobatch_enabled = True
            response = await self.request("POST", "autobatch", who="dept-a")
            self.assertEqual(response.status_code, 200, response.text)
            self.assertTrue(response.json()["results"][0]["dispatched"])
            dispatch.assert_awaited_once()
            self.assertEqual(dispatch.await_args.kwargs["client"].id, "ca")
            self.assertEqual(dispatch.await_args.kwargs["body"]["taskIds"], ["local0", "local1"])
        with patch.object(autobatch, "_flow_binding", new=AsyncMock(return_value="fixture")), patch.object(
                autobatch, "_dispatch_flow", new=AsyncMock(return_value={"dispatched": True})) as flow:
            response = await self.request("POST", "autobatch", who="dept-a")
            self.assertEqual(response.status_code, 200, response.text)
            flow.assert_awaited_once()
            self.assertEqual(flow.await_args.args[1]["taskIds"], ["local0", "local1"])
        async with self.sessions() as session:
            audit = (await session.execute(select(models.AuditLog).where(
                models.AuditLog.action == "autobatch.run"))).scalars().all()
            self.assertEqual(len(audit), 3)
            self.assertTrue(all(row.actor_id == "dept-a" and row.actor_org_id == "a" for row in audit))
            self.assertEqual(sum(row.detail["dispatched"] for row in audit), 2)

    async def test_missing_repo_keeps_scoped_diagnostics_but_cannot_be_managed(self):
        await self.seed_task("own-orphan", repo="missing")
        await self.seed_task("foreign-orphan", client="cb", repo="missing")
        response = await self.request("GET", "autobatch")
        self.assertEqual(response.json()["groups"], 1)
        self.assertEqual(response.json()["all"][0]["taskIds"], ["own-orphan"])
        self.assertFalse(response.json()["all"][0]["ready"])
        async with self.sessions() as session:
            session.add(models.RepoBinding(id="orphan", integration_id="integration",
                                           external_repo="orphan", repo_id="missing"))
            await session.commit()
        self.assertEqual((await self.request("DELETE", "repo-bindings/orphan")).status_code, 403)
        self.assertEqual((await self.request("DELETE", "repo-bindings/orphan", who="super")).status_code, 200)

    async def test_failed_dispatch_keeps_administrator_audit_after_rollback(self):
        await self.seed_batches()
        get_settings().autobatch_enabled = True
        with patch.object(autobatch, "pick_assignee", new=AsyncMock(return_value=(
                {"id": "local:fixture", "type": "agent"}, "fixture"))), patch.object(
                tasks_api, "batch_dispatch", new=AsyncMock(side_effect=ValueError("fixture failure"))):
            response = await self.request("POST", "autobatch", who="dept-a")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["results"][0]["dispatched"])
        async with self.sessions() as session:
            audit = (await session.execute(select(models.AuditLog).where(
                models.AuditLog.action == "autobatch.run"))).scalars().one()
            self.assertEqual(audit.actor_id, "dept-a")
            self.assertEqual(audit.detail["dispatched"], 0)

    async def test_scheduler_requires_explicit_system_principal(self):
        await self.seed_batches()
        async with self.sessions() as session:
            with self.assertRaises(ValueError):
                await autobatch.run_once(session, dry=True)
            with self.assertRaises(ValueError):
                await autobatch.group(session)
            result = await autobatch.run_once(session, dry=True, system=True)
            self.assertEqual(result["groups"], 3)


if __name__ == "__main__":
    unittest.main()
