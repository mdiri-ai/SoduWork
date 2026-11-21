"""Validation helpers for repository remotes accepted by execution workers."""
from __future__ import annotations

import re
from urllib.parse import urlsplit


_SCP_REMOTE = re.compile(r"^[^@\s/:]+@[^\s/:]+:[^\s]+$")
_HTTP_SCHEMES = {"http", "https", "ssh", "git"}


def validate_git_url(value) -> str:
    """Return a normalized remote URL or raise ``ValueError`` for local/script URLs."""
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError("gitUrl 必须是字符串")
    remote = value.strip()
    if not remote:
        return ""
    if _SCP_REMOTE.fullmatch(remote):
        if len(remote) > 512:
            raise ValueError("gitUrl 长度不能超过 512 个字符")
        return remote
    parsed = urlsplit(remote)
    scheme = parsed.scheme.lower()
    if scheme not in _HTTP_SCHEMES or not parsed.netloc:
        raise ValueError("gitUrl 只允许 http(s)、ssh 或 git 远程地址")
    if parsed.password or (parsed.username and not (scheme == "ssh" and parsed.username == "git")):
        raise ValueError("gitUrl 不允许携带账号或密码")
    if any(char.isspace() for char in remote):
        raise ValueError("gitUrl 不能包含空白字符")
    if len(remote) > 512:
        raise ValueError("gitUrl 长度不能超过 512 个字符")
    return remote
