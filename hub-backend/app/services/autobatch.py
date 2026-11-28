"""Public module behavior and service contracts."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from .. import models
from ..config import get_settings
from . import ai_exec, ai_prompts, repository_catalog, task_requirements

log = logging.getLogger("uvicorn.error")

_MAX_PER_BATCH = 20
_KINDS_DISPATCHED = ("ai.dispatched", "multica.dispatched")
_REPO_BUSY_REASON = "这个工程上还有没干完的批次（同工程不许并行）"


def _cfg() -> tuple[bool, int, int]:
    s = get_settings()
    return (bool(getattr(s, "autobatch_enabled", False)),
            max(2, int(getattr(s, "autobatch_min", 3))),
            max(1, int(getattr(s, "autobatch_wait_min", 30))))


async def pick_assignee(session: AsyncSession, client_id: str = "") -> tuple[dict | None, str]:
    """Choose an online Agent on the source account's current device."""
    import asyncio as _aio

    from . import ai_exec
    ctx = ai_exec.with_client_runner_scope(await ai_exec.load(session, force=True), client_id)
    want = str(getattr(get_settings(), "autobatch_assignee", "") or "").strip()
    if want:
        hit = await _aio.to_thread(ai_exec.resolve_requested_sync, ctx, want, "agent", client_id)
        if hit is None:
            return None, f"负责人的设备上找不到配置指定的执行器 {want}"
        return hit, "按配置指定"
    roster = await _aio.to_thread(ai_exec.list_assignees_sync, ctx)
    agents = [agent for agent in roster.get("agents", [])
              if agent.get("online") and agent.get("clientId") == client_id]
    if not agents:
        return None, "负责人的设备上没有可用的在线 Agent"
    idle = next((agent for agent in agents if not agent.get("busy")), None)
    return idle or agents[0], "优先使用负责人的空闲 Agent" if idle else "负责人的 Agent 正忙，按顺序派发"


async def _dispatched_ids(session: AsyncSession) -> set[str]:
    """Exclude previously AI-dispatched tasks, including historical multica.* events, and tasks
    already assigned to a batch.
    """
    event = models.TaskEvent
    failure = aliased(event)
    released = select(failure.id).where(
        failure.task_id == event.detail["batchId"].as_string(),
        failure.kind == ai_exec.EV_DISPATCH_FAILED,
        failure.detail["confirmedNotStarted"].as_boolean().is_(True),
        failure.detail["attemptId"].as_string() == failure.task_id,
    ).exists()
    rows = (await session.scalars(select(event.task_id).where(
        event.kind.in_(_KINDS_DISPATCHED) | ((event.kind == "ai.batched") & ~released)
    ))).all()
    return set(rows)


async def _busy_repos(session: AsyncSession) -> set[str]:
    """Prefer an unfinished batch's execution repository, with a fallback for older batches."""
    source = aliased(models.Task)
    repositories = await session.execute(select(models.Task.repo_id, source.repo_id).select_from(models.Task)
        .join(models.Milestone, models.Milestone.task_id == models.Task.id)
        .outerjoin(source, source.id == models.Milestone.src_task_id)
        .where(models.Task.status.in_(("todo", "doing")), models.Task.origin == "local",
               models.Milestone.src_task_id != "")
        .distinct())
    busy = set()
    for batch_repo, source_repo in repositories:
        repo_id = (batch_repo or "").strip() or (source_repo or "").strip()
        if repo_id:
            busy.add(repo_id)
    return busy


