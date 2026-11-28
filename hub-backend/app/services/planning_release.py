"""Read the approved enterprise release and its hash-locked binary dependencies."""
from __future__ import annotations

import hashlib
import json
import netrc
import os
import re
import zipfile
from dataclasses import dataclass
from email.parser import BytesParser
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import (
    parse_qs,
    unquote,
    urldefrag,
    urlencode,
    urljoin,
    urlsplit,
    urlunsplit,
)

import httpx

NAME = "soduwork-planning-harness"
MODULE = "soduwork_planning_harness"
_GATE = re.compile(r"soduwork_planning_harness-(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-py3-none-any\.whl")
_DIGEST = re.compile(r"[0-9a-fA-F]{64}")
_KNOWN = {"0.2.0": "75fabf2ea7687cd622ccdbfa445c1614255a43bb303e324c5e6745ef7bc7f7f3"}


@dataclass(frozen=True)
class Release:
    version: str
    sha256: str

    @property
    def filename(self):
        return f"{MODULE}-{self.version}-py3-none-any.whl"


def index_url(public=False):
    value = (os.environ.get("SODUWORK_PLANNING_PUBLIC_INDEX_URL", "https://pypi.org/simple/") if public
             else os.environ.get("SODUWORK_PLANNING_INDEX_URL", "")).strip()
    if not value:
        raise ValueError("请先配置企业 Planning 软件源（SODUWORK_PLANNING_INDEX_URL）")
    url = urlsplit(value)
    if (url.scheme != "https" or not url.hostname or url.username is not None or url.password is not None
            or url.query or url.fragment or any(c.isspace() for c in value)):
        raise ValueError("Planning 软件源必须是没有账号、密码和查询参数的 HTTPS simple 索引")
    return value.rstrip("/") + "/"


class _Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []

    def handle_starttag(self, tag, attrs):
        fields = dict(attrs)
        if tag == "a" and fields.get("href") and "data-yanked" not in fields:
            self.links.append(fields["href"])


def _read(url, limit, accept="text/html, text/plain"):
    parsed = urlsplit(url)
    try:
        credentials = netrc.netrc(os.environ.get("NETRC") or None).authenticators(parsed.hostname)
    except FileNotFoundError:
        credentials = None
    except (OSError, netrc.NetrcParseError) as exc:
        raise ValueError("无法读取当前用户的软件源认证配置") from exc
    auth = (credentials[0], credentials[2]) if credentials else None
    # Do not forward authentication through redirects to another repository.
    try:
        with httpx.stream("GET", url, auth=auth, follow_redirects=False, timeout=20,
                          headers={"Accept": accept}) as response:
            response.raise_for_status()
            data = bytearray()
            for chunk in response.iter_bytes(8192):
                data.extend(chunk)
                if len(data) > limit:
                    raise ValueError("企业软件源返回的索引过大")
            return data.decode("utf-8")
    except httpx.HTTPError as exc:
        raise ValueError("无法访问企业 Planning 软件源，请检查网络、读权限和索引地址") from exc


def _asset_digest(index, version, href):
    url = urlsplit(index)
    path = re.fullmatch(r"(.*)/repository/([^/]+)/simple/?", url.path)
    if path:
        endpoint = urlunsplit((url.scheme, url.netloc, path[1] + "/service/rest/v1/search/assets", "", ""))
        query = {"repository": path[2], "name": NAME, "version": version}
        # TLS-terminating Nexus proxies can advertise the same asset with an HTTP
        # scheme. That field identifies a checksum; it is never a download URL here.
        asset_urls = (href, urlsplit(href)._replace(scheme="http").geturl())
        seen = set()
        while True:
            response = json.loads(_read(endpoint + "?" + urlencode(query), 2_000_000, "application/json"))
            for item in response.get("items") or ():
                if item.get("repository") == path[2] and item.get("downloadUrl") in asset_urls:
                    digest = (item.get("checksum") or {}).get("sha256", "")
                    if isinstance(digest, str) and _DIGEST.fullmatch(digest):
                        return digest.lower()
            token = response.get("continuationToken")
            if not isinstance(token, str) or not token or token in seen or len(seen) >= 20:
                break
            seen.add(token)
            query["continuationToken"] = token
        raise ValueError("企业 Nexus 未返回该制品的 SHA-256，请检查发布记录")
    return _read(href + ".sha256", 4096).strip().split(" ", 1)[0].lower()


