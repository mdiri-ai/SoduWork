"""Follow-up on #428: structured evidence references must be preserved and validated.

Legacy reports (free-text evidence only) keep working unchanged; invalid
references fail loudly with 422 instead of being silently discarded.
"""
import unittest

from fastapi import HTTPException

from app.services.task_acceptance_review import validate_report

CRITERIA = [{"id": "c1", "label": "交付完整可打开"}]


def _body(evidence="页面可打开，功能符合标准", refs=None):
    check = {"criterion": "c1", "result": "pass", "evidence": evidence}
    if refs is not None:
        check["evidenceRefs"] = refs
    return {"report": {"verdict": "approve", "summary": "全部通过", "checks": [check]}}


class EvidenceRefsValidationTests(unittest.TestCase):
    def test_legacy_report_without_refs_still_valid(self):
        out = validate_report(_body(), CRITERIA)
        self.assertEqual(out["checks"][0]["evidenceRefs"], [])

    def test_valid_refs_are_preserved(self):
        refs = [{"kind": "artifact_digest", "ref": "sha256:9c1cd5"},
                {"kind": "log_range", "ref": "run-77.log#L120-L148"}]
        out = validate_report(_body(refs=refs), CRITERIA)
        self.assertEqual(out["checks"][0]["evidenceRefs"], refs)

    def test_refs_are_trimmed(self):
        out = validate_report(_body(refs=[{"kind": "attachment", "ref": "  att_1  "}]), CRITERIA)
        self.assertEqual(out["checks"][0]["evidenceRefs"],
                         [{"kind": "attachment", "ref": "att_1"}])

    def test_invalid_refs_fail_loudly(self):
        bad_sets = [
            [{"kind": "unknown_kind", "ref": "x"}],
            [{"kind": "attachment", "ref": "   "}],
            [{"kind": "attachment"}],
            "not-a-list",
            [{"kind": "attachment", "ref": "x" * 513}],
        ]
        for bad in bad_sets:
            with self.assertRaises(HTTPException) as ctx:
                validate_report(_body(refs=bad), CRITERIA)
            self.assertEqual(ctx.exception.status_code, 422)

    def test_ref_count_cap(self):
        refs = [{"kind": "external_url", "ref": f"https://e.example/{i}"} for i in range(21)]
        with self.assertRaises(HTTPException) as ctx:
            validate_report(_body(refs=refs), CRITERIA)
        self.assertEqual(ctx.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
