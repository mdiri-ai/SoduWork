"""Durable admission receipts for the ordered source tasks in one batch request."""
import hashlib
import json

from fastapi import HTTPException
from sqlalchemy import select

from ..models import Milestone, Task, TaskEvent
from . import (
    ai_exec,
    dispatch_attempts,
    execution_sessions,
    task_access,
    task_events,
    task_status,
)
from .requirement_edit_policy import STARTED_EVENT


async def lock_members(session, ids, client):
    locked = {}
    for tid in sorted(set(ids)):
        await task_access.reserve_task_write(session, tid, client.id)
        task = await session.get(Task, tid, with_for_update=True, populate_existing=True)
        if task is None or not task_access.is_owner(task, client):
            raise HTTPException(404, "Task is not owned by this account: " + tid)
        locked[tid] = task
    return [locked[tid] for tid in ids]


async def require_unassigned(session, ids):
    active = await session.scalar(select(Task.id).join(
        TaskEvent, TaskEvent.detail["batchId"].as_string() == Task.id,
    ).where(
        TaskEvent.task_id.in_(ids), TaskEvent.kind.in_(("ai.batch_requested", "ai.batched")),
        Task.status.in_(("todo", "doing", "paused")),
    ).limit(1))
    if active:
        raise HTTPException(409, "已有需求归属正在处理的合并批次，请核对原批次状态")


def request_key(client, ids, body, repo):
    # Hash the effective execution inputs. An old client can repeat the same
    # request after a disconnect without retaining a new client-generated key.
    inputs = [str(client.id), str(client.user_ref or ""), ids, repo, str(body.get("title") or "").strip()[:200],
              str(body.get("brief") or "")[:2000], str(body.get("assigneeId") or "").strip(),
              str(body.get("assigneeType") or "").strip().lower(),
              str(body.get("model") or ""), str(body.get("reasoningEffort") or "")]
    return hashlib.sha256(json.dumps(inputs, sort_keys=True).encode()).hexdigest()


async def _members_reopened(session, batch, rows):
    if batch.status not in {"done", "cancel"} or any(t.status in {"done", "cancel"} for t in rows):
        return False
    # An identical HTTP retry after completion still owns the original receipt.
    # A later explicit reopen starts a new business round for legacy callers.
    closed_at = await session.scalar(select(TaskEvent.at).where(
        TaskEvent.task_id == batch.id, TaskEvent.kind == STARTED_EVENT,
        TaskEvent.detail["to"].as_string() == batch.status,
    ).order_by(TaskEvent.at.desc()).limit(1))
    if closed_at is None:
        return False
    return bool(await session.scalar(select(TaskEvent.id).where(
        TaskEvent.task_id.in_([task.id for task in rows]), TaskEvent.kind == STARTED_EVENT,
        TaskEvent.at > closed_at,
        TaskEvent.detail["from"].as_string().in_(("done", "cancel")),
        TaskEvent.detail["to"].as_string().in_(("todo", "doing", "paused")),
    ).limit(1)))


async def receipt(session, client, rows, key):
    # All callers hold the source locks before this lookup and through the
    # admission commit. Concurrent requests therefore observe the same intent.
    admission = await session.scalar(select(TaskEvent).where(
        TaskEvent.task_id == rows[0].id, TaskEvent.kind == "ai.batch_requested",
        TaskEvent.detail["requestKey"].as_string() == key,
    ).order_by(TaskEvent.at.desc(), TaskEvent.id.desc()).limit(1))
    if admission is None:
        return None
    detail = admission.detail
    batch = await session.get(Task, detail["batchId"])
    if batch is None or not task_access.is_owner(batch, client):
        raise HTTPException(409, "原批次已无法访问，请核对原派发记录")
    if await _members_reopened(session, batch, rows):
        return None
    event = await session.scalar(select(TaskEvent).where(
        TaskEvent.task_id == batch.id, TaskEvent.kind.in_(ai_exec.KINDS_DISPATCH_STATE),
    ).order_by(TaskEvent.at.desc(), TaskEvent.id.desc()).limit(1))
    if (event and event.kind == ai_exec.EV_DISPATCH_FAILED
            and event.detail.get("attemptId") == detail["attemptId"]):
        # Only a definite rejection releases the sources for another admission.
        return None
    active = await current_receipt(session, batch)
    return {**active, "ok": True, "already": True, "batchId": batch.id, "count": len(rows),
            "attemptId": detail["attemptId"]}


async def current_receipt(session, batch):
    active = await dispatch_attempts.existing(session, batch.id, batch.status)
    if active is not None:
        return active
    dispatched = await ai_exec.last_dispatch_event(session, batch.id)
    return {"pending": dispatched is None, "state": "confirming" if dispatched is None else batch.status,
            "identifier": (dispatched.detail or {}).get("identifier", "") if dispatched else ""}


