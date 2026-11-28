"""Safe failure details shared by the Planning install job and Runner log."""
import netrc
import os
import re
import subprocess

from ..log_safety import redact_log_text

_URL = re.compile(r"(?i)\b(?:https?|socks5h?)://[^\s<>\"']+")
_QUERY = re.compile(r"""[?&][\w.%~-]+=[^\s<>"']*""")
_KEY = r"(?:[\w-]{1,64}[_-])?(?:password|passwd|secret|token|api[_-]?key|credential|authorization)"
_ASSIGNMENT = re.compile(
    rf"""(?ix)(\b{_KEY}["']?[ \t]*[:=][ \t]*|--{_KEY}[ \t]+)"""
    r"""(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|[^\s,;]+)"""
)
_HEADER = re.compile(r"(?im)(\b(?:authorization|cookie|set-cookie)[ \t]*[:=])[ \t]*[^\n]*")
_AUTH = re.compile(r"(?i)\b(Bearer|Basic|Device)[ \t]+[\w.~+/=-]+")
_PRIVATE_KEY = re.compile(r"-----BEGIN [\w ]*PRIVATE KEY-----.*?(?:-----END [\w ]*PRIVATE KEY-----|\Z)", re.S)
_TOKEN = re.compile(r"\b(?:sk-|gh[pousr]_|github_pat_|pypi-)[A-Za-z0-9_-]{12,}")
_ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
_SECRET_ENV = re.compile(r"(?i)(?:^|_)(?:password|passwd|token|secret|key|credential)$")


def safe_text(value, limit=2048):
    """Redact before clipping, so a length boundary cannot split a credential."""
    text = str(value).replace("\r\n", "\n").replace("\r", "\n")
    text = _CONTROL.sub("", _ANSI.sub("", text))
    # Index and proxy URLs can include userinfo, signed paths and query parameters.
    text = _URL.sub("<url>", text)
    # urllib3 retries sometimes report only a relative request target.
    text = _QUERY.sub("?<redacted>", text)
    text = _PRIVATE_KEY.sub("<redacted>", text)
    text = _HEADER.sub(r"\1 <redacted>", text)
    text = _AUTH.sub(r"\1 <redacted>", text)
    text = _ASSIGNMENT.sub(r"\1<redacted>", text)
    text = _TOKEN.sub("<redacted>", redact_log_text(text))
    # Child errors occasionally echo the value of an environment variable by itself.
    for name, secret in os.environ.items():
        if len(secret) >= 4 and _SECRET_ENV.search(name):
            text = text.replace(secret, "<redacted>")
    return text.strip()[:limit]


def safe_exception_chain(exc):
    """Keep exception types, reasons and subprocess notes without serializing argv."""
    lines = []
    seen = set()
    relation = ""
    while exc is not None and id(exc) not in seen and len(seen) < 8:
        seen.add(id(exc))
        if isinstance(exc, subprocess.TimeoutExpired):
            reason = f"timeout {exc.timeout}s"
        elif isinstance(exc, subprocess.CalledProcessError):
            reason = f"exit code {exc.returncode}"
        elif isinstance(exc, netrc.NetrcParseError):
            # The parser can include an unrecognised token from the credentials file.
            reason = f"invalid netrc entry on line {exc.lineno}"
        else:
            reason = safe_text(exc, limit=600)
        lines.append(f"{relation}{type(exc).__name__}: {reason}")
        for note in getattr(exc, "__notes__", ())[:4]:
            lines.append(safe_text(note, limit=3072))
        if exc.__cause__ is not None:
            relation, exc = "Caused by ", exc.__cause__
        else:
            relation, exc = "During handling of ", None if exc.__suppress_context__ else exc.__context__
    return "\n".join(lines)