async def group(session: AsyncSession) -> list[dict]:
    """Read-only grouping of pending external bugs by owner and repository, including dispatch
    eligibility.
    """
    enabled, min_n, wait_min = _cfg()
    skip = await _dispatched_ids(session)
    busy = await _busy_repos(session)
    rows = (await session.execute(
        select(models.Task).join(models.Client, models.Client.id == models.Task.owner_client_id)
        .where(models.Task.status == "todo", models.Task.integration_id.is_not(None),
               models.Task.owner_user_id.is_not_distinct_from(models.Client.user_ref))
        .order_by(models.Task.created_at))).scalars().all()
    now = datetime.now(timezone.utc)
    buckets: dict[tuple[str, str], dict] = {}
    for t in rows:
        rid = (getattr(t, "repo_id", "") or "").strip()
        try:
            task_requirements.ensure_executable(t)
        except ValueError:
            continue
        if t.id in skip:
            continue
        if not rid:
            continue                      # Require a mapped repository before dispatch.
        key = (t.owner_client_id or "", rid)
        g = buckets.setdefault(key, {
            "ownerClientId": key[0], "repoId": key[1], "projectId": t.project_id,
            "taskIds": [], "titles": [], "extRepo": getattr(t, "ext_repo", "") or "",
            "oldestAgeMin": 0, "ready": False, "reason": "",
        })
        if len(g["taskIds"]) >= _MAX_PER_BATCH:
            continue
        g["taskIds"].append(t.id)
        g["titles"].append(t.title)
        created = t.created_at or now
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        g["oldestAgeMin"] = max(g["oldestAgeMin"], int((now - created) / timedelta(minutes=1)))
    # Check whether an AI workspace is configured for automatic dispatch.
    rids = {g["repoId"] for g in buckets.values()}
    repos = {r.id: r for r in (await session.execute(
        select(models.Repo).where(models.Repo.id.in_(rids)))).scalars().all()} if rids else {}
    out = []
    for g in buckets.values():
        n = len(g["taskIds"])
        repo = repos.get(g["repoId"])
        g["repoName"] = (repo.name if repo else "")
        g["aiWorkDir"] = (getattr(repo, "ai_work_dir", "") or "") if repo else ""
        g["flowBindingId"] = (await _flow_binding(session, g)) if repo is not None else ""
        if repo is None:
            g["reason"] = "映射指向的工程已经不在了"
        elif not g["flowBindingId"] and not g["aiWorkDir"].strip():
            # A plugin workflow can resolve its own executor; reject only when neither execution path is available.
            g["reason"] = (f"工程「{repo.name or repo.id}」既没绑交付流程插件、"
                           "也没配 AI 干活目录（ai_work_dir），不能自动派")
        elif g["repoId"] in busy:
            g["reason"] = _REPO_BUSY_REASON
        elif n >= min_n:
            g["ready"], g["reason"] = True, f"攒够 {n} 条（阈值 {min_n}）"
        elif n >= 2 and g["oldestAgeMin"] >= wait_min:
            g["ready"], g["reason"] = True, f"最早一条等了 {g['oldestAgeMin']} 分钟（阈值 {wait_min}）"
        elif n < 2:
            g["reason"] = "只有 1 条，谈不上合并处理——等下一条，或者人自己派"
        else:
            g["reason"] = (f"{n} 条，还没到 {min_n} 条；最早一条等了 "
                           f"{g['oldestAgeMin']}/{wait_min} 分钟")
        out.append(g)
    out.sort(key=lambda x: (not x["ready"], -len(x["taskIds"])))
    if not enabled:
        for g in out:
            if g["ready"]:
                g["reason"] += "（总开关没开，只是预览：AUTOBATCH_ENABLED=true 才真派）"
    return out


async def _flow_binding(session: AsyncSession, g: dict) -> str:
    """Find the configured delivery plugin binding through available_bindings, respecting
    organization/project scope and approved versions. Match the plugin key, not its display
    name.
    """
    key = str(getattr(get_settings(), "autobatch_plugin_key", "") or "").strip()
    if not key:
        return ""
    from types import SimpleNamespace

    from .. import automation_models as am
    from . import plugin_service
    pl = (await session.execute(select(am.Plugin).where(
        am.Plugin.key == key))).scalars().first()
    if pl is None or not pl.enabled:
        return ""
    stand_in = SimpleNamespace(id="", project_id=(g.get("projectId") or None),
                               owner_client_id=g.get("ownerClientId") or "",
                               repo_id=g.get("repoId") or None)
    items = await plugin_service.available_bindings(session, stand_in)
    hit = next((x for x in items if x.get("pluginId") == pl.id), None)
    return str(hit.get("bindingId") or "") if hit else ""


