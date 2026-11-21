"""Issue #495 方案二: member repository → local path mappings and cwd resolution."""
import os
import unittest

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from fastapi import HTTPException

from app import models
from app.services import client_repo_paths as svc
from app.services import workdirs


class ClientRepoPathTests(unittest.TestCase):
    def setUp(self):
        self.client = models.Client(id="device-1", user_ref="owner", auth_state="active", config={})

    def test_mapping_roundtrip_and_normalization(self):
        rows = svc.set_path(self.client, "https://GitHub.com/Team/App.git/", "D:\\work\\app")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["gitUrl"], "https://github.com/Team/App")
        self.assertEqual(rows[0]["localPath"], "D:\\work\\app")
        self.assertEqual(svc.resolve_path(self.client, "https://GitHub.com/Team/App.git"), "D:\\work\\app")
        self.assertEqual(svc.resolve_path(self.client, "https://github.com/team/other"), "")

    def test_scp_style_url_and_case(self):
        svc.set_path(self.client, "git@github.com:Team/App.git", "/srv/src/app")
        self.assertEqual(svc.resolve_path(self.client, "git@github.com:Team/App.git"), "/srv/src/app")

    def test_settings_are_replaced_not_erased(self):
        self.client.config = {"mode": "dark"}
        svc.set_path(self.client, "https://github.com/a/b", "/work/b")
        self.assertEqual(self.client.config["mode"], "dark")
        svc.remove_path(self.client, "https://github.com/a/b")
        self.assertNotIn(svc._CONFIG_KEY, self.client.config)
        self.assertEqual(self.client.config["mode"], "dark")

    def test_rejects_relative_and_unsafe_paths(self):
        for path in ("work/app", "../app", "D:/work/../app", "x\x00y"):
            with self.subTest(path=path), self.assertRaises(HTTPException):
                svc.validate_local_path(path)

    def test_rejects_invalid_repo_url(self):
        with self.assertRaises(HTTPException):
            svc.canonical_repo_url("https://")

    def test_auto_dir_prefers_member_mapping(self):
        repo = models.Repo(id="r1", project_id="p1", name="app", git_url="https://github.com/team/app",
                           local_dir="repos/app", ai_work_dir="/server/app")
        directory, why = workdirs.auto_dir(self.client, repo)
        self.assertEqual(directory, "/server/app")  # no mapping yet
        svc.set_path(self.client, repo.git_url, "/home/me/app")
        directory, why = workdirs.auto_dir(self.client, repo)
        self.assertEqual(directory, "/home/me/app")
        self.assertIn("成员配置", why)


if __name__ == "__main__":
    unittest.main()
