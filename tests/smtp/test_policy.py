import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import types
import io
import struct
import socketserver
import sqlite3
import stat
import urllib.error
from contextlib import closing, redirect_stderr
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "policy"))
sys.path.insert(0, str(ROOT / "postfix"))
from canonical import canonical_hash
os.environ.setdefault("MAIL_INSTANCE_ID", "synthetic-unit")
import supervisor
import dsn
import journal
from journal import quarantine_pending, prune_journal

def release_record(queue, deadline="1970-01-03T07:43:20.000Z"):
    return {"queueId": queue, "expiresAt": deadline}

class PolicyTests(unittest.TestCase):
    def test_release_expiry_is_rechecked_after_slow_batches(self):
        now = 200000.0
        clock = [now]
        entries = [{"queue_id": "Q" + str(number), "queue_name": "hold", "sender": "synthetic@example.test", "arrival_time": now - 1} for number in range(501)]
        calls = []
        def authority(endpoint, payload):
            calls.append(payload)
            if len(calls) == 3:
                clock[0] = 200591.0  # The persisted deadline is 200600; margin is ten seconds.
            return {"ok": True, "remove": [], "release": [release_record(item) for item in payload["queueIds"]]}
        with patch.dict(os.environ, {"BOUNCE_DOMAIN": "bounce.example.test"}), patch.object(supervisor.time, "time", side_effect=lambda: clock[0]), patch.object(supervisor, "call", side_effect=authority), patch.object(supervisor.subprocess, "run") as command:
            supervisor.reconcile_queue_snapshot(entries, now)
            self.assertEqual(len(calls), 3)
            command.assert_not_called()

    def test_clock_is_read_before_each_release_and_future_deadline_permits_first(self):
        now = 200000.0
        clock = [now]
        entries = [{"queue_id": queue, "queue_name": "hold", "sender": "synthetic@example.test", "arrival_time": now - 1} for queue in ["First", "Second"]]
        def command_delay(*_, **__):
            clock[0] = 200600.0
        response = {"ok": True, "remove": [], "release": [release_record(entry["queue_id"]) for entry in entries]}
        with patch.dict(os.environ, {"BOUNCE_DOMAIN": "bounce.example.test"}), patch.object(supervisor.time, "time", side_effect=lambda: clock[0]), patch.object(supervisor, "call", return_value=response), patch.object(supervisor.subprocess, "run", side_effect=command_delay) as command:
            supervisor.reconcile_queue_snapshot(entries, now)
            self.assertEqual([item.args[0] for item in command.call_args_list], [["postsuper", "-H", "First"]])

    def test_dsn_authorization_delay_cannot_extend_local_content_deadline(self):
        now = 200000.0
        entry = {"queue_id": "Dsn", "queue_name": "hold", "sender": "", "arrival_time": now - supervisor.LOCAL_CONTENT_LIFETIME + 100,
                 "recipients": [{"address": "b+00000000-0000-4000-8000-000000000001@bounce.example.test"}]}
        for delay in [0, 91]:
            clock = [now]
            def authority(endpoint, payload):
                if endpoint == "dsn-address":
                    clock[0] += delay
                    return {"ok": True}
                return {"ok": True, "remove": [], "release": []}
            with self.subTest(delay=delay), patch.dict(os.environ, {"BOUNCE_DOMAIN": "bounce.example.test"}), patch.object(supervisor.time, "time", side_effect=lambda: clock[0]), patch.object(supervisor, "call", side_effect=authority), patch.object(supervisor.subprocess, "run") as command:
                supervisor.reconcile_queue_snapshot([entry], now)
                self.assertEqual([item.args[0] for item in command.call_args_list], [["postsuper", "-H", "Dsn"]] if delay == 0 else [])

    def test_release_deadline_requires_valid_finite_utc_and_no_conflicting_duplicate(self):
        invalid = [None, float("nan"), float("inf"), "NaN", "Infinity", "1970-01-03T07:43:20",
                   "1970-01-03T07:43:20+01:00", "1970-02-30T07:43:20Z", "0000-01-01T00:00:00Z"]
        for deadline in invalid:
            with self.subTest(deadline=deadline), patch.object(supervisor, "call", return_value={"ok": True, "remove": [], "release": [release_record("Q1", deadline)]}), self.assertRaises(ValueError):
                supervisor.queue_policy(["Q1"])
        with patch.object(supervisor, "call", return_value={"ok": True, "remove": [], "release": [release_record("Q1"), release_record("Q1", "1970-01-03T07:43:21.000Z")]}), self.assertRaises(ValueError):
            supervisor.queue_policy(["Q1"])

    def test_queue_policy_batches_large_snapshot_and_merges_only_qualified_ids(self):
        queues = ["Q" + str(number).zfill(79) for number in range(1205)]
        expected_expired = set(queues[::2])
        def authority(endpoint, payload):
            self.assertEqual(endpoint, "queue-check")
            batch = payload["queueIds"]
            self.assertLessEqual(len(batch), 500)
            response = {"ok": True, "remove": [{"queueId": item, "reason": "expired"} for item in batch if item in expected_expired],
                        "release": [release_record(item) for item in batch if item not in expected_expired]}
            self.assertLess(len(json.dumps(response).encode()), 65536)
            # Even the oversized logical worst case (all IDs in both lists) fits the
            # transport cap; the supervisor separately rejects conflicting decisions.
            worst = {"ok": True, "remove": [{"queueId": item, "reason": "expired"} for item in batch],
                     "release": [release_record(item) for item in batch]}
            self.assertLess(len(json.dumps(worst).encode()), 65536)
            return response
        with patch.object(supervisor, "call", side_effect=authority) as control:
            releases, expired = supervisor.queue_policy(queues)
        self.assertEqual([len(item.args[1]["queueIds"]) for item in control.call_args_list], [250, 250, 250, 250, 205])
        self.assertEqual(expired, expected_expired)
        self.assertEqual(set(releases), set(queues) - expected_expired)
        self.assertEqual(set(releases.values()), {200600.0})

    def test_queue_reconciliation_rejects_late_batch_error_before_any_release(self):
        now = 200000.0
        entries = [{"queue_id": "Q" + str(number), "queue_name": "hold", "sender": "synthetic@example.test", "arrival_time": now - 1} for number in range(1001)]
        calls = []
        def authority(endpoint, payload):
            calls.append(payload)
            return {"ok": True, "remove": [], "release": [release_record(item) for item in payload["queueIds"]] if len(calls) < 3 else [release_record("OutsideSnapshot")]}
        with patch.object(supervisor, "call", side_effect=authority), patch.object(supervisor.subprocess, "run") as command:
            with self.assertRaises(ValueError):
                supervisor.reconcile_queue_snapshot(entries, now)
            command.assert_not_called()
        for invalid in [{"ok": True, "remove": [], "release": "Q1"},
                        {"ok": True, "remove": [{"queueId": "Q1", "reason": "unknown"}], "release": []},
                        {"ok": True, "remove": [{"queueId": "Q1", "reason": "expired"}], "release": [release_record("Q1")]}]:
            with patch.object(supervisor, "call", return_value=invalid), self.assertRaises(ValueError):
                supervisor.queue_policy(["Q1"])

    def test_expired_dsn_is_deleted_without_authority_or_recipient_metadata(self):
        now = 200000.0
        expired = {"queue_name": "hold", "sender": "", "arrival_time": now - supervisor.LOCAL_CONTENT_LIFETIME}
        authority = Mock(side_effect=urllib.error.HTTPError("https://internal/dsn-address", 404, "missing", None, None))
        self.assertEqual(supervisor.held_dsn_action(expired, "bounce.example.test", now, authority), "delete")
        authority.assert_not_called()
        recipient = {"address": "b+00000000-0000-4000-8000-000000000001@bounce.example.test"}
        young = {**expired, "arrival_time": now - 1, "recipients": [recipient]}
        self.assertIsNone(supervisor.held_dsn_action(young, "bounce.example.test", now, authority))
        authority.assert_called_once()
        for arrival in [None, True, now + 1, float("nan"), float("inf")]:
            self.assertIsNone(supervisor.held_dsn_action({**expired, "arrival_time": arrival}, "bounce.example.test", now, authority))

    def test_orphan_content_expires_without_inventing_state_or_releasing_unknown_queues(self):
        now = 200000.0
        old = {"queue_id": "Orphan", "queue_name": "deferred", "sender": "synthetic@example.test", "arrival_time": now - supervisor.LOCAL_CONTENT_LIFETIME}
        young = {**old, "queue_id": "Young", "queue_name": "hold", "arrival_time": now - 1}
        invalid = {**young, "queue_id": "Invalid", "arrival_time": now + 1}
        with patch.dict(os.environ, {"BOUNCE_DOMAIN": "bounce.example.test"}), patch.object(supervisor, "call", return_value={"ok": True, "remove": [], "release": [release_record("Invalid")]}), patch.object(supervisor.subprocess, "run") as command, patch.object(supervisor, "database") as database:
            supervisor.reconcile_queue_snapshot([old, young, invalid], now)
            self.assertEqual([item.args[0] for item in command.call_args_list], [["postsuper", "-d", "Orphan"]])
            database.assert_not_called()
        with patch.object(supervisor, "call", side_effect=TimeoutError("synthetic outage")), patch.object(supervisor.subprocess, "run") as command, patch.object(supervisor, "database") as database:
            with self.assertRaises(TimeoutError):
                supervisor.reconcile_queue_snapshot([old, young], now)
            self.assertEqual([item.args[0] for item in command.call_args_list], [["postsuper", "-d", "Orphan"]])
            database.assert_not_called()

    def test_authoritative_expiry_records_evidence_and_dsn_outage_prevents_all_releases(self):
        now = 200000.0
        base = {"queue_name": "hold", "sender": "synthetic@example.test", "arrival_time": now - 1}
        entries = [{**base, "queue_id": "KnownExpired"}, {**base, "queue_id": "KnownLive"}]
        with tempfile.TemporaryDirectory() as directory, patch.object(supervisor, "DB", str(Path(directory) / "journal.sqlite3")), patch.dict(os.environ, {"BOUNCE_DOMAIN": "bounce.example.test"}), patch.object(supervisor.time, "time", return_value=now):
            with patch.object(supervisor, "call", return_value={"ok": True, "remove": [{"queueId": "KnownExpired", "reason": "expired"}], "release": [release_record("KnownLive")]}), patch.object(supervisor.subprocess, "run") as command:
                supervisor.reconcile_queue_snapshot(entries, now)
                self.assertEqual([item.args[0] for item in command.call_args_list], [["postsuper", "-d", "KnownExpired"], ["postsuper", "-H", "KnownLive"]])
            with supervisor.database() as db:
                records = [json.loads(row[0]) for row in db.execute("SELECT payload FROM events").fetchall()]
                self.assertEqual([(row["queueId"], row["type"]) for row in records], [("KnownExpired", "expired")])
            dsn_entry = {**base, "queue_id": "Dsn", "sender": "", "recipients": [{"address": "b+00000000-0000-4000-8000-000000000001@bounce.example.test"}]}
            with patch.object(supervisor, "call", side_effect=[{"ok": True, "remove": [], "release": [release_record("KnownLive")]}, TimeoutError("synthetic outage")]), patch.object(supervisor.subprocess, "run") as command:
                with self.assertRaises(TimeoutError):
                    supervisor.reconcile_queue_snapshot([entries[1], dsn_entry], now)
                command.assert_not_called()

    def test_journal_cli_prunes_paused_evidence_with_schedule_margin(self):
        now = 4000000.0
        cutoff = now - journal.RETENTION_SECONDS
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / "journal.sqlite3"
            with patch.object(supervisor, "DB", str(filename)), supervisor.database() as db:
                for event_id, created in [("expired", cutoff - 1), ("boundary", cutoff), ("recent", cutoff + 1)]:
                    db.execute("INSERT INTO events VALUES (?,'event','{}',?)", (event_id, created))
                    db.execute("INSERT INTO seen VALUES (?,?)", (event_id, created))
                quarantine_pending(db)
            with patch.object(journal, "JOURNAL_FILE", str(filename)), patch.object(journal.time, "time", return_value=now):
                self.assertEqual(journal.cli(), 0)
            with closing(sqlite3.connect(filename)) as db:
                self.assertEqual(db.execute("SELECT id FROM restore_quarantine ORDER BY id").fetchall(), [("boundary",), ("recent",)])
                self.assertEqual(db.execute("SELECT id FROM seen ORDER BY id").fetchall(), [("boundary",), ("recent",)])
                self.assertEqual(db.execute("SELECT * FROM events").fetchall(), [])

    def test_journal_cli_rejects_missing_nonregular_and_symlink_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / "missing.sqlite3"
            for filename in [missing, Path(directory)]:
                output = io.StringIO()
                with patch.object(journal, "JOURNAL_FILE", str(filename)), redirect_stderr(output):
                    self.assertEqual(journal.cli(), 1)
                self.assertEqual(output.getvalue(), '{"event":"mta_journal_prune_failed"}\n')
            self.assertFalse(missing.exists())
            # Model lstat's symlink result portably: Windows may prohibit creating links.
            with patch.object(journal.Path, "lstat", return_value=types.SimpleNamespace(st_mode=stat.S_IFLNK | 0o777)), patch.object(journal.sqlite3, "connect") as connect:
                with self.assertRaises(ValueError):
                    journal.prune_file(missing, 4000000.0)
                connect.assert_not_called()

    def test_journal_cli_failure_rolls_back_and_emits_no_driver_detail(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / "journal.sqlite3"
            with patch.object(supervisor, "DB", str(filename)), supervisor.database() as db:
                db.execute("INSERT INTO events VALUES ('pending','event','{}',1)")
                db.execute("INSERT INTO seen VALUES ('pending',1)")
                db.execute("CREATE TRIGGER forbid_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_SECRET_CANARY'); END")
            output = io.StringIO()
            with patch.object(journal, "JOURNAL_FILE", str(filename)), patch.object(journal.time, "time", return_value=4000000.0), redirect_stderr(output):
                self.assertEqual(journal.cli(), 1)
            self.assertEqual(output.getvalue(), '{"event":"mta_journal_prune_failed"}\n')
            with closing(sqlite3.connect(filename)) as db:
                self.assertEqual(db.execute("SELECT id FROM seen").fetchall(), [("pending",)])
                self.assertEqual(db.execute("SELECT id FROM events").fetchall(), [("pending",)])

    def test_restore_quarantines_pending_evidence_without_replaying_or_losing_seen(self):
        records = [
            ("local", "commit", '{"type":"accepted_local","queueId":"Qrestore"}', 100.0),
            ("remote", "event", '{"type":"deferred","queueId":"Qrestore"}', 101.0),
            ("rejected", "release-by-queue", '{"queueId":"Qrejected"}', 102.0),
        ]
        with tempfile.TemporaryDirectory() as directory, patch.object(supervisor, "DB", str(Path(directory) / "journal.sqlite3")):
            with supervisor.database() as db:
                db.executemany("INSERT INTO events VALUES (?,?,?,?)", records)
                db.executemany("INSERT INTO seen VALUES (?,?)", [(row[0], row[3]) for row in records])
                db.execute("INSERT INTO seen VALUES ('already_forwarded',90)")
            with supervisor.database() as db:
                before_seen = db.execute("SELECT * FROM seen ORDER BY id").fetchall()
                self.assertEqual(quarantine_pending(db), 3)
            # Reopen as the restarted forwarder would: only its live queue is consumed.
            with supervisor.database() as db:
                self.assertEqual(db.execute("SELECT * FROM events").fetchall(), [])
                self.assertEqual(db.execute("SELECT * FROM restore_quarantine ORDER BY id").fetchall(), sorted(records))
                self.assertEqual(db.execute("SELECT * FROM seen ORDER BY id").fetchall(), before_seen)
                self.assertEqual(quarantine_pending(db), 0)

    def test_restore_quarantine_rolls_back_if_pending_delete_fails(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(supervisor, "DB", str(Path(directory) / "journal.sqlite3")):
            with supervisor.database() as db:
                db.execute("INSERT INTO events VALUES ('pending','event','{}',100)")
                db.execute("INSERT INTO seen VALUES ('pending',100)")
                db.execute("CREATE TRIGGER preserve_pending BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END")
            with supervisor.database() as db:
                with self.assertRaises(sqlite3.DatabaseError):
                    quarantine_pending(db)
                self.assertEqual(db.execute("SELECT id FROM events").fetchall(), [("pending",)])
                self.assertEqual(db.execute("SELECT id FROM seen").fetchall(), [("pending",)])
                self.assertEqual(db.execute("SELECT * FROM restore_quarantine").fetchall(), [])

    def test_retention_uses_original_event_age_after_restore(self):
        cutoff = 200.0
        with tempfile.TemporaryDirectory() as directory, patch.object(supervisor, "DB", str(Path(directory) / "journal.sqlite3")):
            with supervisor.database() as db:
                for event_id, created in [("expired", cutoff - 1), ("boundary", cutoff), ("recent", cutoff + 1)]:
                    db.execute("INSERT INTO events VALUES (?,'event','{}',?)", (event_id, created))
                    db.execute("INSERT INTO seen VALUES (?,?)", (event_id, created))
                quarantine_pending(db)
                db.execute("INSERT INTO events VALUES ('new_pending','event','{}',?)", (cutoff + 1,))
                prune_journal(db, cutoff)
            with supervisor.database() as db:
                self.assertEqual(db.execute("SELECT id FROM restore_quarantine ORDER BY id").fetchall(), [("boundary",), ("recent",)])
                self.assertEqual(db.execute("SELECT id FROM seen ORDER BY id").fetchall(), [("boundary",), ("recent",)])
                self.assertEqual(db.execute("SELECT id FROM events").fetchall(), [("new_pending",)])

    def test_sasl_framing_distinguishes_denied_credentials_from_authority_outage(self):
        spec = importlib.util.spec_from_file_location("sasl_under_test", ROOT / "postfix" / "sasl_bridge.py")
        bridge = importlib.util.module_from_spec(spec)
        # Only the handler framing is under test; no listener/socket/service is created.
        with patch.object(socketserver, "ThreadingUnixStreamServer", object, create=True):
            spec.loader.exec_module(bridge)

        class Stream:
            def __init__(self):
                values = [b"synthetic", b"SYNTHETIC_SECRET_CANARY", b"smtp", b""]
                self.input = io.BytesIO(b"".join(struct.pack("!H", len(value)) + value for value in values))
                self.output = bytearray()
                self.closed = False
            def recv(self, count):
                return self.input.read(min(count, 2))  # Fragmented delivery exercises exact framing.
            def settimeout(self, _):
                pass
            def sendall(self, data):
                self.output.extend(data)
            def close(self):
                self.closed = True

        for error, expected in [
            (None, b"\x00\x02OK"),
            (urllib.error.HTTPError("https://internal/auth", 403, "synthetic denied", None, None), b"\x00\x02NO"),
            (urllib.error.HTTPError("https://internal/auth", 503, "synthetic outage", None, None), b""),
            (urllib.error.HTTPError("https://internal/auth", 401, "synthetic control token failure", None, None), b""),
            (TimeoutError("synthetic timeout"), b""),
        ]:
            with self.subTest(error_class=type(error).__name__):
                stream = Stream()
                with patch.object(bridge, "call", side_effect=error) as control:
                    bridge.Handler(stream, None, None)
                control.assert_called_once()
                self.assertEqual(bytes(stream.output), expected)
                self.assertEqual(stream.closed, expected == b"")
                self.assertNotIn(b"SYNTHETIC_SECRET_CANARY", stream.output)

    def test_malformed_dsn_is_discarded_without_call_but_infrastructure_failure_propagates(self):
        target = "b+00000000-0000-4000-8000-000000000001@bounce.example.test"
        valid = (b"MIME-Version: 1.0\r\nContent-Type: multipart/report; report-type=delivery-status; boundary=synthetic\r\n\r\n"
                 b"--synthetic\r\nContent-Type: text/plain\r\n\r\nSynthetic report\r\n"
                 b"--synthetic\r\nContent-Type: message/delivery-status\r\n\r\nReporting-MTA: dns; sink.test\r\n\r\n"
                 b"Final-Recipient: rfc822; recipient@sink.test\r\nAction: failed\r\nStatus: 5.1.1\r\n\r\n--synthetic--\r\n")
        malformed = [valid.replace(b"MIME-Version: 1.0", b"MalformedHeader"),
                     valid.replace(b"Action: failed", b"MalformedNestedHeader"),
                     valid.replace(b"Status: 5.1.1", b"Status: invalid"),
                     valid.replace(b"Status: 5.1.1\r\n", b"")]
        with patch.dict(os.environ, {"BOUNCE_DOMAIN": "bounce.example.test"}), patch.object(sys, "argv", ["dsn.py", target]):
            for raw in malformed:
                with self.subTest(raw_index=malformed.index(raw)), patch.object(sys, "stdin", types.SimpleNamespace(buffer=io.BytesIO(raw))), patch.object(dsn, "call") as call:
                    self.assertEqual(dsn.main(), 0)
                    call.assert_not_called()
            with patch.object(sys, "stdin", types.SimpleNamespace(buffer=io.BytesIO(valid))), patch.object(dsn, "event_id", side_effect=ValueError("invalid header")), patch.object(dsn, "call") as call:
                self.assertEqual(dsn.main(), 0)
                call.assert_not_called()
            with patch.object(sys, "stdin", types.SimpleNamespace(buffer=io.BytesIO(valid))), patch.object(dsn, "call", side_effect=TimeoutError("synthetic authority outage")) as call:
                with self.assertRaises(TimeoutError):
                    dsn.main()
                call.assert_called_once()

    def test_supervisor_cli_failure_emits_only_static_event(self):
        output = io.StringIO()
        with patch.object(supervisor, "main", side_effect=RuntimeError("SYNTHETIC_SECRET_CANARY")), redirect_stderr(output):
            self.assertEqual(supervisor.cli(), 1)
        self.assertEqual(output.getvalue(), '{"event":"mta_startup_failed"}\n')

    def test_dsn_transport_duplicates_share_fingerprint_but_target_and_status_do_not(self):
        base = b"From: mailer@example.test\r\nMessage-ID: <fixed@example.test>\r\nContent-Type: multipart/report; boundary=synthetic\r\n\r\n--synthetic\r\nbody\r\n"
        first = b"Received: by first.test; timestamp-one\r\nReturn-Path: <>\r\nDKIM-Signature: a=rsa-sha256;\r\n b=first\r\n" + base
        second = b"Received: by second.test; timestamp-two\r\nReceived: by hop.test\r\nDKIM-Signature: a=rsa-sha256; b=second\r\n" + base
        target = "b+00000000-0000-4000-8000-000000000001@bounce.example.test"
        one = dsn.event_id(first, target, ["5.1.1"])
        self.assertEqual(one, dsn.event_id(second, target, ["5.1.1"]))
        self.assertEqual(one, dsn.event_id(second.replace(b"\r\n", b"\n"), target, ["5.1.1"]))
        self.assertNotEqual(one, dsn.event_id(second, target.replace("0001@", "0002@"), ["5.1.1"]))
        self.assertNotEqual(one, dsn.event_id(second, target, ["4.0.0"]))

    def load_policy(self):
        fake = types.SimpleNamespace(Base=object, uniqueID=lambda: 1, CONTINUE=0, TEMPFAIL=4, REJECT=5)
        spec = importlib.util.spec_from_file_location("policy_under_test", ROOT / "policy" / "service.py")
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"Milter": fake}):
            spec.loader.exec_module(module)
        return module

    def test_canonical_transport_headers_do_not_change_binding(self):
        original = [("From", "sender@example.test"), ("Subject", "synthetic\r\n body")]
        self.assertEqual(canonical_hash(original, b"one\ntwo\n"),
                         canonical_hash([("Received", "private"), *original, ("X-Verde2-Lease", "secret")], b"one\r\ntwo\r\n"))
        self.assertNotEqual(canonical_hash(original, b"one\n"), canonical_hash(original, b"two\n"))

    def test_remote_diagnostic_and_recipient_cannot_forge_delivery_status(self):
        with tempfile.TemporaryDirectory() as directory:
            supervisor.DB = str(Path(directory) / "evidence.sqlite3")
            supervisor.ingest("postfix/smtp[10]: Q123: to=<status=sent@example.test>, relay=sink[127.0.0.1]:25, delay=1, delays=0/0/0/1, dsn=5.1.1, status=bounced (remote says status=sent dsn=2.0.0)")
            with supervisor.database() as db:
                records = db.execute("SELECT payload FROM events").fetchall()
            self.assertEqual(len(records), 1)
            record = json.loads(records[0][0])
            self.assertEqual(record["type"], "failed_permanent")
            self.assertEqual(record["enhancedStatus"], "5.1.1")
            self.assertNotIn("recipient", record)
            supervisor.ingest("postfix/smtp[10]: Q123: to=<status=sent@example.test>, relay=sink[127.0.0.1]:25, delay=1, delays=0/0/0/1, dsn=5.1.1, status=bounced (duplicate)")
            with supervisor.database() as db:
                self.assertEqual(db.execute("SELECT count(*) FROM events").fetchone()[0], 1)
            supervisor.ingest("postfix/smtp[10]: Qcached: to=<recipient@sink.test>, relay=sink[127.0.0.1]:25, conn_use=2, delay=1, delays=0/0/0/1, dsn=2.0.0, status=sent (synthetic)")
            with supervisor.database() as db:
                cached = db.execute("SELECT payload FROM events WHERE payload LIKE '%Qcached%'").fetchone()
            self.assertEqual(json.loads(cached[0])["type"], "accepted_remote")

    def test_rejection_proof_is_anchored_sanitized_and_idempotent(self):
        proof = "<22>Oct  6 12:00:00 postfix/cleanup[10]: Qproof: milter-reject: END-OF-MESSAGE from unknown[172.20.0.4]: 4.7.1 Service unavailable; from=<private@example.test> to=<recipient@sink.test> proto=ESMTP helo=<client>"
        with tempfile.TemporaryDirectory() as directory:
            supervisor.DB = str(Path(directory) / "evidence.sqlite3")
            supervisor.ingest(proof)
            supervisor.ingest(proof)
            # A remote diagnostic, wrong process, and a multiline spoof are never prequeue proof.
            supervisor.ingest("postfix/smtp[10]: Qremote: to=<recipient@sink.test>, relay=sink[127.0.0.1]:25, delay=1, delays=0/0/0/1, dsn=4.0.0, status=deferred (" + proof + ")")
            supervisor.ingest(proof.replace("postfix/cleanup", "postfix/submission"))
            supervisor.ingest("postfix/smtp[10]: Qbad: remote says\n" + proof)
            with supervisor.database() as db:
                records = db.execute("SELECT payload FROM events WHERE endpoint='release-by-queue'").fetchall()
            self.assertEqual(len(records), 1)
            result = json.loads(records[0][0])
            self.assertEqual(result["queueId"], "Qproof")
            self.assertEqual(result["responseCode"], 451)
            self.assertTrue(result["provenNotAccepted"])
            self.assertNotIn("@", records[0][0])

    def test_abort_retains_exact_attempt_identity_and_never_releases_after_eom(self):
        module = self.load_policy()
        reservation = "00000000-0000-4000-8000-000000000001"
        lease = "00000000-0000-4000-8000-000000000002"
        policy = module.Policy()
        policy.headers = [("From", "sender@example.test"), ("Message-ID", "<synthetic@example.test>"),
                          ("Content-Type", "text/plain"), ("X-Verde2-Lease", lease)]
        policy.body_bytes = bytearray(b"synthetic\r\n")
        policy.recipients = ["recipient@sink.test"]
        policy.username, policy.sender = "synthetic", "sender@example.test"
        policy.getsymval = lambda _: "QueueAttemptA"
        policy.setreply = Mock()
        policy.chgfrom = Mock(side_effect=RuntimeError("synthetic prequeue failure"))
        module.call = Mock(return_value={"reservationId": reservation, "envelopeFrom": "b+synthetic@bounce.example.test"})
        with patch.dict(os.environ, {"EMAIL_DOMAIN": "example.test", "MAIL_INSTANCE_ID": "instance-a"}):
            self.assertEqual(policy.eom(), 4)
        policy.getsymval = lambda _: "QueueAttemptB"
        policy.abort()
        endpoint, payload = module.call.call_args.args
        self.assertEqual(endpoint, "release")
        self.assertEqual(payload["queueId"], "QueueAttemptA")
        self.assertEqual(payload["instanceId"], "instance-a")
        self.assertEqual(payload["workerLease"], lease)
        self.assertEqual(payload["reservationId"], reservation)
        policy.reservation = reservation
        policy.reservation_binding = {"queueId": "QueueAttemptB", "instanceId": "instance-a", "workerLease": lease}
        policy.eom_returned = True
        module.call.reset_mock()
        policy.abort()
        module.call.assert_not_called()

    def test_only_issued_recent_single_recipient_null_sender_dsns_leave_hold(self):
        now = 200000.0
        address = "b+00000000-0000-4000-8000-000000000001@bounce.example.test"
        entry = {"queue_id": "Qdsn", "queue_name": "hold", "sender": "", "arrival_time": now - 10,
                 "recipients": [{"address": address}]}
        authorize = Mock()
        action = lambda item: supervisor.held_dsn_action(item, "bounce.example.test", now, authorize)
        self.assertEqual(action(entry), "release")
        authorize.assert_called_with(address)
        self.assertEqual(action({**entry, "arrival_time": now - 86400}), "delete")
        for item in [{**entry, "sender": "sender@example.test"}, {**entry, "arrival_time": now + 1},
                     {**entry, "recipients": [{"address": address}, {"address": address}]},
                     {**entry, "recipients": [{"address": "unreserved@example.test"}]}]:
            self.assertIsNone(action(item))
        authorize.side_effect = PermissionError("unknown reserved address")
        self.assertIsNone(action(entry))
        authorize.side_effect = TimeoutError("authority unavailable")
        with self.assertRaises(TimeoutError):
            action(entry)

if __name__ == "__main__":
    unittest.main()