async def _dispatch_flow(session: AsyncSession, g: dict, client, repo) -> dict:
    """Start a delivery-plugin batch with quality, review, merge authorization, and release gates.
    Preserve one source-task milestone per bug; task_status propagates completed batch state to
    members.
    """
    from fastapi import HTTPException

    from .. import automation_models as am
    from ..realtime import hub
    from . import batch_dispatch, workflow_runs
    from . import task_events as ev

    binding = await session.get(am.PluginBinding, g["flowBindingId"])
    if binding is None or not binding.enabled:
        return {**g, "dispatched": False, "error": "交付流程绑定不在了（可能刚被停用）"}
    try:
        rows = await batch_dispatch.lock_members(session, g["taskIds"], client)
        await batch_dispatch.require_unassigned(session, g["taskIds"])
        for task in rows:
            task_requirements.ensure_executable(task)
            if task.status != "todo" or task.repo_id != repo.id:
                raise ValueError("源任务状态或工程已变更，这轮先不派")
    except (ValueError, HTTPException) as error:
        await session.rollback()
        return {**g, "dispatched": False, "error": str(error)}
    if len(rows) < 2:
        return {**g, "dispatched": False, "error": "源任务状态刚变了（不足两条待办），这轮先不派"}
    # Include every source task's title and description, matching batch_dispatch.
    # Use plain-text emphasis because the detail panel does not render Markdown.
    parts = ["本批合并自测试平台推来的 %d 条 bug，请「一条一条修、每条单独提交」：" % len(rows)]
    for i, t in enumerate(rows, 1):
        parts.append(f"\n{i}. {t.title}")
        d = (t.note or "").strip()
        if d:
            parts.append("   " + d[:800].replace("\n", "\n   "))
        if getattr(t, "external_url", None):
            parts.append("   原文：" + str(t.external_url))
    batch = models.Task(
        id=str(uuid.uuid4()),
        owner_client_id=client.id, owner_user_id=client.user_ref, status="todo",
        title=f"合并修复 {len(rows)} 条 bug · {repo.name or '同一工程'}",
        note="\n".join(parts)[:8000])
    batch.project_id = repo.project_id
    batch.repo_id = repo.id
    session.add(batch)
    for i, t in enumerate(rows):
        session.add(models.Milestone(task_id=batch.id, seq=i, title=t.title[:300],
                                     accept=(t.note or "").strip()[:2000], src_task_id=t.id))
    for t in rows:
        ev.record(session, t.id, "ai.batched", {"batchId": batch.id}, actor="SoduWork")
    ev.record(session, batch.id, "plugin.autobatch",
              {"count": len(rows), "sourceTaskIds": [t.id for t in rows],
               "flowBindingId": binding.id}, actor="SoduWork")
    instruction = ("这一批是测试平台推过来的 bug 合并修复。要求：只修清单里列出的问题，"
                   "一条一条修、每条单独提交，提交信息里带上对应的 bug 序号或标题；"
                   "不要顺手重构或改动无关代码。")
    try:
        run = await workflow_runs.start_new_task(session, batch, binding, {},
                                               actor_id="autobatch",
                                               instruction=instruction, repo_id=repo.id)
    except ValueError as e:
        # Roll back the batch shell, milestones, and deduplication markers together if startup fails.
        await session.rollback()
        return {**g, "dispatched": False, "error": f"起交付流程失败：{e}"[:200]}
    try:
        from .task_access import publish_owner
        await publish_owner(session, batch, {
            "type": "notice", "taskId": batch.id,
            "text": f"⚙ 攒了 {len(rows)} 条「{repo.name}」的 bug，已自动起修复流程；"
                    "AI 分析完会请你确认修复范围（基线）"})
    except Exception as e:  # noqa: BLE001 - Push failure must not invalidate an already-started workflow.
        log.warning("归堆起流程后的提醒推送失败：%s", type(e).__name__)
    log.info("自动归堆起交付流程：%s 条 → 任务 %s run %s", len(rows), batch.id, run.id)
    return {**g, "dispatched": True, "batchId": batch.id, "runId": run.id, "flow": True}


async def run_once(session: AsyncSession, dry: bool | None = None) -> dict:
    """Dispatch each eligible group once. With dry=None, a disabled global switch selects preview
    mode.
    """
    enabled, min_n, wait_min = _cfg()
    if dry is None:
        dry = not enabled
    groups = await group(session)
    ready = [g for g in groups if g["ready"]]
    done = []
    for g in ready:
        if dry:
            done.append({**g, "dispatched": False, "dry": True})
            continue
        try:
            done.append(await _dispatch_ready_group(session, g))
        except Exception as e:  # noqa: BLE001 - A failed group must not prevent dispatching other groups.
            done.append({**g, "dispatched": False, "error": f"{type(e).__name__}: {e}"[:200]})
            log.warning("自动合并派活失败：%s", e)
        finally:
            # Dispatch commits its own admissions. Release locks on early returns
            # and after post-commit reads before proceeding to another group.
            await session.rollback()
    return {"enabled": enabled, "dry": dry, "min": min_n, "waitMin": wait_min,
            "groups": len(groups), "ready": len(ready), "results": done, "all": groups}


