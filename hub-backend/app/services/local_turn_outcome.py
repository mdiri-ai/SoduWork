"""Native semantic completion: a zero exit must not hide a truncated turn."""
from __future__ import annotations

from . import declared_outputs, model_errors

REASONING_OUTPUT_LIMIT = "模型在本次输出额度内只返回了思考内容，没有给出正文或可执行的工具调用。此前已完成的步骤仍然保留。"
OUTPUT_RECOVERY_NO_PROGRESS = "输出截断后，续跑没有返回新的答复或完成任何工具调用。本轮仍未完成，已有进度已保留。"
ARMONEL_SUMMARY_FAILED = "本轮未能生成可用的上下文摘要，任务已暂停。原会话历史已保留。"
ARMONEL_SUMMARY_TRUNCATED = "Armonel 缩小分段后，摘要仍达到输出上限。原会话和已完成的操作已保留。使用相同配置继续可能再次停在摘要阶段。"
ARMONEL_CONTEXT_CONTRACT = "Armonel 底座的上下文校验未通过，任务已暂停。"
DSH_CONTEXT_COMPACTED = "DeepSeek Harness 已压缩原会话的上下文，本轮请求没有重新执行。可以发送「继续」接续。"
DSH_CONTEXT_COMPACTION_FAILED = "DeepSeek Harness 未能压缩原会话。原历史和工作区已保留，请检查后再继续。"

TRUNCATED = "模型达到单轮输出上限，本轮尚未完成；已有文件与进度已保留，请缩小当前步骤后继续。"
ARMONEL_TOKEN_LIMIT = "本轮达到上下文或 token 预算上限，已有进度保留。请拆分任务后继续。"
ARMONEL_REQUEST_LIMIT = "本轮达到工具调用或模型请求次数上限，已有改动保留。可以继续完成剩余步骤。"
TOOL_APPROVAL_DENIED = "工具调用未获批准，本轮已停止。已完成的改动保留在工作目录。"
TOOL_APPROVAL_TIMEOUT = "工具审批已超时，待审批的操作没有执行。可以继续原会话并重新发起审批。"
RECOVERY_NOTE = "（SoduWork 自动恢复）模型输出被截断，正从同一会话保留进度续跑当前节点；最多自动恢复一次，不跳过审批或验收。"

PUBLIC_INCOMPLETE_REASONS = (TRUNCATED, ARMONEL_TOKEN_LIMIT, ARMONEL_REQUEST_LIMIT,
                             ARMONEL_SUMMARY_FAILED, ARMONEL_SUMMARY_TRUNCATED, ARMONEL_CONTEXT_CONTRACT,
                             REASONING_OUTPUT_LIMIT, OUTPUT_RECOVERY_NO_PROGRESS,
                             DSH_CONTEXT_COMPACTED, DSH_CONTEXT_COMPACTION_FAILED)


