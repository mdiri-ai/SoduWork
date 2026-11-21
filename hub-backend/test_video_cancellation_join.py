"""Cancellation cannot close the spool while a disk worker is still using it."""
import asyncio
import tempfile
import threading
import unittest
from unittest.mock import patch

from app.services import video_files


class VideoCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_repeated_cancel_waits_for_active_write_before_close(self):
        started, release, finished = threading.Event(), threading.Event(), threading.Event()
        handles, failures = [], []
        create, write = tempfile.TemporaryFile, video_files.VideoBody.write

        def new_file(**kwargs):
            handle = create(**kwargs)
            handles.append(handle)
            return handle

        def blocked_write(body, chunk):
            started.set()
            try:
                if not release.wait(3):
                    raise TimeoutError('test worker was not released')
                write(body, chunk)
            except Exception as exc:
                failures.append(exc)
                raise
            finally:
                finished.set()

        async def chunks():
            yield b'\x00\x00\x00\x18ftypmp42' + b'\x00' * 32

        with patch.object(video_files.tempfile, 'TemporaryFile', side_effect=new_file), \
                patch.object(video_files.VideoBody, 'write', new=blocked_write):
            task = asyncio.create_task(video_files.collect(chunks(), 1024))
            try:
                self.assertTrue(await asyncio.wait_for(asyncio.to_thread(started.wait, 2), 2.5))
                task.cancel()
                await asyncio.sleep(0)
                task.cancel()
                for _ in range(5):
                    await asyncio.sleep(0)
                premature, closed_early = task.done(), handles[0].closed
            finally:
                release.set()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                self.assertTrue(await asyncio.wait_for(asyncio.to_thread(finished.wait, 2), 2.5))
        self.assertFalse(premature, 'collect returned before its disk worker completed')
        self.assertFalse(closed_early, 'temporary file was closed during the write')
        self.assertEqual(failures, [])
        self.assertTrue(handles[0].closed)

    async def test_successful_disk_call_returns_its_result(self):
        self.assertEqual(await video_files.disk_call(lambda a, b: a + b, 2, 3), 5)

    async def test_ordinary_disk_failure_is_not_swallowed(self):
        def fail():
            raise OSError('fixture write failure')
        with self.assertRaisesRegex(OSError, 'fixture write failure'):
            await video_files.disk_call(fail)


if __name__ == '__main__':
    unittest.main()
