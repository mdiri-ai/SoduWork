"""Per-user, explicitly installed Planning environments for the private desktop Runner."""
from __future__ import annotations

import contextlib
import json
import os
import queue
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

from . import planning_release as releases
from .planning_diagnostics import safe_text
from .planning_install_process import MAX_PROBE_REPLY, capture_process

# The same per-user lock is shared between all CLI processes and the installer.
# A turn keeps its Python environment until its ACP process has exited.
_ENTRY = '''import json, os
from pathlib import Path

generation = Path(__file__).resolve().parent
root = generation.parent.parent
with (root / "use.lock").open("r+b") as lease:
    if os.name == "nt":
        import ctypes
        import msvcrt
        from ctypes import wintypes
        class Overlapped(ctypes.Structure):
            _fields_ = [("internal", ctypes.c_size_t), ("internal_high", ctypes.c_size_t),
                        ("offset", wintypes.DWORD), ("offset_high", wintypes.DWORD),
                        ("event", wintypes.HANDLE)]
        # CRT read locks are exclusive. Win32 flags=0 permits concurrent ACP readers.
        lock = ctypes.WinDLL("kernel32", use_last_error=True).LockFileEx
        lock.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD,
                         wintypes.DWORD, ctypes.POINTER(Overlapped)]
        lock.restype = wintypes.BOOL
        if not lock(msvcrt.get_osfhandle(lease.fileno()), 0, 0, 1, 0, ctypes.byref(Overlapped())):
            raise ctypes.WinError(ctypes.get_last_error())
    else:
        import fcntl
        fcntl.flock(lease, fcntl.LOCK_SH)
    if json.loads((root / "active.json").read_text(encoding="utf-8"))["generation"] != generation.name:
        raise SystemExit("Planning installation changed. Retry the turn.")
    from soduwork_planning_harness.launch import main
    raise SystemExit(main())
'''


def root():
    from .local_base import _data_root
    return Path(_data_root()) / "managed-agents" / "ai-planning"


def _interpreter(generation):
    return generation / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def _console(generation):
    return generation / ("Scripts/planning-harness.exe" if os.name == "nt" else "bin/planning-harness")


def _record():
    try:
        value = json.loads((root() / "active.json").read_text(encoding="utf-8"))
        if (isinstance(value, dict) and re.fullmatch(r"[0-9a-f]{32}", value.get("generation", "")) and
                re.fullmatch(r"\d+\.\d+\.\d+", value.get("version", "")) and
                re.fullmatch(r"[0-9a-f]{64}", value.get("sha256", ""))):
            return value
    except (OSError, TypeError, ValueError):
        pass
    return {}


def installation():
    record = _record()
    if not record:
        return "", ""
    generation = root() / "versions" / record["generation"]
    path = _console(generation)
    ready = (path.is_file() and _interpreter(generation).is_file() and (generation / "entry.py").is_file()
             and (generation / "pyvenv.cfg").is_file())
    return (str(path) if ready else "", record["version"])


def command(executable):
    path, _ = installation()
    if not path or path != executable:
        raise RuntimeError("Planning Harness 尚未就绪，请在 Agent 管理中安装或更新")
    generation = Path(path).parent.parent
    return [str(_interpreter(generation)), "-I", "-B", "-u", str(generation / "entry.py")]


@contextlib.contextmanager
def _exclusive(path, busy):
    with path.open("a+b") as stream:
        if stream.tell() == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise ValueError(busy) from exc
        yield


