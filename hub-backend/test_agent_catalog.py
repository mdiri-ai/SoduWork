"""Shared catalog, explicit optional installs and real declaration-only ACP I/O."""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent


def fixture_entry():
    return {
        'id': 'fixture-acp', 'displayName': 'Fixture ACP', 'transport': 'runner',
        'modelMode': 'managed', 'goalMode': 'native', 'group': 'more', 'order': 100,
        'summary': 'Test-only protocol executable',
        'accessControl': {'schema': 'soduwork.access-policy/v1', 'supported': False,
                          'modes': [], 'approval': '', 'sandbox': False},
        'runner': {'adapter': 'acp', 'bins': ['fixture-acp'],
                   'args': ['-u', str(ROOT / 'tests/catalog_acp_agent.py')],
                   'home': {'env': 'FIXTURE_HOME', 'folder': '.fixture-acp'},
                   'modelEnv': {'FIXTURE_BASE': 'base', 'FIXTURE_KEY': 'key', 'FIXTURE_MODEL': 'model'}},
        'install': {'installer': 'manual', 'pkg': '', 'blurb': 'Test fixture',
                    'config_how': 'Environment only', 'config_path': '', 'install_how': 'Provide a reviewed executable'},
    }


class CatalogTest(unittest.TestCase):
    def test_catalog_drives_profiles_installs_models_and_names(self):
        from app import agent_catalog
        from app.services import local_base, agent_setup, agent_execution_options, agent_naming
        self.assertEqual(set(agent_catalog.AGENTS), set(local_base._PROFILES))
        self.assertEqual(set(agent_catalog.AGENTS), set(agent_setup._SPECS))
        for key, row in agent_catalog.AGENTS.items():
            self.assertEqual(local_base._PROFILES[key]['name'], row['displayName'])
            self.assertEqual('local:' + key in agent_execution_options.GATEWAY_MODEL_KINDS,
                             row['modelMode'] == 'managed')
            self.assertEqual(agent_naming.cli_from_name('开发机 · ' + row['displayName']), key)

    def test_malformed_declarations_fail_before_registration(self):
        from app.agent_catalog import load_catalog
        cases = [
            lambda row: row.update(id='../escape'),
            lambda row: row.update(transport='direct'),
            lambda row: row.update(goalMode='script'),
            lambda row: row.pop('accessControl'),
            lambda row: row['accessControl'].update(modes=['full']),
            lambda row: row['runner'].update(adapter='remote-script'),
            lambda row: row['runner'].update(args='shell command'),
            lambda row: row['runner']['home'].update(folder='../outside'),
            lambda row: row['runner']['modelEnv'].update(FIXTURE_KEY='file:/secret'),
            lambda row: row['install'].update(installer='managed'),
            lambda row: row['install'].update(installer='npm', pkg='pkg && command'),
            lambda row: row['install'].update(installer='npm', pkg='fixture-agent', version='latest'),
        ]
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'catalog.json'
            for mutate in cases:
                row = fixture_entry()
                mutate(row)
                target.write_text(json.dumps({'schemaVersion': 1, 'agents': [row]}), encoding='utf-8')
                with self.subTest(mutate=mutate), self.assertRaises(ValueError):
                    load_catalog(target)

    def test_pi_installation_is_pinned_to_the_audited_runtime(self):
        from app.agent_catalog import AGENTS
        self.assertEqual(AGENTS['pi']['install']['version'], '0.84.4')

    def test_armonel_uses_only_the_bundled_program_and_orders_after_pi(self):
        from app.agent_catalog import AGENTS
        from app.services import acp_agents, agent_setup
        self.assertEqual(sorted(AGENTS, key=lambda key: AGENTS[key]['order'])[:3],
                         ['pi', 'armonel', 'codex-harness'])
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / ('armonel.exe' if os.name == 'nt' else 'armonel')
            binary.write_bytes(b'native package fixture')
            binary.chmod(0o755)
            with patch.dict(os.environ, {'SODUWORK_BUNDLED_ARMONEL': binary.name,
                                         'SODUWORK_AGENT_ARMONEL_BIN': str(binary)}):
                self.assertIsNone(acp_agents.find_bin('armonel'))
                with patch.object(agent_setup, '_spawn') as spawn:
                    job = agent_setup.job(agent_setup.start_install('armonel', 'install'))
                    self.assertFalse(job['ok'])
                    self.assertFalse(agent_setup.can_uninstall('armonel'))
                    spawn.assert_not_called()
            with patch.dict(os.environ, {'SODUWORK_BUNDLED_ARMONEL': str(binary)}):
                self.assertEqual(acp_agents.find_bin('armonel'), str(binary))
                metadata = acp_agents.run_args('saved-id', 'work')
                readonly = acp_agents.command_argv('armonel', str(binary), metadata, directory, {})
                self.assertIn('--read-only', readonly)
                self.assertNotIn('--allow-write', readonly)
                self.assertEqual(readonly[readonly.index('--session') + 1], 'saved-id')
                work = acp_agents.command_argv('armonel', str(binary), metadata, directory,
                                             {'accessPolicy': {'mode': 'standard'}})
                self.assertEqual(work[work.index('--') + 1:][:2], [str(binary), 'acp'])
                self.assertIn('--allow-write', work)
                self.assertIn('--allow-exec', work)
                self.assertNotIn('--read-only', work)

    def test_armonel_constrains_each_request_independently_of_task_length(self):
        from app.services.acp_agents import _agent_args
        model = {"base": "http://127.0.0.1:1/v1", "model": "fixture"}
        for settings, expected in (
            ({}, ["32768", "8192"]),
            ({"contextWindow": 128000, "contextWindowSource": "safe-default"}, ["32768", "8192"]),
            ({"contextWindow": 128000, "contextWindowSource": "configured"}, ["128000", "8192"]),
            ({"contextWindow": 32768, "maxOutputTokens": 16384}, ["32768", "16384"]),
            ({"contextWindow": 4096, "maxOutputTokens": 8192}, ["4096", "3840"]),
            ({"contextWindow": 4000000}, ["2000000", "8192"]),
        ):
            with self.subTest(settings=settings):
                args = _agent_args("armonel", {"llm": {**model, **settings}})
                self.assertEqual(args[:1], ["acp"])
                self.assertEqual(args[1::2], ["--context-window", "--max-tokens", "--max-total-tokens", "--max-tool-calls"])
                self.assertEqual(args[2::2], [*expected, "0", "0"])
        self.assertEqual(_agent_args("armonel", {}),
                         ["acp", "--max-total-tokens", "0", "--max-tool-calls", "0"])

    def test_armonel_forwards_only_declared_openai_reasoning_effort(self):
        from app.services.acp_agents import _agent_args
        model = {"base": "http://127.0.0.1:1/v1", "model": "fixture", "kind": "openai-compat",
                 "reasoning": True, "supportsReasoningEffort": True, "thinkingFormat": "openai",
                 "thinkingMode": "controllable", "thinkingLevel": "high",
                 "thinkingLevelMap": {"high": "high", "medium": "xhigh", "off": "none"}}
        for changes, expected in (
            ({}, "high"),
            ({"thinkingLevel": "medium"}, "xhigh"),
            ({"thinkingLevel": "off"}, "off"),
            ({"thinkingLevel": "off", "thinkingMode": "always"}, None),
            ({"thinkingLevel": "off", "thinkingAlwaysOn": True}, None),
            ({"thinkingLevel": ""}, None),
            ({"thinkingFormat": "deepseek"}, None),
            ({"thinkingMode": "none"}, None),
            ({"kind": "anthropic"}, None),
            ({"supportsReasoningEffort": False}, None),
            ({"thinkingLevelMap": {}}, None),
            ({"thinkingLevelMap": {"high": None}}, None),
            ({"thinkingLevelMap": {"high": "unsupported-value"}}, None),
        ):
            with self.subTest(changes=changes):
                args = _agent_args("armonel", {"llm": {**model, **changes}})
                if expected is None:
                    self.assertNotIn("--thinking", args)
                else:
                    self.assertEqual(args[args.index("--thinking") + 1], expected)

    def test_armonel_recovery_uses_only_declared_wire_efforts(self):
        from app.services.acp_agents import inject_llm_env
        route = {"base": "http://localhost/v1", "model": "alias", "localOnly": True}
        for restrictions, expected in (
            ({}, None),
            ({"thinkingLevelMap": {"low": None, "high": "high"}}, ["high"]),
            ({"thinkingLevelMap": {"low": "medium", "high": "high", "off": "none"}}, ["medium", "high"]),
            ({"thinkingLevelMap": {"off": None}}, []),
            ({"supportsReasoningEffort": False, "thinkingLevelMap": {"low": "low"}}, []),
            ({"reasoning": False}, []),
            ({"thinkingMode": "none"}, []),
        ):
            with self.subTest(restrictions=restrictions):
                env = {"ARMONEL_CHAT_RECOVERY_EFFORTS": '["max"]'}
                inject_llm_env("armonel", env, {**route, **restrictions})
                raw = env.get("ARMONEL_CHAT_RECOVERY_EFFORTS")
                self.assertEqual(json.loads(raw) if raw is not None else None, expected)

    def test_armonel_selects_reasoning_recovery_for_verified_gateway(self):
        from app.services.acp_agents import _agent_args, inject_llm_env
        route = {"base": "https://gateway.example/v1", "model": "deployment", "key": "test"}
        device = tempfile.TemporaryDirectory()
        self.addCleanup(device.cleanup)
        self.enterContext(patch.dict(os.environ, {"SODUWORK_DATA_ROOT": device.name}))
        profiles = Path(device.name) / ".armonel" / "recovery-profiles.json"
        profiles.parent.mkdir()
        profiles.write_text(json.dumps({route["base"]: {route["model"]: "openai"}}), encoding="utf-8")
        for changes, expected in (
            ({}, "openai"),
            ({"base": route["base"] + "/", "thinkingMode": "auto"}, "openai"),
            ({"reasoning": True, "thinkingFormat": "openai"}, "openai"),
            ({"thinkingMode": "always"}, None),
            ({"thinkingAlwaysOn": True}, None),
            ({"thinkingMode": "none"}, None),
            ({"supportsReasoningEffort": False}, None),
            ({"thinkingLevelMap": {"off": None}}, None),
            ({"thinkingFormat": "qwen"}, None),
            ({"reasoning": False}, None),
            ({"model": "another-deployment"}, None),
            ({"base": "https://gateway.example.other/v1"}, None),
            ({"base": route["base"] + "/other"}, None),
            ({"reasoning": True, "thinkingMode": "controllable", "thinkingFormat": "zai"}, "zai"),
        ):
            with self.subTest(changes=changes):
                model = {**route, **changes}
                env = {"ARMONEL_CHAT_THINKING_OFF": "stale"}
                inject_llm_env("armonel", env, model)
                self.assertEqual(env.get("ARMONEL_CHAT_THINKING_OFF"), expected)
                self.assertNotIn("--thinking", _agent_args("armonel", {"llm": model}))
        for agent in ("dsh", "opencode"):
            with self.subTest(agent=agent):
                env = {}
                inject_llm_env(agent, env, route)
                self.assertNotIn("ARMONEL_CHAT_THINKING_OFF", env)
        for content in ("[]", "{", '{"https://gateway.example/v1": []}', None):
            with self.subTest(invalid_profile=content):
                if content is None:
                    profiles.unlink()
                else:
                    profiles.write_text(content, encoding="utf-8")
                env = {}
                inject_llm_env("armonel", env, route)
                self.assertNotIn("ARMONEL_CHAT_THINKING_OFF", env)

    def test_source_compatible_acp_runtimes_pin_versions_separately_from_package_names(self):
        from app.agent_catalog import AGENTS, install_specs
        expected = {
            'kimi': ('@moonshot-ai/kimi-code', '2.6.2'),
            'qwen': ('@qwen-code/qwen-code', '0.27.4'),
            'dsh': ('@openma/deepseek-harness-acp', '0.4.41'),
        }
        for key, (package, version) in expected.items():
            self.assertEqual(AGENTS[key]['install']['pkg'], package)
            self.assertEqual(install_specs()[key]['version'], version)
        for key in ('codex', 'codex-harness', 'opencode'):
            self.assertNotIn('version', AGENTS[key]['install'])

    def test_opencode_detection_never_installs_and_ignores_retired_bundle(self):
        from app.services import agent_setup, managed_agents, local_base
        with tempfile.TemporaryDirectory() as directory:
            old = Path(directory) / 'old-opencode.exe'
            old.write_bytes(b'old bundled fixture')
            with (patch.dict(os.environ, {'SODUWORK_BUNDLED_OPENCODE': str(old)}),
                  patch.object(managed_agents, 'managed_binary', return_value=''),
                  patch.object(managed_agents, '_read_active', return_value=''),
                  patch.object(agent_setup, '_pkg_version', return_value=''),
                  patch.object(local_base, '_npm_root', return_value=''),
                  patch.object(local_base.shutil, 'which', return_value=None),
                  patch.object(managed_agents, 'install') as install):
                result = agent_setup.detect('opencode', probes={})
                self.assertFalse(result['installed'])
                self.assertFalse(result['bundled'])
                self.assertEqual(result['state'], 'missing')
                install.assert_not_called()

    def test_existing_opencode_installations_remain_available(self):
        from app.services import local_base, managed_agents
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / 'opencode.exe'
            executable.write_bytes(b'local installed fixture')
            with patch.object(managed_agents, 'managed_binary', return_value=str(executable)):
                self.assertEqual(local_base._opencode_bin(), str(executable))
            with (patch.object(managed_agents, 'managed_binary', return_value=''),
                  patch.object(local_base, '_npm_root', return_value=''),
                  patch.object(local_base.shutil, 'which', return_value=str(executable))):
                self.assertEqual(local_base._opencode_bin(), str(executable))

    def test_install_only_starts_for_explicit_valid_action(self):
        from app.services import agent_setup, managed_agents
        with patch.object(agent_setup, '_spawn') as spawn:
            job = agent_setup.start_install('opencode', 'install')
            self.assertTrue(job)
            spawn.assert_called_once_with(job, agent_setup._run_managed, 'opencode', 'install')
        with patch.object(managed_agents, '_download') as download:
            with self.assertRaises(ValueError):
                managed_agents.install('startup', lambda line: None)
            with self.assertRaises(ValueError):
                agent_setup.start_install('not-registered', 'install')
            with self.assertRaises(ValueError):
                agent_setup.start_install('opencode', 'startup')
            download.assert_not_called()

    def test_new_acp_declaration_dispatches_writes_delivers_and_resumes(self):
        from app import agent_catalog
        data = {'schemaVersion': 1, 'agents': [*copy.deepcopy(list(agent_catalog.AGENTS.values())), fixture_entry()]}
        with tempfile.TemporaryDirectory(prefix='soduwork-catalog-test-') as directory:
            catalog = Path(directory) / 'catalog.json'
            catalog.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
            env = {**os.environ, 'SODUWORK_DATA_ROOT': str(Path(directory) / 'data'),
                   'SODUWORK_AGENT_FIXTURE_ACP_BIN': sys.executable, 'PYTHONUTF8': '1'}
            result = subprocess.run([sys.executable, str(Path(__file__).resolve()),
                                     '--fixture', str(catalog), directory],
                                    cwd=ROOT, env=env, capture_output=True, text=True,
                                    encoding='utf-8', timeout=45)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('CATALOG_DISPATCH_RESUME_OK', result.stdout)


