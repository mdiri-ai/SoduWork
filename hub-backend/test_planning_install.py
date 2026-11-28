"""Offline enterprise index, per-user pip installation and ACP lifecycle checks."""
import base64
import csv
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from hashlib import sha256
from pathlib import Path
from unittest.mock import patch
from zipfile import ZipFile

from app.services import acp_agents, agent_setup
from app.services import planning_install as install
from app.services import planning_release as source


def wheel(index, name, version, files=None):
    module = name.replace("-", "_")
    dist = f"{module}-{version}.dist-info"
    data = dict(files or {})
    data.update({
        f"{dist}/METADATA": f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\nAuthor: yicheng.qiao\n",
        f"{dist}/WHEEL": "Wheel-Version: 1.0\nGenerator: fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
    })
    data = {k: v.encode() for k, v in data.items()}
    record = io.StringIO()
    writer = csv.writer(record)
    for key, raw in data.items():
        digest = base64.urlsafe_b64encode(sha256(raw).digest()).decode().rstrip("=")
        writer.writerow([key, "sha256=" + digest, len(raw)])
    writer.writerow([dist + "/RECORD", "", ""])
    data[dist + "/RECORD"] = record.getvalue().encode()
    page = index / name
    page.mkdir(parents=True, exist_ok=True)
    target = page / f"{module}-{version}-py3-none-any.whl"
    with ZipFile(target, "w") as archive:
        for key, raw in data.items():
            archive.writestr(key, raw)
    (page / "index.html").write_text("".join(
        f'<a href="{p.name}#sha256={sha256(p.read_bytes()).hexdigest()}">{p.name}</a>\n'
        for p in page.glob("*.whl")), encoding="utf-8")
    return sha256(target.read_bytes()).hexdigest()


