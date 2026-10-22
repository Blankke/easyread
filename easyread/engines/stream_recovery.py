"""Bounded recovery for streaming transport, not model-output errors."""
import re

from .engines import EngineError


class StreamInterrupted(EngineError):
    """The connection ended before a completion marker."""


def unsupported_stream(error) -> bool:
    if error.code not in (400, 422):
        return False
    detail = getattr(error, 'detail', '').lower()
    return bool(re.search(r'\bstream(?:ing)?\b', detail) and
                re.search(r'not supported|unsupported|not allowed|not implemented|must be false|only non.stream', detail))


def non_stream_body(body):
    return {k: v for k, v in body.items() if k not in ('stream', 'stream_options')}
