"""Write-ahead object lists for reconciling interrupted delivery ingestion."""
import asyncio
import errno
import hashlib
import json
import logging
import os
import tempfile
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession

from ..models import Attachment
from . import file_io, storage

log = logging.getLogger("uvicorn.error")


def _lock(handle):
    if os.name == "nt":
        import msvcrt
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


def manifest_directory():
    configured = storage.get_settings().artifact_staging_dir
    if configured and not Path(configured).is_absolute():
        raise RuntimeError("ARTIFACT_STAGING_DIR must be an absolute path")
    path = configured or os.path.join(storage._LOCAL_DIR, ".ingest")
    return Path(storage._extended(path, directory=True))


def validate_directory():
    directory = manifest_directory()
    try:
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        with tempfile.TemporaryFile(dir=directory) as probe:
            _lock(probe)
            probe.write(b"\n")
            probe.flush()
            os.fsync(probe.fileno())
    except OSError as exc:
        raise RuntimeError(f"Artifact staging requires a writable persistent directory at {directory}. "
                           "Mount a volume there or configure ARTIFACT_STAGING_DIR.") from exc


class ObjectList:
    def __init__(self, session, task_id):
        bind = session.get_bind().engine
        database = str(bind.url)
        if bind.url.database in (":memory:", ""):
            database += str(id(bind))
        self.legacy_scope = hashlib.sha256((database + "\0" + task_id).encode()).hexdigest()
        self.db_scope = _database_scope(bind)
        self.scope = self.db_scope + "-" + hashlib.sha256(task_id.encode()).hexdigest()
        self.directory = manifest_directory()
        self.handle = None

    def store(self, write, key, *args):
        creating = self.handle is None
        if creating:
            self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            self.handle = (self.directory / (self.scope + "-" + uuid.uuid4().hex + ".objects")).open("x+b")
            _lock(self.handle)
            # Leave byte zero for the Windows mandatory lock.
            self.handle.write(b"\n")
        backend = storage.backend_name()
        self.handle.write((json.dumps([key, backend]) + "\n").encode())
        self.handle.flush()
        os.fsync(self.handle.fileno())
        if creating:
            storage._sync_directory(self.directory)
            storage._sync_directory(self.directory.parent)
        return write(key, *args)

    async def _fence(self, session, handle):
        if handle is not None and session.get_bind().dialect.name == "postgresql":
            # A disconnected writer's COMMIT might still be in flight. Wait for
            # its transaction before deciding which objects lack a durable row.
            name = Path(handle.name).name
            key = int.from_bytes(hashlib.sha256(name.encode()).digest()[:8], "big", signed=True)
            await session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": key})

    async def before_insert(self, session):
        await self._fence(session, self.handle)

    async def _reconcile(self, session, handle, *, abandoned=False):
        # An incomplete tail precedes its storage write and can be discarded.
        handle.seek(1)
        objects = set()
        for line in handle:
            if not line.endswith(b"\n"):
                break
            record = json.loads(line)
            if (not isinstance(record, list) or len(record) != 2 or not isinstance(record[0], str)
                    or not record[0].startswith(("ai/", "att/")) or record[1] not in ("local", "minio")):
                raise ValueError("Invalid artifact manifest record")
            objects.add(tuple(record))
        if objects:
            await self._fence(session, handle)
            if abandoned and session.get_bind().dialect.name == "sqlite":
                # Wait for any in-flight SQLite writer before deciding that its
                # attachment row is missing.
                await session.execute(update(Attachment).where(False).values(size=Attachment.size)
                                      .execution_options(synchronize_session=False))
            keys = {key for key, _ in objects}
            referenced = set(await session.execute(select(Attachment.storage_key, Attachment.backend).where(
                Attachment.storage_key.in_(keys))))
            for key, backend in objects - referenced:
                if not await file_io.run(storage.delete_staged, key, backend):
                    return False
        return True

    async def recover(self, session):
        for scope in (self.scope, self.legacy_scope):
            for path in self.directory.glob(scope + "-*.objects"):
                await self.recover_path(session, path)

    async def recover_path(self, session, path):
        try:
            if not path.stat().st_size:
                return  # The writer may not have published its first record.
            with path.open("r+b") as handle:
                try:
                    _lock(handle)
                except OSError as exc:
                    if exc.errno in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                        return
                    raise
                finished = await self._reconcile(session, handle, abandoned=True)
            if finished:
                path.unlink(missing_ok=True)
        except FileNotFoundError:
            pass
        except ValueError:
            log.warning("Retained unreadable artifact staging manifest %s", path.name)

    async def finish(self, session):
        if self.handle is None:
            return
        path = Path(self.handle.name)
        try:
            finished = await self._reconcile(session, self.handle, abandoned=True)
        finally:
            self.close()
        if finished:
            path.unlink(missing_ok=True)

    def close(self):
        if self.handle is not None:
            self.handle.close()
            self.handle = None


def _database_scope(bind):
    url = bind.url
    if url.get_backend_name() == "sqlite":
        database = url.database
        identity = (f"sqlite:memory:{id(bind)}" if database in (None, "", ":memory:")
                    else os.path.normcase(str(Path(database).resolve())))
    else:
        # User/password rotation need not prevent recovery. Keep schema and other
        # connection options in the identity to avoid touching a separate database.
        identity = repr((url.get_backend_name(), url.host, url.port or 5432, url.database, sorted(url.query.items())))
    return hashlib.sha256(identity.encode()).hexdigest()


async def sweep_once(session_factory):
    """Reconcile durable writes after a crash even if no client retries the task."""
    async with session_factory() as session:
        objects = ObjectList(session, "")
    for path in objects.directory.glob(objects.db_scope + "-*.objects"):
        try:
            async with session_factory() as session:
                await objects.recover_path(session, path)
        except Exception:
            log.warning("Artifact storage reconciliation deferred for %s", path.name, exc_info=True)


async def sweep_loop():
    from ..db import SessionLocal

    while True:
        try:
            await sweep_once(SessionLocal)
        except Exception:
            log.warning("Artifact storage reconciliation failed", exc_info=True)
        await asyncio.sleep(30)


@asynccontextmanager
async def operation(session, task_id):
    objects = ObjectList(session, task_id)
    resolved = False
    try:
        try:
            yield objects
        except BaseException:
            await session.rollback()
            resolved = True
            raise
        resolved = True
    finally:
        try:
            if resolved and objects.handle is not None:
                # Release the reconciliation transaction before returning to the
                # caller. A SQLite writer reservation must not outlive this operation.
                bind = session.bind
                if isinstance(bind, AsyncConnection):
                    bind = bind.engine
                async with AsyncSession(bind) as cleanup:
                    await objects.finish(cleanup)
                    await objects.recover(cleanup)
        except Exception:
            log.warning("Artifact storage reconciliation deferred for task %s", task_id, exc_info=True)
        finally:
            objects.close()
