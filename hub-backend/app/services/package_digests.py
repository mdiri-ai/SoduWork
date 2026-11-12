"""Versioned file-tree identity, independent of ZIP metadata.

v2 frames each UTF-8 path and arbitrary file payload with unsigned 64-bit
big-endian lengths. A domain and file count precede the sorted entries. Unlike
NUL-delimited concatenation, payload bytes cannot impersonate another entry.
Keep the digest as 64 hex characters for existing database/API contracts.
"""
from __future__ import annotations

import hashlib
from collections.abc import Callable, Iterable

ALGORITHM = "sha256-file-tree-v2"
CACHE_VERSION = "v2"
PLUGIN_IDENTITY_ERROR = (
    "插件包校验失败：内容已变化或使用旧版文件摘要。原包已保留；"
    "请核对原始来源、提升插件版本号后重新导入；签名包须由发布者重新签发 v2 签名。")
SKILL_IDENTITY_ERROR = (
    "Skill 包校验失败：内容已变化或使用旧版文件摘要。原文件已保留；"
    "请核对原始来源后重新导入完整 Skill，并重新提交需要共享的版本。")


def file_tree_digest(names: Iterable[str], read: Callable[[str], bytes]) -> str:
    paths = sorted(names)
    digest = hashlib.sha256(b"soduwork.file-tree/v2\0")
    digest.update(len(paths).to_bytes(8, "big"))
    for name in paths:
        path = name.encode("utf-8")
        content = read(name)
        digest.update(len(path).to_bytes(8, "big"))
        digest.update(path)
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return digest.hexdigest()


def assert_plugin_checksum(parsed: dict, expected: str) -> None:
    if parsed.get("checksum") != expected:
        raise ValueError(PLUGIN_IDENTITY_ERROR)
