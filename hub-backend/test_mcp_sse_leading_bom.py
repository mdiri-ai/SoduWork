"""Exercise the real bounded SSE reader with arbitrary network boundaries."""
import io
import json
import time
import unittest

from app.services import mcp_http


class FragmentedResponse(io.BytesIO):
    headers = {'Content-Type': 'text/event-stream; charset=utf-8'}

    def __init__(self, data, width):
        super().__init__(data)
        self.width = width

    def read1(self, count):
        return self.read(min(count, self.width))


class McpSseBomTests(unittest.TestCase):
    def test_reply_with_bom_is_independent_of_network_chunk_boundaries(self):
        result = {'content': [{'type': 'text', 'text': '中文结果🙂'}]}
        message = json.dumps({'jsonrpc': '2.0', 'id': 7, 'result': result}, ensure_ascii=False).encode()
        for width in (1, 2, 3, 5, 65536):
            for line_end in (b'\n', b'\r', b'\r\n'):
                with self.subTest(width=width, line_end=line_end):
                    response = FragmentedResponse(b'\xef\xbb\xbfdata: ' + message + line_end * 2, width)
                    self.assertEqual(mcp_http._read_reply(response, 7, time.monotonic() + 1), result)

    def test_bom_in_result_text_is_preserved(self):
        result = {'content': [{'type': 'text', 'text': 'before\ufeffafter'}]}
        message = json.dumps({'jsonrpc': '2.0', 'id': 7, 'result': result}, ensure_ascii=False).encode()
        response = FragmentedResponse(b'data: ' + message + b'\n\n', 1)
        self.assertEqual(mcp_http._read_reply(response, 7, time.monotonic() + 1), result)

    def test_incomplete_event_remains_rejected(self):
        response = FragmentedResponse(b'\xef\xbb\xbfdata: {"jsonrpc":"2.0","id":7,"result":{}}\n', 1)
        with self.assertRaisesRegex(ValueError, '完整'):
            mcp_http._read_reply(response, 7, time.monotonic() + 1)


if __name__ == '__main__':
    unittest.main()
