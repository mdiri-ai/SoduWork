"""Lifecycle CAS checks on separate connections to a disposable SQLite database."""
import asyncio
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("AUTH_SECRET", "isolated-lifecycle-concurrency-test-secret")
os.environ.setdefault("ADMIN_PASS", "isolated-lifecycle-concurrency-test-password")

import httpx
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.account_conversation_models import (
    AccountConversation, AccountConversationCursor, AccountConversationMessage,
)
from app.api import account_conversations
from app.db import Base, get_session
from app.deps import current_client


class AccountConversationLifecycleConcurrencyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="soduwork-lifecycle-cas-")
        self.engine = create_async_engine(
            "sqlite+aiosqlite:///" + str(Path(self.directory.name) / "lifecycle.db"))
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda sync: Base.metadata.create_all(sync, tables=[
                AccountConversation.__table__, AccountConversationCursor.__table__,
                AccountConversationMessage.__table__]))

        app = FastAPI()
        app.include_router(account_conversations.router)

        async def session_override():
            async with self.sessions() as session:
                yield session

        async def client_override():
            return SimpleNamespace(id="device", user_ref="owner")

        app.dependency_overrides[get_session] = session_override
        app.dependency_overrides[current_client] = client_override
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.engine.dispose()
        self.directory.cleanup()

    async def race(self, first_action, second_action, *, archived=False):
        async with self.sessions() as session:
            session.add_all([
                AccountConversation(id="conversation", owner_user_id="owner", source_client_id="device",
                    source_session_id="native", revision=1, lifecycle_revision=0, archived=archived),
                AccountConversationCursor(owner_user_id="owner", revision=1),
            ])
            await session.commit()

        ready = {name: asyncio.Event() for name in ("first", "second")}
        release = {name: asyncio.Event() for name in ready}
        observed = {}
        original_load = account_conversations._load_owned

        async def load_then_pause(*args, **kwargs):
            row = await original_load(*args, **kwargs)
            name = asyncio.current_task().get_name()
            # Pause only the initial read, allowing conflict reloads after CAS.
            if name not in observed:
                observed[name] = row.revision
                ready[name].set()
                await release[name].wait()
            return row

        async def mutate(action):
            return await self.http.post("/api/v1/account-conversations/conversation/lifecycle",
                json={"action": action, "expectedRevision": 1})

        with patch.object(account_conversations, "_load_owned", new=load_then_pause), \
                patch.object(account_conversations, "_publish_account_update", new=AsyncMock()) as publish:
            tasks = [asyncio.create_task(mutate(first_action), name="first"),
                     asyncio.create_task(mutate(second_action), name="second")]
            try:
                await asyncio.wait_for(asyncio.gather(*(event.wait() for event in ready.values())), 5)
                self.assertEqual(observed, {"first": 1, "second": 1})
                release["first"].set()
                first = await asyncio.wait_for(tasks[0], 5)
                release["second"].set()
                second = await asyncio.wait_for(tasks[1], 5)
                self.assertEqual(first.status_code, 200, first.text)
                self.assertEqual(second.status_code, 409, second.text)
                self.assertEqual(publish.await_count, 1, "a rejected stale mutation must not be broadcast")
            finally:
                for event in release.values():
                    event.set()
                await asyncio.gather(*tasks, return_exceptions=True)

        async with self.sessions() as session:
            stored = await session.get(AccountConversation, "conversation")
            cursor = await session.get(AccountConversationCursor, "owner")
            receipt = first.json()["conversation"]
            self.assertEqual(stored.archived, receipt["archived"])
            self.assertEqual(stored.deleted, receipt["deleted"])
            self.assertEqual(stored.revision, receipt["revision"])
            self.assertEqual(stored.lifecycle_revision, receipt["lifecycleRevision"])
            self.assertEqual(cursor.revision, stored.revision)

    async def test_stale_restore_cannot_succeed_after_concurrent_archive(self):
        await self.race("archive", "restore")

    async def test_stale_archive_cannot_succeed_after_concurrent_restore(self):
        await self.race("restore", "archive", archived=True)

    async def test_stale_restore_cannot_succeed_after_concurrent_delete(self):
        await self.race("delete", "restore")

    async def test_concurrent_checkpoints_allocate_distinct_message_revisions(self):
        # Two checkpoints of the same conversation must not reuse a message
        # revision. SQLite's SELECT FOR UPDATE is a no-op, so the allocator
        # serializes behind the pending conversation write (the flush in
        # _next_message_revision) before reading max(revision).
        async with self.sessions() as session:
            session.add_all([
                AccountConversation(id="conversation", owner_user_id="owner", source_client_id="device",
                                    source_session_id="native", revision=1),
                AccountConversationCursor(owner_user_id="owner", revision=1),
            ])
            await session.commit()

        ready = {name: asyncio.Event() for name in ("first", "second")}
        release = {name: asyncio.Event() for name in ready}
        revisions: dict[str, int] = {}

        async def checkpoint(name: str, message_id: str) -> None:
            async with self.sessions() as session:
                row = await session.get(AccountConversation, "conversation")
                row.revision = await account_conversations._next_directory_revision("owner", session)
                ready[name].set()
                await release[name].wait()
                revision = await account_conversations._next_message_revision(row.id, session)
                session.add(AccountConversationMessage(
                    id=message_id, conversation_id=row.id, position=0, role="user",
                    text="hello", revision=revision))
                await session.commit()
                revisions[name] = revision

        tasks = [asyncio.create_task(checkpoint("first", "m1"), name="first"),
                 asyncio.create_task(checkpoint("second", "m2"), name="second")]
        try:
            await asyncio.wait_for(asyncio.gather(*(event.wait() for event in ready.values())), 5)
            release["first"].set()
            release["second"].set()
            await asyncio.wait_for(asyncio.gather(*tasks), 10)
        finally:
            for event in release.values():
                event.set()
            await asyncio.gather(*tasks, return_exceptions=True)

        self.assertEqual(set(revisions.values()), {1, 2}, revisions)

        async with self.sessions() as session:
            first = await session.get(AccountConversationMessage, "m1")
            second = await session.get(AccountConversationMessage, "m2")
            self.assertEqual({int(first.revision), int(second.revision)}, {1, 2})
