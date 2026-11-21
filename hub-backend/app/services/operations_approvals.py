"""Scoped monitoring projection of the same immutable requests used by delivery gates."""
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.orm import load_only

from .. import automation_models as am, models
from ..deps import has_perm
from ..pagination import Page
from . import approval_routing, release_control


REMIND_AFTER = timedelta(hours=24)


def _pending(visible_client_ids):
    query = select(am.ApprovalRequest).join(
        models.Task, models.Task.id == am.ApprovalRequest.task_id
    ).where(am.ApprovalRequest.status == "pending")
    if visible_client_ids is not None:
        query = query.where(models.Task.owner_client_id.in_(visible_client_ids))
    return query


def can_withdraw(user, request, task):
    return has_perm(user, "release.approve") and (
        user.is_super or user.id in {task.created_by, request.created_by})


def can_transfer(user, request, source):
    return (has_perm(user, "release.approve") and request.action != "review"
            and (user.is_super or user.id == source))


async def counts(session, visible_client_ids):
    rows = _pending(visible_client_ids).with_only_columns(
        am.ApprovalRequest.created_at, am.ApprovalRequest.expires_at).subquery()
    now = datetime.now(timezone.utc)
    overdue = or_(rows.c.expires_at <= now, and_(rows.c.expires_at.is_(None),
                                                 rows.c.created_at <= now - REMIND_AFTER))
    total, overdue_count = (await session.execute(select(
        func.count(), func.count(case((overdue, 1)))).select_from(rows))).one()
    return total, overdue_count


async def _reviewers(session, ids):
    assigned = {}
    decisions = {}
    if ids:
        assignment = am.ApprovalAssignment
        for rid, uid, name, active in await session.execute(
            select(assignment.request_id, assignment.user_id, assignment.user_name, models.User.is_active)
            .outerjoin(models.User, models.User.id == assignment.user_id).where(assignment.request_id.in_(ids))
        ):
            assigned.setdefault(rid, {})[uid] = (name, bool(active))
        decision = am.ApprovalDecision
        for rid, uid in await session.execute(
            select(decision.request_id, decision.user_id).where(decision.request_id.in_(ids))
        ):
            decisions.setdefault(rid, set()).add(uid)
    return assigned, decisions


async def queue(session, user, visible_client_ids, page: Page):
    request, task_model, version_model = am.ApprovalRequest, models.Task, am.ArtifactVersion
    query = _pending(visible_client_ids)
    total = await page.total(session, query)
    query = (query.add_columns(task_model, version_model)
        .outerjoin(version_model, and_(version_model.id == request.artifact_version_id,
                                      version_model.task_id == task_model.id))
        .options(load_only(request.id, request.action, request.created_at, request.expires_at,
                           request.created_by, request.policy_snapshot, request.artifact_version_id, request.environment_id),
                 load_only(task_model.id, task_model.title, task_model.created_by, task_model.owner_user_id,
                           task_model.repo_id, task_model.project_id, task_model.assignee_user_id, task_model.requester_user_id),
                 load_only(version_model.id, version_model.seq, version_model.created_by_kind, version_model.created_by_id))
        .order_by(request.created_at, request.id))
    rows = (await session.execute(page.window(query))).all()
    manage = has_perm(user, "release.approve")
    show_details = manage or has_perm(user, "task.view")
    assigned, decisions = await _reviewers(session, [req.id for req, _, _ in rows] if show_details else [])
    now = int(datetime.now(timezone.utc).timestamp() * 1000)
    items = []
    for req, task, version in rows:
        due = release_control._ms(req.expires_at or req.created_at + REMIND_AFTER)
        snapshot = assigned.get(req.id, {})
        if show_details and (not snapshot or req.action == "review" and set(snapshot) != {task.created_by}):
            # Preview the same assignment repair used when a legacy request is opened or voted on.
            candidates, _ = await approval_routing._candidate_map(
                session, task, req.action, req.policy_snapshot or {}, version)
            snapshot = {uid: (c["user"].display_name or c["user"].username, True) for uid, c in candidates.items()}
        elif (req.policy_snapshot or {}).get("separationOfDuties") and req.action != "review" and snapshot:
            excluded = await approval_routing._implementer_ids(session, task, version)
            snapshot = {uid: value for uid, value in snapshot.items() if uid not in excluded}
        people = [{"userId": uid, "userName": name, "inactive": not active,
                   "canTransfer": bool(version and can_transfer(user, req, uid))}
                  for uid, (name, active) in sorted(snapshot.items())
                  if uid not in decisions.get(req.id, ())]
        items.append({"id": req.id, "action": req.action, "createdAt": release_control._ms(req.created_at),
            "dueAt": due, "overdue": now >= due, "canViewDetails": show_details,
            "taskId": task.id if show_details else "", "taskTitle": task.title if show_details else "",
            "artifactVersionId": req.artifact_version_id if show_details else "",
            "artifactLabel": f"v{version.seq}" if show_details and version else "",
            "environmentId": req.environment_id if show_details else "",
            "assignees": people,
            "canDecide": bool(manage and version and any(p["userId"] == user.id and not p["inactive"] for p in people)),
            "canWithdraw": can_withdraw(user, req, task),
            "canTransfer": any(p["canTransfer"] for p in people)})
    return {"total": total, "items": items}