async def _dispatch_ready_group(session: AsyncSession, g: dict) -> dict:
    client = await session.get(models.Client, g["ownerClientId"])
    # The preview is a snapshot. Serialize admissions and check the latest
    # state before starting execution, including across concurrent sweeps.
    repo = await repository_catalog.lock_deployment_repository(session, g["repoId"])
    if client is None or repo is None:
        return {**g, "dispatched": False, "error": "负责人或工程不在了"}
    if repo.id in await _busy_repos(session):
        return {**g, "dispatched": False, "error": _REPO_BUSY_REASON}
    # Use a bound delivery plugin when available; otherwise use direct batch dispatch.
    if g.get("flowBindingId"):
        return await _dispatch_flow(session, g, client, repo)
    picked, why = await pick_assignee(session, str(g.get("ownerClientId") or ""))
    if picked is None:
        return {**g, "dispatched": False, "error": why}
    # Prefer the owner's configured workspace, falling back to repository ai_work_dir when absent.
    from . import workdirs
    work_dir, _why = workdirs.auto_dir(client, repo)
    if not work_dir:
        return {**g, "dispatched": False,
                "error": "没有可用的干活目录（负责人那台 SoduWork 没设工作目录，工程也没配）"}
    # Reuse the manual dispatch implementation for instructions, milestones, and events.
    # Match api.tasks._repo_ctx fields: path, branch, and flow.
    # An empty path would omit the execution directory from the instructions.
    from ..api import tasks as tasks_api
    body = {
        "taskIds": g["taskIds"],
        "title": f"合并处理 {len(g['taskIds'])} 条 bug · {repo.name or '同一工程'}",
        "repo": {"id": repo.id, "path": work_dir, "name": repo.name, "kind": repo.kind,
                 "gitUrl": repo.git_url, "branch": repo.default_branch,
                 "note": repo.note, "flow": True,   # flow enables branch creation, implementation, verification, commit, and push.
                 # Unattended mode overrides screenshot settings to disable GUI capture.
                 # GUI capture can hang without an operator to recover it.
                 "unattended": True},
        # Include the explicit unattended-execution instructions.
        # This prevents GUI steps from stalling until timeout.
        "brief": ("这一批是测试平台推过来的 bug，按里程碑一条条修，"
                  "每条单独提交，别把几条揉进一个提交里。\n"
                  + ai_prompts.UNATTENDED),
        # Select the executor explicitly.
        # The selected machine must be able to use the supplied workspace path.
        "assigneeId": picked.get("id"), "assigneeType": picked.get("type") or "agent",
    }
    result = await tasks_api.batch_dispatch(body=body, client=client, session=session)
    log.info("自动合并派活：%s 条 → 批次 %s（派给 %s，%s）", len(g["taskIds"]),
             result.get("batchId", ""), picked.get("name"), why)
    return {**g, "dispatched": bool(result.get("ok")), "batchId": result.get("batchId", ""),
            "assignee": picked.get("name") or picked.get("id")}


async def tick_loop() -> None:
    """Run the lifespan background sweep; exit immediately when disabled to avoid idle work and log
    noise.
    """
    import asyncio

    from ..db import SessionLocal
    s = get_settings()
    if not getattr(s, "autobatch_enabled", False):
        log.info("自动合并派活未启用（AUTOBATCH_ENABLED=false）")
        return
    gap = max(60, int(getattr(s, "autobatch_tick_seconds", 300)))
    log.info("自动合并派活已启用：每 %ss 巡检一次，攒够 %s 条或等 %s 分钟就派",
             gap, s.autobatch_min, s.autobatch_wait_min)
    while True:
        try:
            async with SessionLocal() as session:
                out = await run_once(session)
            if out["ready"]:
                log.info("自动合并派活一轮：%s 堆够条件，%s",
                         out["ready"], [r.get("batchId") or r.get("error") for r in out["results"]])
        except asyncio.CancelledError:
            log.info("自动合并派活巡检停止")
            raise
        except Exception as e:  # noqa: BLE001 - Keep the loop alive after an individual sweep fails.
            log.warning("自动合并派活巡检异常：%s", e)
        await asyncio.sleep(gap)
