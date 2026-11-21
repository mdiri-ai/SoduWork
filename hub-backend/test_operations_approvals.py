"""Monitor approval queues and mutations through scoped administrator HTTP routes."""
import os
import unittest
from datetime import datetime, timedelta, timezone

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

import httpx
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am, models
from app.api import operations
from app.auth import sign_token
from app.db import Base, get_session


class OperationsApprovalTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        now = datetime.now(timezone.utc)
        async with self.sessions() as s:
            for org in ("local", "remote"):
                s.add(models.OrgUnit(id=org, name=org))
            for role, perms in (("observer", ["operations.view"]), ("operator", ["operations.view", "release.approve"]),
                                ("reader", ["operations.view", "task.view"])):
                s.add(models.Role(id=role, name=role, permissions=perms))
            for uid in ("alice", "bob", "charlie", "reader", "observer", "outside"):
                s.add(models.User(id=uid, username=uid, display_name=uid,
                    role_id=uid if uid in ("reader", "observer") else "operator",
                    org_id="remote" if uid == "outside" else "local", is_active=True))
                s.add(models.Client(id=uid, user_ref=uid, auth_state="active"))
            for key, owner, action, hours in (("a", "alice", "baseline", 26),
                                              ("b", "alice", "review", 2),
                                              ("x", "outside", "deploy", 48)):
                task = models.Task(id="t"+key, title="Task "+key, created_by=owner,
                                   owner_client_id=owner, owner_user_id=owner)
                version = am.ArtifactVersion(id="v"+key, task_id=task.id, kind="requirement",
                    checksum="synthetic", manifest={"title": task.title, "description": "Scope",
                                                     "acceptanceCriteria": ["Confirmed"]})
                s.add_all([task, version, am.ApprovalRequest(id=key, action=action,
                    task_id=task.id, artifact_version_id=version.id, required_count=1,
                    created_at=now-timedelta(hours=hours),
                    policy_snapshot={"approvers": [{"type": "permission", "key": "release.approve"}]}),
                    am.ApprovalAssignment(request_id=key, user_id=owner, user_name=owner)])
            await s.commit()
        app = FastAPI()
        app.include_router(operations.router)

        async def database():
            async with self.sessions() as session:
                yield session

        app.dependency_overrides[get_session] = database
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.engine.dispose()

    async def request(self, path, *, who="alice", body=None):
        return await self.http.request("GET" if body is None else "POST",
            "/api/v1/admin/operations/" + path, json=body,
            headers={"Authorization": "Bearer " + sign_token(who, 1)})

    async def test_queue_matches_scoped_card_and_displays_deadlines(self):
        first = await self.request("approvals?limit=1")
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()["total"], 2)
        item, = first.json()["items"]
        self.assertEqual((item["id"], item["taskTitle"], item["overdue"]), ("a", "Task a", True))
        self.assertEqual(item["assignees"][0]["userId"], "alice")
        self.assertTrue(item["canDecide"])
        second, = (await self.request("approvals?limit=1&offset=1")).json()["items"]
        self.assertFalse(second["overdue"])
        self.assertFalse(second["canTransfer"])
        self.assertEqual(second["id"], "b")
        work = (await self.request("overview")).json()["work"]
        self.assertEqual((work["pendingApprovals"], work["overdueApprovals"]), (2, 1))
        hidden = (await self.request("approvals", who="observer")).json()
        self.assertEqual(hidden["total"], 2)
        for row in hidden["items"]:
            self.assertFalse(any(row[k] for k in ("canViewDetails", "canWithdraw", "canTransfer", "canDecide",
                                                   "taskTitle", "taskId", "assignees", "artifactVersionId")))

    async def test_transfer_cannot_escape_scope_or_bypass_review_and_votes(self):
        options = (await self.request("approvals/a/transfer-options?fromUserId=alice")).json()
        self.assertEqual({x["userId"] for x in options["items"]}, {"bob", "charlie"})
        body = {"fromUserId": "alice", "toUserId": "bob", "note": "Cover this gate"}
        for approval, target, who, expected in (("a", "outside", "alice", 409),
                ("b", "bob", "alice", 409), ("a", "bob", "reader", 403), ("a", "bob", "charlie", 403),
                ("x", "bob", "alice", 403)):
            res = await self.request("approvals/"+approval+"/transfer", who=who,
                                     body={**body, "toUserId": target})
            self.assertEqual(res.status_code, expected, res.text)
        res = await self.request("approvals/a/transfer", body=body)
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual((await self.request("approvals/a/transfer", body=body)).status_code, 409)
        self.assertEqual((await self.request("approvals/a/withdraw", who="bob", body={"note":"cancel"})).status_code, 403)
        reject = {"decision": "reject", "note": "Please clarify the scope"}
        self.assertEqual((await self.request("approvals/a/decision", body=reject)).status_code, 403)
        res = await self.request("approvals/a/decision", who="bob", body=reject)
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual((await self.request("approvals/a/withdraw", body={"note":"late"})).status_code, 409)
        async with self.sessions() as s:
            self.assertEqual((await s.get(am.ApprovalRequest, "a")).status, "rejected")
            rows = (await s.scalars(select(models.AuditLog))).all()
            self.assertEqual([(r.actor_id, r.target_id) for r in rows], [("alice", "a"), ("bob", "a")])

    async def test_withdraw_leaves_history_and_cannot_vote_on_reissued_request(self):
        self.assertEqual((await self.request("approvals/a/withdraw", body={"note": "Revising"})).status_code, 200)
        async with self.sessions() as s:
            old = await s.get(am.ApprovalRequest, "a")
            self.assertEqual(old.status, "cancelled")
            s.add(am.ApprovalRequest(id="replacement", task_id="ta", action="baseline",
                                     artifact_version_id="va", required_count=1, created_at=old.created_at))
            s.add(am.ApprovalAssignment(request_id="replacement", user_id="alice", user_name="Alice"))
            await s.commit()
        res = await self.request("approvals/a/decision", body={"decision":"approve"})
        self.assertEqual(res.status_code, 409, res.text)
        async with self.sessions() as s:
            self.assertEqual((await s.get(am.ApprovalRequest, "replacement")).status, "pending")
        res = await self.request("approvals/replacement/decision", body={"decision":"approve"})
        self.assertEqual(res.status_code, 200, res.text)

    async def test_partial_vote_and_quorum_survive_transfer(self):
        async with self.sessions() as s:
            req = await s.get(am.ApprovalRequest, "a")
            req.required_count = 3
            s.add_all([am.ApprovalAssignment(request_id="a", user_id=uid, user_name=uid)
                       for uid in ("bob", "charlie")])
            s.add(am.ApprovalDecision(request_id="a", decision="approve", user_id="charlie",
                                      user_name="charlie"))
            await s.commit()
        item = (await self.request("approvals", who="bob")).json()["items"][0]
        self.assertEqual([r["userId"] for r in item["assignees"]], ["alice", "bob"])
        self.assertEqual([r["userId"] for r in item["assignees"] if r["canTransfer"]], ["bob"])
        for target in ("alice", "charlie"):
            res = await self.request("approvals/a/transfer", who="bob", body={
                "fromUserId":"bob", "toUserId":target, "note":"Attempt transfer"})
            self.assertEqual(res.status_code, 409, res.text)
        res = await self.request("approvals/a/decision", body={"decision":"approve"})
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["status"], "pending")
        res = await self.request("approvals/a/decision", who="bob", body={"decision":"approve"})
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["status"], "approved")


if __name__ == "__main__":
    unittest.main()
