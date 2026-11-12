"""Immutable Agent Skill bundles transferred from Hub to a remote Runner."""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import stat
import unicodedata
import uuid
import zipfile
from collections import OrderedDict

from .immutable_cache import publish_immutable_tree
from .local_base import _data_root
from . import package_digests, skill_content, skill_frontmatter

_MAX_FILES = 300
_MAX_BYTES = 30 * 1024 * 1024
_CACHE: OrderedDict[str, bytes] = OrderedDict()


def _safe_name(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", str(value or "")).strip(".-")[:50]
    return value or "skill"


def _zip_info(name: str, mode: int = 0o644) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = (mode & 0o777) << 16
    return info


def _cache_key(items: list[dict]) -> str:
    identity = [{"name": x.get("name"), "contentDigest": x.get("contentDigest"), "checksum": (
        x.get("pluginChecksum") or x.get("packageChecksum") or x.get("bundleChecksum"))}
                for x in items]
    return hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()


def _metadata(data: bytes, name: str) -> dict:
    meta = skill_frontmatter.parse(data, source=name + "/SKILL.md")
    if meta["name"] != name:
        raise ValueError(name + "/SKILL.md: name 与技能包清单不一致")
    return meta


def _read_metadata(folder: str, name: str) -> dict:
    try:
        with open(os.path.join(folder, "SKILL.md"), "rb") as source:
            return _metadata(source.read(), name)
    except OSError as exc:
        raise ValueError(name + "/SKILL.md: 技能文件不可读取，请重新导入") from exc


def build(items: list[dict]) -> bytes:
    """Create a deterministic, path-free zip for bundled skills only."""
    selected = [x for x in (items or []) if x.get("bundled") and os.path.isdir(x.get("path", ""))]
    if not selected:
        return b""
    # Snapshot and validate every source before an in-memory cache hit. Historic
    # identities can be ambiguous; neither a label nor another owner's cache is
    # authority for these bytes. Serialize the same snapshot that was hashed.
    snapshots, snapshot_bytes, snapshot_files = [], 0, 0
    for item in selected:
        snapshot = skill_content.read_files(str(item["path"]))
        snapshot_bytes += sum(len(content) for content in snapshot.values())
        snapshot_files += len(snapshot)
        if snapshot_files > _MAX_FILES or snapshot_bytes > _MAX_BYTES:
            raise ValueError("插件技能文件过多或超过 30MB")
        snapshots.append(snapshot)
    metadata = [_metadata(files["SKILL.md"], str(item.get("name") or ""))
                for item, files in zip(selected, snapshots)]
    identities = []
    for item, snapshot in zip(selected, snapshots):
        digest = package_digests.file_tree_digest(snapshot, snapshot.__getitem__)
        if item.get("packageChecksum") and item["packageChecksum"] != digest:
            raise ValueError(package_digests.SKILL_IDENTITY_ERROR)
        identities.append({**item, "contentDigest": digest})
    key = _cache_key(identities)
    cached = _CACHE.get(key)
    if cached is not None:
        _CACHE.move_to_end(key)
        return cached

    entries, files, total = [], [], 0
    seen = set()
    for index, item in enumerate(selected):
        name = str(item.get("name") or "")
        if not name or name in seen:
            raise ValueError("插件技能名称为空或重复")
        seen.add(name)
        source = os.path.abspath(str(item.get("path") or ""))
        folder = "%02d-%s" % (index, _safe_name(name))
        entries.append({
            "name": name, "description": metadata[index]["description"],
            "compatibility": metadata[index]["compatibility"],
            "version": str(item.get("pluginChecksum") or item.get("packageChecksum") or
                           item.get("bundleChecksum") or "")[:64],
            "dir": folder,
        })
        for relative, content in snapshots[index].items():
            path = os.path.join(source, *relative.split("/"))
            total += len(content)
            mode = stat.S_IMODE(os.stat(path).st_mode) or 0o644
            files.append(("skills/%s/%s" % (folder, relative), content, mode))
            if len(files) > _MAX_FILES or total > _MAX_BYTES:
                raise ValueError("插件技能文件过多或超过 30MB")
    if not any(path.endswith("/SKILL.md") for path, _, _ in files):
        raise ValueError("插件技能缺少 SKILL.md")
    manifest = json.dumps({"schemaVersion": 1, "skills": entries},
                          ensure_ascii=False, sort_keys=True).encode("utf-8")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(_zip_info("manifest.json"), manifest)
        for name, content, mode in sorted(files, key=lambda x: x[0]):
            archive.writestr(_zip_info(name, mode), content)
    data = buffer.getvalue()
    _CACHE[key] = data
    while len(_CACHE) > 4:
        _CACHE.popitem(last=False)
    return data


def _safe_info(info: zipfile.ZipInfo) -> bool:
    name = info.filename.replace("\\", "/")
    mode = (info.external_attr >> 16) & 0xFFFF
    return bool(name) and not name.startswith("/") and not re.match(r"^[A-Za-z]:", name) \
        and all(x not in ("", ".", "..") for x in name.rstrip("/").split("/")) \
        and not stat.S_ISLNK(mode)


def install(data: bytes, expected_sha256: str = "") -> list[dict]:
    """Verify and atomically materialize a bundle received by a Runner."""
    if not data or len(data) > _MAX_BYTES:
        raise ValueError("插件技能包为空或超过 30MB")
    digest = hashlib.sha256(data).hexdigest()
    if expected_sha256 and digest != expected_sha256:
        raise ValueError("插件技能包完整性校验失败")
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise ValueError("插件技能包不是有效的 zip") from exc
    infos = archive.infolist()
    if len(infos) > _MAX_FILES + 1 or sum(x.file_size for x in infos) > _MAX_BYTES:
        raise ValueError("插件技能包文件过多或解压后超过 30MB")
    if any(not _safe_info(x) for x in infos):
        raise ValueError("插件技能包包含不安全路径")
    paths = [unicodedata.normalize("NFC", x.filename.replace("\\", "/")).rstrip("/").casefold()
             for x in infos]
    if len(set(paths)) != len(paths):
        raise ValueError("插件技能包包含重复或跨平台冲突路径")
    try:
        manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
    except (KeyError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("插件技能包清单无效") from exc
    skills = manifest.get("skills") if isinstance(manifest, dict) else None
    if not isinstance(skills, list) or not skills:
        raise ValueError("插件技能包没有技能")
    seen_names, seen_dirs = set(), set()
    for item in skills:
        folder = str(item.get("dir") or "") if isinstance(item, dict) else ""
        name = str(item.get("name") or "") if isinstance(item, dict) else ""
        if not folder or folder != _safe_name(folder) or folder in seen_dirs or not name or name in seen_names:
            raise ValueError("插件技能名称或目录为空、重复或不合法")
        seen_names.add(name)
        seen_dirs.add(folder)
        try:
            _metadata(archive.read("skills/" + folder + "/SKILL.md"), name)
        except KeyError as exc:
            raise ValueError(name + "/SKILL.md: 插件技能包缺少技能文件") from exc

    parent = os.path.join(_data_root(), "runner-plugin-skills", package_digests.CACHE_VERSION)
    target = os.path.join(parent, digest)
    ready = os.path.join(target, ".ready")
    if not os.path.isfile(ready):
        os.makedirs(parent, exist_ok=True)
        tmp = target + ".tmp-" + uuid.uuid4().hex[:10]
        try:
            os.makedirs(tmp, exist_ok=False)
            for info in infos:
                if info.is_dir():
                    continue
                destination = os.path.abspath(os.path.join(tmp, *info.filename.split("/")))
                if os.path.commonpath([os.path.abspath(tmp), destination]) != os.path.abspath(tmp):
                    raise ValueError("插件技能包包含越界路径")
                os.makedirs(os.path.dirname(destination), exist_ok=True)
                with archive.open(info) as source, open(destination, "wb") as dest:
                    shutil.copyfileobj(source, dest)
                mode = (info.external_attr >> 16) & 0o777
                if mode:
                    try:
                        os.chmod(destination, mode)
                    except OSError:
                        pass
            for item in skills:
                _read_metadata(os.path.join(tmp, "skills", item["dir"]), item["name"])
            with open(os.path.join(tmp, ".ready"), "w", encoding="utf-8") as marker:
                marker.write(digest)
            publish_immutable_tree(tmp, target, ready)
        finally:
            if os.path.isdir(tmp):
                shutil.rmtree(tmp, ignore_errors=True)
    try:
        with open(ready, "r", encoding="utf-8") as marker:
            if marker.read().strip() != digest:
                raise ValueError("插件技能缓存校验失败，请重新导入这个版本")
    except OSError as exc:
        raise ValueError("插件技能缓存不可读取，请重新导入这个版本") from exc
    out = []
    for item in skills:
        folder = item["dir"]
        path = os.path.join(target, "skills", folder)
        meta = _read_metadata(path, item["name"])
        out.append({
            "name": meta["name"], "description": meta["description"],
            "compatibility": meta["compatibility"],
            "version": str(item.get("version") or "")[:64],
            "path": path, "root": os.path.join(target, "skills"), "dir": folder,
            "bundled": True, "bundleChecksum": digest,
        })
    from .skill_read_scope import trusted
    return trusted(out)