def run_fixture(catalog_path, directory):
    # Simulates adding exactly one reviewed JSON entry before normal startup.
    # No runtime dispatch, profile registry or ACP bridge implementation is patched.
    from app import agent_catalog
    agent_catalog.AGENTS = agent_catalog.load_catalog(Path(catalog_path))
    from app.services import agent_setup, local_base, ai_local, agent_execution_options, access_policy
    from app.services.local_ctx import prepare_resume
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from types import SimpleNamespace
    import threading
    import time

    class ModelReachability(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
        def log_message(self, *_args):
            pass

    server = HTTPServer(('127.0.0.1', 0), ModelReachability)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    workspace = Path(directory) / 'work'
    workspace.mkdir()
    cfg = {'local_workspace_root': str(workspace), 'llm': {
        'base': f'http://127.0.0.1:{server.server_port}', 'key': 'fixture-secret', 'model': 'fixture-model'}}
    assert 'fixture-acp' in agent_setup._SPECS
    assert agent_setup.detect('fixture-acp', probes={})['installed']
    assert 'local:fixture-acp' in agent_execution_options.GATEWAY_MODEL_KINDS
    assert not access_policy.capability('fixture-acp')['supported']
    assignee = ai_local.resolve_assignee_sync(cfg, 'local:fixture-acp')
    assert assignee and assignee['cliName'] == 'Fixture ACP'
    task = SimpleNamespace(id='catalog-task', title='Write a report', note='Create catalog-result.md')
    receipt = ai_local.dispatch_sync(cfg, task, assignee=assignee, ctx={
        'workDir': str(workspace), 'requiredCapabilities': ['files'],
        'conversationMode': 'adaptive', 'conversationUserText': 'Write a report'})
    assert receipt.get('ok'), receipt
    ref = receipt['issueId']

    def finish():
        deadline = time.monotonic() + 15
        while local_base._RUNS[ref]['state'] == 'running' and time.monotonic() < deadline:
            time.sleep(.05)
        run = local_base._RUNS[ref]
        assert run['state'] == 'done', (run['state'], run.get('error'), run.get('lines'))
        assert run['cliSid'] == 'catalog-fixture-session', run['cliSid']
        status = ai_local.status_sync(cfg, ref)
        assert any(item['filename'] == 'catalog-result.md' for item in status['attachments']), status
        assert 'catalog-result.md' in status['finalText'], status

    finish()
    assert 'First turn delivered' in (workspace / 'catalog-result.md').read_text(encoding='utf-8')
    resumed = prepare_resume(ref, 'Continue and revise the report', cfg)
    assert resumed.get('ok'), resumed
    finish()
    assert 'Resumed successfully' in (workspace / 'catalog-result.md').read_text(encoding='utf-8')
    server.shutdown()
    server.server_close()
    print('CATALOG_DISPATCH_RESUME_OK')


if __name__ == '__main__':
    if '--fixture' in sys.argv:
        run_fixture(sys.argv[2], sys.argv[3])
    else:
        unittest.main()
