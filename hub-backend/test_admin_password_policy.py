"""B01 regression: administrative password policy (12-128 chars, no blank passwords).

Run with: python3 -m unittest -v test_admin_password_policy
"""
import importlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

# Configure an isolated database and fixed secrets BEFORE importing app modules:
# app/db.py rejects test scripts that connect to a live business database, and
# app/config.py would otherwise generate development secret files on import.
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["AUTH_SECRET"] = "b01-regression-test-secret-0123456789-abcdef"
os.environ["ADMIN_PASS"] = "B01RegressionAdminPass123"

import httpx
from fastapi import FastAPI
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models
from app.api import admin
from app.auth import hash_password, is_empty_password_hash, sign_token, verify_password
from app.db import Base, get_session
from app.schemas import AdminLogin, UserCreate, UserUpdate
from app.services import client_access, rbac

for model_file in (Path(__file__).parent / "app").glob("*models.py"):
    importlib.import_module("app." + model_file.stem)

VALID = "CorrectHorse123"  # 15 characters
WEAK = ["", "1", "   ", " " * 12, "\u3000" * 12, "a" * 8, "a" * 11, "a" * 129]


class AdminPasswordSchemaTests(unittest.TestCase):
    def test_weak_passwords_rejected_on_all_three_contracts(self):
        for pw in WEAK:
            with self.subTest(length=len(pw), sample=repr(pw[:8])):
                with self.assertRaises(ValidationError):
                    AdminLogin(user="u", **{"pass": pw})
                with self.assertRaises(ValidationError):
                    UserCreate(username="u", password=pw, orgId="o")
                with self.assertRaises(ValidationError):
                    UserUpdate(password=pw)

    def test_valid_password_accepted_and_not_rewritten(self):
        # Whitespace padding is preserved; only all-whitespace values are rejected.
        pw = "  " + VALID + "  "
        self.assertEqual(AdminLogin(user="u", **{"pass": pw}).pw, pw)
        self.assertEqual(UserCreate(username="u", password=pw, orgId="o").password, pw)
        self.assertEqual(UserUpdate(password=pw).password, pw)

    def test_boundary_lengths(self):
        self.assertEqual(UserCreate(username="u", password="a" * 12, orgId="o").password, "a" * 12)
        self.assertEqual(UserCreate(username="u", password="a" * 128, orgId="o").password, "a" * 128)
        for length in (11, 129):
            with self.subTest(length=length), self.assertRaises(ValidationError):
                UserCreate(username="u", password="a" * length, orgId="o")

    def test_login_password_is_required_and_optional_reset_is_preserved(self):
        # AdminLogin.pw used to default to "", which admitted empty credentials.
        with self.assertRaises(ValidationError):
            AdminLogin(user="u")
        self.assertEqual(UserUpdate(displayName="x").model_dump(exclude_none=True),
                         {"displayName": "x"})
        self.assertIsNone(UserUpdate().password)

    def test_server_side_backstop_and_client_policy_is_unchanged(self):
        for pw in ("", "   ", " " * 12, "a" * 11, "a" * 129):
            with self.subTest(length=len(pw)):
                with self.assertRaises(client_access.ClientAccessError) as ctx:
                    client_access.validate_admin_password(pw)
                self.assertEqual(ctx.exception.status, 422)
        self.assertEqual(client_access.validate_admin_password(VALID), VALID)
        # Client self-registration / email reset keep their own 8-character policy.
        self.assertEqual(client_access.validate_password("a" * 8, new_account=True), "a" * 8)

    def test_empty_password_hash_detector(self):
        self.assertTrue(is_empty_password_hash(hash_password("")))
        self.assertFalse(is_empty_password_hash(hash_password(VALID)))
        self.assertFalse(is_empty_password_hash(""))
        self.assertFalse(is_empty_password_hash("not-a-hash"))
        self.assertFalse(is_empty_password_hash("pbkdf2$999999999$00$00"))
        # verify_password short-circuits empty credentials; detection must not.
        self.assertFalse(verify_password("", hash_password("")))


class AdminPasswordServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        self.addAsyncCleanup(self.engine.dispose)
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    async def test_create_user_backstop_rejects_weak_password(self):
        async with self.sessions() as session:
            for index, pw in enumerate(("", "1", " " * 12, "a" * 11, "a" * 129)):
                with self.subTest(length=len(pw)):
                    with self.assertRaises(client_access.ClientAccessError):
                        await rbac.create_user(session, f"weak-{index}", pw, "n", None, None)
            await rbac.create_user(session, "good-user", VALID, "Good", None, None)
            row = await session.scalar(select(models.User).where(models.User.username == "good-user"))
            self.assertTrue(verify_password(VALID, row.password_hash))
            self.assertFalse(is_empty_password_hash(row.password_hash))
            self.assertEqual(await session.scalar(select(models.User).where(
                models.User.username.like("weak-%")).limit(1)), None)

    async def test_apply_user_patch_backstop_rejects_weak_password(self):
        user = models.User(id="u1", username="u1", password_hash=hash_password(VALID),
                           is_active=True, auth_version=1)
        for pw in ("", " " * 12, "a" * 11):
            with self.subTest(length=len(pw)):
                with self.assertRaises(client_access.ClientAccessError):
                    rbac.apply_user_patch(user, {"password": pw})
        self.assertTrue(verify_password(VALID, user.password_hash))
        self.assertEqual(user.auth_version, 1)
        rbac.apply_user_patch(user, {"password": "AnotherValidPass123"})
        self.assertTrue(verify_password("AnotherValidPass123", user.password_hash))
        self.assertEqual(user.auth_version, 2)

    async def test_legacy_blank_password_quarantine_is_precise_and_idempotent(self):
        async with self.sessions() as session:
            session.add_all([
                models.User(id="blank", username="blank-user",
                            password_hash=hash_password(""), is_active=True, auth_version=1),
                models.User(id="short", username="short-user",
                            password_hash=hash_password("1"), is_active=True, auth_version=1),
                models.User(id="oidc", username="oidc-user",
                            password_hash="", is_active=True, auth_version=1),
                models.User(id="good", username="good-user",
                            password_hash=hash_password(VALID), is_active=True, auth_version=1),
            ])
            await session.commit()
            self.assertEqual(await rbac.quarantine_legacy_blank_passwords(session), 1)
            self.assertEqual(await rbac.quarantine_legacy_blank_passwords(session), 0)
            for uid, active, version in (("blank", False, 2), ("short", True, 1),
                                         ("oidc", True, 1), ("good", True, 1)):
                row = await session.get(models.User, uid)
                with self.subTest(uid=uid):
                    self.assertEqual(row.is_active, active)
                    self.assertEqual(row.auth_version, version)


class AdminPasswordHttpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.engine = create_async_engine(
            f"sqlite+aiosqlite:///{Path(temp.name).as_posix()}/b01.db")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        self.addAsyncCleanup(self.engine.dispose)
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        async with self.sessions() as session:
            session.add_all([
                models.OrgUnit(id="org-1", name="HQ"),
                models.User(id="admin", username="admin", password_hash=hash_password(VALID),
                            is_super=True, is_active=True, auth_version=1, org_id="org-1"),
            ])
            await session.commit()

        async def session_for_request():
            async with self.sessions() as session:
                yield session

        app = FastAPI()
        app.include_router(admin.router)
        app.dependency_overrides[get_session] = session_for_request
        self.http = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test/api/v1/admin/",
            headers={"Authorization": "Bearer " + sign_token("admin", 1)})
        self.addAsyncCleanup(self.http.aclose)

    async def test_login_rejects_weak_password_before_verify_password(self):
        with patch("app.api.admin.verify_password") as verify:
            for pw in ("", "1", " " * 12, "a" * 11, "a" * 129):
                response = await self.http.post("login", json={"user": "admin", "pass": pw})
                self.assertEqual(response.status_code, 422, (len(pw), response.text))
            verify.assert_not_called()
        response = await self.http.post("login", json={"user": "admin", "pass": VALID})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("token", response.json())

    async def test_create_user_rejects_weak_password(self):
        for pw in WEAK:
            response = await self.http.post("users", json={
                "username": "candidate", "password": pw, "orgId": "org-1"})
            self.assertEqual(response.status_code, 422, (len(pw), response.text))

    async def test_create_login_and_reset_with_valid_password(self):
        created = await self.http.post("users", json={
            "username": "new-user", "password": VALID, "orgId": "org-1"})
        self.assertEqual(created.status_code, 200, created.text)
        uid = created.json()["id"]
        login = await self.http.post("login", json={"user": "new-user", "pass": VALID})
        self.assertEqual(login.status_code, 200, login.text)
        rejected = await self.http.patch(f"users/{uid}", json={"password": "a" * 11})
        self.assertEqual(rejected.status_code, 422, rejected.text)
        accepted = await self.http.patch(f"users/{uid}", json={"password": "AnotherValid123"})
        self.assertEqual(accepted.status_code, 200, accepted.text)
        old_login = await self.http.post("login", json={"user": "new-user", "pass": VALID})
        self.assertEqual(old_login.status_code, 401)
        new_login = await self.http.post("login", json={"user": "new-user", "pass": "AnotherValid123"})
        self.assertEqual(new_login.status_code, 200, new_login.text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
