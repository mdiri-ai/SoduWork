"""Task attachment storage abstraction. Use configured MinIO or the local uploads directory; APIs
use put/get/delete without storing binary data in the database. Persist the selected backend
with each object.
"""
import hashlib
import os
import re
import shutil
import tempfile
from io import BytesIO

from ..config import get_settings

# Local fallback directory: hub-backend/uploads/.
_LOCAL_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "uploads")

_minio_client = None


def backend_name() -> str:
    return "minio" if get_settings().minio_endpoint else "local"


def _client():
    """Create the MinIO client lazily only when configured, keeping local storage independent of
    that dependency.
    """
    global _minio_client
    if _minio_client is None:
        from minio import Minio  # Import the optional dependency lazily.
        s = get_settings()
        _minio_client = Minio(
            s.minio_endpoint, access_key=s.minio_access_key,
            secret_key=s.minio_secret_key, secure=s.minio_secure,
        )
        # Ensure the bucket exists idempotently.
        try:
            if not _minio_client.bucket_exists(s.minio_bucket):
                _minio_client.make_bucket(s.minio_bucket)
        except Exception:
            pass  # Tolerate read-only credentials or an already-existing bucket.
    return _minio_client


_NAME_LIMIT = 255  # Per-component limit: bytes on POSIX filesystems, UTF-16 units on NTFS.
_WINDOWS_PATH_LIMIT = 259
_WINDOWS_INVALID = re.compile(r'[<>:"|?*\x00-\x1f]')
_WINDOWS_RESERVED = re.compile(r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", re.I)
_SAFE_SUFFIX = re.compile(r"\.[A-Za-z0-9]{1,16}")


def _utf16_units(value: str) -> int:
    return len(value.encode("utf-16-le", errors="surrogatepass")) // 2


def _windows_component_ok(name: str) -> bool:
    return (_utf16_units(name) <= _NAME_LIMIT and not _WINDOWS_INVALID.search(name)
            and not name.endswith((" ", ".")) and not _WINDOWS_RESERVED.match(name))


def _native_name_ok(name: str, path: str) -> bool:
    if os.name == "nt":
        return _windows_component_ok(name) and _utf16_units(os.path.abspath(path)) <= _WINDOWS_PATH_LIMIT
    return len(os.fsencode(name)) <= _NAME_LIMIT


def _hashed_names(key: str, safe: str) -> tuple[str, str]:
    # Object keys embed the uploaded filename, which can exceed native limits
    # (long or multibyte names) or contain characters Windows rejects. The
    # readable form keeps an ASCII prefix and extension; the compact form keeps
    # only the digest and extension for deep upload directories. Neither
    # depends on the directory, so a moved or restored uploads directory still
    # maps every key to the name it was written under.
    head, _, tail = safe.rpartition("__")
    suffix = os.path.splitext(tail or safe)[1]
    suffix = suffix if _SAFE_SUFFIX.fullmatch(suffix) else ""
    head = re.sub(r"[^A-Za-z0-9._-]", "_", head)[:120]
    compact = "h-" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:40] + suffix
    return (head + "__" + compact if head else compact), compact


def _extended(path: str, *, directory: bool = False) -> str:
    if os.name != "nt":
        return path
    path = os.path.abspath(path)
    # Windows directory creation can hit its legacy limit before a complete file path does.
    if path.startswith("\\\\?\\") or (not directory and _utf16_units(path) <= _WINDOWS_PATH_LIMIT):
        return path
    return "\\\\?\\UNC\\" + path[2:] if path.startswith("\\\\") else "\\\\?\\" + path


def _local_path(key: str) -> str:
    # A versioned directory prevents overlap with legacy flat filenames. Full
    # lowercase digests distinguish case-only keys on NTFS and bound name length
    # even for 200-character Chinese display names. Logical DB keys never change.
    root = os.path.join(_LOCAL_DIR, "objects-v2")
    return _extended(os.path.join(root, hashlib.sha256(key.encode("utf-8")).hexdigest()))


def _legacy_paths(key: str):
    safe = key.replace("/", "__").replace("\\", "__")
    for name in dict.fromkeys((safe, *_hashed_names(key, safe))):
        if name in ("", ".", "..") or "\x00" in name:
            continue
        if os.name == "nt" and not _windows_component_ok(name):
            continue
        if os.name != "nt" and len(os.fsencode(name)) > _NAME_LIMIT:
            continue
        yield _extended(os.path.join(_LOCAL_DIR, name))


def _read_local_path(key: str) -> str:
    current = _local_path(key)
    if os.path.isfile(current):
        return current
    if os.path.isfile(current + ".deleted"):
        return current
    for path in _legacy_paths(key):
        if os.path.isfile(path):
            return path
    return current


class AmbiguousLocalKeys(ValueError):
    """The inventory contains keys sharing a legacy file; no migration occurred."""

    def __init__(self, collisions):
        self.collisions = collisions
        super().__init__("Ambiguous legacy local objects; retain originals and resolve keys: "
                         + repr(collisions))


