"""Drain Planning installer diagnostics while keeping ACP stdout for its protocol."""
from __future__ import annotations

import contextlib
import errno
import os
import queue
import subprocess
import threading

from .acp_process import OwnedProcessGroup, close_process
from .planning_diagnostics import safe_text

_TAIL_BYTES = 2048
_LOG_LINES = 12
MAX_PROBE_REPLY = 1024 * 1024


class _OutputTail:
    def __init__(self):
        self.data = bytearray()
        self.partial = False
        self.truncated = False

    def drain(self, stream):
        while chunk := stream.read1(8192):
            self.data.extend(chunk)
            excess = len(self.data) - _TAIL_BYTES
            if excess > 0:
                self.truncated = True
                self.partial = self.data[excess - 1] != ord("\n")
                del self.data[:excess]

    def note(self, exc, label):
        # A retained suffix of a long line may have lost its Authorization
        # header or URL scheme. Redact only complete diagnostic lines.
        data = self.data.partition(b"\n")[2] if self.partial else self.data
        text = safe_text(data.decode("utf-8", errors="replace"), limit=_TAIL_BYTES * 4)
        lines = text.splitlines()
        tail = "\n".join(lines[-_LOG_LINES:])
        omitted = self.truncated or len(lines) > _LOG_LINES or len(tail) > _TAIL_BYTES
        if tail or omitted:
            prefix = "[earlier output omitted]\n" if omitted else ""
            exc.add_note(f"{label}: {prefix}{tail[-_TAIL_BYTES:]}".rstrip())


def _read_reply(stream, reply):
    try:
        reply.put(stream.readline(MAX_PROBE_REPLY + 1))
    except OSError as exc:
        reply.put(exc)
        return
    # A peer may emit more output on shutdown. Drain it without recording frames.
    while stream.read1(8192):
        pass


def _finish_probe(process):
    # The Windows venv launcher can precede the interpreter. EOF lets the
    # harness release its SQLite files before the installer removes the probe.
    try:
        process.stdin.close()
    except OSError as exc:
        if not isinstance(exc, BrokenPipeError) and not (os.name == "nt" and exc.errno == errno.EINVAL):
            raise
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        pass


@contextlib.contextmanager
def capture_process(args, *, env, cwd, probe=False):
    process = subprocess.Popen(args, env=env, cwd=cwd, stdin=subprocess.PIPE if probe else subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=os.name != "nt",
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    group = OwnedProcessGroup(process.pid) if os.name != "nt" else None
    readers = []
    tails = {}
    reply = queue.Queue(maxsize=1) if probe else None
    try:
        with contextlib.ExitStack() as cleanup:
            cleanup.callback(close_process, process, readers, group)
            if probe:
                cleanup.callback(_finish_probe, process)
            for label, stream in (("stdout", process.stdout), ("stderr", process.stderr)):
                if probe and label == "stdout":
                    reader = threading.Thread(target=_read_reply, args=(stream, reply), daemon=True)
                else:
                    tails[label] = _OutputTail()
                    reader = threading.Thread(target=tails[label].drain, args=(stream,), daemon=True)
                reader.start()
                readers.append(reader)
            yield process, reply
    except Exception as exc:
        if probe and process.returncode:
            exc.add_note(f"ACP probe exit code: {process.returncode}")
        for label, tail in tails.items():
            tail.note(exc, label)
        raise
