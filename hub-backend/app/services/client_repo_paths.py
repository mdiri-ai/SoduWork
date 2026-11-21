"""Per-device mapping from a Git repository URL to the member's local checkout path.

方案二 of issue #495: a requirement binds a repository, and each member keeps their own
``git URL -> absolute local path`` mapping so the same requirement resolves to the right
directory on every device. Mappings live in ``Client.config['repoPaths']`` (a device-scoped
JSON slot), so no schema migration is needed and quota/account resets already clear them.
"""
from __future__ import annotations

import os
import re
from urllib.parse import urlsplit

from fastapi import HTTPException

from ..models import Client

_CONFIG_KEY = "repoPaths"
_MAX_ENTRIES = 200
_MAX_URL = 512
_MAX_PATH = 700
_WINDOWS_DRIVE = re.compile(r"^[A-Za-z]:[\\/]")
_UNC = re.compile(r"^[\\/]{2}")


def canonical_repo_url(value) -> str:
    """Normalize a Git URL so equivalent forms share one mapping key."""
    raw = str(value or "").strip()
    if not raw or len(raw) > _MAX_URL:
        raise HTTPException(422, "仓库地址无效")
    parsed = urlsplit(raw)
    key = raw.rstrip("/")
    if parsed.scheme in ("http", "https", "ssh", "git"):
        host = (parsed.hostname or "").lower()
        path = parsed.path.rstrip("/")
        if path.endswith(".git"):
            path = path[:-4]
        if not host:
            raise HTTPException(422, "仓库地址缺少主机")
        suffix = ":" + str(parsed.port) if parsed.port else ""
        key = f"{parsed.scheme}://{host}{suffix}{path}"
    else:
        # scp-style git@host:owner/repo.git and local aliases: case-insensitive host is
        # irrelevant here, keep the literal form but trim a trailing .git for stability.
        key = key[:-4] if key.endswith(".git") else key
    return key[:_MAX_URL]


def validate_local_path(value) -> str:
    """Accept an absolute local directory only; never allow a relative path on a device."""
    raw = str(value or "").strip()
    if not raw or len(raw) > _MAX_PATH:
        raise HTTPException(422, "本地路径无效")
    if "\x00" in raw:
        raise HTTPException(422, "本地路径包含非法字符")
    if not (os.path.isabs(raw) or _WINDOWS_DRIVE.match(raw) or _UNC.match(raw)):
        raise HTTPException(422, "本地路径必须是绝对路径")
    # A mapped directory may be anywhere the member chooses, but traversal segments would
    # make the reported path ambiguous across platforms; reject them.
    normalized = raw.replace("\\", "/")
    if any(part == ".." for part in normalized.split("/")):
        raise HTTPException(422, "本地路径不能包含 ..")
    return raw


def _config(client: Client) -> dict:
    value = getattr(client, "config", None)
    if not isinstance(value, dict):
        value = {}
        client.config = value
    return value


def list_paths(client: Client) -> list[dict]:
    rows = _config(client).get(_CONFIG_KEY)
    if not isinstance(rows, list):
        return []
    return [dict(row) for row in rows if isinstance(row, dict) and row.get("gitUrl") and row.get("localPath")]


def set_path(client: Client, git_url, local_path) -> list[dict]:
    url = canonical_repo_url(git_url)
    path = validate_local_path(local_path)
    rows = [row for row in list_paths(client) if row.get("gitUrl") != url]
    rows.append({"gitUrl": url, "localPath": path})
    if len(rows) > _MAX_ENTRIES:
        raise HTTPException(422, "仓库路径映射数量超出上限")
    rows.sort(key=lambda row: row["gitUrl"])
    cfg = _config(client)
    cfg[_CONFIG_KEY] = rows
    client.config = cfg  # force SQLAlchemy JSON mutation tracking
    return rows


def remove_path(client: Client, git_url) -> list[dict]:
    url = canonical_repo_url(git_url)
    rows = [row for row in list_paths(client) if row.get("gitUrl") != url]
    cfg = _config(client)
    if rows:
        cfg[_CONFIG_KEY] = rows
    else:
        cfg.pop(_CONFIG_KEY, None)
    client.config = cfg
    return rows


def resolve_path(client: Client, git_url) -> str:
    """Return the mapped local path for a repository, or an empty string when unmapped."""
    if not git_url:
        return ""
    url = canonical_repo_url(git_url)
    for row in list_paths(client):
        if row.get("gitUrl") == url:
            return str(row.get("localPath") or "")
    return ""