async def reserve(session, batch, rows, key, who, aid, atype, model, picked):
    attempt_id = batch.id
    for task in rows:
        task_events.record(session, task.id, "ai.batch_requested", {
            "requestKey": key, "batchId": batch.id, "attemptId": attempt_id}, actor=who)
        task_events.record(session, task.id, "ai.batched", {
            "batchId": batch.id, "batchTitle": batch.title, "n": len(rows)}, actor=who)
        if task.status == "todo":
            await task_status.mark(session, task, "doing", why="并入合并批次")
    runner_route = picked if str((picked or {}).get("id") or "").startswith(ai_exec.REMOTE_PREFIX) else None
    return await dispatch_attempts.start(session, batch.id, who, aid, atype, model,
                                         stable_id=attempt_id, runner_route=runner_route)


def member_admissions(batch_id, attempt_id):
    return select(TaskEvent.task_id).join(Milestone, Milestone.src_task_id == TaskEvent.task_id).where(
        Milestone.task_id == batch_id,
        TaskEvent.kind == "ai.batch_requested",
        TaskEvent.detail["batchId"].as_string() == batch_id,
        TaskEvent.detail["attemptId"].as_string() == attempt_id,
    )


async def release_unstarted(session, batch, attempt_id):
    """Release only member transitions still owned by this batch admission."""
    if batch.id != attempt_id:
        return False
    members = list(await session.scalars(member_admissions(batch.id, attempt_id)
                                         .distinct().order_by(TaskEvent.task_id)))
    for tid in members:
        await task_access.reserve_task_write(session, tid, batch.owner_client_id)
        task = await session.get(Task, tid, with_for_update=True, populate_existing=True)
        if (not task or task.owner_client_id != batch.owner_client_id
                or task.owner_user_id != batch.owner_user_id or task.status != "doing"
                or task.archived_at):
            continue
        # Historical admissions wrote ai.batched immediately before the
        # todo -> doing transition. A later transition or admission supersedes it.
        relevant = ("ai.batched", "ai.batch_requested", STARTED_EVENT, *ai_exec.KINDS_DISPATCH_STATE)
        events = list(await session.scalars(select(TaskEvent).where(
            TaskEvent.task_id == tid, TaskEvent.kind.in_(relevant)
        ).order_by(TaskEvent.at.desc(), TaskEvent.id.desc()).limit(2)))
        if (len(events) == 2 and events[0].kind == STARTED_EVENT
                and events[0].detail == {"from": "todo", "to": "doing"}
                and events[1].kind == "ai.batched" and events[1].detail.get("batchId") == batch.id):
            await task_status.mark(session, task, "todo", why="合并批次确认未启动")
    return bool(members)


async def settle(session, batch, count, who, aid, picked, result):
    """Record the transport outcome under the batch row lock and return any definite rejection."""
    attempt_id = batch.id
    if batch.status == "cancel":
        rejected = await session.scalar(select(TaskEvent.id).where(
            TaskEvent.task_id == batch.id, TaskEvent.kind == ai_exec.EV_DISPATCH_FAILED,
            TaskEvent.detail["confirmedNotStarted"].as_boolean().is_(True)).limit(1))
        if rejected:
            raise HTTPException(409, "执行机已确认本批次未启动，请重新派发")
    previous = await ai_exec.last_dispatch_event(session, batch.id)
    if previous is not None:
        # A heartbeat or reconciliation probe already confirmed this delivery.
        return None
    if result.get("ok"):
        task_events.record(session, batch.id, ai_exec.EV_DISPATCHED, {
            **dispatch_attempts.success_detail(attempt_id, aid, picked),
            "ref": result.get("issueId", ""), "issueId": result.get("issueId", ""),
            "identifier": result.get("identifier", ""), "url": result.get("url", ""), "by": who,
            "provider": result.get("provider", ""), "batch": count,
            "runnerId": result.get("runnerId", ""), "host": result.get("host", ""),
            "assigneeId": result.get("assigneeId") or aid, "assigneeType": result.get("assigneeType", "agent"),
            "assigneeName": result.get("assigneeName", ""), "assigneeCli": result.get("assigneeCli", ""),
        }, actor=who)
        await execution_sessions.record_dispatch(session, batch, result)
        return None
    if result.get("uncertain"):
        route = dict(picked or {})
        for field in ("runnerId", "runnerBootId", "host", "lastRunnerReplyAt"):
            if result.get(field):
                route[field] = result[field]
        detail = dispatch_attempts.uncertain(session, batch.id, who, attempt_id, result.get("error"), aid, route)
        await execution_sessions.confirm_uncertain_dispatch(
            session, batch, detail["expectedRef"], str(detail.get("runnerId") or ""))
        return None
    await release_unstarted(session, batch, attempt_id)
    await task_status.mark(session, batch, "cancel", why="执行机拒绝批次")
    failure = dispatch_attempts.record_failure(session, batch.id, who, attempt_id, "dispatch",
                                               result.get("error"), aid, picked)
    failure["confirmedNotStarted"] = True
    failure["batchReleased"] = True
    return {"message": failure["error"], "batchId": batch.id, "attemptId": attempt_id, "retryable": True}
