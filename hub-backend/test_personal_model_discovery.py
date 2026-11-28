"""Personal model discovery: saved + draft modes, org protection, no writes."""
import importlib
import os
from pathlib import Path
import unittest
from unittest.mock import patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

import httpx
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models
from app.api import tasks
from app.db import Base, get_session
from app.services import device_auth, model_discovery

for model_file in (Path(__file__).parent / "app").glob("*models.py"):
    importlib.import_module("app." + model_file.stem)


class PersonalModelDiscoveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        async with self.sessions() as session:
            session.add(models.User(id="owner", username="owner", display_name="Owner",
                                    is_active=True, auth_version=1))
            client = models.Client(id="box1", user_ref="owner", auth_state="active",
                                    auth_version=1, config={},
                                    models=[{"providerId": "custom-gw", "name": "saved-model"}])
            session.add(client)
            await session.commit()
            self.device_token, _ = device_auth.issue_session(client)
        self.app = FastAPI()
        self.app.include_router(tasks.router)

        async def db():
            async with self.sessions() as session:
                yield session

        self.app.dependency_overrides[get_session] = db
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app),
                                      base_url="http://isolated")

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.engine.dispose()

    async def personal(self, **fields):
        async with self.sessions() as session:
            client = await session.get(models.Client, "box1")
            client.config = {"modelProviders": [dict(
                {"id": "custom-gw", "name": "GW", "kind": "openai-compat",
                 "baseUrl": "http://127.0.0.1:9/v1", "personal": True, "enabled": True},
                **fields)]}
            await session.commit()

    async def request(self, path, body=None):
        headers = {"Authorization": "Device " + self.device_token}
        return await self.http.post("/api/v1" + path, json=body or {}, headers=headers)

    async def test_org_provider_is_forbidden(self):
        async with self.sessions() as session:
            session.add(models.ModelProvider(id="openai", name="OpenAI", kind="openai-compat",
                                             base_url="https://api.openai.com/v1", api_key="k",
                                             builtin=True, enabled=True))
            await session.commit()
        resp = await self.request("/my-models/openai/discover")
        self.assertEqual(resp.status_code, 403, resp.text)

    async def test_saved_personal_provider_discovers_and_filters_known(self):
        await self.personal()
        async with self.sessions() as session:
            client = await session.get(models.Client, "box1")
            client.model_keys = {"custom-gw": "sekret"}
            await session.commit()

        seen = {}

        async def fake_discover(base, key, kind="openai-compat", *, allow_empty_key=False):
            seen.update(base=base, key=key, kind=kind, allow_empty_key=allow_empty_key)
            return {"ok": True, "models": ["saved-model", "fresh-1"], "path": "/models", "detail": ""}

        with patch.object(model_discovery, "discover", fake_discover):
            resp = await self.request("/my-models/custom-gw/discover")
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertEqual(body["models"], ["fresh-1"])
        self.assertEqual(body["known"], ["saved-model"])
        self.assertEqual(seen, {"base": "http://127.0.0.1:9/v1", "key": "sekret",
                                "kind": "openai-compat", "allow_empty_key": False})

    async def test_draft_mode_requires_base_url(self):
        resp = await self.request("/my-models/custom-new/discover", {"apiKey": "k"})
        self.assertEqual(resp.status_code, 400, resp.text)

    async def test_draft_no_key_gateway_allowed(self):
        seen = {}

        async def fake_discover(base, key, kind="openai-compat", *, allow_empty_key=False):
            seen.update(base=base, key=key, kind=kind, allow_empty_key=allow_empty_key)
            return {"ok": True, "models": ["local-m"], "path": "/models", "detail": ""}

        with patch.object(model_discovery, "discover", fake_discover):
            resp = await self.request("/my-models/custom-lm/discover",
                                      {"baseUrl": "http://127.0.0.1:8686/v1", "authMode": "none"})
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(seen, {"base": "http://127.0.0.1:8686/v1", "key": "",
                               "kind": "openai-compat", "allow_empty_key": True})
        self.assertEqual(resp.json()["models"], ["local-m"])

    async def test_discovery_never_persists_models(self):
        await self.personal()

        async def fake_discover(base, key, kind="openai-compat", *, allow_empty_key=False):
            return {"ok": True, "models": ["ghost"], "path": "/models", "detail": ""}

        with patch.object(model_discovery, "discover", fake_discover):
            resp = await self.request("/my-models/custom-gw/discover")
        self.assertEqual(resp.status_code, 200, resp.text)
        async with self.sessions() as session:
            client = await session.get(models.Client, "box1")
            names = [row["name"] for row in (client.models or [])]
        self.assertNotIn("ghost", names)

    async def test_unknown_kind_rejected(self):
        resp = await self.request("/my-models/custom-x/discover",
                                  {"baseUrl": "https://x.example/v1", "kind": "grpc"})
        self.assertEqual(resp.status_code, 400, resp.text)


if __name__ == "__main__":
    unittest.main()
