"""Consume an authenticated tar stream into an EMPTY offline spool. No links/devices."""
import os
import pathlib
import sys
import tarfile
import pwd
import grp
import sqlite3
import time

root = pathlib.Path('/spool')
if any(root.iterdir()):
    raise SystemExit('restore_spool_not_empty')
uids = {0, pwd.getpwnam('postfix').pw_uid}
gids = {0, grp.getgrnam('postfix').gr_gid, grp.getgrnam('postdrop').gr_gid}
total = 0
entries = 0
with tarfile.open(fileobj=sys.stdin.buffer, mode='r|') as archive:
    for member in archive:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or not (member.isdir() or member.isfile()):
            raise SystemExit('restore_spool_entry_invalid')
        target = root.joinpath(*path.parts)
        if not target.resolve().is_relative_to(root.resolve()):
            raise SystemExit('restore_spool_path_invalid')
        total += member.size
        entries += 1
        if member.size > 1024 * 1024 * 1024 or total > 20 * 1024 * 1024 * 1024 or entries > 100000:
            raise SystemExit('restore_spool_entry_oversized')
        if member.uid not in uids or member.gid not in gids or member.mode & 0o4000 or (member.mode & 0o3000 and not member.isdir()):
            raise SystemExit('restore_spool_permissions_invalid')
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as output:
                source = archive.extractfile(member)
                while chunk := source.read(65536):
                    output.write(chunk)
        os.chown(target, member.uid, member.gid)
        os.chmod(target, member.mode & 0o3777)

# An old pending observation must not automatically resolve restored uncertainty.
# Preserve it for manual reconciliation, outside the collector's forward table.
journal = root / 'evidence' / 'events.sqlite3'
if journal.exists():
    if not journal.is_file() or journal.is_symlink():
        raise SystemExit('restore_journal_invalid')
    sys.path.insert(0, '/opt/verde2')
    from journal import quarantine_pending, prune_journal, RETENTION_SECONDS
    with sqlite3.connect(journal, timeout=10) as connection:
        quarantine_pending(connection)
        prune_journal(connection, time.time() - RETENTION_SECONDS)
