"""Opt-in upstream error details stay redacted and never change client errors."""

import json
import os
import unittest
from unittest import mock

from app.api import ai_proxy

FLAG = "SODUWORK_AI_PROXY_DEBUG"


class UpstreamDetailSwitchTests(unittest.TestCase):
    def tearDown(self):
        os.environ.pop(FLAG, None)

    def test_disabled_by_default(self):
        os.environ.pop(FLAG, None)
        self.assertFalse(ai_proxy._upstream_detail_enabled())

    def test_truthy_values_enable(self):
        for value in ("1", "true", "TRUE", "yes", " on "):
            os.environ[FLAG] = value
            self.assertTrue(ai_proxy._upstream_detail_enabled(), value)

    def test_other_values_stay_disabled(self):
        for value in ("", "0", "false", "off", "anything"):
            os.environ[FLAG] = value
            self.assertFalse(ai_proxy._upstream_detail_enabled(), value)


class UpstreamErrorMessageTests(unittest.TestCase):
    def test_extracts_provider_message(self):
        body = json.dumps({"error": {"message": "thinking.type `disabled` is not supported",
                                     "code": "InvalidParameter"}})
        self.assertEqual(ai_proxy._upstream_error_detail(body),
                         "thinking.type `disabled` is not supported")

    def test_falls_back_to_message_root(self):
        self.assertEqual(ai_proxy._upstream_error_detail('{"message": "gateway exploded"}'),
                         "gateway exploded")

    def test_non_json_body_is_used_verbatim(self):
        self.assertEqual(ai_proxy._upstream_error_detail("plain bad gateway"), "plain bad gateway")

    def test_credentials_are_redacted(self):
        body = json.dumps({"error": {"message": "Authorization: Bearer sk-live-secret-123 rejected"}})
        detail = ai_proxy._upstream_error_detail(body)
        self.assertNotIn("sk-live-secret-123", detail)
        self.assertIn("<redacted>", detail)

    def test_message_is_squashed_and_capped(self):
        detail = ai_proxy._upstream_error_detail(json.dumps({"error": {"message": "a\n\nb " + "x" * 500}}))
        self.assertTrue(detail.startswith("a b "))
        self.assertEqual(len(detail), 200)

    def test_blank_inputs_return_none(self):
        self.assertIsNone(ai_proxy._upstream_error_detail(""))
        self.assertIsNone(ai_proxy._upstream_error_detail("   "))


class ErrLoggingTests(unittest.TestCase):
    def _logs(self, debug: bool):
        env = {FLAG: "1" if debug else "0"}
        with mock.patch.dict(os.environ, env, clear=False):
            with self.assertLogs("uvicorn.error", level="WARNING") as captured:
                ai_proxy._err(400, "模型服务返回了暂时无法处理的错误（HTTP 400）",
                              upstream=json.dumps({"error": {"message": "boom Authorization: Bearer abc123"}}))
        return "\n".join(captured.output)

    def test_detail_logged_only_when_enabled(self):
        enabled = self._logs(True)
        disabled = self._logs(False)

        self.assertIn("upstream detail", enabled)
        self.assertIn("status=400", enabled)
        self.assertIn("boom", enabled)
        self.assertNotIn("abc123", enabled)

        self.assertNotIn("upstream detail", disabled)
        self.assertIn("upstream error suppressed", disabled)
        self.assertIn("bytes=", disabled)

    def test_client_error_message_is_unchanged(self):
        response = ai_proxy._err(400, "模型服务返回了暂时无法处理的错误（HTTP 400）",
                                 upstream=json.dumps({"error": {"message": "boom"}}))
        payload = json.loads(response.body)
        self.assertEqual(payload["error"]["message"], "模型服务返回了暂时无法处理的错误（HTTP 400）")
        self.assertEqual(payload["error"]["status"], 400)


if __name__ == "__main__":
    unittest.main()
