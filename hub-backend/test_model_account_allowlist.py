"""Per-model account allowlist: usable() admission, personal-key block, admin API."""
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI

from test_model_runtime import IsolatedDatabase
from app import auth
from app.db import get_session
from app.models import AuditLog, Client, ModelDef, ModelProvider, User
from app.api import admin
from app.services import device_auth, model_config_guard
from app.services import model_catalog as catalog


class AccountAllowlistTests(IsolatedDatabase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        async with self.engine.begin() as connection:
            await connection.run_sync(User.__table__.create)
            await connection.run_sync(AuditLog.__table__.create)
        async with self.sessions() as session, session.begin():
            session.add_all([
                User(id="admin", username="admin", is_super=True),
                User(id="alice", username="alice"), User(id="bob", username="bob"),
                Client(id="a", user_ref="alice", auth_state="active", config={}, models=[]),
                Client(id="b", user_ref="bob", auth_state="active",
                       model_keys={"custom-p": "b-private"},
                       config={"modelProviders": [{"id": "custom-p", "name": "Personal",
                                                   "baseUrl": "http://127.0.0.1:9/v1",
                                                   "personal": True, "kind": "openai-compat"}]},
                       models=[{"providerId": "custom-p", "name": "model", "ctxWindow": 128000,
                                "config": {"imageRouting": "auto", "maxOutputTokens": 32768}}]),
                ModelProvider(id="p", name="Fixture", api_key="company-private",
                              base_url="http://127.0.0.1:9/v1"),
                ModelDef(id="p:model", provider_id="p", name="model", ctx_window=128000,
                         config={"imageRouting": "auto", "maxOutputTokens": 32768}),
            ])
        self.app = FastAPI()
        self.app.include_router(admin.router)

        async def isolated_session():
            async with self.sessions() as session:
                yield session
        self.app.dependency_overrides[get_session] = isolated_session
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")
        self.headers = {"admin": {"Authorization": "Bearer " + auth.sign_claims(
            {"uid": "admin", "ver": 1}, ttl_seconds=600, token_type="user")}}
        async with self.sessions() as session:
            for name in ("a", "b"):
                token, _ = device_auth.issue_session(await session.get(Client, name))
                self.headers[name] = {"Authorization": "Device " + token}

    async def asyncTearDown(self):
        await self.http.aclose()
        await super().asyncTearDown()

    async def allow(self, accounts):
        async with self.sessions() as session:
            model = await session.get(ModelDef, "p:model")
            model.allowed_user_ids = accounts
            await session.commit()

    async def test_allowlist_blocks_other_accounts_and_stays_open_when_empty(self):
        async with self.sessions() as session:
            rows = await catalog.usable(session, await session.get(Client, "a"))
            self.assertEqual([r["id"] for r in rows], ["p:model"])
            # Client b additionally sees its personal model while nothing is restricted.
            rows = await catalog.usable(session, await session.get(Client, "b"))
            self.assertEqual([r["id"] for r in rows], ["p:model", "custom-p:model"])
        await self.allow(["alice"])
        async with self.sessions() as session:
            rows = await catalog.usable(session, await session.get(Client, "a"))
            self.assertEqual([r["id"] for r in rows], ["p:model"])
            self.assertEqual(await catalog.usable(session, await session.get(Client, "b")), [])

    async def test_restricted_model_blocks_personal_same_name(self):
        async with self.sessions() as session:
            own = [r for r in await catalog.usable(session, await session.get(Client, "b")) if r["own"]]
            self.assertEqual([r["id"] for r in own], ["custom-p:model"])
        await self.allow(["alice"])
        # The account cannot restore the restricted organization model under a personal key.
        async with self.sessions() as session:
            self.assertEqual(await catalog.usable(session, await session.get(Client, "b")), [])

    async def test_internal_call_without_client_is_not_restricted(self):
        await self.allow(["alice"])
        async with self.sessions() as session:
            rows = await catalog.usable(session, None)
            self.assertEqual([r["id"] for r in rows], ["p:model"])

    async def test_admin_catalog_exposes_allowlist_only_for_administrators(self):
        await self.allow(["alice"])
        async with self.sessions() as session:
            plain = (await catalog.catalog(session))["models"][0]
            self.assertNotIn("allowedAccounts", plain)
            admin_row = (await catalog.catalog(session, admin=True))["models"][0]
            self.assertEqual(admin_row["allowedAccounts"], ["alice"])
        response = await self.http.get("/api/v1/admin/model-catalog", headers=self.headers["admin"])
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["models"][0]["allowedAccounts"], ["alice"])

    async def test_put_model_def_persists_allowlist_and_audits_it(self):
        async with self.sessions() as session:
            revision = model_config_guard.revision(await session.get(ModelDef, "p:model"))
        audit_log = AsyncMock()
        with patch.object(admin.audit, "log", audit_log):
            response = await self.http.put("/api/v1/admin/model-defs", headers=self.headers["admin"],
                json={"providerId": "p", "name": "model", "expectedRevision": revision,
                      "allowedAccounts": ["alice", " bob ", "", "alice"]})
        self.assertEqual(response.status_code, 200, response.text)
        async with self.sessions() as session:
            self.assertEqual((await session.get(ModelDef, "p:model")).allowed_user_ids, ["alice", "bob"])
        detail = audit_log.call_args.args[6]
        self.assertEqual(detail["allowedAccounts"], ["alice", "bob"])
        # Invalid account types are rejected without committing the other changes.
        async with self.sessions() as session:
            revision = model_config_guard.revision(await session.get(ModelDef, "p:model"))
        for bad in (["alice", 3], "alice"):
            with self.subTest(bad=bad):
                with patch.object(admin.audit, "log", new=AsyncMock()):
                    response = await self.http.put("/api/v1/admin/model-defs", headers=self.headers["admin"],
                        json={"providerId": "p", "name": "model", "expectedRevision": revision,
                              "allowedAccounts": bad})
                self.assertEqual(response.status_code, 400, response.text)
                async with self.sessions() as session:
                    self.assertEqual((await session.get(ModelDef, "p:model")).allowed_user_ids,
                                     ["alice", "bob"])

    async def test_model_def_accounts_lists_active_users_for_administrators(self):
        response = await self.http.get("/api/v1/admin/model-defs/accounts", headers=self.headers["admin"])
        self.assertEqual(response.status_code, 200, response.text)
        accounts = {row["id"]: row["name"] for row in response.json()["accounts"]}
        self.assertEqual(accounts, {"admin": "admin", "alice": "alice", "bob": "bob"})
        for name in ("a", "b"):
            response = await self.http.get("/api/v1/admin/model-defs/accounts", headers=self.headers[name])
            self.assertNotEqual(response.status_code, 200, response.text)


if __name__ == "__main__":
    unittest.main()
