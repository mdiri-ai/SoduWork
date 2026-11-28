"""Live-view invalidation retains only cached or in-flight device state."""
import asyncio
import gc
import tracemalloc
import unittest

from app.services import live_view_cache as cache


class LiveViewCacheLifetimeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        cache.reset_for_tests()

    def tearDown(self):
        cache.reset_for_tests()

    def retained_by_events(self, client):
        gc.collect()
        tracemalloc.start()
        try:
            before = tracemalloc.take_snapshot()
            for index in range(10_000):
                cache.invalidate(client or f"device-{index}", {"taskId": f"task-{index}"})
            gc.collect()
            after = tracemalloc.take_snapshot()
            return sum(row.size_diff for row in after.compare_to(before, "filename")
                       if row.traceback[0].filename == cache.__file__)
        finally:
            tracemalloc.stop()

    async def test_events_without_cached_views_do_not_retain_historical_devices(self):
        self.assertLess(self.retained_by_events(None), 64 * 1024)

    async def test_one_cached_device_does_not_retain_every_historical_task(self):
        async def build():
            return {"view": "desk"}

        await cache.get_or_build("desk", "device", "", build)
        self.assertLess(self.retained_by_events("device"), 64 * 1024)

    async def test_evicted_snapshots_release_their_generation_state(self):
        async def build():
            return {"view": "trace"}

        for index in range(1_000):
            await cache.get_or_build("trace", f"device-{index}", "task", build)
        gc.collect()
        tracemalloc.start()
        try:
            before = tracemalloc.take_snapshot()
            for index in range(1_000, 11_000):
                await cache.get_or_build("trace", f"device-{index}", "task", build)
            gc.collect()
            after = tracemalloc.take_snapshot()
            retained = sum(row.size_diff for row in after.compare_to(before, "filename")
                           if row.traceback[0].filename == cache.__file__)
            self.assertLess(retained, 512 * 1024)
        finally:
            tracemalloc.stop()

    async def test_event_during_first_build_prevents_a_stale_cache_hit(self):
        started, release = asyncio.Event(), asyncio.Event()
        builds = 0

        async def build():
            nonlocal builds
            builds += 1
            if builds == 1:
                started.set()
                await release.wait()
            return {"build": builds}

        pending = asyncio.create_task(cache.get_or_build("trace", "device", "task", build))
        await started.wait()
        cache.invalidate("device", {"taskId": "task"})
        release.set()
        self.assertEqual(await pending, {"build": 1})
        self.assertEqual(await cache.get_or_build("trace", "device", "task", build), {"build": 2})
        self.assertEqual(await cache.get_or_build("trace", "device", "task", build), {"build": 2})

    async def test_clear_keeps_waiting_builds_serial_and_rebuilds_current_state(self):
        started, release = asyncio.Event(), asyncio.Event()
        builds = active = peak = 0

        async def build():
            nonlocal builds, active, peak
            builds += 1
            active += 1
            peak = max(peak, active)
            try:
                if builds == 1:
                    started.set()
                    await release.wait()
                return {"build": builds}
            finally:
                active -= 1

        first = asyncio.create_task(cache.get_or_build("trace", "device", "task", build))
        await started.wait()
        waiting = asyncio.create_task(cache.get_or_build("trace", "device", "task", build))
        cache.clear()
        release.set()
        self.assertEqual(await first, {"build": 1})
        self.assertEqual(await waiting, {"build": 2})
        self.assertEqual(await cache.get_or_build("trace", "device", "task", build), {"build": 2})
        self.assertEqual(peak, 1)

    async def test_task_event_invalidates_all_views_for_only_its_device(self):
        builds = 0

        async def build():
            nonlocal builds
            builds += 1
            return builds

        self.assertEqual(await cache.get_or_build("desk", "device", "", build), 1)
        self.assertEqual(await cache.get_or_build("trace", "device", "other-task", build), 2)
        self.assertEqual(await cache.get_or_build("trace", "other-device", "task", build), 3)
        cache.invalidate("device", {"task_id": "task"})
        self.assertEqual(await cache.get_or_build("desk", "device", "", build), 4)
        self.assertEqual(await cache.get_or_build("trace", "device", "other-task", build), 5)
        self.assertEqual(await cache.get_or_build("trace", "other-device", "task", build), 3)


if __name__ == "__main__":
    unittest.main()
