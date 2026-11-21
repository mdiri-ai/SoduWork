"""Administrator actions on the pending gate selected in the operations queue."""
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, StringConstraints
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from ..db import get_session
from ..deps import current_user, require_perm
from ..models import User
from ..pagination import Page, PageQuery
from ..services import approval_routing, artifact_version_guard, audit, operations_approvals, rbac, task_events
from . import approvals
from .scope import task_or_404, visible_clients


router = APIRouter(prefix="/api/v1/admin/operations/approvals", dependencies=[Depends(require_perm("operations.view"))])
Admin = Annotated[User, Depends(require_perm("release.approve"))]
Session = Annotated[AsyncSession, Depends(get_session)]
Note = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1200)]


class Withdrawal(BaseModel):
    note: Note


class Transfer(Withdrawal):
    fromUserId: str
    toUserId: str


class Decision(BaseModel):
    decision: str
    note: Annotated[str, StringConstraints(strip_whitespace=True, max_length=1200)] = ""


@router.get("")
async def queue(page: PageQuery, session: Session, user: User = Depends(current_user)):
    return await operations_approvals.queue(session, user, await visible_clients(session, user), page or Page(20, 0))


async def _pending(session, user, request_id, *, lock):
    request = await session.get(am.ApprovalRequest, request_id)
    if request is None:
        raise HTTPException(404, "审批项不存在")
    # Take the same task lock as a decision before reading scope and mutable gate state.
    if lock:
        try:
            await artifact_version_guard.lock_task(session, request.task_id)
        except ValueError:
            raise HTTPException(404, "需求不存在")
        await session.refresh(request, with_for_update=True)
    task = await task_or_404(session, user, request.task_id)
    if request.status != "pending":
        raise HTTPException(409, "这项审批已经处理，请刷新待办")
    return request, task


def _audit(session, user, request, task, action, detail):
    fields = {"taskId": task.id, "requestId": request.id, "versionId": request.artifact_version_id,
              "action": request.action, **detail}
    audit.add(session, user, "operations.approval_" + action, "approval_request", request.id, task.title, fields)
    return fields


@router.post("/{request_id}/decision")
async def decide(request_id: str, body: Decision, user: Admin, session: Session):
    request, task = await _pending(session, user, request_id, lock=True)
    if body.decision not in ("approve", "reject"):
        raise HTTPException(400, "决定只能是 approve 或 reject")
    _audit(session, user, request, task, body.decision, {"note": body.note})
    out = await approvals.decide_as_user(session, user, request_id, body.model_dump())
    return {"ok": True, "status": out["request"]["status"]}


@router.post("/{request_id}/withdraw")
async def withdraw(request_id: str, body: Withdrawal, user: Admin, session: Session):
    request, task = await _pending(session, user, request_id, lock=True)
    if not operations_approvals.can_withdraw(user, request, task):
        raise HTTPException(403, "只有发起人或超级管理员可以撤回待审请求")
    request.status = "cancelled"
    request.resolved_at = datetime.now(timezone.utc)
    fields = _audit(session, user, request, task, "withdraw", {"note": body.note})
    task_events.record(session, task.id, "release.approval_withdrawn", fields, actor=user.display_name or user.username)
    await session.commit()
    return {"ok": True, "status": "cancelled"}


async def _transfer_options(session, user, request, task, from_id, *, materialize=False):
    if request.action == "review":
        raise HTTPException(409, "交付成果只能由需求创建人验收")
    if not operations_approvals.can_transfer(user, request, from_id):
        raise HTTPException(403, "只能转交分配给自己的审批")
    version = await session.get(am.ArtifactVersion, request.artifact_version_id)
    if version is None or version.task_id != task.id:
        raise HTTPException(409, "审批版本已失效")
    assignments = {a.user_id: a for a in await session.scalars(select(am.ApprovalAssignment).where(
        am.ApprovalAssignment.request_id == request.id))}
    candidates, excluded = await approval_routing._candidate_map(
        session, task, request.action, request.policy_snapshot or {}, version)
    if not assignments:
        if materialize:
            assignments = {a.user_id: a for a in await approval_routing.ensure_assignments(session, task, request)}
        else:
            assignments = dict.fromkeys(candidates)
    votes = set(await session.scalars(select(am.ApprovalDecision.user_id).where(
        am.ApprovalDecision.request_id == request.id)))
    if from_id not in assignments or from_id in votes or from_id in excluded:
        raise HTTPException(409, "原处理人已变化或已经投票")
    scope = await rbac.scope_org_ids(session, user)
    task_org = await approval_routing._task_org_id(session, task)
    others = set(assignments) - {from_id} - votes - excluded
    # A disabled account cannot supply a remaining countersignature.
    others = {u.id for u in await approval_routing._active_users(session, others)}
    options = {}
    for uid, candidate in candidates.items():
        target = candidate["user"]
        if (uid == from_id or uid in votes or scope is not None and target.org_id not in scope
                or len(others | votes | {uid}) < request.required_count
                or not await approval_routing._in_scope(session, target, task_org)):
            continue
        options[uid] = target
    return assignments, options


@router.get("/{request_id}/transfer-options")
async def transfer_options(request_id: str, fromUserId: Annotated[str, Query(min_length=1)],
                           user: Admin, session: Session):
    request, task = await _pending(session, user, request_id, lock=False)
    _, options = await _transfer_options(session, user, request, task, fromUserId)
    return {"items": sorted([{"userId": uid, "userName": target.display_name or target.username}
                             for uid, target in options.items()], key=lambda p: (p["userName"], p["userId"]))}


@router.post("/{request_id}/transfer")
async def transfer(request_id: str, body: Transfer, user: Admin, session: Session):
    request, task = await _pending(session, user, request_id, lock=True)
    assignments, options = await _transfer_options(session, user, request, task, body.fromUserId, materialize=True)
    target = options.get(body.toUserId)
    if target is None:
        raise HTTPException(409, "接手人必须符合审批策略、职责分离和会签人数要求")
    source = assignments[body.fromUserId]
    if target.id in assignments:
        await session.delete(source)
    else:
        source.user_id, source.user_name = target.id, target.display_name or target.username
        source.sources = [{"type": "transfer", "label": "审批转交", "id": body.fromUserId}]
    fields = _audit(session, user, request, task, "transfer", body.model_dump())
    task_events.record(session, task.id, "release.approval_transferred", fields, actor=user.display_name or user.username)
    await session.commit()
    return {"ok": True}