class ReleaseTests(unittest.TestCase):
    def test_source_fallback_is_confined_to_an_unmanaged_source_session(self):
        # Only the absolute interpreter supplied by start.sh may back a source installation.
        source_env = {"SODUWORK_SOURCE_SESSION": "1", "SODUWORK_SOURCE_RUNNER_PYTHON": sys.executable}
        with patch.dict(os.environ, source_env, clear=True), patch.object(install, "_run") as check:
            self.assertEqual(install._bootstrap_python(), Path(sys.executable))
            self.assertIn("源码", check.call_args.args[2])
        for override in ({"SODUWORK_RUNTIME_MANAGED": "1"}, {"SODUWORK_SOURCE_SESSION": "0"},
                         {"SODUWORK_MANAGED_PYTHON": "invalid-product-path"}):
            with self.subTest(override=override), patch.dict(os.environ, {**source_env, **override}, clear=True):
                with self.assertRaisesRegex(ValueError, "随附"):
                    install._bootstrap_python()
        with patch.dict(os.environ, {**source_env, "SODUWORK_SOURCE_RUNNER_PYTHON": "python"}, clear=True):
            with self.assertRaisesRegex(ValueError, "源码启动器"):
                install._bootstrap_python()
        spawn = subprocess.Popen
        with patch.dict(os.environ, source_env, clear=True), patch.object(
                subprocess, "Popen", side_effect=lambda args, **kw: spawn(
                    [args[0], "-c", "raise SystemExit(1)"], **kw)) as probe:
            with self.assertRaisesRegex(ValueError, "源码启动 Planning 需要使用 CPython 3.12"):
                install._bootstrap_python()
            self.assertIn("sys.version_info[:2] != (3,12)", probe.call_args.args[0][-1])
        with patch.dict(os.environ, {**source_env, "SODUWORK_MANAGED_PYTHON": sys.executable}, clear=True), \
                patch.object(install, "_run") as check:
            self.assertEqual(install._bootstrap_python(), Path(sys.executable))
            self.assertIn("随附", check.call_args.args[2])

    def test_nexus_selects_latest_stable_without_following_yanked_or_foreign_candidates(self):
        index = "https://nexus.example/repository/releases/simple/"
        href = "https://nexus.example/repository/releases/assets/soduwork_planning_harness-0.10.0-py3-none-any.whl"
        contents = (f'<a href="{href}#md5=old">latest</a>' +
                    f'<a href="{href.replace("0.10.0", "0.9.0")}#sha256={"c" * 64}">old</a>' +
                    f'<a data-yanked="" href="{href.replace("0.10.0", "1.0.0")}">retired</a>')
        page = json.dumps({"items": [{"downloadUrl": href, "repository": "releases", "checksum": {"sha256": "a" * 64}}]})
        with patch.dict(os.environ, {"SODUWORK_PLANNING_INDEX_URL": index}), patch.object(
                source, "_read", side_effect=[contents, page]) as read:
            self.assertEqual(source.latest(), source.Release("0.10.0", "a" * 64))
            self.assertIn("/service/rest/v1/search/assets?repository=releases&", read.call_args.args[0])
        with patch.dict(os.environ, {"SODUWORK_PLANNING_INDEX_URL": index}), patch.object(
                source, "_read", return_value=contents.replace("nexus.example", "mirror.example")):
            with self.assertRaisesRegex(ValueError, "其他来源"):
                source.latest()

    def test_reverse_proxy_scheme_in_asset_metadata_only(self):
        index = "https://registry.invalid/repository/company/simple/"
        url = "https://registry.invalid/repository/company/packages/" + source.Release("0.8.0", "").filename
        advertised = url.replace("https://", "http://", 1)
        digest = "a" * 64

        def item(link, repository="company"):
            return {"repository": repository, "downloadUrl": link, "checksum": {"sha256": digest}}

        for metadata_url, repository, accepted in [
            (advertised, "company", True), (url, "company", True),
            (advertised, "another", False),
            (advertised.replace("registry.invalid", "foreign.invalid"), "company", False),
            (advertised.replace("/packages/", "/other/"), "company", False),
            (advertised.replace("registry.invalid", "registry.invalid:8080"), "company", False),
            (advertised + "?mirror=1", "company", False),
        ]:
            with self.subTest(link=metadata_url, repository=repository), patch.dict(
                os.environ, {"SODUWORK_PLANNING_INDEX_URL": index}
            ), patch.object(source, "_read", side_effect=[
                f'<a href="{url}">wheel</a>', json.dumps({"items": [item(metadata_url, repository)]}),
            ]) as reader:
                if accepted:
                    self.assertEqual(source.latest(), source.Release("0.8.0", digest))
                else:
                    with self.assertRaisesRegex(ValueError, "SHA-256"):
                        source.latest()
                self.assertEqual(reader.call_count, 2)
                self.assertTrue(all(call.args[0].startswith("https://registry.invalid/") for call in reader.call_args_list))

    def test_credentials_never_enter_index_arguments(self):
        for value in ["http://repo.example/simple", "https://user:example@repo.example/simple",
                      "https://repo.example/simple?token=example"]:
            with patch.dict(os.environ, {"SODUWORK_PLANNING_INDEX_URL": value}), self.assertRaisesRegex(ValueError, "HTTPS"):
                source.index_url()
        with patch.dict(os.environ, {"PIP_EXTRA_INDEX_URL": "https://untrusted.invalid", "PIP_TRUSTED_HOST": "bad.invalid"}):
            env = install._environment()
            self.assertNotIn("PIP_EXTRA_INDEX_URL", env)
            self.assertNotIn("PIP_TRUSTED_HOST", env)
            self.assertEqual(env["PIP_CONFIG_FILE"], os.devnull)

    def test_management_jobs_require_the_same_desktop_owner_and_hide_credentials(self):
        with patch.object(agent_setup, "_spawn"):
            job = agent_setup.start_install("ai-planning", "install", owner_id="local-owner")
        self.addCleanup(agent_setup._JOBS.pop, job, None)
        self.assertIsNone(agent_setup.job(job, owner_id="local-owner"))
        self.assertIsNone(agent_setup.job(job, owner_id="other", include_private=True))
        result = agent_setup.job(job, owner_id="local-owner", include_private=True)
        self.assertEqual((result["key"], result["action"]), ("ai-planning", "install"))


@unittest.skipUnless(sys.implementation.name == "cpython" and sys.version_info[:2] == (3, 12),
                     "fixture installs real wheels with the supported desktop CPython 3.12")
