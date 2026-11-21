"""Decode complete model JSON objects without swallowing surrounding prose."""
import unittest

from app.services.task_parse_contract import _extract_json


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


if __name__ == "__main__":
    unittest.main()
