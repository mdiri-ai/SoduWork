"""Exercise the packaged launch contract, private desktop channel, and ACP lifecycle."""
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

NS = "com.allintechinc/planning"


def fixture():
    def read():
        return json.loads(sys.stdin.readline())

    def send(**fields):
        print(json.dumps({"jsonrpc": "2.0", **fields}), flush=True)

    def answer(req, **fields):
        send(id=req["id"], result=fields)

    assert not os.environ.get("PLANNING_TEST_HOST_SECRET")
    assert not os.environ.get("SODUWORK_APPROVAL_CHANNEL")
    init = read()
    caps = init["params"]["clientCapabilities"]
    assert caps["terminal"] is False
    answer(init, protocolVersion=1, agentCapabilities={"_meta": caps["_meta"], "loadSession": True})
    session = read()
    assert session["params"]["_meta"][NS]["ownerId"] == "owner"
    answer(session, sessionId="native")
    prompt = read()
    mode = prompt["params"]["prompt"][0]["text"]
    params = {"sessionId": "native", "executionId": prompt["params"]["_meta"][NS]["executionId"],
              "callId": "model-1", "request": {"messages": [{"role": "user", "content": "hello"}]}}
    if mode == "skip-commit":
        answer(prompt, stopReason="end_turn")
        return
    send(id=1, method="_" + NS + "/model", params={**params, "sessionId": "other"})
    assert read()["error"]["code"] == -32602
    if mode.startswith("stream"):
        assert caps["_meta"][NS]["modelStream"] is True
        params["stream"] = True
    send(id=2, method="_" + NS + "/model", params=params)
    if mode in ("stream", "stream-cancel"):
        for seq in range(1 if mode == "stream-cancel" else 2):
            event = read()
            assert "id" not in event and event["method"] == "_" + NS + "/modelChunk"
            delta = event["params"]
            assert delta["seq"] == seq and delta["callId"] == "model-1" and delta["sessionId"] == "native"
        if mode == "stream-cancel":
            while read().get("method") != "session/cancel":
                pass
            answer(prompt, stopReason="cancelled")
            return
        assert read()["result"] == {"streamed": True, "chunkCount": 2}
    else:
        if mode == "cancel":
            while read().get("method") != "session/cancel":
                pass
            answer(prompt, stopReason="cancelled")
            return
        assert read()["result"]["choices"][0]["message"]["content"] == "ok"
    artifacts = []
    if mode.startswith("read-attachment:"):
        target = mode.split(":", 1)[1]
        send(id=4, method="fs/read_text_file", params={"sessionId": "native", "path": target})
        assert read()["result"]["content"] == "一月,15\n二月,17"
        send(id=5, method="fs/write_text_file", params={"sessionId": "native", "path": target, "content": "changed"})
        assert "error" in read()
    if mode == "workbook":
        assert caps["_meta"][NS]["workbook"] is True
        target = str(Path.cwd() / "report.xlsx")
        rows = [["项目", "次数"], ["检修", 3]]
        send(id=4, method="session/request_permission", params={"sessionId": "native",
            "options": [{"optionId": "yes", "kind": "allow_once", "name": "允许"},
                        {"optionId": "no", "kind": "reject_once", "name": "拒绝"}],
            "toolCall": {"toolCallId": "workbook-1", "kind": "edit", "title": "写入工作表",
                         "rawInput": {"path": target, "workbookRows": rows}}})
        assert read()["result"]["outcome"]["optionId"] == "yes"
        book = {**params, "callId": "workbook-1", "path": "report.xlsx", "operation": "write", "rows": rows}
        send(id=5, method="_" + NS + "/workbook", params=book)
        fact = read()["result"]
        assert fact["path"] == "report.xlsx" and fact["rows"] == rows
        send(id=6, method="_" + NS + "/workbook", params={**book, "operation": "read"})
        assert read()["result"] == fact
        send(id=7, method="_" + NS + "/workbook", params=book)
        assert "error" in read()
        artifacts = [{"path": fact["path"], "sha256": fact["sha256"]}]
    send(id=3, method="_" + NS + "/commit", params={**params, "callId": "publish", "artifacts": artifacts})
    assert read()["result"]["receiptId"] == "receipt"
    answer(prompt, stopReason="end_turn")


class PlanningRunnerTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from app.services import local_base, planning_host, access_policy, access_broker
        self.ref = "test-planning-" + self._testMethodName
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        policy = access_policy.normalize({"schema": access_policy.SCHEMA, "mode": "standard",
            "revision": 1, "workspaceRoot": str(self.root)}, str(self.root))
        self.calls = []
        self.model_started = asyncio.Event()
        self.wait_for_cancel = False
        self.stream_open = asyncio.Event()
        self.stream_closed = asyncio.Event()
        self.return_completion = False
        planning_host.configure(asyncio.get_running_loop(), self)
        self.addCleanup(planning_host.configure, None, None)
        run = {"state": "running", "cli": "ai-planning", "ws": str(self.root), "eventDestination": "local", "accessPolicy": policy}
        self.enterContext(patch.dict(local_base._RUNS, {self.ref: run}))
        self.enterContext(patch.object(local_base, "_STORE", str(self.root / "runs")))
        env = {}
        self.cfg = {"accessPolicy": policy, "planningHostGrant": "private-test-grant",
                    "planningOwnerId": "owner", "planningExecutionId": "turn"}
        self.channel = access_broker.attach(self.ref, self.cfg, env)
        self.addCleanup(access_broker.close, self.ref)
        self.enterContext(patch.dict(os.environ, {**env, "PLANNING_TEST_HOST_SECRET": "private"}))

    async def call(self, body, timeout):
        self.calls.append(body)
        self.assertEqual((body["grant"], body["runId"], body["workspace"]),
                         ("private-test-grant", self.ref, str(self.root)))
        if body["method"] == "model.start":
            if self.return_completion:
                completion = {"choices": [{"message": {"content": "ok"}}]}
                return {"ok": True, "data": {"completion": completion}}
            return {"ok": True, "data": {"started": True}}
        if body["method"] == "model.next":
            seq = body["params"]["seq"]
            if seq == 1 and self.wait_for_cancel:
                self.stream_open.set()
                await asyncio.Future()
            return {"ok": True, "data": {"chunks": [{"choices": [{"delta": {"content": str(seq)}}]}],
                                         "done": seq == 1}}
        if body["method"] == "model.close":
            self.stream_closed.set()
            return {"ok": True, "data": {}}
        if body["method"] in {"workbook.authorize", "fs.authorize"}:
            return {"ok": True, "data": {"authorized": True}}
        if body["method"] == "commit":
            return {"ok": True, "data": {"receiptId": "receipt", "artifacts": []}}
        self.model_started.set()
        if self.wait_for_cancel:
            await asyncio.Future()
        return {"ok": True, "data": {"choices": [{"message": {"content": "ok"}}]}}

    def drive(self, mode):
        from app.services.acp_bridge import AcpBridge
        bridge = AcpBridge([sys.executable, "-I", "-u", __file__, "--agent"],
                           str(self.root), "ai-planning", "workspace", allow_terminal=True)
        try:
            return bridge.run(mode)
        finally:
            bridge.close()

    async def test_full_turn(self):
        self.assertEqual(await asyncio.to_thread(self.drive, "complete"), 0)
        self.assertEqual([c["method"] for c in self.calls], ["model", "commit"])

    async def test_no_success_without_desktop_receipt(self):
        from app.services.acp_bridge import BridgeError
        with self.assertRaisesRegex(BridgeError, "回执"):
            await asyncio.to_thread(self.drive, "skip-commit")

    async def test_cancel_inflight_model(self):
        from app.services import access_broker
        self.wait_for_cancel = True
        task = asyncio.create_task(asyncio.to_thread(self.drive, "cancel"))
        await asyncio.wait_for(self.model_started.wait(), 5)
        self.assertTrue(access_broker.cancel_planning(self.ref))
        self.assertEqual(await asyncio.wait_for(task, 5), 0)
        self.assertEqual([c["method"] for c in self.calls], ["model"])

    def enable_stream(self):
        self.channel.planning.model_stream = True
        env = json.loads(os.environ["SODUWORK_APPROVAL_CHANNEL"])
        env["planning"]["modelStream"] = True
        os.environ["SODUWORK_APPROVAL_CHANNEL"] = json.dumps(env)

    async def test_stream_is_forwarded_before_completion(self):
        self.enable_stream()
        self.assertEqual(await asyncio.to_thread(self.drive, "stream"), 0)
        self.assertEqual([c["method"] for c in self.calls], [
            "model.start", "model.next", "model.next", "model.close", "commit"])

    async def test_stream_accepts_same_request_json_response(self):
        self.enable_stream()
        self.return_completion = True
        self.assertEqual(await asyncio.to_thread(self.drive, "stream-json"), 0)
        self.assertEqual([c["method"] for c in self.calls], ["model.start", "model.close", "commit"])

    async def test_cancel_after_first_stream_delta(self):
        from app.services import access_broker
        self.enable_stream()
        self.wait_for_cancel = True
        task = asyncio.create_task(asyncio.to_thread(self.drive, "stream-cancel"))
        await asyncio.wait_for(self.stream_open.wait(), 5)
        self.assertTrue(access_broker.cancel_planning(self.ref))
        self.assertEqual(await asyncio.wait_for(task, 5), 0)
        await asyncio.wait_for(self.stream_closed.wait(), 2)
        self.assertFalse(any(c["method"] == "commit" for c in self.calls))

    async def test_attachment_archive_is_projected_read_only(self):
        from app.services import local_base, planning_host
        archive = Path(local_base._store_dir(self.ref)) / "inputs"
        archive.mkdir(parents=True)
        data = "一月,15\n二月,17"
        source = archive / "数据.csv"
        source.write_text(data, encoding="utf-8")
        staged = [{"path": str(source), "contentType": "text/csv", "name": source.name}]
        view = planning_host.input_view(str(self.root), self.ref, staged)[0]
        self.assertFalse(Path(view["path"]).exists())
        self.assertEqual(await asyncio.to_thread(self.drive, "read-attachment:" + view["path"]), 0)
        self.assertEqual([b["method"] for b in self.calls], ["model", "fs.authorize", "commit"])
        self.assertEqual(source.read_text(encoding="utf-8"), data)

    async def test_workbook_write_and_read_via_real_skill(self):
        from app.services import access_broker
        helper = Path(__file__).resolve().parents[1] / "skills/office/scripts/planning_workbook.py"
        self.channel.planning.workbook = [sys.executable, "-I", "-B", "-u", str(helper)]
        env = json.loads(os.environ["SODUWORK_APPROVAL_CHANNEL"])
        env["planning"]["workbook"] = True
        os.environ["SODUWORK_APPROVAL_CHANNEL"] = json.dumps(env)
        job = asyncio.create_task(asyncio.to_thread(self.drive, "workbook"))
        async with asyncio.timeout(5):
            while not self.channel.pending:
                await asyncio.sleep(.05)
        request_id = next(iter(self.channel.pending))
        result = access_broker.respond(self.ref, request_id, "once", 1)
        self.assertTrue(result["ok"])
        self.assertEqual(await asyncio.wait_for(job, 20), 0)
        self.assertEqual(sum(c["method"] == "workbook.authorize" for c in self.calls), 3)
        self.assertTrue((self.root / "report.xlsx").is_file())

    def test_office_command_uses_the_desktop_python_and_sibling_skill(self):
        from app.services import planning_workbook
        layout = "python/python.exe" if os.name == "nt" else "python/bin/python3"
        python = self.root / layout
        helper = self.root / "skills/office/scripts/planning_workbook.py"
        for f in (python, helper, helper.with_name("inspect_office.py")):
            f.parent.mkdir(parents=True, exist_ok=True)
            f.touch()
        with patch.dict(os.environ, {"SODUWORK_MANAGED_PYTHON": str(python), "SODUWORK_PLANNING_WORKBOOK": str(helper)}), \
                patch.object(planning_workbook.subprocess, "run") as probe:
            probe.return_value.stdout = b'{"ready":true}'
            self.assertEqual(planning_workbook.command(), [str(python), "-I", "-B", "-u", str(helper)])
            self.assertEqual(probe.call_count, 1)
            with patch.dict(os.environ, {"SODUWORK_PLANNING_WORKBOOK": str(self.root / "elsewhere.py")}):
                self.assertIsNone(planning_workbook.command())
            with patch.dict(os.environ, {"SODUWORK_MANAGED_PYTHON": str(self.root / "elsewhere/python3")}):
                self.assertIsNone(planning_workbook.command())
            helper.with_name("inspect_office.py").unlink()
            self.assertIsNone(planning_workbook.command())
            self.assertEqual(probe.call_count, 1)

    def test_only_the_execution_target_is_desktop_only(self):
        from fastapi import HTTPException
        from app.services import cloud_conversations, cloud_environments, handoff_agent_policy
        targets = cloud_environments._available_agents([{"key": "ai-planning"}])
        self.assertNotIn("ai-planning", {target["id"] for target in targets})
        with self.assertRaises(HTTPException) as denied:
            cloud_conversations.clean_options({"agentId": "ai-planning", "sessionId": "test-planning", "text": "continue"})
        self.assertEqual(denied.exception.status_code, 422)
        source = {"adapterId": "ai-planning"}
        consent = {"fromAgentId": "ai-planning", "toAgentId": "pi", "accepted": True}
        self.assertTrue(handoff_agent_policy.validate(source, {"agentFallback": consent}, "pi"))
        with self.assertRaises(HTTPException):
            handoff_agent_policy.validate(source, {}, "pi")

    async def test_remote_cannot_start_or_continue_a_planning_turn(self):
        import runner_main
        from app.services import runner_event_scope
        runner = object.__new__(runner_main.Runner)
        for message in [{"op": "job.dispatch", "cli": "ai-planning"},
                        {"op": "job.comment", "ref": self.ref},
                        {"op": "job.comment", "cfg": self.cfg, "ref": self.ref}]:
            packet = runner_event_scope.ingress({**message, "_localParent": True}, local=False)
            result = await runner._job(packet)
            self.assertEqual(result["code"], "DESKTOP_AGENT_REQUIRED")

    async def test_planning_history_uses_the_standard_session_projection(self):
        import runner_main
        from app.services import ai_local, local_stream, runner_admission, runner_event_scope
        runner = object.__new__(runner_main.Runner)
        runner._admission = runner_admission.AdmissionQueue()
        with patch.object(ai_local, "session_sync", return_value={"items": [], "usageReceipts": ["private"]}), \
                patch.object(local_stream, "authorization_required_sync", return_value=False):
            answer = await runner._job(runner_event_scope.ingress({"op": "job.session", "ref": self.ref}, local=False))
        self.assertTrue(answer["ok"], answer)
        self.assertEqual(answer["data"]["items"], [])
        self.assertNotIn("usageReceipts", answer["data"])

    def test_requires_managed_planning_installation_and_local_identity(self):
        from app.services import acp_agents, agent_setup, planning_host, planning_install
        self.assertTrue(agent_setup.can_uninstall("ai-planning"))
        launcher = self.root / "launch.py"
        launcher.touch()
        with patch.dict(os.environ, {"SODUWORK_DATA_ROOT": str(self.root),
                "SODUWORK_AGENT_AI_PLANNING_BIN": sys.executable, "SODUWORK_PLANNING_LAUNCHER": str(launcher)}):
            self.assertIsNone(acp_agents.find_bin("ai-planning"))
            generation = planning_install.root() / "versions" / ("a" * 32)
            console = planning_install._console(generation)
            console.parent.mkdir(parents=True)
            for path in (console, planning_install._interpreter(generation), generation / "entry.py", generation / "pyvenv.cfg"):
                path.touch()
            self.assertIsNone(acp_agents.find_bin("ai-planning"), "an unactivated environment cannot execute")
            (planning_install.root() / "active.json").write_text(json.dumps({
                "generation": generation.name, "version": "0.2.0", "sha256": "b" * 64}), encoding="utf-8")
            self.assertEqual(acp_agents.find_bin("ai-planning"), str(console))
            argv = acp_agents.command_argv("ai-planning", str(console), [], str(self.root))
            self.assertEqual(argv[argv.index("--") + 1:],
                             [str(planning_install._interpreter(generation)), "-I", "-B", "-u",
                              str(generation / "entry.py"), "acp"])
        with self.assertRaises(ValueError):
            planning_host.Turn(self.ref, self.cfg, {"eventDestination": "hub"})
        self.assertFalse(planning_host.authorized({**self.cfg, "llm": {"key": "private"}}))


if __name__ == "__main__":
    if "--agent" in sys.argv:
        fixture()
    else:
        unittest.main()