def observe(cli: str, event: dict, terminal: dict) -> None:
    if (cli in {"armonel", "codex", "codex-harness", "opencode", "dsh", "kimi", "qwen"}
            and event.get("type") == "turn_stopped" and event.get("reason") == "cancelled"):
        terminal["nativeCancelled"] = True
        return
    if cli in {"armonel", "dsh"} and event.get("type") == "turn_stopped":
        reason = event.get("reason")
        if reason == "reasoning_output_limit":
            terminal["reasoningOutputLimit"] = True
        elif cli == "dsh" and reason == "output_recovery_no_progress":
            # A recovery can end cleanly at the protocol level while the
            # preceding truncated task still has no usable result.
            terminal["outputTruncated"] = True
            terminal["outputRecoveryNoProgress"] = True
        elif cli == "dsh" and reason in {"dsh_context_compacted", "dsh_context_compaction_failed"}:
            terminal["dshContextRecovery"] = reason
        elif cli == "armonel" and reason == "tool_approval_denied":
            terminal["toolApprovalDenied"] = True
        elif cli == "armonel" and reason == "tool_approval_timeout":
            terminal["toolApprovalTimeout"] = True
        elif cli == "armonel" and reason == "max_turn_requests":
            terminal["requestLimitReached"] = True
        elif cli == "armonel" and reason in {"context_summary_failed", "context_summary_truncated"}:
            terminal["contextSummaryFailed"] = reason
        elif cli == "armonel" and reason == "context_contract":
            terminal["contextContractFailed"] = True
        return
    if cli in {"pi", "opencode", "dsh", "kimi", "qwen", "armonel"} and event.get("error"):
        # A protocol/runtime failure after an attempted continuation is stronger
        # evidence than the earlier output limit. _on_line retains its diagnosis.
        terminal.pop("outputTruncated", None)
        terminal.pop("requestLimitReached", None)
        terminal.pop("reasoningOutputLimit", None)
        terminal.pop("outputRecoveryNoProgress", None)
        terminal.pop("contextSummaryFailed", None)
        terminal.pop("contextContractFailed", None)
        terminal.pop("dshContextRecovery", None)
        # A transport error takes ownership from an earlier retryable Pi model
        # error; a later native message must not clear the transport diagnosis.
        if terminal.pop("piSemanticError", False):
            terminal.pop("result", None)
        return
    if (cli in {"opencode", "dsh", "kimi", "qwen", "armonel"} and event.get("type") == "step_finish"
            and not event.get("contextOnly")):
        part = event.get("part")
        reason = part.get("reason") if isinstance(part, dict) else None
        if reason in {"length", "max_tokens"} and not terminal.get("isError"):
            terminal["outputTruncated"] = True
        elif reason == "stop":
            terminal.pop("outputTruncated", None)
            terminal.pop("reasoningOutputLimit", None)
            terminal.pop("outputRecoveryNoProgress", None)
        return
    if cli != "pi" or event.get("type") not in {"message_end", "turn_end", "agent_end"}:
        return
    message = event.get("message")
    if event.get("type") == "agent_end":
        message = next((m for m in reversed(event.get("messages") or [])
                        if isinstance(m, dict) and m.get("role") == "assistant"), None)
    if not isinstance(message, dict) or message.get("role") != "assistant":
        return
    reason = str(message.get("stopReason") or "")
    # Pi can retry a transient model error in the same process. Only clear the
    # error owned by this observer; transport/policy failures must remain fatal.
    if reason in {"stop", "toolUse", "length", "max_tokens"} and terminal.pop("piSemanticError", False):
        terminal.pop("isError", None)
        terminal.pop("result", None)
    if reason in {"length", "max_tokens"} and not terminal.get("isError"):
        terminal["outputTruncated"] = True
    elif reason == "stop":
        terminal.pop("outputTruncated", None)
        # A print-mode Pi process should exit after a final assistant message. Keep a
        # short-lived settlement candidate so the process watchdog can recover if the
        # provider leaves the child alive after emitting the complete answer.
        if event.get("type") == "message_end":
            terminal["piFinalResponse"] = True
    elif reason in {"error", "aborted"}:
        terminal.pop("outputTruncated", None)
        if terminal.get("isError") and not terminal.get("piSemanticError"):
            return
        if not terminal.get("isError"):
            terminal["piSemanticError"] = True
        terminal["isError"] = True
        # Extract a safe model diagnosis before the SDK error envelope is discarded.
        terminal["result"] = (model_errors.public_failure(message.get("errorMessage"))
                              if reason == "error" else "模型调用已中断，已有进度已保留。")


def recovery(run: dict, terminal: dict) -> dict:
    """Only resume an explicit file-workflow contract, never an arbitrary chat."""
    if (run.get("cli") != "pi" or not terminal.get("outputTruncated")
            or run.get("artifactMode") != "files" or run.get("queue")
            or int(run.get("completionRetries") or 0) >= 1):
        return {}
    paths = declared_outputs.paths([
        {"kind": "file", "path": name} for name in run.get("expectedOutputPaths") or []])
    if not paths:
        return {}
    return {"recover": True, "reason": "模型输出截断", "note": RECOVERY_NOTE,
            "prompt": "上一轮达到模型单轮输出上限而中断，并未完成当前节点。"
            "先检查已有文件，从现有进度继续，不重做已完成步骤。"
            "将工作拆成短小步骤，每完成一小段立即调用工具写入或验证，避免一次生成大段内容。"
            "只完成当前节点并核验这些约定产出：" + "、".join(paths)
            + "。仍需遵守原任务全部边界；不执行后续节点，不代替用户审批，"
            "不新增部署、费用或对外发送。无法完成就准确说明阻断，不能声称成功。"}
