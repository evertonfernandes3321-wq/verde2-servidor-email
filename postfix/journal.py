"""Offline restore operations on an explicitly supplied SQLite connection; no import-time I/O."""
import sqlite3
import stat
import sys
import time
from pathlib import Path

QUARANTINE_SCHEMA = "CREATE TABLE IF NOT EXISTS restore_quarantine (id TEXT PRIMARY KEY, endpoint TEXT, payload TEXT, created REAL)"
JOURNAL_FILE = "/var/spool/postfix/evidence/events.sqlite3"
# A five-minute independent schedule leaves ten minutes of margin before 30 days.
RETENTION_SECONDS = 30 * 86400 - 600


def quarantine_pending(conn: sqlite3.Connection):
    """Atomically retain pending evidence outside the forwarding queue, preserving seen IDs.

    The caller must keep the restored MTA offline. Errors propagate and leave pending
    records intact; a conflicting quarantine ID requires explicit reconciliation.
    """
    conn.execute("SAVEPOINT quarantine_pending")
    try:
        conn.execute(QUARANTINE_SCHEMA)
        moved = conn.execute(
            "INSERT INTO restore_quarantine (id,endpoint,payload,created) "
            "SELECT id,endpoint,payload,created FROM events"
        ).rowcount
        conn.execute("DELETE FROM events")
        conn.execute("RELEASE SAVEPOINT quarantine_pending")
        return moved
    except Exception:
        conn.execute("ROLLBACK TO SAVEPOINT quarantine_pending")
        conn.execute("RELEASE SAVEPOINT quarantine_pending")
        raise


def prune_journal(conn: sqlite3.Connection, cutoff: float):
    """Apply the same original-event retention cutoff within the caller's transaction."""
    conn.execute("DELETE FROM seen WHERE created<?", (cutoff,))
    conn.execute("DELETE FROM events WHERE created<?", (cutoff,))
    conn.execute("DELETE FROM restore_quarantine WHERE created<?", (cutoff,))


def prune_file(filename, now: float):
    """Prune an existing regular journal, without starting MTA/forwarding or creating a DB."""
    path = Path(filename)
    if not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError("journal_not_regular")
    conn = sqlite3.connect(path.absolute().as_uri() + "?mode=rw", uri=True, timeout=10)
    try:
        with conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(QUARANTINE_SCHEMA)
            prune_journal(conn, now - RETENTION_SECONDS)
    finally:
        conn.close()


def cli():
    try:
        prune_file(JOURNAL_FILE, time.time())
        return 0
    except Exception:
        print('{"event":"mta_journal_prune_failed"}', file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(cli())
