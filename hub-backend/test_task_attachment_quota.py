"""Task attachment admission and durable storage recovery."""

import asyncio
import hashlib
import io
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import attachments
from app.models import Attachment, User
from app.services import artifact_staging, file_io, storage


class TaskAttachmentQuotaTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        self.root = Path(directory)
        self.url = "sqlite+aiosqlite:///" + (self.root / "test.db").as_posix()
        self.engine = create_async_engine(self.url)
        self.addAsyncCleanup(self.engine.dispose)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(User.__table__.create)
            await connection.run_sync(Attachment.__table__.create)
        async with self.sessions() as session:
            session.add_all([
                User(id="u1", username="one", org_id="org"),
                User(id="u2", username="two", org_id="org"),
            ])
            await session.commit()
        self.settings = SimpleNamespace(
            attach_max_mb=1, attach_owner_quota_bytes=4, attach_org_quota_bytes=6,
            artifact_staging_dir=str(self.root / "staging"), minio_endpoint="",
        )
        self.enterContext(patch.object(attachments, "get_settings", return_value=self.settings))
        self.enterContext(patch.object(storage, "get_settings", return_value=self.settings))
        self.enterContext(patch.object(storage, "_LOCAL_DIR", str(self.root / "objects")))

    async def upload(self, device, user, data, sessions=None):
        client = SimpleNamespace(id=device, user_ref=user)
        async with (sessions or self.sessions)() as session:
            return await attachments._save_attachment(
                session, client, "task-" + device, UploadFile(filename="input.txt", file=io.BytesIO(data)),
            )

    async def test_sqlite_quota_is_shared_across_independent_engines(self):
        other = create_async_engine(self.url)
        self.addAsyncCleanup(other.dispose)
        other_sessions = async_sessionmaker(other, expire_on_commit=False)
        results = await asyncio.gather(
            self.upload("one", "u1", b"1234"),
            self.upload("two", "u1", b"1234", other_sessions),
            return_exceptions=True,
        )
        errors = [result for result in results if isinstance(result, HTTPException)]
        self.assertEqual([(error.status_code, error.detail) for error in errors],
                         [(413, "attachment_owner_quota_exceeded")])
        async with self.sessions() as session:
            row = (await session.scalars(select(Attachment))).one()
            self.assertEqual(row.evidence_meta["sha256"], hashlib.sha256(b"1234").hexdigest())
            self.assertEqual(row.evidence_meta["ownerUserId"], "u1")

    async def test_organization_quota_is_shared_by_distinct_owners(self):
        await self.upload("one", "u1", b"1234")
        with self.assertRaises(HTTPException) as failure:
            await self.upload("two", "u2", b"123")
        self.assertEqual((failure.exception.status_code, failure.exception.detail),
                         (413, "attachment_org_quota_exceeded"))
        self.assertEqual((await self.upload("two", "u2", b"12")).size, 2)

    async def test_zero_limit_rejects_before_writing_objects(self):
        self.settings.attach_owner_quota_bytes = 0
        with patch.object(storage, "put_stream") as put:
            with self.assertRaises(HTTPException) as failure:
                await self.upload("one", "u1", b"x")
        self.assertEqual((failure.exception.status_code, failure.exception.detail),
                         (413, "attachment_owner_quota_exceeded"))
        put.assert_not_called()

    async def test_historical_account_upload_charges_until_the_row_is_deleted(self):
        async with self.sessions() as session:
            session.add(Attachment(id="legacy", task_id="old", uploaded_by="admin:u1",
                                   size=4, role="input", filename="old", storage_key="att/old/file"))
            await session.commit()
        with self.assertRaises(HTTPException) as failure:
            await self.upload("current", "u1", b"x")
        self.assertEqual(failure.exception.detail, "attachment_owner_quota_exceeded")
        async with self.sessions() as session:
            await session.delete(await session.get(Attachment, "legacy"))
            await session.commit()
        self.assertEqual((await self.upload("current", "u1", b"1234")).size, 4)

    async def test_ack_loss_preserves_committed_object(self):
        client = SimpleNamespace(id="one", user_ref="u1")
        file = UploadFile(filename="input.txt", file=io.BytesIO(b"ok"))
        async with self.sessions() as session:
            commit = session.commit

            async def lost_ack():
                await commit()
                raise ConnectionError("Commit acknowledgement lost")

            with patch.object(session, "commit", side_effect=lost_ack), self.assertRaises(ConnectionError):
                await attachments._save_attachment(session, client, "task-one", file)
        async with self.sessions() as session:
            row = (await session.scalars(select(Attachment))).one()
            self.assertEqual(storage.get(row.storage_key, row.backend), b"ok")
        self.assertEqual(list(artifact_staging.manifest_directory().iterdir()), [])

    async def test_restart_sweep_retries_unavailable_deletion(self):
        key = "ai/task/interrupted-result"
        async with self.sessions() as session:
            objects = artifact_staging.ObjectList(session, "task")
            try:
                await file_io.run(objects.store, storage.put, key, b"tmp", "text/plain")
            finally:
                objects.close()
        with patch.object(storage, "delete", return_value=False):
            await artifact_staging.sweep_once(self.sessions)
        self.assertEqual(storage.get(key, "local"), b"tmp")
        self.assertEqual(len(list(artifact_staging.manifest_directory().glob("*.objects"))), 1)
        await artifact_staging.sweep_once(self.sessions)
        with self.assertRaises(FileNotFoundError):
            storage.get(key, "local")
        self.assertEqual(list(artifact_staging.manifest_directory().iterdir()), [])

    async def test_restart_sweep_removes_a_partially_written_local_file(self):
        key = "ai/task/interrupted-result"
        destination = Path(storage._local_path(key))

        def interrupted_write(logical_key, data):
            self.assertEqual(logical_key, key)
            destination.parent.mkdir(parents=True)
            named = storage._temporary_object_prefix(str(destination)) + "interrupted"
            (destination.parent / named).write_bytes(data)

        async with self.sessions() as session:
            objects = artifact_staging.ObjectList(session, "task")
            try:
                await file_io.run(objects.store, interrupted_write, key, b"tmp")
            finally:
                objects.close()
        await artifact_staging.sweep_once(self.sessions)
        self.assertEqual(list(destination.parent.iterdir()), [])
        self.assertEqual(list(artifact_staging.manifest_directory().iterdir()), [])

    async def test_minio_failure_uses_configured_staging_and_releases_quota(self):
        self.settings.minio_endpoint = "synthetic"
        application_dir = self.root / "read-only-app"
        application_dir.touch()
        self.enterContext(patch.object(storage, "_LOCAL_DIR", str(application_dir / "uploads")))
        artifact_staging.validate_directory()
        with (patch.object(storage, "put_stream", side_effect=OSError("Unavailable")),
              patch.object(storage, "delete", return_value=True) as remove):
            with self.assertRaises(OSError):
                await self.upload("one", "u1", b"1234")
            remove.assert_called_once()
            self.assertEqual(remove.call_args.args[1], "minio")
        self.assertEqual(list(artifact_staging.manifest_directory().iterdir()), [])
        with patch.object(storage, "put_stream", return_value="minio"):
            self.assertEqual((await self.upload("one", "u1", b"1234")).size, 4)

    async def test_staging_validation_reports_unwritable_configuration(self):
        blocker = self.root / "file"
        blocker.touch()
        self.settings.artifact_staging_dir = str(blocker / "dir")
        with self.assertRaisesRegex(RuntimeError, "ARTIFACT_STAGING_DIR"):
            artifact_staging.validate_directory()
