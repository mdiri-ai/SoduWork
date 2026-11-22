# -*- coding: utf-8 -*-
"""Capability-probe optional-control strip: a probe-injected optional parameter
(such as a thinking switch) can trigger a generic refusal that reads like a
missing capability. The probe must retry without those controls before accepting
an "unsupported" verdict for the feature under test. Runs without real networks.
"""
from __future__ import annotations

import asyncio
import json
import re
import unittest
from unittest.mock import patch

from app.services import model_transport
from app.services.model_capability_probe import run
from app.services.model_errors import UpstreamError


class FakeStream:
    outcome = "completed"
    headers = {"content-type": "text/event-stream"}

    def __init__(self, value):
        inner = json.dumps({"value": value})
        tool_call = {"index": 0, "id": "call_t1", "type": "function",
                     "function": {"name": "soduwork_capability_echo", "arguments": inner}}
        self._chunks = [
            b"data: " + json.dumps({"choices": [{"delta": {"tool_calls": [tool_call]}}]}).encode() + b"\n\n",
            b"data: " + json.dumps({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]}).encode() + b"\n\n",
            b"data: [DONE]\n\n",
        ]

    async def chunks(self):
        for chunk in self._chunks:
            yield chunk

    async def aclose(self):
        pass


class FakeText:
    outcome = "completed"
    headers = {"content-type": "text/event-stream"}

    def __init__(self, text):
        self._chunks = [
            b"data: " + json.dumps({"choices": [{"delta": {"role": "assistant", "content": text}}]}).encode() + b"\n\n",
            b"data: " + json.dumps({"choices": [{"delta": {}, "finish_reason": "stop"}]}).encode() + b"\n\n",
            b"data: [DONE]\n\n",
        ]

    async def chunks(self):
        for chunk in self._chunks:
            yield chunk

    async def aclose(self):
        pass


def _conf():
    # A DeepSeek-style reasoning config injects thinking={"type": "disabled"} into
    # every probe request; a lighter flash tier can refuse that optional parameter.
    return {"model": "deepseek-flash", "kind": "openai-compat",
            "thinkingMode": "controllable", "thinkingFormat": "deepseek"}


class OptionalControlStripTests(unittest.TestCase):
    def test_thinking_refusal_is_stripped_and_tool_calling_passes(self):
        """400 on the thinking parameter must retry without it, not fail toolCalling."""
        bodies = []

        async def fake(conf, path, body, *, stream=False, timeout=None):
            payload = json.loads(body)
            bodies.append(payload)
            if "thinking" in payload:
                raise UpstreamError(400, json.dumps({"error": {"message": "tools not supported"}}))
            if any(m.get("role") == "tool" for m in payload["messages"]):
                return FakeText(payload["messages"][-1]["content"])
            match = re.search(r"with value ([0-9a-f]+)", payload["messages"][0]["content"])
            return FakeStream(match.group(1))

        with patch.object(model_transport, "open_response", fake):
            report = asyncio.run(run(_conf(), ["toolCalling"]))
        result = report["checks"]["toolCalling"]
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["code"], "verified")
        self.assertEqual(result.get("compatibilityHint"), "optional_controls_stripped")
        self.assertEqual(len(bodies), 3, "first call + stripped retry + tool-result follow-up")
        self.assertIn("thinking", bodies[0])
        self.assertNotIn("thinking", bodies[1])
        self.assertIn("tools", bodies[1], "the feature under test must stay in the retry")
        self.assertNotIn("thinking", bodies[2], "the follow-up turn must not re-inject stripped controls")

    def test_refusal_without_optional_controls_stays_unsupported(self):
        """A genuine capability gap must keep the honest unsupported verdict."""
        calls = []

        async def fake(conf, path, body, *, stream=False, timeout=None):
            calls.append(json.loads(body))
            raise UpstreamError(400, json.dumps({"error": {"message": "tools not supported"}}))

        with patch.object(model_transport, "open_response", fake):
            report = asyncio.run(run(_conf(), ["toolCalling"]))
        result = report["checks"]["toolCalling"]
        self.assertEqual(result["status"], "unsupported")
        self.assertEqual(result["code"], "capability_not_supported")
        self.assertEqual(len(calls), 2, "one stripped retry is attempted before giving up")

    def test_plain_tool_calling_without_injection_unaffected(self):
        """Requests without injected optional controls must behave exactly as before."""

        async def fake(conf, path, body, *, stream=False, timeout=None):
            payload = json.loads(body)
            if any(m.get("role") == "tool" for m in payload["messages"]):
                return FakeText(payload["messages"][-1]["content"])
            match = re.search(r"with value ([0-9a-f]+)", payload["messages"][0]["content"])
            return FakeStream(match.group(1))

        plain = {"model": "plain-model", "kind": "openai-compat",
                 "thinkingMode": "always", "thinkingFormat": "zai"}
        with patch.object(model_transport, "open_response", fake):
            report = asyncio.run(run(plain, ["toolCalling"]))
        result = report["checks"]["toolCalling"]
        self.assertEqual(result["status"], "passed")
        self.assertNotIn("compatibilityHint", result)


if __name__ == "__main__":
    unittest.main()
