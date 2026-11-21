"""Real-filesystem attachment storage regressions; registered in the release gate."""
import os
import shutil
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from app.services import storage


class LocalAttachmentNameTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.enterContext(patch.object(storage, "_LOCAL_DIR", self.folder.name))
        self.enterContext(patch.object(storage, "backend_name", return_value="local"))

    def assert_payload(self, key, payload):
        self.assertEqual(storage.get(key, "local"), payload)
        stream = storage.open_stream(key, "local")
        self.assertEqual(b"".join(storage.iter_stream(stream)), payload)
        self.assertTrue(stream.closed)

    def legacy_file(self, key, payload, form="flat"):
        safe = key.replace("/", "__").replace("\\", "__")
        name = safe if form == "flat" else storage._hashed_names(key, safe)[form == "compact"]
        path = storage._extended(os.path.join(storage._LOCAL_DIR, name))
        os.makedirs(storage._extended(storage._LOCAL_DIR, directory=True), exist_ok=True)
        with open(path, "wb") as handle:
            handle.write(payload)
        return path

    def test_old_data_reads_streams_and_deletes_without_losing_neighbor(self):
        key, neighbor = "att/task/id/report.txt", "att/task/other/other.txt"
        path = self.legacy_file(key, b"written by old release")
        self.legacy_file(neighbor, b"untouched")
        self.assert_payload(key, b"written by old release")
        storage.delete(key, "local")
        self.assertFalse(os.path.exists(path))
        self.assert_payload(neighbor, b"untouched")
        with self.assertRaises(FileNotFoundError):
            storage.get(key, "local")

    def test_each_old_format_survives_directory_copy(self):
        for form in ("flat", "readable", "compact"):
            with self.subTest(form=form):
                source = os.path.join(self.folder.name, "source-" + form)
                target = os.path.join(self.folder.name, "restored-" + form)
                key = "att/task/id/report.txt"
                with patch.object(storage, "_LOCAL_DIR", source):
                    self.legacy_file(key, b"old bytes", form)
                shutil.copytree(source, target)
                with patch.object(storage, "_LOCAL_DIR", target):
                    self.assert_payload(key, b"old bytes")
                    storage.delete(key, "local")
                    with self.assertRaises(FileNotFoundError):
                        storage.open_stream(key, "local")
                with patch.object(storage, "_LOCAL_DIR", source):
                    self.assert_payload(key, b"old bytes")

    def test_collision_keys_have_independent_bytes_streams_and_deletion(self):
        for first, second in (("att/t/a__b/name.txt", "att/t/a/b/name.txt"),
                              ("att/t/id/Report.txt", "att/t/id/report.txt"),
                              ("att/t/id/100%file", "att/t/id/100%25file"),
                              ("att/t/id/a\\b", "att/t/id/a/b")):
            with self.subTest(keys=(first, second)):
                storage.put(first, b"first", "text/plain")
                storage.put_stream(second, BytesIO(b"second"), 6, "text/plain")
                self.assert_payload(first, b"first")
                self.assert_payload(second, b"second")
                self.assertNotEqual(storage._local_path(first).casefold(),
                                    storage._local_path(second).casefold())
                storage.delete(first, "local")
                with self.assertRaises(FileNotFoundError):
                    storage.get(first, "local")
                self.assert_payload(second, b"second")
                storage.delete(second, "local")

    def test_real_filesystem_name_boundaries(self):
        for name in ("报告" * 98 + ".pdf", "x" * 196 + ".txt", "🦄" * 196 + ".txt",
                     "会议纪要: 11月17日.docx", "CON", "report. ", ".."):
            with self.subTest(name=name):
                key = "att/task/id/" + name
                payload = ("payload:" + name).encode()
                storage.put(key, payload, "application/octet-stream")
                self.assert_payload(key, payload)
                path = storage._local_path(key)
                self.assertEqual(os.stat(path).st_size, len(payload))
                with open(path, "rb") as handle:
                    self.assertEqual(handle.read(), payload)  # The ordinary main stream, including NTFS.
                self.assertRegex(os.path.basename(path), r"^[a-f0-9]{64}$")
                storage.delete(key, "local")
                self.assertFalse(os.path.exists(path))

    def test_v2_directory_relocation(self):
        key = "att/task/id/报告:final.pdf"
        storage.put(key, b"v2 bytes", "application/pdf")
        target = os.path.join(self.folder.name, "copy")
        shutil.copytree(os.path.join(self.folder.name, "objects-v2"),
                        os.path.join(target, "objects-v2"))
        with patch.object(storage, "_LOCAL_DIR", target):
            self.assert_payload(key, b"v2 bytes")
            storage.delete(key, "local")
            with self.assertRaises(FileNotFoundError):
                storage.get(key, "local")
        self.assert_payload(key, b"v2 bytes")

    def test_legacy_overwrite_then_delete_does_not_resurrect_old_bytes(self):
        key = "att/task/id/report.txt"
        old = self.legacy_file(key, b"old")
        storage.put(key, b"new", "text/plain")
        self.assert_payload(key, b"new")
        storage.delete(key, "local")
        self.assertEqual(Path(old).read_bytes(), b"old")
        with self.assertRaises(FileNotFoundError):
            storage.get(key, "local")
        self.assertEqual(storage.migrate_local_objects([key]), 0)
        with self.assertRaises(FileNotFoundError):
            storage.open_stream(key, "local")
        storage.put(key, b"recreated", "text/plain")
        self.assert_payload(key, b"recreated")

    def test_deleting_new_object_does_not_unlink_another_keys_legacy_file(self):
        legacy_key, new_key = "att/t/a__b/name.txt", "att/t/a/b/name.txt"
        old = self.legacy_file(legacy_key, b"legacy owner's bytes")
        storage.put(new_key, b"new key's bytes", "text/plain")
        storage.delete(new_key, "local")
        storage.delete(new_key, "local")  # Idempotent deletion must not probe the alias.
        self.assertEqual(Path(old).read_bytes(), b"legacy owner's bytes")
        self.assert_payload(legacy_key, b"legacy owner's bytes")
        with self.assertRaises(FileNotFoundError):
            storage.get(new_key, "local")

    def test_failed_stream_write_preserves_previous_object(self):
        key = "att/task/id/report.txt"
        storage.put(key, b"original", "text/plain")

        class BrokenStream(BytesIO):
            def read(self, size=-1):
                raise OSError("simulated interrupted upload")

        with self.assertRaises(OSError):
            storage.put_stream(key, BrokenStream(b"replacement"), 11, "text/plain")
        self.assert_payload(key, b"original")
        self.assertFalse(list(Path(self.folder.name).rglob(".upload-*")))

    def test_migration_preflights_all_aliases_before_changing_any_file(self):
        first, second = "att/t/a__b/name.txt", "att/t/a/b/name.txt"
        shared = self.legacy_file(first, b"cannot know which record owns these bytes")
        unique = self.legacy_file("att/t/unique/name.txt", b"unique")
        before = Path(shared).read_bytes()
        with self.assertRaises(storage.AmbiguousLocalKeys) as caught:
            storage.migrate_local_objects(["att/t/unique/name.txt", first, second])
        self.assertIn(sorted([first, second]), caught.exception.collisions)
        self.assertEqual(Path(shared).read_bytes(), before)
        self.assertEqual(Path(unique).read_bytes(), b"unique")
        self.assertFalse(os.path.exists(os.path.join(self.folder.name, "objects-v2")))

    def test_migration_reports_case_ambiguity_before_cross_platform_restore(self):
        keys = ["att/t/id/Report.txt", "att/t/id/report.txt"]
        original = self.legacy_file(keys[0], b"original")
        # On a case-sensitive host these are two files; on NTFS one file.
        self.legacy_file(keys[1], b"original")
        with self.assertRaises(storage.AmbiguousLocalKeys):
            storage.migrate_local_objects(keys)
        self.assertEqual(Path(original).read_bytes(), b"original")

    def test_unique_migration_is_repeatable_and_uses_unchanged_logical_keys(self):
        key = "att/task/id/report.txt"
        old = self.legacy_file(key, b"old payload")
        self.assertEqual(storage.migrate_local_objects([key, key]), 1)
        self.assertFalse(os.path.exists(old))
        self.assertEqual(storage.migrate_local_objects([key]), 0)
        self.assert_payload(key, b"old payload")
        storage.delete(key, "local")
        with self.assertRaises(FileNotFoundError):
            storage.get(key, "local")

    def test_migration_preserves_conflicting_old_and_new_objects(self):
        key = "att/task/id/report.txt"
        old = self.legacy_file(key, b"old")
        storage.put(key, b"new", "text/plain")
        with self.assertRaises(FileExistsError):
            storage.migrate_local_objects([key])
        self.assertEqual(Path(old).read_bytes(), b"old")
        self.assert_payload(key, b"new")

    def test_multiple_historical_formats_for_one_key_are_not_guessed(self):
        key = "att/task/id/report.txt"
        first = self.legacy_file(key, b"first", "flat")
        second = self.legacy_file(key, b"second", "compact")
        with self.assertRaisesRegex(ValueError, "Multiple legacy objects"):
            storage.migrate_local_objects([key])
        self.assertEqual(Path(first).read_bytes(), b"first")
        self.assertEqual(Path(second).read_bytes(), b"second")

    def test_interrupted_migration_can_resume(self):
        keys = ["att/task/a/report.txt", "att/task/b/report.txt"]
        for key in keys:
            self.legacy_file(key, key.encode())
        rename = os.rename
        calls = 0

        def interrupted(source, destination):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("simulated interruption")
            return rename(source, destination)

        with patch.object(os, "rename", side_effect=interrupted):
            with self.assertRaises(OSError):
                storage.migrate_local_objects(keys)
        self.assertEqual(storage.migrate_local_objects(keys), 1)
        for key in keys:
            self.assert_payload(key, key.encode())

    @unittest.skipUnless(os.name == "nt", "requires real Windows filesystem")
    def test_windows_deep_directory_with_non_bmp_characters(self):
        deep = os.path.join(self.folder.name, "项目📅" * 30, "uploads")
        with patch.object(storage, "_LOCAL_DIR", deep):
            for key in ("att/t/id/会议纪要:final.pdf", "att/t/id/" + "表" * 196 + ".txt"):
                storage.put(key, b"deep path payload", "text/plain")
                self.assert_payload(key, b"deep path payload")
                storage.delete(key, "local")
                with self.assertRaises(FileNotFoundError):
                    storage.get(key, "local")


