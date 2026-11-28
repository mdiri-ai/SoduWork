"""Run the bundled Office Skill on bounded private files, then publish a verified new workbook."""
import hashlib
import json
import math
import os
import stat
import subprocess
import tempfile
from pathlib import Path

MAX_FILE = 2 * 1024 * 1024
MAX_ROWS_BYTES = 256 * 1024


def rows_digest(rows):
    if not isinstance(rows, list) or not 1 <= len(rows) <= 1000:
        raise ValueError("工作表需要 1 至 1000 行")
    for row in rows:
        if not isinstance(row, list) or not 1 <= len(row) <= 64 or len(row) != len(rows[0]):
            raise ValueError("工作表每行需要 1 至 64 列")
        for cell in row:
            if isinstance(cell, str) and 0 < len(cell) <= 32767 and not cell.lstrip().startswith("="):
                continue
            if type(cell) in (float, int) and abs(cell) <= 2**53 - 1 and math.isfinite(cell):
                continue
            raise ValueError("工作表数据包含不支持的单元格")
    data = json.dumps(rows, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
    if len(data) > MAX_ROWS_BYTES:
        raise ValueError("工作表数据超过 256 KB")
    return hashlib.sha256(data).hexdigest()


def _regular(path):
    try:
        entry = path.lstat()
        return (stat.S_ISREG(entry.st_mode) and path == path.resolve(strict=True)
                and not getattr(entry, 'st_file_attributes', 0) & 0x400)
    except (ValueError, OSError):
        return False


def command():
    from .planning_host import child_environment
    python = Path(os.environ.get("SODUWORK_MANAGED_PYTHON", ""))
    skill = Path(os.environ.get("SODUWORK_PLANNING_WORKBOOK", ""))
    layout = Path("python/python.exe" if os.name == "nt" else "python/bin/python3")
    if not python.is_absolute() or len(python.parents) < len(layout.parts):
        return None
    resources = python.parents[len(layout.parts) - 1]
    expected = resources / "skills" / "office" / "scripts" / "planning_workbook.py"
    if (python != resources / layout or not python.is_file()
            or not python.resolve().is_relative_to(resources / "python")
            or skill != expected or not _regular(skill) or not _regular(skill.with_name("inspect_office.py"))):
        return None
    argv = [str(python), "-I", "-B", "-u", str(skill)]
    try:
        check = subprocess.run([*argv, "--check"], env=child_environment(os.environ),
                stdin=subprocess.DEVNULL, capture_output=True, timeout=8, check=True)
        return argv if json.loads(check.stdout).get("ready") is True else None
    except (OSError, ValueError, AttributeError, subprocess.SubprocessError):
        return None


def _source(path):
    if not _regular(path) or path.stat().st_size > MAX_FILE:
        raise ValueError("需要本机授权目录内小于等于 2 MB 的普通工作簿")
    with path.open("rb") as stream:
        before = os.fstat(stream.fileno())
        data = stream.read(MAX_FILE + 1)
        after = path.lstat()
        if (not _regular(path) or not os.path.samestat(before, after) or len(data) > MAX_FILE
                or before.st_size != len(data) or before.st_mtime_ns != after.st_mtime_ns):
            raise ValueError("工作簿在读取期间发生变化")
    return data


def _path(turn, params):
    root = Path(turn.workspace)
    raw = params.get("path")
    if not isinstance(raw, str) or not raw or len(raw) > 512:
        raise ValueError("无效的工作簿路径")
    path = root / raw
    if (path.suffix.lower() != ".xlsx" or ".." in Path(raw).parts
            or not path.is_relative_to(root) or path != path.resolve()
            or path.name.rstrip(" .") != path.name or ":" in path.name or path.is_reserved()):
        raise ValueError("工作簿路径必须指向工作区内的 .xlsx 文件")
    if path.parent == Path(turn.input_view["alias"]):
        if params.get("operation") != "read":
            raise ValueError("会话附件为只读")
        return path, Path(turn.input_view["root"]) / path.name
    if path.parent != root:
        raise ValueError("工作簿必须位于工作区顶层")
    return path, path


def execute(turn, params, channel):
    from .planning_host import child_environment
    operation = params.get("operation")
    if not turn.workbook or operation not in ("write", "read"):
        raise ValueError("本机 Office 工具未授权")
    target, source = _path(turn, params)
    auth = {k: params[k] for k in ("sessionId", "executionId", "callId")}
    auth.update(operation=operation, path=str(target))
    writing = operation == "write"
    if writing:
        if channel.policy["mode"] == "readonly" or os.path.lexists(target):
            raise ValueError("只允许在可写工作区新建工作簿")
        auth["sha256"] = rows_digest(params.get("rows"))

    def authorize():
        result = turn.desktop("workbook.authorize", auth, channel)
        if not result.get("ok") or result.get("data", {}).get("authorized") is not True:
            raise ValueError(result.get("error") or "本机桌面授权已撤销")

    authorize()
    # A private sibling lets publication use an atomic same-volume no-replace operation.
    with tempfile.TemporaryDirectory(prefix=".soduwork-office-", dir=turn.workspace if writing else None) as directory:
        staged = Path(directory) / "workbook.xlsx"
        packet = {"operation": operation, "path": str(staged)}
        if writing:
            packet["rows"] = params["rows"]
        else:
            staged.write_bytes(_source(source))
        encoded = json.dumps(packet, ensure_ascii=False, allow_nan=False).encode() + b"\n"
        with channel.condition:
            if channel.closed or channel.stopping:
                raise ValueError("工作簿执行已取消")
            process = subprocess.Popen(turn.workbook, cwd=directory, env=child_environment(os.environ),
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            channel.office_processes.add(process)
        try:
            output, _ = process.communicate(encoded, timeout=20)
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()
            with channel.condition:
                channel.office_processes.discard(process)
        if process.returncode or len(output) > MAX_ROWS_BYTES * 3:
            raise ValueError("本机 Office 工具未完成工作簿操作")
        result = json.loads(output)
        if not isinstance(result, dict) or not isinstance(result.get("rows"), list):
            raise ValueError("本机 Office 工具未返回工作表数据")
        digest = hashlib.sha256(_source(staged)).hexdigest()
        if (result.get("sha256") != digest
                or writing and rows_digest(result["rows"]) != auth["sha256"]):
            raise ValueError("工作簿回读校验失败")
        if writing:
            authorize()
            with channel.condition:
                if channel.stopping or channel.closed or _path(turn, params)[0] != target:
                    raise ValueError("工作簿写入授权已失效")
                # os.rename on Windows refuses an existing target. POSIX rename would overwrite.
                if os.name == "nt":
                    staged.rename(target)
                else:
                    os.link(staged, target, follow_symlinks=False)
        return {"path": target.relative_to(turn.workspace).as_posix(), "sha256": digest, "rows": result["rows"]}
