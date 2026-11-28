"""ACP v1 subprocess bridge for SoduWork Runner.

The bridge is dependency-free. It translates ACP NDJSON JSON-RPC into the
normalized event stream already consumed by SoduWork's local execution runtime.
Client-side files are confined to one task workspace. Terminal access is only
advertised when the task passed SoduWork's existing capability gate.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import queue
import re
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

try:
    from .acp_access import BridgeAccess, AccessError, ApprovalTimeout, ApprovalCancelled
    from .acp_transition import Transition
    from .acp_process import close_process, ProcessCleanupError, OwnedProcessGroup
    from . import runtime_images
    from . import opencode_runtime_config
    from . import opencode_session_migration
    from . import opencode_turn_outcome
    from . import qwen_runtime
    from . import opencode_model_selection
    from . import codex_acp_outcome
except ImportError:  # direct script entry used by source Runner
    from acp_access import BridgeAccess, AccessError, ApprovalTimeout, ApprovalCancelled
    from acp_transition import Transition
    from acp_process import close_process, ProcessCleanupError, OwnedProcessGroup
    import runtime_images
    import opencode_runtime_config
    import opencode_session_migration
    import opencode_turn_outcome
    import qwen_runtime
    import opencode_model_selection
    import codex_acp_outcome

_PROTOCOL = 1
_MAX_FILE_BYTES = 4 * 1024 * 1024
_MAX_TERMINALS = 8
_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_SECRET_MARKERS = ("KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL")
_TASK_OUTPUT_RECOVERY_ENV = "SODUWORK_TASK_OUTPUT_RECOVERY_OWNED"
_DSH_COMPACT_ONLY_ENV = "SODUWORK_DSH_COMPACT_ONLY"
_DSH_OUTPUT_CONTINUATION = (
    "上一段模型输出达到单次上限。请沿用当前会话，从最后一个已确认的工具结果继续完成原请求。"
    "已经完成的写入、命令、发送或其他操作不要重复。结果不确定时先只读核对。"
    "被截断且未执行的工具调用请拆成更小的完整调用，分步写入和验证，避免再次生成过长参数。"
    "如果交付物已经完成，请直接给出结果和已完成的验证。"
)
_DSH_REASONING_CONTINUATION = (
    "继续当前会话里的原请求。上一次模型回复在思考阶段用完了输出额度。"
    "请直接给出简短的可用答案；若任务需要工具，就先发出下一项最小、完整的工具调用，等待结果。"
    "沿用已经确认的工具结果。操作结果不确定时先只读核对，保留已完成的工作。"
)


@dataclass
class _PromptProgress:
    """Evidence from one native prompt; old transcript and compaction are excluded."""

    text: bool = False
    thinking: bool = False
    other_content: bool = False
    tool_seen: bool = False
    tool_completed: bool = False
    tool_ids: set[str] = field(default_factory=set)

    def advanced(self) -> bool:
        return self.text or self.tool_completed

    def reasoning_only(self) -> bool:
        return self.thinking and not (self.text or self.other_content or self.tool_seen)


def _utf8_stdio() -> None:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, OSError):
            pass


def _emit(value: dict) -> None:
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")), flush=True)


def _dsh_prompt_usage(value: Any) -> dict | None:
    """DSH totals one ACP prompt, with cache reads/writes separate from uncached input."""
    if not isinstance(value, dict):
        return None
    names = {"inputTokens": "input", "outputTokens": "output", "totalTokens": "total",
             "cachedReadTokens": "cacheRead", "cachedWriteTokens": "cacheWrite",
             "thoughtTokens": "reasoningTokens"}
    counts = {target: value[source] for source, target in names.items()
              if type(value.get(source)) is int and 0 <= value[source] <= 2**53 - 1}
    if not {"input", "output", "total"} <= counts.keys():
        return None
    return {**counts, "inputIncludesCache": False}


def _text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        if value.get("type") == "text":
            return str(value.get("text") or "")
        if value.get("type") == "content":
            return _text(value.get("content"))
    if isinstance(value, list):
        return "\n".join(filter(None, (_text(item) for item in value)))
    return ""


def _stderr_detail(head: list[str], tail: list[str]) -> str:
    """Keep the actual exception, not just Node's final stack-frame lines."""
    selected: list[str] = []
    candidates = [*head, *[
        line for line in tail
        if any(mark in line.lower() for mark in (
            "error", "exception", "failed", "cannot", "uncaught", "err_"))
    ], *tail[-4:]]
    for line in candidates:
        clean = " ".join(str(line or "").split())[:500]
        if clean and clean not in selected:
            selected.append(clean)
        if len(selected) >= 8:
            break
    return ("; " + " | ".join(selected)) if selected else ""


class BridgeError(RuntimeError):
    def __init__(self, message: str, code: int = -32603):
        super().__init__(message)
        self.code = code


def _safe_path(root: str, value: str) -> str:
    """Resolve an ACP path and reject workspace and symlink escapes."""
    if not value or not os.path.isabs(value):
        raise BridgeError("ACP paths must be absolute", -32602)
    base = os.path.realpath(os.path.abspath(root))
    target = os.path.realpath(os.path.abspath(value))
    try:
        inside = os.path.commonpath((base, target)) == base
    except ValueError:
        inside = False
    if not inside:
        raise BridgeError("ACP request escaped the task workspace")
    return target


def _terminal_env(items: Any) -> dict[str, str]:
    env = os.environ.copy()
    for item in items or []:
        if not isinstance(item, dict):
            raise BridgeError("Invalid terminal environment entry", -32602)
        name = str(item.get("name") or "")
        value = str(item.get("value") or "")
        upper = name.upper()
        if not _ENV_NAME.fullmatch(name):
            raise BridgeError("Invalid terminal environment variable name", -32602)
        if (upper.startswith(("SODUWORK_", "SODUWORK_", "GIT_CONFIG_"))
                or any(marker in upper for marker in _SECRET_MARKERS)):
            raise BridgeError("Agent cannot override protected environment variables")
        env[name] = value
    return env