def _environment():
    # A global pip configuration or inherited extra index can retarget even an
    # explicit index-url. Disable configuration files as well as environment overrides.
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(
        ("PIP_", "PYTHON", "UV_", "CONDA_", "DYLD_")) and k.upper() not in
        {"VIRTUAL_ENV", "LD_PRELOAD", "LD_LIBRARY_PATH", "_MEIPASS2", "_PYI_APPLICATION_HOME_DIR"}}
    env["PIP_CONFIG_FILE"] = os.devnull
    env["PIP_NO_INPUT"] = "1"
    env["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"
    # A PyInstaller process modifies DLL/library lookup. Its private runtime
    # libraries are not compatible with the desktop's standalone CPython.
    if os.environ.get("LD_LIBRARY_PATH_ORIG"):
        env["LD_LIBRARY_PATH"] = os.environ["LD_LIBRARY_PATH_ORIG"]
    return env


def _run(python, args, error, *, timeout=180, cwd=None):
    try:
        # The diagnostics reader uses UTF-8 on every desktop, including Windows.
        cmd = [str(python), "-I", "-B", "-X", "utf8", *map(str, args)]
        with capture_process(cmd, cwd=cwd, env=_environment()) as (process, _):
            try:
                code = process.wait(timeout=timeout)
            except subprocess.TimeoutExpired as exc:
                raise ValueError(f"{error}（超时 {timeout} 秒）") from exc
            if code:
                raise ValueError(f"{error}（退出码 {code}）")
    except OSError as exc:
        raise ValueError(error + system_error_code(exc)) from exc


def system_error_code(exc):
    winerror = getattr(exc, "winerror", None)
    if isinstance(winerror, int):
        return f"（WinError {winerror}）"
    return f"（errno {exc.errno}）" if isinstance(exc.errno, int) else ""


def _check_probe_reply(line, version):
    if isinstance(line, OSError):
        raise line
    if not line:
        raise ValueError("ACP process closed stdout before its initialize response")
    if len(line) > MAX_PROBE_REPLY:
        raise ValueError("ACP initialize response exceeds the size limit")
    reply = json.loads(line)
    if not isinstance(reply, dict) or reply.get("id") != 1:
        raise ValueError("Invalid ACP initialize response or request ID")
    error = reply.get("error")
    if isinstance(error, dict):
        # Retain the standard diagnostic fields only. error.data and other
        # fields can hold private state or even a complete protocol payload.
        code = error.get("code")
        label = "ACP initialize returned a JSON-RPC error"
        if type(code) is int and -(2**31) <= code < 2**31:
            label += f" (code {code})"
        message = error.get("message")
        if isinstance(message, str) and message:
            label += ": " + safe_text(message, limit=400)
        raise ValueError(label)
    result = reply.get("result")
    if not isinstance(result, dict) or result.get("protocolVersion") != 1:
        raise ValueError("ACP protocol version mismatch")
    agent = result.get("agentInfo")
    if not isinstance(agent, dict) or agent.get("name") != "planning-harness" or agent.get("version") != version:
        raise ValueError("ACP identity mismatch")


def _handshake(python, version, state):
    args = [str(python), "-I", "-B", "-X", "utf8", "-u", "-m", releases.MODULE + ".launch", "acp"]
    env = {**_environment(), "PLANNING_STATE_DIR": str(Path(state).resolve())}
    try:
        with capture_process(args, env=env, cwd=state, probe=True) as (process, response):
            request = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                       "params": {"protocolVersion": 1, "clientCapabilities": {}}}
            process.stdin.write((json.dumps(request) + "\n").encode("utf-8"))
            process.stdin.flush()
            try:
                line = response.get(timeout=25)
            except queue.Empty as exc:
                raise ValueError("ACP initialize timed out after 25 seconds") from exc
            _check_probe_reply(line, version)
    except (ValueError, RecursionError, OSError) as exc:
        raise ValueError("已下载的软件包未通过本机 Planning ACP 握手") from exc


def _remove_probe(state):
    for attempt in range(5):
        try:
            shutil.rmtree(state)
            return
        except OSError as exc:
            code = getattr(exc, "winerror", None)
            if code not in (32, 33):
                raise
            if attempt == 4:
                raise ValueError(f"Planning ACP 握手状态目录仍被占用（WinError {code}），请稍后重试") from exc
            time.sleep(0.1 * 2 ** attempt)


def _download(python, dest, lock, group, index):
    file = dest.parent / (group + ".txt")
    file.write_text("\n".join(lock) + "\n", encoding="utf-8")
    _run(python, ["-m", "pip", "download", "--no-deps", "--only-binary=:all:", "--require-hashes",
                  "--no-cache-dir", "--keyring-provider", "disabled", "--timeout", "25", "--retries", "2",
                  "--index-url", index, "--dest", dest, "-r", file], "软件源下载或 SHA-256 校验失败：" + group,
         timeout=900)
    return file


def _bootstrap_python():
    configured = os.environ.get("SODUWORK_MANAGED_PYTHON", "")
    source = (not configured and os.environ.get("SODUWORK_RUNTIME_MANAGED") != "1"
              and os.environ.get("SODUWORK_SOURCE_SESSION") == "1")
    python = Path(os.environ.get("SODUWORK_SOURCE_RUNNER_PYTHON", "") if source else configured)
    if not python.is_absolute() or not python.is_file():
        if source:
            raise ValueError("未找到源码启动器的 Python 环境，请使用 CPython 3.12 启动 SoduWork")
        raise ValueError("未找到 SoduWork 随附的 Python 3.12，请修复客户端运行环境")
    _run(python, ["-c", "import sys;sys.exit(sys.implementation.name != 'cpython' or sys.version_info[:2] != (3,12))"],
         "源码启动 Planning 需要使用 CPython 3.12 创建启动器环境" if source else "Planning 需要客户端随附的 CPython 3.12")
    return python


