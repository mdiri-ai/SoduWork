"""Exercise list and write contracts on the Hub HTTP routes against isolated SQLite."""
import os
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

import httpx
from fastapi import FastAPI
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models, models
from app.db import Base, get_session
from app.deps import current_client, current_user
from app.library_models import LibraryFolder, LibraryItem
from app.api import admin, approvals, clients, deliveries, environments, library, runner_ws, tasks, usage, work_catalog
from app.permissions import ALL_KEYS


class HubContractTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.addAsyncCleanup(self.engine.dispose)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with self.sessions() as session:
            for i in range(3):
                key = f"row-{i}"
                user = models.User(id=key, username=key, org_id=key, is_super=i == 0)
                device = models.Client(id=key, user_ref=key, auth_state="active")
                session.add_all([user, device, models.OrgUnit(id=key, name=key),
                                 models.Role(id=key, name=key), models.Domain(id=key, name=key)])
                if i == 0:
                    self.user, self.device = user, device
            await session.flush()
            for i in range(3):
                session.add(models.AiSchedule(id=f"schedule-{i}", title=f"schedule {i}",
                                              owner_client_id="row-1" if i == 2 else "row-0"))
            session.add(models.Project(id="project", name="Fixture", org_id="row-0"))
            session.add(LibraryFolder(id="dir", name="Folder", owner_key="row-0"))
            session.add_all([LibraryItem(id=key, title=key, owner_key=owner) for key, owner in
                             (("file-a", "row-0"), ("file-b", "row-0"), ("private", "row-1"))])
            await session.commit()
        self.user._perms = set(ALL_KEYS)
        api = FastAPI()
        for router in (admin.router, approvals.router, clients.router, deliveries.router, environments.router,
                       library.router, runner_ws.router, tasks.router, usage.router, work_catalog.admin_router):
            api.include_router(router)

        async def database():
            async with self.sessions() as session:
                yield session

        api.dependency_overrides[get_session] = database
        api.dependency_overrides[current_user] = lambda: self.user
        api.dependency_overrides[current_client] = lambda: self.device
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=api),
                                      base_url="http://fixture/api/v1/")
        self.addAsyncCleanup(self.http.aclose)

    async def request(self, method, path, expected=200, **kwargs):
        response = await self.http.request(method, path, **kwargs)
        self.assertEqual(response.status_code, expected, (method, path, response.status_code))
        return response.json()

    async def test_admin_and_device_list_windows(self):
        for i in range(2):
            await self.request("POST", "tasks", json={"title": f"task {i}"})
        for path in ("admin/users", "admin/orgs", "admin/roles", "admin/domains",
                     "admin/clients", "tasks", "schedules"):
            with self.subTest(path=path):
                legacy = await self.request("GET", path)
                self.assertIsInstance(legacy, list)
                self.assertEqual(len(legacy), 2 if path in ("tasks", "schedules") else 3)
                seen = []
                for offset in range(len(legacy)):
                    page = await self.request("GET", path, params={"offset": offset, "limit": 1})
                    self.assertEqual(page["total"], len(legacy))
                    self.assertEqual(len(page["items"]), 1)
                    seen.append(page["items"][0]["id"])
                self.assertCountEqual(seen, [row["id"] for row in legacy])
                beyond = await self.request("GET", path, params={"offset": 300})
                self.assertEqual((beyond["items"], beyond["total"]), ([], len(legacy)))
                await self.request("GET", path, 422, params={"limit": 0})
        await self.request("GET", "approvals", 422, params={"limit": 0})
        await self.request("GET", "deliveries", 422, params={"limit": 0})
        for path in ("admin/client-inventory", "admin/clients?paged=1"):
            page = await self.request("GET", path + ("&" if "?" in path else "?") + "pageSize=1")
            self.assertEqual((page["pageSize"], len(page["items"]), page["total"]), (1, 1, 3))
        for mix in ("limit=3&page=1", "offset=0&pageSize=25"):
            response = await self.http.get("admin/client-inventory?" + mix)
            self.assertEqual(response.status_code, 422)
            self.assertEqual(response.headers.get("X-Error-Code"), "hub.input.pages")
        self.user.is_super = False
        limited = await self.request("GET", "admin/users?limit=1")
        self.assertEqual(([user["id"] for user in limited["items"]], limited["total"]), (["row-0"], 1))

    async def test_library_pages_cross_folder_boundary(self):
        with patch("app.api.library.library_read_cache.ensure_ready", new_callable=AsyncMock):
            first = await self.request("GET", "library?scope=all&limit=2")
            self.assertEqual([f["id"] for f in first["folders"]], ["dir"])
            self.assertEqual([f["id"] for f in first["items"]], ["file-a"])
            last = await self.request("GET", "library?scope=all&offset=2&limit=2")
            self.assertEqual((last["total"], last["folders"], last["items"][0]["id"]), (3, [], "file-b"))
            empty = await self.request("GET", "library?scope=all&offset=50")
            self.assertEqual((empty["total"], empty["folders"], empty["items"]), (3, [], []))

    async def test_task_writes_and_comments(self):
        await self.request("POST", "tasks", 400, json={"title": "invalid", "assigneeUserId": "missing"})
        for value in (True, False):
            await self.request("POST", "tasks", 422, json={"title": "invalid", "due": value})
        await self.request("POST", "team/tasks", 400, json={"title": "invalid", "toInbox": True,
                                                           "assigneeUserId": "missing"})
        async with self.sessions() as session:
            self.assertEqual(await session.scalar(select(func.count()).select_from(models.Task)), 0)
        task = await self.request("POST", "tasks", json={"title": "valid", "due": 1900000000000})
        self.assertEqual(task["due"], 1900000000000)
        await self.request("PATCH", f"tasks/{task['id']}", 422, json={"due": False})
        self.assertEqual((await self.request("GET", f"tasks/{task['id']}"))["due"], 1900000000000)
        comments = f"tasks/{task['id']}/comments"
        for body, status in (({}, 422), (False, 422), ("x" * 4001, 400)):
            await self.request("POST", comments, status, json={"body": body})
        await self.request("POST", comments, json={"body": "x" * 4000})
        async with self.sessions() as session:
            stored = (await session.scalars(select(models.TaskComment.body))).all()
            self.assertEqual(stored, ["x" * 4000])

    async def test_workflow_guide_targets_effective_plugin_in_selected_org(self):
        async with self.sessions() as session:
            for plugin_id, org_id, enabled in (
                ("platform-flow", None, True), ("local-flow", "row-0", False),
            ):
                session.add(automation_models.Plugin(id=plugin_id, org_id=org_id,
                                                     key="shared-flow", name="Flow", enabled=enabled))
            await session.commit()

        for org_id, plugin_id, enabled in (("row-0", "local-flow", False), ("row-1", "platform-flow", True)):
            with self.subTest(org_id=org_id):
                catalog = await self.request("GET", "admin/work-catalog", params={"orgId": org_id})
                matches = [row for row in catalog["workflows"] if row["key"] == "shared-flow"]
                self.assertEqual([(row["id"], row["enabled"]) for row in matches], [(plugin_id, enabled)])

    async def test_catalog_and_environment_inputs(self):
        for body in ({"name": "fixture", "type": "unlisted"},
                     {"name": "fixture", "type": "generic", "config": {"baseUrl": "unsupported://example.invalid"}}):
            await self.request("POST", "admin/integrations", 400, json=body)
        await self.request("POST", "admin/projects/project/repos", 400,
                           json={"name": "fixture", "gitUrl": "file:///fixture"})
        await self.request("POST", "admin/environments", 400,
                           json={"key": "testing", "tier": "unlisted"})
        env = await self.request("POST", "admin/environments", json={"key": "testing", "name": ""})
        self.assertEqual(env["name"], "testing")
        await self.request("PATCH", f"admin/environments/{env['id']}", 400, json={"tier": "unlisted"})
        await self.request("POST", "admin/work-catalog/professions", 400,
                           json={"orgId": "row-0", "name": "Analyst", "category": "unlisted"})

    async def test_usage_window_and_enrollment(self):
        for path in ("usage/me", "admin/usage/overview"):
            for days in (-1, 0, 366, 999999):
                await self.request("GET", path, 422, params={"days": days})
            for days in (1, 365):
                await self.request("GET", path, params={"days": days})
        for body in ({}, {"host": "  "}, {"runnerId": "new-runner"}):
            await self.request("POST", "admin/runners/enroll", 422, json=body)
        async with self.sessions() as session:
            self.assertEqual(await session.scalar(select(func.count()).select_from(automation_models.RunnerNode)), 0)

        new = await self.request("POST", "admin/runners/enroll", json={"host": "fixture-host", "orgId": "row-0"})
        rotated = await self.request("POST", "admin/runners/enroll", json={"runnerId": new["runnerId"]})
        self.assertTrue(rotated["rotated"])
        self.assertEqual(rotated["runnerId"], new["runnerId"])