def latest():
    index = index_url()
    project = urljoin(index, NAME + "/")
    page = _Links()
    page.feed(_read(project, 2_000_000))
    releases = {}
    for link in page.links:
        href, fragment = urldefrag(urljoin(project, link))
        parsed = urlsplit(href)
        match = _GATE.fullmatch(unquote(parsed.path.rsplit("/", 1)[-1]))
        if not match:
            continue
        if parsed.netloc != urlsplit(project).netloc or parsed.scheme != "https" or parsed.query:
            raise ValueError("企业 Planning 软件源包含了其他来源的软件包")
        version = tuple(map(int, match.groups()))
        digests = parse_qs(fragment).get("sha256", [])
        if digests and (len(digests) != 1 or not _DIGEST.fullmatch(digests[0])):
            raise ValueError("企业 Planning 软件源的 SHA-256 无效")
        entry = (href, digests[0].lower() if digests else "")
        if version in releases and releases[version] != entry:
            raise ValueError("同一 Planning 版本存在不一致的制品")
        releases[version] = entry
    if not releases:
        raise ValueError("企业软件源尚未发布可安装的 Planning 稳定版")
    newest = max(releases)
    version = ".".join(map(str, newest))
    href, digest = releases[newest]
    if not digest:
        digest = _asset_digest(index, version, href)
    if not _DIGEST.fullmatch(digest) or version in _KNOWN and digest != _KNOWN[version]:
        raise ValueError("Planning 制品缺少可信 SHA-256 或与已核准版本不一致")
    return Release(version, digest)


def dependency_locks(wheel: Path, release: Release):
    with wheel.open("rb") as file:
        if hashlib.file_digest(file, "sha256").hexdigest() != release.sha256:
            raise ValueError("Planning 软件包 SHA-256 校验失败")
        with zipfile.ZipFile(file) as archive:
            info = BytesParser().parsebytes(archive.read(f"{MODULE}-{release.version}.dist-info/METADATA"))
            manifest = json.loads(archive.read(f"{MODULE}/manifest.json"))
            if (info.get_all("Name") != [NAME] or info.get_all("Version") != [release.version]
                    or info.get_all("Author") != ["yicheng.qiao"] or manifest.get("distribution") != NAME
                    or manifest.get("harnessId") != "ai-planning" or manifest.get("version") != release.version
                    or any(type(manifest.get(key)) is not int or manifest[key] != 1 for key in
                           ("schema", "protocolVersion", "hostExtensionVersion"))):
                raise ValueError("Planning 软件包元数据或协议版本与客户端不匹配")
            lock = archive.read(f"{MODULE}/requirements.lock").decode("utf-8")
    private, public, names = [], [], set()
    for line in lock.replace("\\\n", " ").splitlines():
        if not line.strip():
            continue
        declaration, *hashes = re.split(r"\s+--hash=sha256:", line.strip())
        match = re.fullmatch(r"([a-z0-9][a-z0-9._-]*)(?:\[[a-z0-9.,-]+\])?==[a-zA-Z0-9.][a-zA-Z0-9.+!-]*"
                             r"(?:\s*;[a-zA-Z0-9_'\x22 ().=!<>-]+)?", declaration.strip())
        if not match or not hashes or not all(_DIGEST.fullmatch(item.strip()) for item in hashes):
            raise ValueError("Planning 依赖必须逐项固定名称、版本和 SHA-256")
        name = re.sub(r"[-_.]+", "-", match[1])
        if name in names:
            raise ValueError("Planning 依赖名称重复")
        names.add(name)
        destination = private if name.startswith(("mdiri-", "soduwork-", "allin-")) else public
        destination.append(line.strip())
    if "mdiri-agent-base" not in names:
        raise ValueError("Planning 软件包未声明已校验的 Agent Base 依赖")
    return private, public
