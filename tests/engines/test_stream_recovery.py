import io
import json
import threading
import unittest
import urllib.error
from unittest.mock import patch

from easyread.engines import openai_api
from easyread.engines.engines import Cancelled, EngineError
from tests.engines.test_api_stream_errors import sse


class RecoveryTest(unittest.TestCase):
    def test_explicit_rejection_falls_back_once_for_both_apis(self):
        for api in ('chat', 'responses'):
            error = urllib.error.HTTPError('local', 400, 'bad', {}, None)
            error.detail = 'stream is not supported'
            payload = ({'choices': [{'message': {'content': 'complete'}, 'finish_reason': 'stop'}]}
                       if api == 'chat' else {'status': 'completed', 'output': [
                           {'type': 'message', 'content': [{'type': 'output_text', 'text': 'complete'}]}]})
            response = io.BytesIO(json.dumps(payload).encode())
            calls = []
            def open_response(o, body, stream):
                calls.append((dict(body), stream))
                if len(calls) == 1:
                    raise error
                return response
            with self.subTest(api=api), patch.object(openai_api, '_open', side_effect=open_response):
                self.assertEqual(openai_api.complete({'model': 'm', 'api': api}, 'q', []), 'complete')
            self.assertEqual(len(calls), 2)
            self.assertNotIn('stream', calls[1][0])
            self.assertNotIn('stream_options', calls[1][0])
            self.assertFalse(calls[1][1])

    def test_disconnect_discards_partial_and_retries_once(self):
        broken = sse([{'choices': [{'delta': {'content': 'discard'}}]}])
        good = sse([{'choices': [{'delta': {'content': 'complete'}, 'finish_reason': 'stop'}]}], done=True)
        with patch.object(openai_api, '_open', side_effect=[broken, good]) as request, patch.object(openai_api, '_sleep'):
            self.assertEqual(openai_api.complete({'model': 'm'}, 'q', []), 'complete')
            self.assertEqual(request.call_count, 2)

    def test_persistent_disconnect_is_bounded(self):
        with patch.object(openai_api, '_open', side_effect=lambda *a: sse([])) as request, patch.object(openai_api, '_sleep'):
            with self.assertRaises(openai_api.StreamInterrupted):
                openai_api.complete({'model': 'm'}, 'q', [])
            self.assertEqual(request.call_count, 2)

    def test_auth_and_output_limit_are_not_retried(self):
        error = urllib.error.HTTPError('local', 401, 'bad', {}, None)
        error.detail = 'stream is not supported'
        for outcome in (error, sse([{'choices': [{'finish_reason': 'length'}]}])):
            with patch.object(openai_api, '_open', side_effect=[outcome]) as request, self.assertRaises(EngineError):
                openai_api.complete({'model': 'm'}, 'q', [])
            self.assertEqual(request.call_count, 1)

    def test_cancel_during_backoff_does_not_start_retry(self):
        cancel = threading.Event()
        with patch.object(openai_api, '_open', return_value=sse([])) as request, patch.object(openai_api, '_sleep', side_effect=lambda *a: cancel.set()):
            with self.assertRaises(Cancelled):
                openai_api.complete({'model': 'm'}, 'q', [], cancel)
            self.assertEqual(request.call_count, 1)
