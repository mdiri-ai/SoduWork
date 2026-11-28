"""One dispatch pipeline for device and administrator entry points.

Routes authorize their caller before entering this service. ``client`` is always
the task owner whose model, credentials and workspace are used; ``actor`` is the
separately authorized operator recorded in audit and workflow receipts.
"""
import logging
from types import SimpleNamespace

from fastapi import HTTPException
from sqlalchemy import select

from ..automation_models import ExecutionSession
from ..models import Task
from ..schemas import task_to_api
from . import audit, task_access, task_requirements
from . import tasks as svc
from .task_dispatch_context import (
    _attach_dev_flow,
    _attach_skills,
    _ext_project_id,
    _link_task_repo,
    _push_task,
    _remote_execution_context,
    _repo_ctx,
    _resolve_repo,
    _settle_work_dir,
    _stale_runner_hint,
)

log = logging.getLogger("uvicorn.error")


async def _active_workflow(session, tid):
    from ..automation_models import WorkflowRun
    from .workflow_runs import _ACTIVE_RUN_STATES
    return (await session.execute(select(WorkflowRun).where(
        WorkflowRun.task_id == tid, WorkflowRun.state.in_(tuple(_ACTIVE_RUN_STATES)),
    ).order_by(WorkflowRun.created_at.desc()).limit(1))).scalar_one_or_none()


