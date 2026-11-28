"""Decode complete model JSON objects without swallowing surrounding prose."""
import unittest

from app.services.task_parse_contract import _extract_json, _sanitize_parsed


class TaskJsonTests(unittest.TestCase):
    def test_first_object_is_preserved_before_another_object(self):
        self.assertEqual(_extract_json('{"title":"First"}\nExample: {"title":"Second"}'),
                         {"title": "First"})

    def test_braces_in_following_prose_do_not_invalidate_the_draft(self):
        self.assertEqual(_extract_json('```json\n{"title":"Ship"}\n```\nUse {title} above.'),
                         {"title": "Ship"})

    def test_non_json_braces_before_the_object_are_ignored(self):
        self.assertEqual(_extract_json('Fill {fields}: {"title":"Ship"}'), {"title": "Ship"})

    def test_nested_objects_and_escaped_quotes_are_not_cut_short(self):
        text = r'{"title":"Use } and \"quotes\"", "meta":{"items":[{"key":"{"}]}}'
        self.assertEqual(_extract_json(text), {"title": 'Use } and "quotes"',
                                             "meta": {"items": [{"key": "{"}]}})

    def test_whitespace_fences_and_non_ascii_remain_supported(self):
        self.assertEqual(_extract_json('好的\n```json\n{"title":"写周报"}\n```'),
                         {"title": "写周报"})

    def test_missing_or_incomplete_json_returns_an_empty_draft(self):
        for value in ("", "No fields", '{"title":', "[1,2]", None):
            with self.subTest(value=value):
                self.assertEqual(_extract_json(value), {})


    def test_truncated_outer_response_does_not_promote_an_example(self):
        text = '{"note":"Unfinished","example":{"title":"Nested example","priority":"low"}'
        self.assertEqual(_extract_json(text), {})
        self.assertEqual(_sanitize_parsed(_extract_json(text)), {})

    def test_array_alternatives_do_not_supply_draft_fields(self):
        complete = '[{"title":"Option A"},{"title":"Option B"}]'
        for text in (complete, complete[:-1]):
            with self.subTest(text=text):
                self.assertEqual(_extract_json(text), {})
                self.assertEqual(_sanitize_parsed(_extract_json(text)), {})

    def test_nested_array_alternatives_remain_empty_at_every_truncation(self):
        import json
        complete = json.dumps([[{
            "title": 'Use ] and "quotes"',
            "example": {"title": "Nested example"},
        }], {"title": "Option B"}])
        for end in range(len(complete) + 1):
            with self.subTest(end=end):
                self.assertEqual(_sanitize_parsed(_extract_json(complete[:end])), {})

    def test_standalone_draft_is_kept_before_array_examples(self):
        examples = '[{"title":"Option A"},{"title":"Option B"}]'
        for suffix in (examples, examples[:-1]):
            with self.subTest(suffix=suffix):
                self.assertEqual(_extract_json('{"title":"Ship"}\n' + suffix),
                                 {"title": "Ship"})

    def test_complete_array_can_precede_a_standalone_draft(self):
        text = '[{"title":"Example"}]\n{"title":"Ship"}'
        self.assertEqual(_extract_json(text), {"title": "Ship"})

    def test_mismatched_containers_do_not_promote_nested_drafts(self):
        for text in ('[{"title":"Example"] {"title":"Nested"}]',
                     '{"meta":[{"title":"Example"}} {"title":"Nested"}',
                     '[{"title":"Example"}} {"title":"Nested"}]'):
            with self.subTest(text=text):
                self.assertEqual(_extract_json(text), {})

    def test_truncated_nested_containers_do_not_supply_draft_fields(self):
        import json
        complete = json.dumps({
            "note": 'Use } and "quoted" text',
            "example": {"items": [{"title": "Nested example", "priority": "low"}]},
        })
        for end in range(len(complete)):
            with self.subTest(end=end):
                self.assertEqual(_extract_json(complete[:end]), {})
        self.assertEqual(_extract_json(complete), json.loads(complete))

    def test_malformed_outer_response_does_not_promote_an_example(self):
        text = '{"note":invalid,"example":{"title":"Nested example","priority":"low"}}'
        self.assertEqual(_extract_json(text), {})

    def test_valid_top_level_draft_after_a_malformed_object_is_preserved(self):
        text = '{"note":invalid,"example":{"title":"Nested example"}}\n{"title":"Ship"}'
        self.assertEqual(_extract_json(text), {"title": "Ship"})

    def test_first_complete_draft_is_kept_before_an_incomplete_example(self):
        text = '{"title":"Ship","priority":"high"}\n{"note":"Unfinished","example":{"title":"Nested"}'
        self.assertEqual(_extract_json(text), {"title": "Ship", "priority": "high"})


if __name__ == "__main__":
    unittest.main()