class InstallationTests(unittest.TestCase):
    def test_real_install_update_rollback_uninstall_and_running_session(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            private, public = work / "private", work / "public"
            base = wheel(private, "mdiri-agent-base", "1.0.0", {"fixture_base.py": "OK = True"})
            dep = wheel(public, "fixture-public", "1.0.0", {"fixture_public.py": "OK = True"})
            # A public namesake cannot satisfy the private name.
            wheel(public, "mdiri-agent-base", "1.0.0", {"fixture_base.py": "OK = False"})
            def publish(version, broken=False):
                launch = f'''import json, sys
import fixture_base, fixture_public
def main():
    from pathlib import Path
    import os
    assert Path(os.environ['PLANNING_STATE_DIR']).is_absolute()
    assert fixture_base.OK and fixture_public.OK
    for line in sys.stdin:
        req = json.loads(line)
        reply = {{"id":req["id"], "jsonrpc":"2.0", "result":{{"protocolVersion":1,
                 "agentInfo":{{"name":"planning-harness","version":{repr("wrong" if broken else version)}}}}}}}
        print(json.dumps(reply),flush=True)
if __name__ == "__main__":
    main()
'''
                mod = source.MODULE
                digest = wheel(private, source.NAME, version, {
                    f"{mod}-{version}.dist-info/entry_points.txt": f"[console_scripts]\nplanning-harness = {mod}.launch:main\n",
                    f"{mod}/__init__.py": "", f"{mod}/launch.py": launch,
                    f"{mod}/manifest.json": json.dumps(dict(schema=1, protocolVersion=1, hostExtensionVersion=1,
                                                            harnessId="ai-planning", distribution=source.NAME, version=version)),
                    f"{mod}/requirements.lock": f"mdiri.agent_base==1.0.0 --hash=sha256:{base}\n"
                                                f"fixture-public==1.0.0 --hash=sha256:{dep}\n",
                })
                return source.Release(version, digest)
            release = publish("1.0.0")
            def current():
                return release
            with patch.dict(os.environ, {"SODUWORK_DATA_ROOT": str(work / "data"), "SODUWORK_MANAGED_PYTHON": sys.executable}), \
                    patch.object(source, "latest", side_effect=current), \
                    patch.object(source, "index_url", side_effect=lambda public=False: (work / ("public" if public else "private")).as_uri()):
                self.assertIn("未安装", install.install("check", lambda _: None))
                with patch.dict(os.environ, {"SODUWORK_MANAGED_PYTHON": "", "SODUWORK_RUNTIME_MANAGED": "0",
                                             "SODUWORK_SOURCE_SESSION": "1", "SODUWORK_SOURCE_RUNNER_PYTHON": sys.executable}):
                    install.install("install", lambda _: None)
                old = install._record()
                install.install("update", lambda _: None)
                new = install._record()
                self.assertEqual((old["version"], old["sha256"]), (new["version"], new["sha256"]))
                self.assertNotEqual(old["generation"], new["generation"])
                console, version = install.installation()
                self.assertEqual(version, "1.0.0")
                cmd = [*acp_agents.executable_command("ai-planning", console), "acp"]
                env = {**os.environ, "PLANNING_STATE_DIR": str(work / "runtime-state")}
                proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env)
                try:
                    initialize = '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n'
                    proc.stdin.write(initialize)
                    proc.stdin.flush()
                    self.assertEqual(json.loads(proc.stdout.readline())["result"]["agentInfo"]["version"], version)
                    second = subprocess.run(cmd, input=initialize, text=True, capture_output=True,
                                            env=env, check=True, timeout=15)
                    self.assertEqual(json.loads(second.stdout)["result"]["agentInfo"]["version"], version)
                    for operation in ("uninstall", "update"):
                        with self.assertRaisesRegex(ValueError, "正在运行"):
                            install.install(operation, lambda _: None)
                finally:
                    proc.stdin.close()
                    proc.wait(timeout=15)
                    proc.stdout.close()
                release = publish("1.1.0", broken=True)
                with self.assertRaisesRegex(ValueError, "ACP"):
                    install.install("update", lambda _: None)
                self.assertEqual(install.installation(), (console, version))
                release = publish("1.2.0")
                install.install("update", lambda _: None)
                self.assertEqual(install.installation()[1], "1.2.0")
                self.assertFalse(Path(console).exists())
                with patch.object(install.shutil, "rmtree", side_effect=PermissionError):
                    self.assertIn("已卸载", install.install("uninstall", lambda _: None))
                self.assertEqual(install.installation(), ("", ""))
                install.install("uninstall", lambda _: None)
                self.assertEqual(list((install.root() / "versions").iterdir()), [])