def _close_process(proc: subprocess.Popen, readers: list[threading.Thread],
                   process_group: OwnedProcessGroup | None = None) -> None:
    try:
        close_process(proc, readers, process_group)
    except ProcessCleanupError as exc:
        raise BridgeError(str(exc)) from exc


class _Terminal:
    def __init__(self, command: str, args: list[str], cwd: str,
                 env: dict[str, str], limit: int) -> None:
        self.id = uuid.uuid4().hex
        self.limit = limit
        self.lock = threading.Lock()
        self.buffer = bytearray()
        self.truncated = False
        flags = ({"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
                 if os.name == "nt" else {"start_new_session": True})
        try:
            self.proc = subprocess.Popen(
                [command, *args], cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **flags)
        except OSError as exc:
            raise BridgeError("Terminal command failed to start: %s" %
                              type(exc).__name__) from exc
        self.process_group = OwnedProcessGroup(self.proc.pid) if os.name != "nt" else None
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self) -> None:
        assert self.proc.stdout
        while True:
            chunk = self.proc.stdout.read(65536)
            if not chunk:
                return
            with self.lock:
                self.buffer.extend(chunk)
                if len(self.buffer) > self.limit:
                    del self.buffer[:len(self.buffer) - self.limit]
                    self.truncated = True

    def output(self) -> tuple[str, bool]:
        with self.lock:
            return (bytes(self.buffer).decode("utf-8", errors="replace"),
                    self.truncated)

    def status(self) -> dict | None:
        code = self.proc.poll()
        return None if code is None else {"exitCode": int(code), "signal": None}

    def wait(self) -> dict:
        code = self.proc.wait()
        self.reader.join(timeout=1)
        return {"exitCode": int(code), "signal": None}

    def kill(self) -> None:
        _close_process(self.proc, [self.reader], self.process_group)


