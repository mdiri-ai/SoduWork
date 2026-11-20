"""Role writes and user role updates through authenticated admin requests."""
import importlib
import os
from pathlib import Path
import unittest

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

import httpx
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models
from app.api import admin
from app.auth import sign_token
from app.db import Base, get_session

for model_file in (Path(__file__).parent / "app").glob("*models.py"):
    importlib.import_module("app." + model_file.stem)


class UserRoleUpdateTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        async with self.sessions() as session:
            session.add_all([
                models.OrgUnit(id="team", name="Team"),
                models.OrgUnit(id="child", name="Child", parent_id="team"),
                models.OrgUnit(id="outside", name="Outside"),
                models.Role(id="manager", name="Manager", permissions=["user.manage"]),
                models.Role(id="reader", name="Reader", permissions=["task.view"]),
            ])
            for uid, org, role in (("actor", "team", "manager"),
                                   ("target", "child", "manager"),
                                   ("outsider", "outside", "manager"),
                                   ("reader", "team", "reader")):
                session.add(models.User(
                    id=uid, username=uid, display_name=uid, org_id=org, role_id=role,
                    is_active=True, auth_version=1,
                    positions=["profession"], domains=["domain"],
                ))
            session.add(models.User(
                id="super", username="super", display_name="Super", org_id="team",
                is_super=True, is_active=True, auth_version=1,
            ))
            await session.commit()

        self.app = FastAPI()
        self.app.include_router(admin.router)

        async def db():
            async with self.sessions() as session:
                yield session

        self.app.dependency_overrides[get_session] = db
        self.http = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app), base_url="http://isolated",
        )
        self.tokens = {uid: sign_token(uid, 1)
                       for uid in ("actor", "target", "outsider", "reader", "super")}

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.engine.dispose()

    async def request(self, method, path, who="actor", **kwargs):
        headers = {"Authorization": "Bearer " + self.tokens[who]} if who else {}
        return await self.http.request(method, "/api/v1/admin" + path, headers=headers, **kwargs)

    async def assert_stored_role(self, uid, expected):
        async with self.sessions() as session:
            user = await session.get(models.User, uid)
            self.assertEqual(user.role_id, expected)

    async def test_role_writes_reject_unknown_permissions_without_changes(self):
        invalid = "delivery.aprove"
        body = {"name": "Changed", "permissions": ["task.dispatch", invalid]}
        for method, path in (("POST", "/roles"), ("PATCH", "/roles/reader")):
            with self.subTest(method=method):
                response = await self.request(method, path, who="super", json=body)
                self.assertEqual(response.status_code, 400, response.text)
                self.assertIn(invalid, response.json()["detail"])

        async with self.sessions() as session:
            roles = (await session.execute(select(models.Role.name, models.Role.permissions))).all()
            self.assertEqual(dict(roles), {"Manager": ["user.manage"], "Reader": ["task.view"]})
            self.assertIsNone(await session.scalar(select(models.AuditLog.id).limit(1)))

    async def test_valid_role_permissions_can_be_set_preserved_and_cleared(self):
        valid = ["task.view", "delivery.review"]
        created = await self.request("POST", "/roles", who="super",
                                     json={"name": "Custom", "permissions": valid})
        self.assertEqual(created.status_code, 200, created.text)
        self.assertEqual(created.json()["permissions"], valid)
        path = "/roles/" + created.json()["id"]
        for body, expected in (({"name": "Renamed"}, valid), ({"permissions": None}, valid),
                               ({"permissions": ["task.dispatch"]}, ["task.dispatch"]),
                               ({"permissions": []}, [])):
            with self.subTest(body=body):
                updated = await self.request("PATCH", path, who="super", json=body)
                self.assertEqual(updated.status_code, 200, updated.text)
                self.assertEqual(updated.json()["permissions"], expected)

    async def test_explicit_null_clears_role_in_response_list_database_and_audit(self):
        updated = await self.request("PATCH", "/users/target", json={"roleId": None})
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertIsNone(updated.json()["roleId"])
        listed = await self.request("GET", "/users")
        self.assertEqual(listed.status_code, 200, listed.text)
        target = next(user for user in listed.json() if user["id"] == "target")
        self.assertIsNone(target["roleId"])
        await self.assert_stored_role("target", None)
        async with self.sessions() as session:
            audit = (await session.execute(select(models.AuditLog).where(
                models.AuditLog.action == "user.update",
                models.AuditLog.target_id == "target",
            ))).scalars().one()
            self.assertEqual(audit.actor_id, "actor")
            self.assertEqual(audit.detail["fields"], ["roleId"])
            self.assertFalse(audit.detail["pwChanged"])

    async def test_omitted_role_keeps_existing_role(self):
        updated = await self.request("PATCH", "/users/target", json={"displayName": "Renamed"})
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["displayName"], "Renamed")
        self.assertEqual(updated.json()["roleId"], "manager")
        await self.assert_stored_role("target", "manager")

    async def test_role_can_be_replaced_and_assigned_after_clearing(self):
        for role_id in ("reader", None, "manager"):
            with self.subTest(role_id=role_id):
                updated = await self.request("PATCH", "/users/target", json={"roleId": role_id})
                self.assertEqual(updated.status_code, 200, updated.text)
                self.assertEqual(updated.json()["roleId"], role_id)
                await self.assert_stored_role("target", role_id)

    async def test_existing_token_loses_permissions_after_role_is_cleared(self):
        allowed = await self.request("GET", "/users", who="target")
        self.assertEqual(allowed.status_code, 200, allowed.text)
        previous_me = await self.request("GET", "/me", who="target")
        self.assertEqual(previous_me.json()["permissions"], ["user.manage"])

        updated = await self.request("PATCH", "/users/target", json={"roleId": None})
        self.assertEqual(updated.status_code, 200, updated.text)
        # request() reuses the exact token issued in setUp, without logging in again.
        current_me = await self.request("GET", "/me", who="target")
        self.assertEqual(current_me.status_code, 200, current_me.text)
        self.assertIsNone(current_me.json()["roleId"])
        self.assertEqual(current_me.json()["permissions"], [])
        denied = await self.request("GET", "/users", who="target")
        self.assertEqual(denied.status_code, 403, denied.text)
        denied = await self.request("PATCH", "/users/target", who="target",
                                    json={"roleId": "manager"})
        self.assertEqual(denied.status_code, 403, denied.text)
        await self.assert_stored_role("target", None)

    async def test_other_null_fields_keep_existing_values(self):
        updated = await self.request("PATCH", "/users/target", json={
            "roleId": None, "displayName": None, "orgId": None, "isActive": None,
            "positions": None, "domains": None, "password": None, "tokenQuota": None,
        })
        self.assertEqual(updated.status_code, 200, updated.text)
        async with self.sessions() as session:
            target = await session.get(models.User, "target")
            self.assertIsNone(target.role_id)
            self.assertEqual(target.display_name, "target")
            self.assertEqual(target.org_id, "child")
            self.assertTrue(target.is_active)
            self.assertEqual(target.positions, ["profession"])
            self.assertEqual(target.domains, ["domain"])
            self.assertEqual(target.password_hash, "")
            self.assertEqual(target.auth_version, 1)

    async def test_empty_string_still_clears_role(self):
        updated = await self.request("PATCH", "/users/target", json={"roleId": ""})
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertIsNone(updated.json()["roleId"])
        await self.assert_stored_role("target", None)

    async def test_role_update_keeps_authentication_permission_and_scope_guards(self):
        for who, uid, expected in ((None, "target", 401),
                                   ("reader", "target", 403),
                                   ("actor", "outsider", 403)):
            with self.subTest(who=who, uid=uid):
                denied = await self.request("PATCH", "/users/" + uid, who=who,
                                            json={"roleId": None})
                self.assertEqual(denied.status_code, expected, denied.text)
                await self.assert_stored_role(uid, "manager")
        denied = await self.request("PATCH", "/users/target",
                                    json={"roleId": None, "orgId": "outside"})
        self.assertEqual(denied.status_code, 403, denied.text)
        await self.assert_stored_role("target", "manager")

    async def test_superadmin_cannot_be_disabled_when_clearing_role(self):
        denied = await self.request("PATCH", "/users/super", who="super",
                                    json={"roleId": None, "isActive": False})
        self.assertEqual(denied.status_code, 400, denied.text)
        async with self.sessions() as session:
            user = await session.get(models.User, "super")
            self.assertTrue(user.is_active)
            self.assertTrue(user.is_super)
            self.assertEqual(user.auth_version, 1)


if __name__ == "__main__":
    unittest.main()