def migrate_local_objects(keys):
    """Offline migration with the COMPLETE local-key inventory, writes stopped.

    Check every legacy alias before moving anything. Never duplicate one old
    object under two logical identities: already-collided bytes are unrecoverable
    without a backup. Ambiguous inventories raise and leave all originals intact.
    Directory relocation does not change names or require database updates.
    """
    keys = sorted(set(keys))
    aliases = {}
    sources = {}
    multiple = {}
    for key in keys:
        if os.path.isfile(_local_path(key) + ".deleted") and not os.path.isfile(_local_path(key)):
            continue  # A retained original must never revive a deleted object.
        candidates = [path for path in _legacy_paths(key) if os.path.isfile(path)]
        if any(os.path.islink(path) for path in candidates):
            raise ValueError("Refusing to migrate a symlink: " + key)
        if len(candidates) > 1:
            multiple[key] = candidates
        for path in candidates:
            # Conservative across filesystems: a restore may move from a
            # case-sensitive filesystem to Windows or the reverse.
            aliases.setdefault(path.casefold(), set()).add(key)
            sources.setdefault(key, path)
    collisions = [sorted(group) for group in aliases.values() if len(group) > 1]
    if collisions:
        raise AmbiguousLocalKeys(collisions)
    if multiple:
        raise ValueError("Multiple legacy objects match one key; retain all: " + repr(multiple))
    for key, source in sources.items():
        destination = _local_path(key)
        if os.path.exists(destination):
            raise FileExistsError("Both legacy and v2 objects exist; retain both: " + key)
    for key, source in sources.items():
        destination = _local_path(key)
        os.makedirs(_extended(os.path.dirname(destination), directory=True), exist_ok=True)
        os.rename(source, destination)
    return len(sources)


async def migrate_local_attachments(session):
    """Inventory task attachments and message snapshots before Hub starts serving."""
    import asyncio
    from sqlalchemy import select
    from ..models import Attachment

    keys = list(await session.scalars(select(Attachment.storage_key).where(
        Attachment.backend == "local", Attachment.storage_key != "")))
    return await asyncio.to_thread(migrate_local_objects, keys)


def _put_local(key: str, source) -> None:
    destination = _local_path(key)
    os.makedirs(_extended(os.path.dirname(destination), directory=True), exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".upload-", dir=os.path.dirname(destination))
    try:
        with os.fdopen(descriptor, "wb") as output:
            shutil.copyfileobj(source, output, 1024 * 1024)
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)


def put(key: str, data: bytes, content_type: str) -> str:
    """Store an object and return the backend actually used: minio or local."""
    if backend_name() == "minio":
        s = get_settings()
        _client().put_object(s.minio_bucket, key, BytesIO(data), length=len(data), content_type=content_type)
        return "minio"
    _put_local(key, BytesIO(data))
    return "local"


def put_stream(key: str, handle, size: int, content_type: str) -> str:
    """Store a seekable video stream without allocating the complete file."""
    handle.seek(0)
    if backend_name() == "minio":
        _client().put_object(get_settings().minio_bucket, key, handle,
                             length=size, content_type=content_type,
                             part_size=5 * 1024 * 1024, num_parallel_uploads=1)
        return "minio"
    _put_local(key, handle)
    return "local"


def get(key: str, backend: str) -> bytes:
    """Read object bytes from the backend recorded at write time, supporting storage migration."""
    if backend == "minio":
        s = get_settings()
        resp = _client().get_object(s.minio_bucket, key)
        try:
            return resp.read()
        finally:
            resp.close(); resp.release_conn()
    path = _read_local_path(key)
    if not os.path.exists(path):
        raise FileNotFoundError(key)
    with open(path, "rb") as f:
        return f.read()


def open_stream(key: str, backend: str):
    """Open an attachment for bounded chunked delivery.

    The caller must pass the returned handle to ``iter_stream`` so network and
    file resources are closed after the response, including client disconnects.
    This function is synchronous by design and should be opened via
    ``asyncio.to_thread`` from async routes.
    """
    if backend == "minio":
        s = get_settings()
        return _client().get_object(s.minio_bucket, key)
    path = _read_local_path(key)
    if not os.path.exists(path):
        raise FileNotFoundError(key)
    return open(path, "rb")


def iter_stream(handle, chunk_size: int = 1024 * 1024):
    """Yield an already-open storage object without loading it into memory."""
    try:
        while True:
            chunk = handle.read(max(64 * 1024, min(int(chunk_size), 4 * 1024 * 1024)))
            if not chunk:
                break
            yield chunk
    finally:
        try:
            handle.close()
        finally:
            release = getattr(handle, "release_conn", None)
            if callable(release):
                release()


def delete(key: str, backend: str) -> None:
    try:
        if backend == "minio":
            s = get_settings()
            _client().remove_object(s.minio_bucket, key)
        else:
            current = _local_path(key)
            if os.path.isfile(current):
                # A legacy alias may belong to another key. Never remove it
                # while deleting a v2 object; remember deletion to prevent an
                # old alias from reappearing through compatibility lookup.
                with open(current + ".deleted", "wb"):
                    pass
                os.remove(current)
            elif not os.path.exists(current + ".deleted"):
                for path in _legacy_paths(key):
                    if os.path.isfile(path):
                        os.remove(path)
    except Exception:
        pass  # Storage deletion failure must not block metadata removal.
