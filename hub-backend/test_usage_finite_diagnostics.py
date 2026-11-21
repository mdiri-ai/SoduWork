"""A malformed provider metric must not poison otherwise valid usage facts."""
import json
import unittest

from starlette.responses import JSONResponse
from app.services.usage_values import normalize_usage
from app.services.runner_event_outbox import snapshot_bytes


class UsageFiniteDiagnosticsTests(unittest.TestCase):
    def test_invalid_diagnostics_cannot_break_api_or_durable_event_json(self):
        for invalid in (float('nan'), float('inf'), float('-inf')):
            with self.subTest(invalid=repr(invalid)):
                usage = normalize_usage({'input_tokens': 12, 'output_tokens': 3,
                    'provider_metric': invalid, 'cost': {'total': invalid, 'input': 0.25},
                    'duration_ms': 10, 'finished': True})
                payload = {'usage': usage}
                self.assertEqual(json.loads(JSONResponse(payload).body), payload)
                self.assertEqual(json.loads(snapshot_bytes(payload)), payload)
                self.assertEqual(usage['total_tokens'], 15)
                self.assertFalse(usage['cost_known'])
                self.assertNotIn('provider_metric', usage['raw_usage'])
                self.assertEqual(usage['raw_usage']['cost'], {'input': 0.25})
                self.assertIs(usage['raw_usage']['finished'], True)

    def test_infinite_preferred_counter_does_not_hide_valid_alias(self):
        usage = normalize_usage({'input_tokens': float('inf'), 'prompt_tokens': 12,
                                 'output_tokens': 3})
        self.assertEqual(usage['input_tokens'], 12)
        self.assertEqual(usage['total_tokens'], 15)

    def test_valid_precision_and_explicit_known_zero_are_preserved(self):
        usage = normalize_usage({'input': 9007199254740993, 'costUsd': '0.000003',
                                 'duration_ms': 2.5})
        self.assertEqual(usage['input_tokens'], 9007199254740993)
        self.assertEqual(usage['cost_microusd'], 3)
        self.assertEqual(usage['raw_usage']['costUsd'], '0.000003')
        self.assertTrue(normalize_usage({'cost': 0})['cost_known'])


if __name__ == '__main__':
    unittest.main()
