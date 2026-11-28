"""The Git credential helper only answers for the host this execution may reach."""
import os
import subprocess
import unittest

from types import SimpleNamespace
from unittest.mock import patch

from app.services import code_creds

TOKEN = "fixture-helper-token"


def ask_helper(helper: str, host: str, allowed: str, protocol: str = "https") -> str:
    """Ask the credential helper about one host, the way git does."""
    env = dict(os.environ)
    env["GIT_CONFIG_COUNT"] = "2"
    env["GIT_CONFIG_KEY_0"] = "credential.helper"
    env["GIT_CONFIG_VALUE_0"] = ""
    env["GIT_CONFIG_KEY_1"] = "credential.helper"
    env["GIT_CONFIG_VALUE_1"] = helper
    env["SODUWORK_GIT_USER"] = "fixture-user"
    env["SODUWORK_GIT_TOKEN"] = TOKEN
    env["SODUWORK_GIT_ALLOWED_HOSTS"] = allowed
    env["GIT_TERMINAL_PROMPT"] = "0"
    proc = subprocess.run(
        ["git", "credential", "fill"],
        input=f"protocol={protocol}\nhost={host}\n\n",
        env=env, capture_output=True, text=True, timeout=30)
    return proc.stdout


def helper_from_env(env: dict) -> str:
    """Return the credential.helper this environment installs."""
    count = int(env.get("GIT_CONFIG_COUNT") or 0)
    for index in range(count):
        if env.get(f"GIT_CONFIG_KEY_{index}") == "credential.helper":
            value = env.get(f"GIT_CONFIG_VALUE_{index}") or ""
            if value:
                return value
    return ""