def _prepare(generation, release, say):
    managed = _bootstrap_python()
    say("正在创建独立 Python 环境")
    _run(managed, ["-m", "venv", generation], "无法创建用于 Planning 的独立 Python 环境")
    python = _interpreter(generation)
    with tempfile.TemporaryDirectory(dir=root(), prefix="download-") as stage:
        dest = Path(stage) / "wheels"
        dest.mkdir()
        source = releases.index_url()
        say("正在校验企业软件包和锁定的依赖")
        main = _download(python, dest, [f"{releases.NAME}=={release.version} --hash=sha256:{release.sha256}"],
                         "harness", source)
        private, public = releases.dependency_locks(dest / release.filename, release)
        locks = [main, _download(python, dest, private, "company", source)]
        if public:
            locks.append(_download(python, dest, public, "public", releases.index_url(public=True)))
        args = ["-m", "pip", "install", "--no-index", "--no-deps", "--only-binary=:all:", "--require-hashes",
                "--find-links", dest, "--no-compile"]
        for lock in locks:
            args.extend(["-r", lock])
        _run(python, args, "无法从已校验的 wheel 安装 Planning", timeout=600)
    _run(python, ["-m", "pip", "check"], "Planning 软件包依赖不完整")
    say("正在校验本机 ACP 接口")
    state = tempfile.mkdtemp(dir=generation, prefix="probe-")
    try:
        _handshake(python, release.version, state)
    finally:
        _remove_probe(state)
    (generation / "entry.py").write_text(_ENTRY, encoding="utf-8")


def _prune(versions, keep=""):
    removed = True
    if versions.is_dir():
        for path in versions.iterdir():
            if re.fullmatch(r"[0-9a-f]{32}", path.name) and path.name != keep:
                try:
                    shutil.rmtree(path)
                except OSError:
                    # Activation/deactivation is already committed. A later operation can retry cleanup.
                    removed = False
    return removed


def install(action, say):
    if action not in {"install", "update", "uninstall", "check"}:
        raise ValueError("Planning 安装操作无效")
    directory = root()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    versions = directory / "versions"
    use = directory / "use.lock"
    active = directory / "active.json"
    busy = "Planning 会话正在运行，请结束当前任务后重试"
    with _exclusive(directory / "manage.lock", "另一项 Planning 管理操作正在进行"):
        if action == "uninstall":
            with _exclusive(use, busy):
                active.unlink(missing_ok=True)
                if not _prune(versions):
                    return "Planning Harness 已卸载；部分旧环境仍被系统占用，稍后再次卸载可清理"
            return "Planning Harness 已卸载"
        release = releases.latest()
        _, current = installation()
        if action == "check":
            return f"本机版本：{current or '未安装'}；企业可用版本：{release.version}"
        previous = _record()
        if previous.get("version") == release.version and previous.get("sha256") != release.sha256:
            raise ValueError("同一 Planning 版本的制品摘要已改变，请联系发行管理员")
        if current and tuple(map(int, current.split("."))) > tuple(map(int, release.version.split("."))):
            raise ValueError("企业源版本低于当前安装版本，本次保留当前版本")
        # Fail early if busy. Recheck at activation because a turn may start while downloading.
        with _exclusive(use, busy):
            pass
        version_id = uuid.uuid4().hex
        generation = versions / version_id
        generation.mkdir(parents=True, mode=0o700)
        try:
            _prepare(generation, release, say)
            with _exclusive(use, busy):
                say("正在激活已通过 ACP 校验的 Planning 环境")
                record = {"generation": version_id, "version": release.version, "sha256": release.sha256}
                temp = directory / (version_id + ".tmp")
                try:
                    temp.write_text(json.dumps(record), encoding="utf-8")
                    os.replace(temp, active)
                finally:
                    temp.unlink(missing_ok=True)
                if not _prune(versions, version_id):
                    say("部分旧环境仍被系统占用，下次管理操作会重试清理")
            return "Planning Harness " + release.version + " 已安装并通过 ACP 握手"
        finally:
            if _record().get("generation") != version_id:
                shutil.rmtree(generation, ignore_errors=True)