class ProbeCleanupTests(unittest.TestCase):
    def test_probe_waits_for_eof_and_database_close_before_returning(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp)
            script = state / "test_probe.py"
            script.write_text(
                "import json, sqlite3, sys\n"
                "from pathlib import Path\n"
                "store = sqlite3.connect('sessions.sqlite3')\n"
                "request = json.loads(sys.stdin.readline())\n"
                "print(json.dumps({'id': request['id'], 'result': {'protocolVersion': 1, 'agentInfo': "
                "{'name': 'planning-harness', 'version': '0.2.0'}}}), flush=True)\n"
                "assert sys.stdin.read() == ''\n"
                "store.close()\n"
                "Path('probe-closed').touch()\n", encoding="utf-8")
            spawn = subprocess.Popen

            def run_probe(args, **kwargs):
                return spawn([args[0], "-I", "-B", "-u", str(script)], **kwargs)

            with patch.object(subprocess, "Popen", side_effect=run_probe):
                install._handshake(sys.executable, "0.2.0", state)
            self.assertTrue((state / "probe-closed").is_file())
            (state / "sessions.sqlite3").unlink()

    def test_probe_cleanup_only_retries_bounded_windows_sharing_errors(self):
        error = PermissionError("fixture path")
        for code in (32, 33, 5):
            error.winerror = code
            with self.subTest(code=code), patch.object(install.shutil, "rmtree", side_effect=error) as remove, \
                    patch.object(install.time, "sleep"):
                if code == 5:
                    with self.assertRaises(PermissionError) as caught:
                        install._remove_probe("probe-fixture")
                    self.assertIs(caught.exception, error)
                    self.assertEqual(remove.call_count, 1)
                else:
                    with self.assertRaisesRegex(ValueError, "WinError " + str(code)):
                        install._remove_probe("probe-fixture")
                    self.assertEqual(remove.call_count, 5)
        error.winerror = 32
        with patch.object(install.shutil, "rmtree", side_effect=[error, None]) as remove, patch.object(install.time, "sleep"):
            install._remove_probe("probe-fixture")
            self.assertEqual(remove.call_count, 2)


