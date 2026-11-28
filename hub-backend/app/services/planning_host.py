"""Per-turn access to the owning desktop's private enterprise Planning broker."""
import asyncio
import concurrent.futures
import hashlib
import json
import os
import re

NAMESPACE = "com.allintechinc/planning"
CAPABILITIES = {"version": 1, "model": True, "commit": True}
MAX_BYTES = 512_000
_FIELDS = ("planningHostGrant", "planningOwnerId", "planningExecutionId")
_host = None


def configure(loop, pipe):
    global _host
    _host = (loop, pipe) if loop and pipe else None


def authorized(cfg):
    cfg = cfg or {}
    return all(isinstance(cfg.get(k), str) and re.fullmatch(r"[\w.:-]{1,160}", cfg[k])
               for k in _FIELDS) and not any((cfg.get("llm") or {}).get(k)
                                             for k in ("key", "base"))


def child_environment(env):
    # Python is launched by absolute path with -I. Do not inherit user tokens,
    # proxy/MCP configuration, PATH-based plugins, or the private access channel.
    return {k: v for k, v in env.items() if k.upper() in {
        "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "PLANNING_STATE_DIR"}}


def input_alias(workspace, ref):
    return os.path.join(workspace, ".soduwork-inputs-" + hashlib.sha256(ref.encode()).hexdigest()[:24])


def input_text(root, name):
    path = os.path.join(root, name)
    if (not name or name != os.path.basename(name) or os.path.islink(path)
            or os.path.realpath(path) != os.path.abspath(path) or not os.path.isfile(path)):
        raise ValueError("Planning 附件不存在或已移出会话存档")
    with open(path, "rb") as stream:
        raw = stream.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError("Planning 单个文本附件上限为 512 KB")
    try:
        value = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError("Planning 首版仅支持 UTF-8 文本附件") from exc
    if "\x00" in value:
        raise ValueError("Planning 首版仅支持 UTF-8 文本附件")
    return value


def input_view(workspace, ref, staged):
    """Present archive inputs as read-only paths without copying into a user repository."""
    from .local_base import _store_dir
    root = os.path.join(_store_dir(ref), "inputs")
    alias = input_alias(workspace, ref)
    if staged and os.path.lexists(alias):
        raise ValueError("工作区内已有同名附件视图，请先移开该目录")
    rows = []
    for item in staged:
        name = os.path.basename(item["path"])
        if name.lower().endswith(".xlsx"):
            from . import planning_workbook
            if not planning_workbook.command() or item.get("size", 0) > planning_workbook.MAX_FILE:
                raise ValueError("需要已安装本机 Office Skill 及 2 MB 以内的 .xlsx 工作簿")
        elif not (str(item.get("contentType", "")).startswith("text/")
                or os.path.splitext(name)[1].lower() in {
                    ".txt", ".md", ".csv", ".tsv", ".json", ".jsonl", ".log", ".yaml", ".yml", ".xml"}):
            raise ValueError("Planning 当前支持 UTF-8 文本附件和本机 Office Skill 支持的 .xlsx 文件")
        else:
            input_text(root, name)
        rows.append({**item, "path": os.path.join(alias, name)})
    return rows


def stream_model(params, host, notify):
    """Forward actual provider deltas in order while the original ACP request remains open."""
    scope = {k: params[k] for k in ("sessionId", "executionId", "callId")}
    seq, size = 0, 0
    try:
        start = host("model.start", {**scope, "request": params.get("request")})
        if isinstance(start.get("completion"), dict) and start["completion"].get("choices"):
            return start["completion"]
        if start.get("started") is not True:
            raise ValueError("模型流未能启动")
        while True:
            page = host("model.next", {**scope, "seq": seq})
            chunks, done = page.get("chunks"), page.get("done")
            if not isinstance(chunks, list) or len(chunks) > 16 or type(done) is not bool:
                raise ValueError("模型流片段格式无效")
            for chunk in chunks:
                if not isinstance(chunk, dict) or not isinstance(chunk.get("choices"), list):
                    raise ValueError("模型流未返回有效的 Chat Completion 片段")
                size += len(json.dumps(chunk, ensure_ascii=False).encode())
                if size > 8 * 1024 * 1024 or seq == 65536:
                    raise ValueError("模型流响应超过上限")
                notify({**scope, "seq": seq, "chunk": chunk})
                seq += 1
            if done:
                if not seq:
                    raise ValueError("模型流未返回内容")
                return {"streamed": True, "chunkCount": seq}
    finally:
        # A normal EOF, denial, or a transport failure all release the same
        # upstream request. The desktop also revokes streams on owner loss.
        try:
            host("model.close", scope)
        except (ValueError, RuntimeError, OSError):
            pass


class Turn:
    def __init__(self, ref, cfg, run):
        if (not _host or not authorized(cfg) or run.get("eventDestination") != "local"
                or not cfg.get("accessPolicy")):
            raise ValueError("Planning 需要本机 SoduWork 提供本轮模型与工作区授权")
        self.loop, self.pipe = _host
        self.ref, self.grant = ref, cfg["planningHostGrant"]
        from .local_base import _store_dir
        self.workspace = os.path.realpath(run["ws"])
        self.input_view = {"alias": input_alias(self.workspace, ref),
                           "root": os.path.abspath(os.path.join(_store_dir(ref), "inputs"))}
        from . import planning_workbook
        self.workbook = planning_workbook.command()
        self.model_stream = cfg.get("planningModelStream") is True
        self.active_stream = None
        self.execution_id, self.owner_id = cfg["planningExecutionId"], cfg["planningOwnerId"]

    def call(self, payload, channel):
        params, method = payload.get("params"), payload.get("method")
        if (method not in {"model", "commit", "workbook", "fs.authorize", "model.start", "model.next", "model.close"} or not isinstance(params, dict)
                or params.get("executionId") != self.execution_id or not params.get("sessionId")
                or not isinstance(params.get("callId"), str) or not params["callId"]):
            return {"ok": False, "error": "Planning 调用与本轮授权不匹配"}
        if method.startswith("model."):
            scope = {k: params[k] for k in ("sessionId", "executionId", "callId")}
            with channel.condition:
                if not self.model_stream:
                    return {"ok": False, "error": "本轮未协商模型流"}
                if method == "model.start":
                    if self.active_stream is not None:
                        return {"ok": False, "error": "当前模型调用尚未完成"}
                    self.active_stream = scope
                elif self.active_stream != scope:
                    return {"ok": method == "model.close", "data": {}, "error": "模型调用已关闭"}
                if method == "model.close":
                    self.active_stream = None
        if method == "workbook":
            import subprocess

            from . import planning_workbook
            try:
                return {"ok": True, "data": planning_workbook.execute(self, params, channel)}
            except (OSError, TypeError, ValueError, subprocess.SubprocessError) as exc:
                return {"ok": False, "error": str(exc)[:300]}
        return self.desktop(method, params, channel)

    def close_stream(self):
        # Called under the launch channel's condition when the bridge exits or
        # the user stops it. No socket owned by the child is needed to abort SSE.
        if self.active_stream and not self.loop.is_closed():
            scope, self.active_stream = self.active_stream, None
            request = self.pipe.call({"grant": self.grant, "runId": self.ref,
                "workspace": self.workspace, "method": "model.close", "params": scope}, timeout=10)
            asyncio.run_coroutine_threadsafe(request, self.loop)

    def desktop(self, method, params, channel):
        with channel.condition:
            if (channel.closed or channel.stopping) and method != "model.close":
                return {"ok": False, "error": "Planning 执行已停止"}
            request = self.pipe.call({"grant": self.grant, "runId": self.ref,
                "workspace": self.workspace, "method": method, "params": params}, timeout=90)
            future = asyncio.run_coroutine_threadsafe(request, self.loop)
            channel.host_calls.add(future)
        try:
            return future.result(timeout=95)
        except (OSError, RuntimeError, ValueError, TimeoutError, concurrent.futures.CancelledError):
            future.cancel()
            return {"ok": False, "error": "Planning 桌面授权已取消或超时"}
        finally:
            with channel.condition:
                channel.host_calls.discard(future)
