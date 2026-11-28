"""The synthetic owning desktop for the Planning Runner lifecycle fixtures."""
import json

from app.services import access_policy, planning_install
from app.services.runner_desktop_capabilities import PREFIX


def desktop_jobs(machine, workspace):
    # The vendor is a Python test peer. Discovery/install are covered separately.
    planning_install.command = lambda executable: [executable]
    issued = {}
    policy = {"schema": access_policy.SCHEMA, "mode": "standard", "revision": 1, "workspaceRoot": str(workspace)}

    def write(frame):
        packet = json.loads(frame.removeprefix(PREFIX))
        assert packet["kind"] == "planning-host", packet
        body = packet["body"]
        params = body["params"]
        assert body["workspace"] == str(workspace)
        assert issued[params["executionId"]] == body["grant"]
        assert params["sessionId"] == "native-ai-planning"
        if body["method"] == "fs.authorize":
            assert params["operation"] == "read"
            data = {"authorized": True}
        else:
            assert body["method"] == "commit"
            data = {"receiptId": params["executionId"], "artifacts": []}
        machine._planning_host.reply({"requestId": packet["id"], "result": {"ok": True, "data": data}})

    machine._write_local_rpc = write

    async def job(message):
        if message["op"] in {"job.dispatch", "job.comment"}:
            turn = message.get("turnId") or message["dispatchId"]
            issued[turn] = "grant-" + turn
            cfg = {
                **message.get("cfg", {}),
                "local_cli": "ai-planning",
                "planningOwnerId": "fixture-owner",
                "planningExecutionId": turn,
                "planningHostGrant": issued[turn],
                "accessPolicy": policy,
            }
            message = {**message, "cfg": cfg}
            if message["op"] == "job.dispatch":
                message["ctx"] = {**message["ctx"], "accessPolicy": policy}
        return await machine._local_rpc_dispatch(message)

    return job