class InstallationDiagnosticTests(unittest.TestCase):
    def failed_job(self, operation):
        owner = "test-diagnostic-owner"
        with patch.object(install, "install", side_effect=operation), \
                patch.object(agent_setup, "_spawn", side_effect=agent_setup._guard), \
                self.assertLogs("uvicorn.error", level="WARNING") as captured:
            job_id = agent_setup.start_install("ai-planning", "install", owner_id=owner)
            self.addCleanup(agent_setup._JOBS.pop, job_id, None)
        job = agent_setup.job(job_id, owner_id=owner, include_private=True)
        self.assertEqual((job["state"], job["ok"]), ("done", False))
        self.assertIsNone(agent_setup.job(job_id, owner_id="other", include_private=True))
        self.assertLess(len(job["detail"]), 300)
        return job["detail"], "\n".join(job["lines"]), "\n".join(captured.output)

    def test_failed_pip_stage_preserves_bounded_stdout_and_stderr(self):
        script = """
import os, sys
sys.stdout.write('pip progress\\n' * 20000)
sys.stderr.write('Authorization: Bearer ' + 'A' * 100000 + 'clipped-secret-suffix\\n')
print('Proxy-Authorization: NTLM fixture-proxy-credential', file=sys.stderr)
print('403 on /repository/wheel?X-Amz-Signature=fixture-signed-query', file=sys.stderr)
print('Backend said: ' + os.environ['FIXTURE_REPO_TOKEN'], file=sys.stderr)
print('FIXTURE-WHEEL-NOT-FOUND https://fixture-user:fixture-pass@registry.invalid/simple/', flush=True)
print('FIXTURE-HASH-MISMATCH', file=sys.stderr, flush=True)
sys.exit(7)
"""
        def fail(action, say):
            install._run(sys.executable, ["-c", script], "wheel download failed")

        with patch.dict(os.environ, {"FIXTURE_REPO_TOKEN": "fixture-private-env-value"}):
            summary, job_log, runner_log = self.failed_job(fail)
        self.assertIn("wheel download failed", summary)
        self.assertIn("7", summary)
        for output in (job_log, runner_log):
            self.assertIn("FIXTURE-WHEEL-NOT-FOUND", output)
            self.assertIn("FIXTURE-HASH-MISMATCH", output)
            self.assertLess(len(output), 6000)
        self.assertIn("FIXTURE-HASH-MISMATCH", "\n".join(job_log.splitlines()[-40:]))
        for secret in ("fixture-pass", "clipped-secret-suffix", "fixture-proxy-credential",
                       "fixture-private-env-value", "fixture-signed-query"):
            self.assertNotIn(secret, summary + job_log + runner_log)

    def failed_probe(self, script):
        spawn = subprocess.Popen
        def fail(action, say):
            with tempfile.TemporaryDirectory() as state, patch.object(
                    subprocess, "Popen", side_effect=lambda args, **kw: spawn(
                        [args[0], "-I", "-u", "-c", script], **kw)):
                install._handshake(sys.executable, "0.2.1", state)

        return self.failed_job(fail)

    def test_acp_startup_failure_records_stderr_without_echoing_protocol_frames(self):
        summary, job_log, runner_log = self.failed_probe("""
import sys
sys.stdin.readline()
print('FIXTURE-ACP-IMPORT: missing module', file=sys.stderr, flush=True)
print('Authorization: Bearer fixture-acp-bearer', file=sys.stderr, flush=True)
print('{"debug": "fixture-private-protocol-payload"}', flush=True)
sys.exit(3)
""")
        self.assertIn("ACP", summary)
        for output in (job_log, runner_log):
            self.assertIn("FIXTURE-ACP-IMPORT", output)
        for value in ("fixture-acp-bearer", "fixture-private-protocol-payload"):
            self.assertNotIn(value, summary + job_log + runner_log)

    def test_acp_error_without_stderr_retains_safe_rpc_reason(self):
        summary, job_log, runner_log = self.failed_probe("""
import json, sys
request = json.loads(sys.stdin.readline())
print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "error": {
    "code": -32042, "message": "FIXTURE-ADAPTER-UNAVAILABLE token=fixture-rpc-secret",
    "data": {"session": "fixture-private-session-data"}
}}), flush=True)
""")
        for output in (job_log, runner_log):
            self.assertIn("-32042", output)
            self.assertIn("FIXTURE-ADAPTER-UNAVAILABLE", output)
        for value in ("fixture-rpc-secret", "fixture-private-session-data"):
            self.assertNotIn(value, summary + job_log + runner_log)

    def test_runner_log_keeps_sanitized_exception_causes(self):
        def fail(action, say):
            try:
                raise OSError("FIXTURE-CERTIFICATE-VERIFY-FAILED at https://fixture-user:fixture-cause-pass@registry.invalid")
            except OSError as cause:
                raise ValueError("could not access Planning index") from cause

        summary, job_log, runner_log = self.failed_job(fail)
        self.assertIn("could not access Planning index", summary)
        self.assertIn("OSError", runner_log)
        self.assertIn("FIXTURE-CERTIFICATE-VERIFY-FAILED", runner_log)
        self.assertNotIn("fixture-cause-pass", summary + job_log + runner_log)

    def test_timeout_keeps_stderr_and_hides_subprocess_arguments(self):
        def fail(action, say):
            install._run(sys.executable, ["-u", "-c",
                "import sys, time; print('FIXTURE-CONNECT-RETRY', file=sys.stderr); time.sleep(20)",
                "fixture-private-argument"], "wheel download failed", timeout=2)

        summary, job_log, runner_log = self.failed_job(fail)
        self.assertIn("wheel download failed", summary)
        for output in (job_log, runner_log):
            self.assertIn("FIXTURE-CONNECT-RETRY", output)
        self.assertNotIn("fixture-private-argument", summary + job_log + runner_log)