async def dispatch(tid, body, client, session, *, actor=None, handoff_claim=None):
    import asyncio as _aio

    from ..services import (
        ai_exec,
        client_access,
        conversation_handoffs,
        dispatch_attempts,
        dispatch_identity,
        managed_work_route,
    )
    from ..services import task_events as ev
    from ..services.conversation_turns import ensure_available, execution_instruction
    confirmed_inputs = "inputManifest" in body
    confirmed_files = confirmed_sources = confirmation_error = None
    if confirmed_inputs:
        from sqlalchemy.ext.asyncio import AsyncSession
        # Freeze bytes outside the task write transaction. Recheck the selected
        # storage references under the admission lock before recording intent.
        selected = None
        async with AsyncSession(session.bind) as preview:
            candidate = await preview.get(Task, tid)
            if candidate is None or not task_access.is_owner(candidate, client):
                raise HTTPException(404, "需求不存在")
            if not managed_work_route.direct_requested(body):
                raise HTTPException(409, "附件清单仅用于直接派发，请按当前执行方式重新预览")
            try:
                ensure_available(candidate, body.get("conversationTurn"), "dispatch")
                await client_access.assert_quota(preview, str(candidate.assignee_user_id or client.user_ref or ""))
            except client_access.ClientAccessError as error:
                raise HTTPException(error.status, error.detail()) from error
            except ValueError as error:
                raise HTTPException(409, str(error)) from error
            if await dispatch_attempts.existing(preview, tid, candidate.status) is None:
                selected = await ai_exec.snapshot_task_file_selection(preview, tid)
        if selected is not None:
            try:
                files, manifest, confirmed_sources = await ai_exec.prepare_confirmed_task_files(selected, body["inputManifest"])
                confirmed_files = (files, manifest)
            except ai_exec.TaskAttachmentError as error:
                confirmation_error = str(error)
    await task_access.reserve_task_write(session, tid, client.id)
    t = await session.get(Task, tid, with_for_update=True, populate_existing=True)
    if t is None or not task_access.is_owner(t, client):
        raise HTTPException(status_code=404, detail="需求不存在")
    try:
        await client_access.assert_quota(session, str(t.assignee_user_id or client.user_ref or ""))
    except client_access.ClientAccessError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail()) from exc
    handoff, body = await conversation_handoffs.dispatch_body(session, client, t, body, handoff_claim=handoff_claim)
    explicit_direct = managed_work_route.direct_requested(body)
    if confirmed_inputs and (handoff or not explicit_direct):
        raise HTTPException(409, "附件清单仅用于直接派发，请按当前执行方式重新预览")
    if handoff and actor is not None:
        raise HTTPException(409, "云端交接需由会话本人在原会话中确认，不能从管理端重新派发")
    try:
        ensure_available(t, body.get("conversationTurn"), "dispatch")
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    from .dispatch_instructions import confirmed_turn
    instruction_scope = confirmed_turn(t, body.get("conversationTurn"))
    if t.status == "done":
        raise HTTPException(status_code=400, detail="需求已完成，不用再交给 AI")
    if t.status == "cancel":
        raise HTTPException(409, "需求已关闭，请先恢复需求，再安排执行")
    submission_mode = str(body.get("submissionMode") or body.get("executionSubmissionMode") or "").strip().lower()
    if submission_mode or "executionSubmissionMode" not in (t.work_routing or {}):
        from .conversation_turns import default_submission_mode, normalize_submission_mode
        routing = dict(t.work_routing or {})
        routing["executionSubmissionMode"] = normalize_submission_mode(
            submission_mode, fallback=default_submission_mode(t))
        t.work_routing = routing
    # Runtime ownership must not depend on today's project/default-plugin settings.
    # A settings change or an explicit direct choice cannot create a second executor.
    running = await _active_workflow(session, tid)
    if running is not None:
        if confirmed_inputs:
            raise HTTPException(409, "这项需求已有运行中的工作流，请核对当前执行")
        return {"ok": True, "identifier": running.id, "runId": running.id,
                "provider": "plugin", "reused": True, "assigneeName": "进行中的工作流",
                "task": await svc.task_to_api_live(session, t)}
    from .conversation_turns import _workflow_starting
    if await _workflow_starting(session, tid):
        raise HTTPException(409, "这项需求正在启动工作流，请等待当前执行确认")
    active_dispatch = await dispatch_attempts.existing(session, tid, t.status)
    if active_dispatch is not None:
        return {**active_dispatch, "task": await svc.task_to_api_live(session, t)}
    conversation_brief = execution_instruction(body.get("brief"), body.get("conversationTurn"))
    aid = str(body.get("assigneeId") or "").strip()
    atype = str(body.get("assigneeType") or "").strip().lower()
    if atype not in ("agent", "squad"):
        atype = ""
    me = actor if actor is not None else await task_requirements.identity(session, client)
    who = (me.display_name or me.username) if me else "承办人"
    # Personal-plugin requests carry identity and parameters only; the owner's device resolves the body.
    personal_plugin = None
    if isinstance(body.get("personalPlugin"), dict) and str(
            (body.get("personalPlugin") or {}).get("key") or "").strip():
        from ..services import schedules as sch_service
        try:
            raw_plugin = body["personalPlugin"]
            personal_plugin = sch_service.personal_plugin_spec(SimpleNamespace(
                personal_plugin_key=raw_plugin.get("key"),
                personal_plugin_version_policy=raw_plugin.get("versionPolicy"),
                personal_plugin_version=raw_plugin.get("version"),
                personal_plugin_checksum=raw_plugin.get("checksum"),
            ))
            personal_plugin["inputs"] = sch_service.clean_plugin_inputs(
                raw_plugin.get("inputs"))
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
    # Project work must enter the approved project workflow. This is the final
    # server-side guard for old clients and pages that forgot to send a binding.
    if managed_work_route.is_managed(t) and not explicit_direct:
        if personal_plugin:
            raise HTTPException(
                status_code=409,
                detail="\u9879\u76ee需求\u5fc5\u987b\u8d70\u5df2\u5ba1\u6279\u7684\u9879\u76ee\u5de5\u4f5c\u6d41\uff0c\u4e0d\u80fd\u4e34\u65f6\u5207\u6362\u4e2a\u4eba\u63d2\u4ef6")
        repo_body = body.get("repo") if isinstance(body.get("repo"), dict) else {}
        repo_id = str(body.get("repoId") or repo_body.get("id") or t.repo_id or "")
        execution = managed_work_route.execution_from_assignee(
            aid, str(body.get("model") or ""))
        try:
            routed = await managed_work_route.start(
                session, t, binding_id=str(body.get("bindingId") or ""),
                execution=execution, repo_id=repo_id,
                instruction=str(body.get("brief") or ""),
                actor_id=str(me.id) if me else "", actor_name=who)
        except managed_work_route.ManagedWorkflowError as route_error:
            raise HTTPException(
                status_code=409,
                detail="\u9879\u76ee\u5de5\u4f5c\u6d41\u6ca1\u6709\u542f\u52a8\uff1a" + str(route_error)) from route_error
        except Exception as route_error:  # noqa: BLE001 - fail closed
            log.exception("\u9879\u76ee\u5de5\u4f5c\u6d41\u542f\u52a8\u5931\u8d25")
            raise HTTPException(
                status_code=502,
                detail="\u9879\u76ee\u5de5\u4f5c\u6d41\u542f\u52a8\u5931\u8d25\uff0c需求\u6ca1\u6709\u964d\u7ea7\u4e3a\u666e\u901a AI \u76f4\u6d3e") from route_error
        task_api = await _push_task(session, t, created=False)
        return {**routed, "task": task_api or task_to_api(t)}




    try:
        from ..services import zero_work_route
        routed = None if personal_plugin or explicit_direct else await zero_work_route.try_route(
            session, t, aid=aid, atype=atype, model=str(body.get("model") or ""),
            brief=str(body.get("brief") or ""), actor_id=str(me.id) if me else "",
            actor_name=who)
    except Exception as route_error:  # noqa: BLE001
        log.warning("零活路由异常，退回直派：%s", type(route_error).__name__)
        routed = None
    if routed is not None:
        task_api = await _push_task(session, t, created=False)
        return {**routed, "task": task_api or task_to_api(t)}
    from sqlalchemy import select as _select
    await task_access.reserve_task_write(session, tid, client.id)
    t = (await session.execute(
        _select(Task).where(
            Task.id == tid, task_access.owner_clause(client)
        ).with_for_update().execution_options(populate_existing=True)
    )).scalar_one_or_none()
    if t is None:
        raise HTTPException(status_code=404, detail="需求不存在")
    try:
        ensure_available(t, body.get("conversationTurn"), "dispatch")
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    active_dispatch = await dispatch_attempts.existing(session, tid, t.status)
    if active_dispatch is not None:
        active_dispatch["task"] = await svc.task_to_api_live(session, t)
        return active_dispatch
    if confirmed_inputs:
        if confirmed_files is None:
            raise HTTPException(409, confirmation_error or "需求执行状态已变化，请重新预览后再派发")
        try:
            await ai_exec.verify_task_file_selection(session, tid, confirmed_sources)
        except ai_exec.TaskAttachmentError as error:
            raise HTTPException(409, str(error)) from error
    if explicit_direct:
        from ..services.execution_context import public as public_execution_context
        routing = dict(t.work_routing or {})
        routing["selectedStrategy"] = "direct"
        routing["workflowBindingId"] = ""
        routing["executionContext"] = public_execution_context(body.get("executionContext"))
        t.work_routing = routing
    attempt_id = await dispatch_attempts.start(
        session, tid, who, aid, atype, str(body.get("model") or ""),
        stable_id=conversation_handoffs.dispatch_id(handoff) if handoff else "")
    picked = None

    async def _fail(stage: str, message, status: int = 502,
                    retryable: bool = True, *, model_confirmation=None):
        message = await _stale_runner_hint(session, stage, message, picked)
        detail = await dispatch_attempts.failed(
            session, tid, who, attempt_id, stage, message, aid, picked, retryable)
        fresh = await session.get(Task, tid)
        if (fresh is not None and fresh.status == "doing"
                and await ai_exec.last_dispatch_event(session, tid) is None):
            from ..services import task_status
            if await task_status.mark(
                    session, fresh, "todo", why="首次 AI 安排执行失败"):
                await session.commit()
        if fresh is not None:
            try:
                await _push_task(session, fresh, created=False)
            except Exception as push_error:  # noqa: BLE001 - Push failure must not undo persisted failure facts.
                log.warning("推送派活失败状态失败：%s", type(push_error).__name__)
        if model_confirmation is not None:
            raise model_confirmation
        raise HTTPException(status_code=status, detail={
            "message": detail["error"], "code": "AI_DISPATCH_FAILED",
            "phase": detail["phase"], "phaseName": detail["phaseName"],
            "retryable": detail["retryable"], "attemptId": attempt_id,
        })


    async def _pending(message, receipt: dict):
        """Keep an indeterminate Runner ACK visible without starting a duplicate."""
        pending_pick = dict(picked or {})
        for key in ("runnerId", "runnerBootId", "runnerClientId", "host"):
            value = str((receipt or {}).get(key) or "")
            if value:
                pending_pick[key] = value
        detail = dispatch_attempts.uncertain(
            session, tid, who, attempt_id, message, aid, pending_pick)
        if t.status == "todo":
            from ..services import task_status
            await task_status.mark(session, t, "doing", why="等待 Runner 回执确认")
        from ..services import execution_sessions as _es
        confirmed_ref = await _es.confirm_uncertain_dispatch(
            session, t, detail["expectedRef"],
            str(detail.get("runnerId") or ""))
        state = "confirming"
        if confirmed_ref:
            state = await session.scalar(select(ExecutionSession.state).where(
                ExecutionSession.task_id == tid, ExecutionSession.ref == confirmed_ref))
        final_ref = confirmed_ref or detail["expectedRef"]
        if me:
            await audit.log(
                session, me, "task.ai_dispatch_pending", "task", tid, t.title,
                {"attemptId": attempt_id, "expectedRef": detail["expectedRef"],
                 "runnerId": str(detail.get("runnerId") or "")})
        await session.commit()
        task_api = None
        try:
            task_api = await _push_task(session, t, created=False)
        except Exception as push_error:  # noqa: BLE001 - durable state remains authoritative
            log.warning("推送派活待确认状态失败：%s", type(push_error).__name__)
        out = dict(receipt or {})
        out.update({
            "ok": True, "pending": not bool(confirmed_ref),
            "uncertain": not bool(confirmed_ref),
            "state": state,
            "retryable": False, "attemptId": attempt_id,
            "issueId": final_ref, "expectedRef": detail["expectedRef"],
            "task": task_api or task_to_api(t),
        })
        return out

    try:
        ctx = await ai_exec.load(session, force=True)
    except Exception as error:  # noqa: BLE001
        await _fail("configuration", "读取 Agent 配置失败：" + str(error), 502)
    # Apply the task owner's Git credentials when configured, otherwise retain executor defaults.
    try:
        ctx = await ai_exec.with_task_git(session, ctx, t, lock_to_client=not bool(handoff))
        if handoff:
            ctx = await conversation_handoffs.dispatch_scope(session, client, ctx, handoff)
    except conversation_handoffs.ModelConfirmationRequired as error:
        await _fail("configuration", error.detail, error.status_code, model_confirmation=error)
    except Exception as error:  # noqa: BLE001
        await _fail("configuration", "读取需求归属人的代码账号失败：" + str(error), 502)
    if personal_plugin:
        # Personal-plugin execution must stay on the owner's online Runner.
        # Do not migrate or silently fall back when its device-local plugin library is unavailable.
        ctx = ai_exec.with_client_runner_scope(ctx, client.id)
    # Honor explicit selection first, then project defaults, resolving a real agent on the responsible user's device.
    # Do not pass an empty assignee and silently fall back to the server.
    try:
        if not handoff:
            ctx, aid = await _remote_execution_context(
                session, client, ctx, body, aid, t, personal_plugin)
        if aid:
            picked = await _aio.to_thread(
                ai_exec.resolve_requested_sync, ctx, aid, atype, client.id, "",
                ai_exec.required_capabilities(t))
        else:
            from ..services import task_assignment
            project_defaults = await task_assignment.project_route(session, t.project_id)
            picked = await _aio.to_thread(
                ai_exec.resolve_default_sync, ctx, client.id,
                project_defaults.get("agentKind") or "",
                ai_exec.required_capabilities(t))
    except HTTPException as error:
        await _fail("routing", error.detail, error.status_code)
    except Exception as error:  # noqa: BLE001
        await _fail("routing", "选择执行机失败：" + str(error), 502)
    if picked is None:
        await _fail(
            "routing",
            "当前电脑没有可接这条需求的在线 Agent，请检查底座安装、Runner 状态和能力授权",
            409,
        )
    try:
        from ..services import task_execution_model
        ctx, agent_execution = await task_execution_model.prepare(
            session, client, ctx, picked, str(body.get("model") or ""),
            str(body.get("reasoningEffort") or ""))
    except ValueError as error:
        if (isinstance(error, task_execution_model.ManagedModelUnavailable)
                and handoff and handoff.options.get("managedModelSelection")):
            conflict = conversation_handoffs.ModelConfirmationRequired(
                handoff.options["managedModelSelection"], unavailable=True)
            await _fail("configuration", conflict.detail, conflict.status_code, model_confirmation=conflict)
        await _fail("configuration", str(error), 409, False)
    except Exception as error:  # noqa: BLE001 - never launch with an unrelated model
        await _fail("configuration", "读取执行模型配置失败：" + type(error).__name__, 502)
    if handoff:
        try:
            conversation_handoffs.check_prepared_model(handoff.options, ctx.get("_managedModelSelection"))
        except conversation_handoffs.ModelConfirmationRequired as error:
            await _fail("configuration", error.detail, error.status_code, model_confirmation=error)
    try:
        # Handoffs use their own verified archive or cloud input manifest.
        files, input_manifest = confirmed_files if confirmed_files is not None else ([], [])
        if not handoff and not confirmed_inputs:
            files, input_manifest = await ai_exec.collect_task_files(session, tid)
        extra = await ai_exec.collect_task_context(session, tid)
    except ai_exec.TaskAttachmentError as error:
        await _fail("context", str(error), 409, False)
    except Exception as error:  # noqa: BLE001
        await _fail("context", "整理需求说明和附件失败：" + str(error), 502)
    extra["brief"] = conversation_brief
    extra["dispatchId"] = attempt_id
    if agent_execution:
        extra["agentExecution"] = agent_execution
    if personal_plugin:
        extra["personalPlugin"] = personal_plugin
    routing = dict(getattr(t, "work_routing", None) or {})
    extra["requiredSkills"] = [
        str(x) for x in (routing.get("requiredSkills") or []) if str(x)]

    # Use the execution device's supplied repository workspace path.
    extra["repo"] = _repo_ctx(body)
    try:
        _repo = await _resolve_repo(session, extra["repo"])
        # Use the configured work root, cloning project code when needed and isolating temporary tasks beneath temp.
        _remote = str((picked or {}).get("id") or "").startswith(ai_exec.REMOTE_PREFIX)
        _wd = await _settle_work_dir(session, client, _repo, extra["repo"], tid, remote=_remote)
    except HTTPException as error:
        await _fail("workspace", error.detail, error.status_code, error.status_code >= 500)
    except Exception as error:  # noqa: BLE001
        await _fail("workspace", "准备工作目录失败：" + str(error), 502)
    if not _wd.get("ok"):
        await _fail("workspace", _wd.get("detail") or "工作目录没准备好", 409)
    extra["workDir"] = _wd.get("dir", "")
    extra["workRoot"] = _wd.get("workRoot", "")
    # Fill missing project association so code-delivery checks can resolve the repository.
    try:
        newly_linked = _repo is not None and not t.repo_id
        _link_task_repo(t, _repo)
        if newly_linked and not handoff:
            # The credential lookup before routing could not yet bind this repository.
            ctx = await ai_exec.with_task_git(session, ctx, t, lock_to_client=False)
        await _attach_dev_flow(session, extra["repo"], _repo)   # Merge global development-flow defaults with repository overrides.
        await _attach_skills(session, extra, extra["repo"], client)   # Resolve selected skills against their availability policy.
        # Use the provider's project association when the task project has an explicit binding.
        extra["extProjectId"] = await _ext_project_id(session, t)
        extra = await ai_exec.with_project_context(session, extra, t, _repo)
    except Exception as error:  # noqa: BLE001
        await _fail("workflow", "加载工程流程和能力失败：" + str(error), 502)
    try:
        if handoff:
            files, extra = await conversation_handoffs.dispatch_inputs(session, handoff, extra)
        if _remote and not handoff:
            await task_access.reserve_task_write(session, tid, client.id)
            if not await dispatch_attempts.pin_runner_route(session, tid, attempt_id, picked):
                raise HTTPException(409, "派活请求已被更新，请刷新需求状态")
        # Content reads can retain the personal Runner policy lock in this
        # transaction. Release preparation locks before transport authorization
        # acquires its own lock; the durable attempt above still fences retries.
        # The transport rechecks current ownership and policy before sending.
        await session.commit()
    except HTTPException:
        raise
    except Exception as error:  # noqa: BLE001
        await session.rollback()
        await _fail("dispatch", "准备派活失败：" + str(error), 502)
    try:
        r = await _aio.to_thread(ai_exec.dispatch_sync, ctx, t, files, picked, extra)
    except Exception as error:  # An adapter can fail after the Runner accepted the request.
        if not picked.get("dispatchIntentAt"):
            if isinstance(error, HTTPException):
                raise
            await _fail("dispatch", "Runner 启动 Agent 失败：" + str(error), 502)
        r = {"ok": False, "uncertain": True, "code": "RUNNER_ACK_UNKNOWN",
             "error": "执行机回执处理异常：" + type(error).__name__}
    confirmed_event = None
    if picked.get("dispatchIntentAt"):
        # A read-only probe or heartbeat can confirm this attempt while the HTTP
        # caller waits for the original RPC. Serialize its reply with the sweep.
        from . import dispatch_reconcile
        await task_access.reserve_task_write(session, tid, client.id)
        t = await session.get(Task, tid, with_for_update=True, populate_existing=True)
        latest = await dispatch_reconcile._latest_state(session, tid)
        fact = dict(latest.detail or {}) if latest else {}
        expected = dispatch_identity.execution_ref(attempt_id)
        if latest and latest.kind in ai_exec.KINDS_DISPATCHED and fact.get("ref") == expected:
            confirmed_event = latest
        if confirmed_event and not r.get("ok"):
            row = await session.scalar(select(ExecutionSession).where(
                ExecutionSession.task_id == tid, ExecutionSession.ref == expected))
            if row:
                meta = row.metadata_ or {}
                return {**(r if r.get("ok") else {}), "ok": True, "uncertain": False, "pending": False,
                        "attemptId": attempt_id, "issueId": expected, "state": row.state, "queued": row.state == "queued",
                        "queuePosition": meta.get("queuePosition", 0), "queueClass": meta.get("queueClass", ""),
                        "runnerId": row.runner_id, "provider": "runner", "task": await svc.task_to_api_live(session, t)}
        if fact.get("attemptId") and fact["attemptId"] != attempt_id:
            raise HTTPException(409, "派活请求已被更新，请刷新需求状态")
        if fact.get("lastRunnerReplyAt"):
            picked["lastRunnerReplyAt"] = fact["lastRunnerReplyAt"]
    if not r.get("ok"):
        if r.get("uncertain"):
            return await _pending(r.get("error") or "执行机回执暂未确认", r)
        await _fail("dispatch", r.get("error") or "Runner 没有接受这条需求", 502)
    # Mark dispatched work as in progress so scheduled tasks reflect the execution state.
    if t.status == "todo":
        from ..services import task_status
        await task_status.mark(session, t, "doing", why="直派 AI")
    # Record who dispatched to which agent, its runtime, and the supplied context.
    # This supports later diagnosis of incorrect or incomplete outputs.
    _prog = [p for p in (getattr(t, "progress", None) or [])
             if isinstance(p, dict) and (p.get("text") or "").strip()]
    dispatch_detail = {**dispatch_attempts.success_detail(attempt_id, aid, picked),
                **({"conversationTurn": instruction_scope} if instruction_scope else {}),
                "ref": r.get("issueId", ""), "issueId": r.get("issueId", ""),
                "identifier": r.get("identifier", ""),
                "url": r.get("url", ""), "by": who, "provider": r.get("provider", ""),
                "runnerId": r.get("runnerId", ""), "host": r.get("host", ""),
                "assigneeId": r.get("assigneeId", "") or aid,
                "assigneeType": r.get("assigneeType", "agent"),
               "assigneeName": r.get("assigneeName", ""), "assigneeCli": r.get("assigneeCli", ""),
               "files": r.get("files", 0),
               "pluginSnapshot": dict(r.get("pluginSnapshot") or {}),
               "carried": {"note": bool((t.note or "").strip()),
                           "tags": len(getattr(t, "tags", None) or []),
                           "progress": len(_prog), "comments": len(extra.get("comments") or []),
                           "files": [f[0] for f in files][:r.get("files", 0)],
                           **({"inputManifest": input_manifest} if input_manifest or confirmed_inputs else {}),
                           "brief": "" if handoff and handoff.options.get("contentRef") else extra["brief"].strip()[:300]}}
    if confirmed_event is None:
        ev.record(session, tid, ai_exec.EV_DISPATCHED, dispatch_detail, actor=who)
    else:
        confirmed_event.detail = {**confirmed_event.detail, **dispatch_detail}
    from ..services import execution_sessions as _es
    row = await _es.record_dispatch(session, t, r)
    if row is not None and confirmed_event is not None:
        meta = row.metadata_ or {}
        r.update(state=row.state, queued=row.state == "queued",
                 queuePosition=meta.get("queuePosition", 0), queueClass=meta.get("queueClass", ""))
    await audit.log(session, me, "task.ai_dispatch", "task", tid, t.title,
                    {"identifier": r.get("identifier", "")}) if me else None
    await session.commit()
    # Send throttled upgrade guidance after successful dispatch to an outdated Runner.
    try:
        from ..services import update_nudges
        version = str(r.get("runnerVersion") or "")
        if not version and r.get("runnerId"):
            from ..automation_models import RunnerNode
            node = await session.get(RunnerNode, str(r.get("runnerId")))
            version = str(getattr(node, "version", "") or "")
        await update_nudges.nudge_stale_runner(
            str(t.owner_client_id or ""), version, str(r.get("host") or ""))
    except Exception as nudge_error:  # noqa: BLE001
        log.warning("执行机升级提醒失败：%s", type(nudge_error).__name__)
    # Push the final server task snapshot immediately after dispatch.
    # Clients should not wait for a full refresh to display progress.
    task_api = await _push_task(session, t, created=False)
    out = dict(r)
    out["task"] = task_api or task_to_api(t)
    return out
