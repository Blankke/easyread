"""Bound the number of papers processed concurrently (PR #64).

Each paper still uses its own segment concurrency. This is not a global cap
on model requests. Configuration is read when the server starts.
"""
from __future__ import annotations

from ..app import config


def worker_count(cfg: dict) -> int:
    value = cfg.get("paper_concurrency", config.DEFAULTS["paper_concurrency"])
    if type(value) is not int:
        return config.DEFAULTS["paper_concurrency"]
    return max(1, min(4, value))