class AcpBridge:
    def __init__(self, argv: list[str], cwd: str, agent_name: str,
                 permission: str, session_id: str = "",
                 allow_terminal: bool = False) -> None:
        self.argv = argv
        self.cwd = os.path.realpath(os.path.abspath(cwd))
        if not os.path.isdir(self.cwd):
            raise BridgeError("Task workspace does not exist")
        self.agent_name = agent_name
        self.access = BridgeAccess(agent_name=agent_name)
        self.permission = "readonly" if self.access.mode == "readonly" else permission
        self.session_id = session_id
        self.allow_terminal = bool(allow_terminal and self.permission != "readonly")
        self.proc: subprocess.Popen | None = None
        self.readers: list[threading.Thread] = []
        self.process_group: OwnedProcessGroup | None = None
        self.inbox: queue.Queue = queue.Queue()
        self.next_id = 0
        self.pending: dict[Any, dict] = {}
        self.loading = False
        self.session_close_supported = False
        self.session_active = False
        self.message_id = ""
        self.message_has_native_id = False
        self.message_parts: list[str] = []
        self.message_stream_emitted = False
        self.message_count = 0
        self.tools: dict[str, str] = {}
        self.codex_tool_output = codex_acp_outcome.ToolOutput(agent_name)
        self.terminals: dict[str, _Terminal] = {}
        self.stderr_head: list[str] = []
        self.stderr_tail: list[str] = []
        self.transition = Transition(self)
        self.permission_refused = False
        self.outcome = None
        self.dsh_can_compact = False
        self.dsh_commands_advertised = False
        self.dsh_compact_only = (os.environ.pop(_DSH_COMPACT_ONLY_ENV, "") == "1"
                                 and self.agent_name == "dsh")
        self.dsh_compact_reply: list[str] | None = None
        self.prompt_progress: _PromptProgress | None = None
        # The Runner owns this flag. A managed task must not receive a fresh
        # pair of bridge retries every time its persisted controller resumes it.
        self.task_output_recovery_owned = os.environ.get(_TASK_OUTPUT_RECOVERY_ENV) == "1"

    def start(self) -> None:
        flags = ({"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
                 if os.name == "nt" else {"start_new_session": True})
        agent_env = self.access.agent_environment(self.agent_name, os.environ.copy())
        agent_env.pop(runtime_images.ENV_KEY, None)
        # This is host control, not provider configuration or a tool environment.
        agent_env.pop(_TASK_OUTPUT_RECOVERY_ENV, None)
        if self.agent_name == "opencode":
            # Reapply in the child entry for already-running source Runners.
            # Keep guard/model config, but never open the personal database.
            try:
                opencode_runtime_config.prepare_environment(agent_env)
                if self.session_id:
                    opencode_session_migration.migrate_session(
                        agent_env, self.session_id, self.cwd, self.argv[0])
            except (opencode_session_migration.OpenCodeSessionMigrationError,
                    opencode_runtime_config.OpenCodeEnvironmentError) as exc:
                raise BridgeError(str(exc)) from exc
            except OSError as exc:
                raise BridgeError("OpenCode 受管数据目录无法创建，请检查 Runner 数据目录权限。") from exc
            self.outcome = opencode_turn_outcome.Observer()
            agent_env = self.outcome.environment(agent_env)
        try:
            self.proc = subprocess.Popen(
                self.argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, cwd=self.cwd, env=agent_env,
                text=True, encoding="utf-8", errors="replace", bufsize=1,
                **flags)
        except OSError as exc:
            raise BridgeError("ACP Agent failed to start: %s" %
                              type(exc).__name__) from exc
        self.process_group = OwnedProcessGroup(self.proc.pid) if os.name != "nt" else None
        self.readers = [
            threading.Thread(target=self._read_stdout, daemon=True, name="acp-stdout"),
            threading.Thread(target=self._read_stderr, daemon=True, name="acp-stderr"),
        ]
        for reader in self.readers:
            reader.start()

    def _read_stdout(self) -> None:
        assert self.proc and self.proc.stdout
        try:
            for raw in self.proc.stdout:
                line = raw.strip()
                if not line:
                    continue
                try:
                    self.inbox.put(("message", json.loads(line)))
                except json.JSONDecodeError:
                    self.inbox.put(("noise", line[:400]))
        finally:
            self.inbox.put(("eof", None))

    def _read_stderr(self) -> None:
        assert self.proc and self.proc.stderr
        for raw in self.proc.stderr:
            line = raw.strip()
            if self.outcome and self.outcome.consume(line):
                continue
            if line:
                if len(self.stderr_head) < 5:
                    self.stderr_head.append(line[:500])
                self.stderr_tail = [*self.stderr_tail[-19:], line[:500]]

    def _exit_detail(self) -> str:
        # Pipe closure and the stderr reader race with the first request. Drain
        # pending diagnostics, but do not wait forever for inherited open pipes.
        for reader in self.readers:
            if reader.name == "acp-stderr" and reader is not threading.current_thread():
                reader.join(timeout=.5)
        return _stderr_detail(self.stderr_head, self.stderr_tail)

    def send(self, value: dict) -> None:
        if not self.proc or not self.proc.stdin:
            raise BridgeError("ACP connection is not ready")
        try:
            self.proc.stdin.write(json.dumps(
                value, ensure_ascii=False, separators=(",", ":")) + "\n")
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            raise BridgeError("ACP Agent disconnected early" + self._exit_detail()) from exc

    def request(self, method: str, params: dict, *, timeout: float | None = None) -> dict:
        self.next_id += 1
        request_id = self.next_id
        deadline = time.monotonic() + timeout if timeout is not None else None
        self.send({"jsonrpc": "2.0", "id": request_id,
                   "method": method, "params": params})
        if request_id in self.pending:
            return self._unwrap(self.pending.pop(request_id))
        while True:
            if deadline is not None and time.monotonic() >= deadline:
                raise BridgeError("ACP request did not settle before cleanup")
            self.transition.tick(method)
            try:
                kind, value = self.inbox.get(timeout=.15)
            except queue.Empty:
                continue
            if kind == "message":
                if isinstance(value, dict) and "method" in value:
                    self._incoming(value)
                    continue
                if isinstance(value, dict) and value.get("id") == request_id:
                    return self._unwrap(value)
                if isinstance(value, dict) and "id" in value:
                    self.pending[value["id"]] = value
            elif kind == "noise":
                _emit({"type": "item.completed", "item": {
                    "type": "error",
                    "message": "Invalid ACP stdout: " + str(value)}})
            elif kind == "eof":
                code = self.proc.poll() if self.proc else None
                detail = self._exit_detail()
                raise BridgeError("ACP Agent exited early%s%s" % (
                    " (code %s)" % code if code is not None else "", detail))

    @staticmethod
    def _unwrap(message: dict) -> dict:
        if message.get("error"):
            error = message["error"]
            detail = error.get("message") if isinstance(error, dict) else str(error)
            code = error.get("code") if isinstance(error, dict) else None
            raise BridgeError(str(detail or "ACP request failed"), code if type(code) is int else -32603)
        result = message.get("result")
        return result if isinstance(result, dict) else {}

    def _read_text_file(self, params: dict) -> dict:
        path = (self.access.path(self.cwd, str(params.get("path") or ""))
                if self.access.enabled else _safe_path(self.cwd, str(params.get("path") or "")))
        if not os.path.isfile(path):
            raise BridgeError("Requested file does not exist", -32002)
        if os.path.getsize(path) > _MAX_FILE_BYTES:
            raise BridgeError("A single file read cannot exceed 4 MB")
        first = params.get("line")
        first = 1 if first is None else first
        limit = params.get("limit")
        if (type(first) is not int or first < 1
                or (limit is not None and (type(limit) is not int or limit < 1))):
            raise BridgeError("Invalid file line range", -32602)
        # An omitted ACP limit means the complete file, including for an
        # Agent's read/modify/write operation. Never present a truncated prefix
        # as the whole file. Bound the actual read as well as the size probe so
        # a file growing between those operations cannot bypass the byte cap.
        with open(path, "rb") as handle:
            raw = handle.read(_MAX_FILE_BYTES + 1)
        if len(raw) > _MAX_FILE_BYTES:
            raise BridgeError("A single file read cannot exceed 4 MB")
        content = raw.decode("utf-8", errors="replace")
        if first == 1 and limit is None:
            return {"content": content}
        lines = content.splitlines(keepends=True)
        end = None if limit is None else first - 1 + limit
        return {"content": "".join(lines[first - 1:end])}

    def _write_text_file(self, params: dict) -> dict:
        if self.permission != "workspace":
            raise BridgeError("Read-only sessions cannot write files", -32601)
        content = params.get("content")
        if not isinstance(content, str):
            raise BridgeError("File content must be a string", -32602)
        path = (self.access.path(self.cwd, str(params.get("path") or ""), write=True,
                                      arguments={"contentDigest": hashlib.sha256(
                                          content.encode("utf-8")).hexdigest()})
                if self.access.enabled else _safe_path(self.cwd, str(params.get("path") or "")))
        if len(content.encode("utf-8")) > _MAX_FILE_BYTES:
            raise BridgeError("A single file write cannot exceed 4 MB")
        parent = os.path.dirname(path)
        if not os.path.isdir(parent):
            raise BridgeError("Target directory does not exist", -32002)
        try:
            with open(path, "w", encoding="utf-8", newline="") as handle:
                handle.write(content)
        except OSError as exc:
            raise BridgeError("File write failed: %s" % type(exc).__name__) from exc
        if self.prompt_progress is not None:
            self.prompt_progress.tool_seen = self.prompt_progress.tool_completed = True
        return {}

    def _terminal_create(self, params: dict) -> dict:
        if not self.allow_terminal:
            raise BridgeError("This task was not granted terminal capability", -32601)
        if len(self.terminals) >= _MAX_TERMINALS:
            raise BridgeError("A session can open at most 8 terminals")
        command = str(params.get("command") or "").strip()
        args = params.get("args") or []
        if not command or not isinstance(args, list) or len(args) > 256:
            raise BridgeError("Invalid terminal command arguments", -32602)
        args = [str(item) for item in args]
        cwd = (self.access.path(self.cwd, str(params.get("cwd") or self.cwd))
               if self.access.enabled else _safe_path(self.cwd, str(params.get("cwd") or self.cwd)))
        automatic_program = (self.access.terminal_program(command, args, cwd, params.get("env"))
                             if self.access.enabled else "")
        if self.access.enabled and not automatic_program and not self.access.approve(
                "terminal.execute", command, {"command": command, "args": args,
                                             "cwd": cwd, "env": params.get("env") or []},
                title="Run terminal command"):
            raise BridgeError("Terminal command was not approved")
        if not os.path.isdir(cwd):
            raise BridgeError("Terminal working directory does not exist", -32002)
        try:
            limit = min(4 * 1024 * 1024,
                        max(4096, int(params.get("outputByteLimit") or 1024 * 1024)))
        except (TypeError, ValueError, OverflowError) as exc:
            raise BridgeError("Invalid terminal output limit", -32602) from exc
        terminal = _Terminal(
            automatic_program or command,
            self.access.terminal_arguments(command, args) if automatic_program else args,
            cwd, _terminal_env(params.get("env")), limit)
        self.terminals[terminal.id] = terminal
        return {"terminalId": terminal.id}

    def _terminal(self, params: dict) -> _Terminal:
        terminal_id = str(params.get("terminalId") or "")
        terminal = self.terminals.get(terminal_id)
        if not terminal:
            raise BridgeError("Terminal does not exist or was released", -32002)
        return terminal

    def _client_request(self, method: str, params: dict) -> dict | None:
        if method.startswith("terminal/") and not self.allow_terminal:
            raise BridgeError("This task was not granted terminal capability", -32601)
        if method in {"fs/read_text_file", "fs/write_text_file"}:
            path = params.get("path")
            if not isinstance(path, str) or not os.path.isabs(path):
                raise BridgeError("ACP paths must be absolute", -32602)
        if method == "fs/read_text_file":
            return self._read_text_file(params)
        if method in {"fs/write_text_file", "terminal/create"} and self.transition.stop_requested:
            raise ApprovalCancelled("The user stopped this turn")
        if (method in {"fs/write_text_file", "terminal/create"}
                and (self.transition.requested or self.transition.cancel_sent)):
            raise AccessError("Permission change in progress; this operation was not started")
        if method == "fs/write_text_file":
            return self._write_text_file(params)
        if method == "terminal/create":
            return self._terminal_create(params)
        if method == "terminal/output":
            terminal = self._terminal(params)
            output, truncated = terminal.output()
            result = {"output": output, "truncated": truncated}
            status = terminal.status()
            if status is not None:
                result["exitStatus"] = status
            return result
        if method == "terminal/wait_for_exit":
            return self._terminal(params).wait()
        if method == "terminal/kill":
            self._terminal(params).kill()
            return {}
        if method == "terminal/release":
            terminal = self._terminal(params)
            terminal.kill()
            self.terminals.pop(terminal.id, None)
            return {}
        return None

    def _incoming(self, message: dict) -> None:
        method = str(message.get("method") or "")
        if method == "session/update":
            params = message.get("params") or {}
            if self.dsh_compact_only and params.get("sessionId") != self.session_id:
                return
            self._update(params.get("update") or {})
            return
        if "id" not in message:
            return
        if method == "session/request_permission":
            try:
                result = self._permission_result(message.get("params") or {})
            except ApprovalTimeout:
                result = {"outcome": {"outcome": "cancelled"},
                          "_meta": {"armonel/stopReason": "tool_approval_timeout"}}
            except AccessError:
                result = {"outcome": {"outcome": "cancelled"}}
            self.send({"jsonrpc": "2.0", "id": message["id"], "result": result})
            return
        params = message.get("params") or {}
        try:
            result = self._client_request(method, params)
        except (BridgeError, AccessError, OSError) as exc:
            self.send({"jsonrpc": "2.0", "id": message["id"], "error": {
                "code": getattr(exc, "code", -32603),
                "message": type(exc).__name__ if isinstance(exc, OSError) else str(exc)}})
            return
        if result is not None:
            self.send({"jsonrpc": "2.0", "id": message["id"], "result": result})
            return
        self.send({"jsonrpc": "2.0", "id": message["id"], "error": {
            "code": -32601,
            "message": "Unsupported SoduWork Runner client method: " + method}})

    def _permission_result(self, params: dict) -> dict:
        if self.transition.cancel_sent or self.transition.stop_requested:
            return {"outcome": {"outcome": "cancelled"}}
        call = params.get("toolCall") or {}
        raw_options = params.get("options") or []
        kimi_approval = {"approve_once": "allow_once", "approve_always": "allow_always",
                         "reject": "reject_once"}
        # Kimi can also request permission to *run* AskUserQuestion. Its
        # canonical approval options must remain on the ordinary grant path.
        canonical_approval = (isinstance(raw_options, list) and len(raw_options) == len(kimi_approval)
                              and all(isinstance(item, dict) and isinstance(item.get("optionId"), str)
                                      and kimi_approval.get(item["optionId"]) == item.get("kind")
                                      and item["optionId"] in kimi_approval for item in raw_options)
                              and len({item["optionId"] for item in raw_options}) == len(kimi_approval))
        if self.agent_name == "kimi" and call.get("title") == "AskUserQuestion" and not canonical_approval:
            # This reviewed Kimi fallback asks for an answer, not permission.
            # Full access and legacy workspace mode must never choose for users.
            choice = None
            if not self.transition.permission_blocked(params):
                choice = self.access.native_question(params)
            if choice is None:
                self.transition.next_poll = 0
                self.transition.tick("permission")
                self.transition.permission_blocked(params)
                return {"outcome": {"outcome": "cancelled"}}
            return {"outcome": {"outcome": "selected", "optionId": choice}}
        options = [item for item in (params.get("options") or [])
                   if isinstance(item, dict) and item.get("optionId")]
        approved = self.permission != "readonly"
        if self.transition.permission_blocked(params):
            approved = False
        elif self.agent_name == "armonel" and (not approved or not self.access.enabled):
            approved = False
        elif self.access.enabled:
            approved = self.access.native_permission(params)
            if not approved:
                self.transition.next_poll = 0
                self.transition.tick("permission")
                self.transition.permission_blocked(params)
        wanted = (("allow_once",) if approved else ("reject_once", "reject_always"))
        selected = next((item for kind in wanted for item in options
                         if item.get("kind") == kind), None)
        if not selected:
            selected = next((item for item in options
                             if str(item.get("kind") or "").startswith("reject_")),
                            None)
        if self.agent_name == "armonel" and (not selected or str(selected.get("kind")).startswith("reject_")):
            self.permission_refused = True
        if not selected:
            return {"outcome": {"outcome": "cancelled"}}
        return {"outcome": {"outcome": "selected",
                            "optionId": selected["optionId"]}}

    def _flush_message(self) -> None:
        text = "".join(self.message_parts).strip()
        # ACP agents stream `agent_message_chunk` events.  Those chunks are
        # emitted as they arrive below; only emit the accumulated snapshot
        # here for agents that supplied no streamable chunks (legacy ACP
        # implementations and replayed complete messages).
        if not self.loading and self.message_stream_emitted:
            # Close the same stream without replaying its accumulated text.
            # The desktop uses this marker to flip the assistant block to a
            # settled state before the next thought/tool segment arrives.
            _emit({"type": "text", "part": {
                "streamId": self.message_id,
                "text": "", "delta": "", "done": True,
            }})
        elif text and not self.loading:
            _emit({"type": "text", "part": {"text": text}})
        self.message_id = ""
        self.message_has_native_id = False
        self.message_parts = []
        self.message_stream_emitted = False
        self._flush_thought()

    def _flush_thought(self) -> None:
        stream = getattr(self, "thought_stream", "")
        if stream and not self.loading:
            _emit({"type": "reasoning", "part": {"streamId": stream, "delta": "", "done": True}})
        self.thought_stream = ""

    def _update(self, update: dict) -> None:
        kind = str(update.get("sessionUpdate") or "")
        if self.agent_name == "dsh" and kind == "available_commands_update":
            self.dsh_commands_advertised = True
            self.dsh_can_compact = any(
                isinstance(command, dict) and command.get("name") == "compact"
                for command in update.get("availableCommands") or [])
        if self.dsh_compact_reply is not None and kind == "agent_message_chunk":
            self.dsh_compact_reply.append(_text(update.get("content")))
            return
        if self.loading or self.dsh_compact_only:
            return
        if self.transition.update(update) is False:
            return
        progress = self.prompt_progress
        self.codex_tool_output.consume(update)
        self.access.observe_tool(update)
        if kind == "agent_thought_chunk":
            text = _text(update.get("content"))
            # Some adapters forward empty reasoning deltas alongside text.
            # They carry no content and must not end the active message.
            if not text:
                return
            meta = update.get("_meta")
            dsh = meta.get("dsh") if isinstance(meta, dict) else None
            if progress and text.strip() and not (isinstance(dsh, dict) and dsh.get("subagent")):
                progress.thinking = True
            # Late reasoning may interleave with one explicitly identified
            # message (DSH); only a tool, new message or turn ends that stream.
            if self.message_parts and not self.message_has_native_id:
                self._flush_message()
            if not getattr(self, "thought_stream", ""):
                self.thought_count = getattr(self, "thought_count", 0) + 1
                self.thought_stream = "acp:thought:%s" % self.thought_count
            _emit({"type": "reasoning", "part": {"streamId": self.thought_stream,
                   "delta": text, "done": False}})
            return
        if kind == "agent_message_chunk":
            self._flush_thought()
            message_id = str(update.get("messageId") or "")
            if self.message_id and message_id and message_id != self.message_id:
                self._flush_message()
            if message_id:
                self.message_id = message_id
                self.message_has_native_id = True
            elif not self.message_id:
                self.message_count += 1
                self.message_id = "acp:message:%s" % self.message_count
            content = _text(update.get("content"))
            if progress:
                if content.strip():
                    progress.text = True
                block = update.get("content")
                if isinstance(block, dict) and block.get("type") not in (None, "text"):
                    progress.other_content = True
            if content:
                self.message_parts.append(content)
                if not self.loading:
                    self.message_stream_emitted = True
                    _emit({"type": "text", "part": {
                        "streamId": self.message_id,
                        "text": content,
                        "delta": content,
                        "done": False,
                    }})
            return
        if kind == "plan":
            self._flush_message()
            for entry in update.get("entries") or []:
                if not isinstance(entry, dict):
                    continue
                title = str(entry.get("content") or "").strip()
                if title:
                    _emit({"type": "tool_use", "part": {
                        "tool": "Plan", "state": {
                            "input": {"command": title[:300]}}}})
            return
        if kind == "tool_call":
            self._flush_message()
            tool_id = str(update.get("toolCallId") or "")
            if progress and tool_id:
                progress.tool_seen = True
                if tool_id not in self.tools:
                    progress.tool_ids.add(tool_id)
                if tool_id in progress.tool_ids and update.get("status") == "completed":
                    progress.tool_completed = True
            title = str(update.get("title") or update.get("kind") or "Tool")
            self.tools[tool_id] = title
            raw = update.get("rawInput")
            raw_input = raw if isinstance(raw, dict) else {}
            locations = update.get("locations") or []
            path = ""
            if locations and isinstance(locations[0], dict):
                path = str(locations[0].get("path") or "")
            args = {key: str(raw_input[key])[:1500] for key in
                    ("command", "path", "filePath", "file_path", "pattern", "query")
                    if isinstance(raw_input.get(key), str)}
            if path and not any(args.get(key) for key in ("path", "filePath", "file_path")):
                args["path"] = path[:1500]
            _emit({"type": "tool_use", "part": {"tool": title, "callId": tool_id,
                   "toolKind": str(update.get("kind") or "")[:40],
                   "state": {"input": args}}})
            return
        if kind == "tool_call_update":
            text = _text(update.get("content"))
            tool_id = str(update.get("toolCallId") or "")
            if progress and tool_id:
                progress.tool_seen = True
                if update.get("status") == "completed" and tool_id in progress.tool_ids:
                    progress.tool_completed = True
            if update.get("status") in ("completed", "failed"):
                text = self.codex_tool_output.finish(update, text)
                _emit({"type": "tool_execution_end",
                       "toolName": self.tools.get(tool_id, "Tool"),
                       "toolCallId": tool_id,
                       **self.transition.result_fields(update), "result": text[:2000]})
            return
        if kind == "usage_update":
            meta = update.get("_meta")
            dsh = meta.get("dsh") if isinstance(meta, dict) else None
            if self.agent_name == "dsh" and isinstance(dsh, dict) and dsh.get("subagent"):
                return  # A delegated session has its own context window.
            used = update.get("used")
            if isinstance(used, str):
                try:
                    used = int(used)
                except ValueError:
                    used = None
            valid = (isinstance(used, int) and not isinstance(used, bool) and used >= 0) or (
                isinstance(used, float) and math.isfinite(used) and used >= 0)
            tokens = {"input": int(used), "output": 0, "total": int(used)} if valid else {}
            _emit({"type": "step_finish", "contextOnly": True, "part": {
                "contextWindow": update.get("size"), "tokens": tokens}})

    def _output_limited(self, result: dict) -> bool:
        if result.get("stopReason") != "max_tokens":
            return False
        if self.agent_name in {"dsh", "opencode", "kimi", "armonel"}:
            # Armonel uses this ACP stop reason for both task budgets and
            # per-response limits. The Runner reports a generic token limit.
            return True
        # Qwen also uses max_tokens for its input/session budget. Only the
        # reviewed host projection identifies an exhausted output recovery.
        meta = result.get("_meta")
        owned = meta.get("soduwork") if isinstance(meta, dict) else None
        return (self.agent_name == "qwen" and isinstance(owned, dict)
                and owned.get("outputLimit") is True)

    def _client_capabilities(self) -> dict:
        timeout = (self.access.channel or {}).get("permissionTimeoutMs") if self.agent_name == "armonel" else None
        return {
            **codex_acp_outcome.capabilities(self.agent_name),
            **({"_meta": {"armonel/permissionTimeoutMs": timeout}} if type(timeout) is int and timeout > 0 else {}),
            # codex-acp only advertises its custom enterprise gateway when the
            # ACP client explicitly opts in. Other ACP agents safely ignore it.
            "auth": {"_meta": {"gateway": True}},
            "fs": {
                "readTextFile": True,
                "writeTextFile": self.permission == "workspace",
            },
            "terminal": self.allow_terminal,
        }

    def _prompt(self, content: list) -> dict:
        result = self.request("session/prompt", {"sessionId": self.session_id, "prompt": content})
        if self.agent_name == "dsh" and result.get("stopReason"):
            usage = _dsh_prompt_usage(result.get("usage"))
            if usage is not None:
                # Emit once per settled prompt, including cancellation and recovery. One
                # prompt may cover several model steps; this is not context occupancy.
                _emit({"type": "acp_prompt_usage", "usage": usage})
        return result

    def _compact_dsh_history(self) -> bool:
        # The native command creates a durable checkpoint in this same session.
        # DSH reports command failures as message chunks with an end_turn result.
        if self.access.enabled:
            self.transition.next_poll = 0
            self.transition.tick("before-prompt")
            if self.transition.stop_requested:
                return False
        self.dsh_compact_reply = []
        try:
            result = self._prompt([{"type": "text", "text": "/compact"}])
            return (result.get("stopReason") == "end_turn"
                    and "".join(self.dsh_compact_reply).startswith("Compacted "))
        finally:
            self.dsh_compact_reply = None

    def _dsh_compaction_available(self) -> bool:
        # DSH may publish commands just after returning session/resume.
        deadline = time.monotonic() + 2
        while not self.dsh_commands_advertised:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            try:
                kind, value = self.inbox.get(timeout=remaining)
            except queue.Empty:
                return False
            if kind != "message" or not isinstance(value, dict):
                return False
            if "method" in value:
                self._incoming(value)
            elif "id" in value:
                self.pending[value["id"]] = value
        return self.dsh_can_compact

    def run(self, prompt: str) -> int:
        if self.dsh_compact_only and not self.session_id:
            _emit({"type": "turn_stopped", "reason": "dsh_context_compaction_failed"})
            return 2
        self.start()
        init = self.request("initialize", {
            "protocolVersion": _PROTOCOL,
            "clientCapabilities": self._client_capabilities(),
            "clientInfo": {
                "name": "soduwork-runner", "title": "SoduWork Runner", "version": "1"},
        })
        if int(init.get("protocolVersion") or 0) != _PROTOCOL:
            raise BridgeError("ACP protocol version is incompatible")
        capabilities = init.get("agentCapabilities") or {}
        if self.agent_name == "armonel":
            identity = init.get("agentInfo") or {}
            if identity.get("name") != "armonel" or not capabilities.get("loadSession"):
                raise BridgeError("随附的 Armonel 不支持 ACP 会话恢复，请修复或更新 SoduWork。")
        content = []
        if not self.dsh_compact_only:
            try:
                content = runtime_images.prompt(prompt, capabilities, os.environ.get(runtime_images.ENV_KEY, ""))
            except runtime_images.ImageInputError as exc:
                raise BridgeError(str(exc)) from exc
        self.transition.resumable = bool(capabilities.get("loadSession") or
            (capabilities.get("sessionCapabilities") or {}).get("resume") is not None)
        session_params = {"cwd": self.cwd, "mcpServers": []}
        session_caps = capabilities.get("sessionCapabilities") or {}
        self.session_close_supported = isinstance(session_caps.get("close"), dict)
        session_config = {}
        if self.session_id:
            self.loading = True
            try:
                if session_caps.get("resume") is not None:
                    session_config = self.request("session/resume", {
                        **session_params, "sessionId": self.session_id})
                elif capabilities.get("loadSession"):
                    session_config = self.request("session/load", {
                        **session_params, "sessionId": self.session_id})
                else:
                    raise BridgeError(
                        "This Agent cannot safely resume the previous session")
            finally:
                self.loading = False
        else:
            created = self.request("session/new", session_params)
            session_config = created
            self.session_id = str(created.get("sessionId") or "")
            if not self.session_id:
                raise BridgeError("ACP Agent did not return a session ID")
        self.session_active = True
        if self.agent_name == "qwen":
            try:
                qwen_runtime.apply_model(self, session_config)
            except RuntimeError as exc:
                raise BridgeError(str(exc)) from exc
        if self.agent_name == "opencode":
            try:
                opencode_model_selection.apply_model(self, session_config)
            except RuntimeError as exc:
                raise BridgeError(str(exc)) from exc
        self.access.apply(self, session_config)
        _emit({"type": "session", "sessionID": self.session_id})
        _emit({"type": "step_start"})
        if self.dsh_compact_only:
            try:
                compacted = self._dsh_compaction_available() and self._compact_dsh_history()
            except BridgeError:
                compacted = False
            if self.transition.stop_requested:
                _emit({"type": "turn_stopped", "reason": "cancelled"})
                return 0
            reason = "dsh_context_compacted" if compacted else "dsh_context_compaction_failed"
            _emit({"type": "turn_stopped", "reason": reason})
            return 2
        continued_output = False
        compacted_output = False
        while True:
            if self.access.enabled:
                self.transition.next_poll = 0
                self.transition.tick("before-prompt")
                if self.transition.stop_requested:
                    _emit({"type": "turn_stopped", "reason": "cancelled"})
                    return 0
            progress = self.prompt_progress = _PromptProgress() if self.agent_name == "dsh" else None
            self.permission_refused = False
            if self.outcome:
                self.outcome.begin(self.session_id)
            try:
                result = self._prompt(content)
            except BridgeError as exc:
                if self.transition.stop_requested:
                    self._flush_message()
                    _emit({"type": "turn_stopped", "reason": "cancelled"})
                    return 0
                # Armonel rc.4 reports these native stops as JSON-RPC errors.
                # Forward only their stable reason, never the appended detail.
                if self.agent_name != "armonel":
                    raise
                message = str(exc)
                prefix = "Task stopped: compaction_failed. "
                if exc.code == -32603 and message.startswith("Task stopped: context_contract."):
                    reason = "context_contract"
                elif message.startswith(prefix):
                    detail = message[len(prefix):].removeprefix("Context summary failed before replacing history: ")
                    reason = ("context_summary_truncated" if detail.startswith(
                        "Summary was truncated again on a smaller segment; original history was preserved")
                        else "context_summary_failed")
                else:
                    raise
                self._flush_message()
                _emit({"type": "turn_stopped", "reason": reason})
                return 2
            finally:
                self.prompt_progress = None
            self._flush_message()
            if not isinstance(result.get("stopReason"), str) or not result["stopReason"].strip():
                raise BridgeError("ACP session/prompt response is missing stopReason")
            failure = codex_acp_outcome.failure(self.agent_name, result)
            if failure:
                raise BridgeError(failure)
            recovery_without_result = (progress is not None and continued_output
                                       and result["stopReason"] == "end_turn"
                                       and (not progress.advanced() or self.transition.busy()))
            if self.agent_name in {"dsh", "kimi", "qwen"} or self._output_limited(result):
                reason = str(result.get("stopReason") or "")
                if reason in {"", "end_turn"} or self._output_limited(result):
                    _emit({"type": "step_finish", "part": {
                        "reason": "max_tokens" if reason == "max_tokens" else "stop"}})
            if self.outcome and result.get("stopReason") in (None, "", "end_turn"):
                native_reason = self.outcome.finish()
                _emit({"type": "step_finish", "part": {"reason": native_reason}})
                if native_reason in {"length", "max_tokens"}:
                    result = {**result, "stopReason": "max_tokens"}
            if not self.transition.complete(result):
                if (progress is not None and result.get("stopReason") == "max_tokens"
                        and not self.task_output_recovery_owned
                        and not self.permission_refused
                        and not self.transition.requested
                        and not self.transition.stop_requested
                        and not self.transition.cancel_sent and not self.transition.busy()):
                    if continued_output:
                        if (compacted_output or not progress.advanced() or not self.dsh_can_compact
                                or not self._compact_dsh_history()):
                            break
                        compacted_output = True
                        self.transition.next_poll = 0
                        self.transition.tick("complete")
                        if (self.transition.stop_requested or self.transition.requested
                                or self.transition.cancel_sent or self.transition.busy()):
                            break
                    continued_output = True
                    continuation = _DSH_REASONING_CONTINUATION if progress.reasoning_only() else _DSH_OUTPUT_CONTINUATION
                    content = [{"type": "text", "text": continuation}]
                    _emit({"type": "step_start"})
                    continue
                break
            continuation = self.transition.reconfigure(session_config)
            if continuation is None:
                return 73
            if not continuation:
                return 0
            # The native mode applies to the next native turn (Codex snapshots
            # its policy at turn/start). Keep the process, session and completed
            # tools; resume with the trusted continuation, never the user input.
            content = [{"type": "text", "text": continuation}]
        reason = str(result.get("stopReason") or "")
        if self.transition.stop_requested:
            _emit({"type": "turn_stopped", "reason": "cancelled"})
            return 0
        meta = result.get("_meta")
        if self.agent_name == "armonel" and (reason == "context_contract" or
                isinstance(meta, dict) and meta.get("armonel/stopReason") == "context_contract"):
            _emit({"type": "turn_stopped", "reason": "context_contract"})
            return 2
        if reason in ("", "end_turn"):
            if recovery_without_result:
                # Preserve the native end_turn receipt. It did not resolve the
                # earlier truncation with a usable answer or a settled tool.
                _emit({"type": "turn_stopped", "reason": "output_recovery_no_progress"})
                return 2
            return 0
        if (self.agent_name == "armonel" and reason == "cancelled" and isinstance(meta, dict)
                and meta.get("armonel/stopReason") == "tool_approval_timeout"):
            _emit({"type": "turn_stopped", "reason": "tool_approval_timeout"})
            return 0
        if reason == "cancelled":
            _emit({"type": "turn_stopped", "reason": "cancelled"})
            return 0
        if (reason == "refusal" and self.permission_refused
                and not self.transition.requested and not self.transition.blocked):
            _emit({"type": "turn_stopped", "reason": "tool_approval_denied"})
            return 0
        if self._output_limited(result):
            if (self.agent_name == "armonel" and isinstance(meta, dict)
                    and meta.get("armonel/stopReason") == "reasoning_output_limit"):
                _emit({"type": "turn_stopped", "reason": "reasoning_output_limit"})
            if progress is not None:
                if progress.reasoning_only():
                    _emit({"type": "turn_stopped", "reason": "reasoning_output_limit"})
                elif continued_output and not progress.advanced():
                    _emit({"type": "turn_stopped", "reason": "output_recovery_no_progress"})
            return 2
        if self.agent_name == "armonel" and reason == "max_turn_requests":
            _emit({"type": "turn_stopped", "reason": "max_turn_requests"})
            return 2
        raise BridgeError("Agent stopped this turn: " + reason)

    def close(self) -> None:
        errors = []
        try:
            if self.session_active and self.session_close_supported and self.proc and self.proc.poll() is None:
                try:
                    self.request("session/close", {"sessionId": self.session_id}, timeout=0.75)
                except (AccessError, BridgeError):
                    # The outer Runner still requires verified process exit.
                    pass
            for terminal in list(self.terminals.values()):
                try:
                    terminal.kill()
                except (OSError, BridgeError) as exc:
                    errors.append(exc)
            self.terminals.clear()
            if self.proc:
                try:
                    _close_process(self.proc, self.readers, self.process_group)
                except (OSError, BridgeError) as exc:
                    errors.append(exc)
        finally:
            self.access.close()
            if self.outcome:
                self.outcome.close()
        if errors:
            raise BridgeError("ACP cleanup failed: " + str(errors[0])) from errors[0]


def _parse() -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--agent-name", default="acp")
    parser.add_argument(
        "--permission", choices=("workspace", "readonly"), default="workspace")
    parser.add_argument("--session", default="")
    parser.add_argument("--terminal", action="store_true")
    parser.add_argument("agent", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.agent and args.agent[0] == "--":
        args.agent = args.agent[1:]
    if not args.agent:
        parser.error("missing ACP agent command")
    return args


def _friendly_bridge_error(agent_name: str, message: str) -> str:
    if agent_name == "opencode":
        if safe := opencode_runtime_config.config_error_message(message):
            return safe
    if (agent_name == "dsh"
            and re.search(r"\bMoveFileExW\s+EXDEV\s*\(Win32\s+17\)", message, re.I)
            and re.search(r"[\\/]session\.v4\.jsonl(?:\.zstd)?(?=[.\s\"'<>]|$)", message, re.I)):
        return ("DeepSeek Harness 无法保存本机会话归档：Windows 同目录重命名失败（错误 17），"
                "本次执行未完成。这需要归档兼容修复，重新登录或放宽工具权限不能解决；"
                "可先使用其他已验证可用的底座。原始信息：" + message)
    # Keep the existing authentication guidance separate from storage failures.
    if "authentication required" in message.lower():
        return ("%s 缺少可用的模型凭据：通常是这台设备没有被授权模型"
                "（请在管理端「模型服务」配置或授权后重试），或在执行机上"
                "登录该 Agent 的个人账号。原始信息：%s"
                % (agent_name or "该 Agent", message))
    return message


def main() -> int:
    _utf8_stdio()
    args = _parse()
    prompt = sys.stdin.read()
    bridge = AcpBridge(
        args.agent, args.cwd, args.agent_name, args.permission,
        args.session, allow_terminal=args.terminal)
    try:
        return bridge.run(prompt)
    except (BridgeError, AccessError, opencode_turn_outcome.OutcomeError) as exc:
        message = _friendly_bridge_error(bridge.agent_name, str(exc))
        _emit({"error": {"name": "AcpBridgeError", "message": message}})
        return 2
    finally:
        bridge.close()


if __name__ == "__main__":
    raise SystemExit(main())