class CredentialHelperHostScopeTests(unittest.TestCase):
    def test_registered_probe_without_token_explains_what_to_configure(self):
        url = "https://git.example.test/team/repo.git"
        git = code_creds.for_repo(SimpleNamespace(git_creds={"name": "Fixture"}), url)
        with patch.object(subprocess, "run") as run:
            result = code_creds.probe_sync(git, url)
        self.assertFalse(result["ok"])
        self.assertIn("还没配 token", result["detail"])
        run.assert_not_called()

    def test_ssh_probe_uses_only_its_temporary_key(self):
        git = {"token": TOKEN, "key": "fixture-key"}
        with patch.dict(os.environ, SODUWORK_GIT_TOKEN="inherited-fixture"), \
                patch.object(code_creds, "_write_key", return_value="fixture.key") as write_key, \
                patch.object(code_creds, "forget_key") as cleanup, \
                patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "", "")) as run:
            result = code_creds.probe_sync(git, "git@example.test:team/repo.git")
        self.assertTrue(result["ok"])
        env = run.call_args.kwargs["env"]
        self.assertEqual(env["GIT_ALLOW_PROTOCOL"], "ssh")
        self.assertIn("fixture.key", env["GIT_SSH_COMMAND"])
        self.assertNotIn("SODUWORK_GIT_TOKEN", env)
        cleanup.assert_called_once_with(write_key.call_args.args[1])

    def test_allowed_host_is_derived_from_the_repository_url(self):
        self.assertEqual(code_creds.https_host("https://git.internal.corp/team/repo.git"),
                         "git.internal.corp")
        self.assertEqual(code_creds.https_host("https://user@git.internal.corp:8443/team/repo.git"),
                         "git.internal.corp:8443")
        self.assertEqual(code_creds.https_host("git@git.internal.corp:team/repo.git"),
                         "")
        self.assertEqual(code_creds.https_host(""), "")
        self.assertEqual(code_creds.https_host("   "), "")

    def test_allowed_host_keeps_the_port_because_git_reports_it(self):
        # git passes the port through to the helper, so the allow-list has to
        # keep it or a repository on a custom port would never authenticate.
        helper = code_creds._helper_script()
        allowed = code_creds.https_host("https://git.internal.corp:8443/team/repo.git")
        self.assertIn(TOKEN, ask_helper(helper, "git.internal.corp:8443", allowed))
        self.assertNotIn(TOKEN, ask_helper(helper, "git.internal.corp", allowed))

    def test_helper_returns_credentials_only_for_the_allowed_host(self):
        helper = code_creds._helper_script()
        allowed = code_creds.https_host("https://git.internal.corp/team/repo.git")
        self.assertIn(TOKEN, ask_helper(helper, "git.internal.corp", allowed))
        for host in ("gitlab.com", "attacker.example", "evil.invalid"):
            with self.subTest(host=host):
                self.assertNotIn(TOKEN, ask_helper(helper, host, allowed))

    def test_protocol_and_default_port(self):
        helper = code_creds._helper_script()
        allowed = code_creds.https_host("https://EXAMPLE.test:443/team/repo")
        self.assertEqual(allowed, "example.test")
        self.assertIn(TOKEN, ask_helper(helper, "example.test:443", allowed))
        self.assertNotIn(TOKEN, ask_helper(helper, "example.test", allowed, protocol="http"))
        self.assertEqual(code_creds.https_host("http://example.test/team/repo"), "")

    def test_empty_allow_list_withholds_credentials_from_every_host(self):
        helper = code_creds._helper_script()
        for host in ("git.internal.corp", "attacker.example"):
            with self.subTest(host=host):
                self.assertNotIn(TOKEN, ask_helper(helper, host, ""))

    def test_env_for_scopes_the_helper_to_the_given_url(self):
        git = {"name": "Fixture", "email": "fixture@example.test",
               "user": "fixture-user", "token": TOKEN, "key": ""}
        url = "https://git.internal.corp/team/repo.git"
        self.assertFalse(code_creds.env_for({}, git, url=url)["SODUWORK_GIT_TOKEN"])
        bound = code_creds.for_repo(SimpleNamespace(git_creds=git), url)
        env = code_creds.env_for({}, bound, ref="fixture", url=url)
        self.assertEqual(env["SODUWORK_GIT_ALLOWED_HOSTS"], "git.internal.corp")
        helper = helper_from_env(env)
        self.assertTrue(helper, "环境里应当装有 credential.helper")
        self.assertIn(TOKEN, ask_helper(helper, "git.internal.corp", env["SODUWORK_GIT_ALLOWED_HOSTS"]))
        self.assertNotIn(TOKEN, ask_helper(helper, "attacker.example", env["SODUWORK_GIT_ALLOWED_HOSTS"]))

    def test_execution_uses_bound_origin_without_requiring_a_clone_url_again(self):
        from app.services import git_ops

        owner = SimpleNamespace(git_creds={"token": TOKEN})
        target = "https://git.example.test:8443/team/repo.git"
        git = code_creds.for_repo(owner, target)
        env = git_ops._env(git)
        self.assertEqual(env["SODUWORK_GIT_ALLOWED_HOSTS"], "git.example.test:8443")
        self.assertIn(TOKEN, ask_helper(helper_from_env(env), "git.example.test:8443", env["SODUWORK_GIT_ALLOWED_HOSTS"]))
        mismatch = code_creds.env_for({}, git, url="https://other.example.test/demo")
        self.assertFalse(mismatch["SODUWORK_GIT_TOKEN"])
        self.assertFalse(code_creds.for_repo(owner, "")["token"])

    def test_env_for_without_a_url_withholds_credentials(self):
        git = {"name": "Fixture", "email": "fixture@example.test",
               "user": "fixture-user", "token": TOKEN, "key": ""}
        env = code_creds.env_for({}, git, ref="fixture")
        self.assertEqual(env.get("SODUWORK_GIT_ALLOWED_HOSTS", ""), "")
        helper = helper_from_env(env)
        self.assertNotIn(TOKEN, ask_helper(helper, "git.internal.corp", ""))


if __name__ == "__main__":
    unittest.main()
