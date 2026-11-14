"""Bounded retries for transient Windows filesystem/filter-driver failures."""
import errno
import os
import time


def retry_write(operation):
    for attempt in range(5):
        try:
            return operation()
        except OSError as error:
            # EINVAL was reported while creating .write.lock in #109. Never
            # remove someone else's lock or fall back to an unlocked write.
            transient = os.name == "nt" and (
                error.errno == errno.EINVAL or getattr(error, "winerror", None) in (32, 33))
            if not transient or attempt == 4:
                raise
            time.sleep(.05 * (attempt + 1))
