# -*- coding: utf-8 -*-
"""A fenceless branch task (local-execution branch, no Handoff row) must
still appear in the cloud conversation directory; otherwise the desktop
client cannot rediscover the branched session (isRemoteKnown misses and
opening the branch throws 这条会话已经不存在)."""
import asyncio, os, sys, types
from unittest.mock import AsyncMock, patch

import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///.smoke-fenceless.db")

from app.api.cloud_conversations import directory


class FencelessBranchDirectoryTests(unittest.IsolatedAsyncioTestCase):
    async def test_fenceless_branch_task_appears_in_directory(self):
        task_row = types.SimpleNamespace(
            id="fenceless-task", origin="cloud-conversation",
            owner_user_id="user-1", owner_client_id="desktop-1",
            title="branch title", created_by="user-1",
            updated_at=None, created_at=None,
            work_routing={
                "selectedStrategy": "direct",
                "cloudConversation": {"requestId": "req-1", "sessionId": "cloud-req-1"},
                "executionContext": {"schemaVersion": 1, "strategy": "direct",
                                     "agent": {"id": "local:pi", "cli": "pi"}},
            },
        )

        class Result:
            def __init__(self, values):
                self.values = values
            def scalars(self):
                return self
            def all(self):
                return self.values

        class DirectorySession:
            def __init__(self):
                self.calls = 0
            async def execute(self, _query):
                self.calls += 1
                # 1st: task rows; 2nd+: handoff / event lookups return nothing.
                return Result([task_row] if self.calls == 1 else [])
            async def scalars(self, _query):
                return Result([])

        async def decorate_access(_session, _rows, apis, _client):
            return apis

        def task_to_api(task):
            return {"id": task.id, "origin": task.origin, "title": task.title,
                    "created": 10, "updatedAt": 20, "createdBy": task.created_by,
                    "ownerClientId": task.owner_client_id,
                    "workRouting": task.work_routing}

        with patch("app.api.cloud_conversations.task_svc.task_to_api", side_effect=task_to_api), \
             patch("app.api.cloud_conversations.task_svc.ai_states", new=AsyncMock(return_value={})), \
             patch("app.api.cloud_conversations.task_access.decorate_many", new=AsyncMock(side_effect=decorate_access)), \
             patch("app.services.conversation_review_projection.decorate_many", new=AsyncMock(side_effect=lambda s, r, a: a)):
            result = await directory(types.SimpleNamespace(id="desktop-1", user_ref="user-1"), DirectorySession())

        chats = result.get("chats", [])
        self.assertEqual(len(chats), 1)
        row = chats[0]
        self.assertEqual(row["sessionId"], "cloud-req-1")
        self.assertEqual(row["taskId"], "fenceless-task")
        self.assertEqual(row["phase"], "committed")
        self.assertTrue(row["canContinue"])
        self.assertTrue(row["canSend"])
        self.assertFalse(row["readOnly"])
        self.assertEqual(row["target"]["id"], "local:pi")
        self.assertEqual(row["adapterId"], "pi")


if __name__ == "__main__":
    unittest.main()