class AttachmentInventoryTests(unittest.IsolatedAsyncioTestCase):
    async def test_startup_inventories_local_task_and_message_records_only(self):
        from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
        from app.models import Attachment

        with tempfile.TemporaryDirectory() as directory, patch.object(storage, "_LOCAL_DIR", directory):
            engine = create_async_engine("sqlite+aiosqlite:///:memory:")
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Attachment.__table__.create)
                keys = ["att/task/id/brief.txt", "mate-messages/id/snapshot.txt"]
                async with async_sessionmaker(engine)() as session:
                    for key in keys:
                        session.add(Attachment(task_id="", storage_key=key, backend="local"))
                        Path(directory, key.replace("/", "__")).write_bytes(key.encode())
                    session.add(Attachment(task_id="", storage_key="remote-only", backend="minio"))
                    session.add(Attachment(task_id="", storage_key="", backend="local"))
                    await session.commit()
                    self.assertEqual(await storage.migrate_local_attachments(session), 2)
                    self.assertEqual(await storage.migrate_local_attachments(session), 0)
                for key in keys:
                    self.assertEqual(storage.get(key, "local"), key.encode())
                    self.assertFalse(Path(directory, key.replace("/", "__")).exists())
                self.assertEqual(len(list(Path(directory, "objects-v2").iterdir())), 2)
            finally:
                await engine.dispose()


if __name__ == "__main__":
    unittest.main()
