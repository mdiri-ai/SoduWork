"""Regression checks for PR lint comparison against an existing application."""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from scripts.check_changed_lint import new_findings


class ChangedLintTests(unittest.TestCase):
    def make_advanced_merge(self, root):
        app = root / "app"
        app.mkdir()
        (app / "base.py").write_bytes(b"print(1)\n")

        def git(*args):
            return subprocess.check_output([
                "git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                "-c", "commit.gpgsign=false", *args,
            ], cwd=root, stderr=subprocess.DEVNULL, text=True).strip()

        git("init", "--quiet", "--initial-branch=main")
        git("add", "app")
        git("commit", "--quiet", "-m", "test: create fixture base")
        event_base = git("rev-parse", "HEAD")
        upstream = app / "upstream.py"
        upstream.write_bytes(b"import math\n")
        git("add", "app")
        main_tree = git("write-tree")
        main_first = git("commit-tree", main_tree, "-p", event_base, "-m", "test: advance main")
        main_current = git("commit-tree", main_tree, "-p", main_first, "-m", "test: advance main again")
        upstream.unlink()
        (app / "contribution.py").write_bytes(b"print(2)\n")
        git("add", "--all", "app")
        contribution = git("commit-tree", git("write-tree"), "-p", event_base,
                           "-m", "test: add clean contribution")
        upstream.write_bytes(b"import math\n")
        git("add", "app")
        merge = git("commit-tree", git("write-tree"), "-p", main_current, "-p", contribution,
                    "-m", "test: merge contribution into advanced main")
        git("update-ref", "refs/heads/main", merge)
        return event_base

    def check_merge(self, root, event_base, *, pull_request=True):
        env = os.environ.copy()
        env.update(GITHUB_EVENT_NAME="pull_request" if pull_request else "push",
                   GITHUB_REF="refs/pull/17/merge" if pull_request else "refs/heads/main",
                   BASE_SHA=event_base)
        script = Path(__file__).parent / "scripts" / "check_changed_lint.py"
        return subprocess.run([sys.executable, script, event_base], cwd=root,
                              env=env, capture_output=True, text=True)

    def test_queued_pr_uses_current_merge_parent_when_event_base_is_missing_from_shallow_clone(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            original = root / "original"
            original.mkdir()
            event_base = self.make_advanced_merge(original)
            checkout = root / "checkout"
            subprocess.run(["git", "clone", "--quiet", "--depth=2", original.as_uri(), str(checkout)],
                           check=True, capture_output=True)
            missing = subprocess.run(["git", "cat-file", "-e", event_base + "^{commit}"],
                                     cwd=checkout, capture_output=True)
            self.assertNotEqual(missing.returncode, 0, "The fixture must lack the old event base")
            result = self.check_merge(checkout, event_base)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertNotEqual(self.check_merge(checkout, event_base, pull_request=False).returncode, 0)
            (checkout / "app" / "bad.py").write_bytes(b"print(undefined)\n")
            rejected = self.check_merge(checkout, event_base)
            self.assertEqual(rejected.returncode, 1, rejected.stderr)
            self.assertIn("F821", rejected.stdout)

    def test_queued_pr_does_not_report_advanced_main_findings_when_old_event_base_is_available(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            event_base = self.make_advanced_merge(root)
            result = self.check_merge(root, event_base)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            unrelated = self.check_merge(root, event_base, pull_request=False)
            self.assertEqual(unrelated.returncode, 1, unrelated.stderr)
            self.assertIn("F401", unrelated.stdout)

    def test_existing_finding_shifts_but_changed_import_block_is_checked(self):
        original = b"import sys\nimport os\n\nprint(sys.version, os.name)\n"
        shift = b"# Existing file\n" + original
        self.assertEqual(new_findings("app/example.py", original, shift), [])
        edited = shift.replace(b"import os\n", b"import re\nimport os\n")
        codes = {item["code"] for item in new_findings("app/example.py", original, edited)}
        self.assertEqual(codes, {"I001", "F401"})

    def test_removing_last_use_flags_an_unchanged_import(self):
        before = b"import os\n\nprint(os.name)\n"
        findings = new_findings("app/example.py", before, b"import os\n")
        self.assertEqual([item["code"] for item in findings], ["F401"])

    def test_renamed_file_and_new_finding_of_same_kind(self):
        script = Path(__file__).parent / "scripts" / "check_changed_lint.py"
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            app = root / "app"
            app.mkdir()
            old = app / "old file.py"
            old.write_bytes(b"import math\n\n\ndef first():\n    return 1\n")

            def git(*args):
                subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                                *args], cwd=root, check=True, capture_output=True)

            def check(base):
                return subprocess.run([sys.executable, script, base], cwd=root, capture_output=True, text=True)

            git("init", "--quiet")
            git("add", "app")
            git("commit", "--quiet", "-m", "Add fixture")
            git("mv", "app/old file.py", "app/renamed file.py")
            renamed = app / "renamed file.py"
            renamed.write_bytes(b"# New heading\n" + renamed.read_bytes())
            result = check("HEAD")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            renamed.write_bytes(renamed.read_bytes() + b"\n\ndef second():\n    import math\n")
            (app / "new.py").write_bytes(b"print(undefined)\n")
            result = check("HEAD")
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn("F401", result.stdout)
            self.assertIn("F821", result.stdout)
            self.assertNotEqual(check("nonexistent-base").returncode, 0)


if __name__ == "__main__":
    unittest.main()
