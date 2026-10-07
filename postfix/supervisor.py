"""Consume syslog privately; persist only allowlisted evidence before delivery to the API."""
import hashlib
import math
import json
import os
import re
import signal
import socket
import sqlite3
import subprocess
import threading
import time
import urllib.error
import sys
from contextlib import contextmanager
from datetime import datetime
from control import call
from journal import QUARANTINE_SCHEMA, prune_journal

DB = "/var/spool/postfix/evidence/events.sqlite3"
INSTANCE = os.environ["MAIL_INSTANCE_ID"]
STOP = threading.Event()
LOCAL_CONTENT_LIFETIME = 24 * 3600 - 600
RELEASE_MARGIN = 10

@contextmanager
def database():
    db = sqlite3.connect(DB, timeout=10)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, endpoint TEXT, payload TEXT, created REAL)")
    db.execute("CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, created REAL)")
    db.execute(QUARANTINE_SCHEMA)
    try:
        with db:
            yield db
    finally:
        db.close()

def ingest(line):
    # Never print or persist raw syslog: remote SMTP diagnostics can contain bodies/addresses.
    queue_match = re.fullmatch(r"(?:<\d{1,3}>)?(?:[A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} )?(?:[A-Za-z0-9_.-]+ )?postfix/([\w-]+)\[\d+\]: ([A-Za-z0-9]+): ([^\r\n]*)", line)
    if not queue_match:
        return
    process, queue, detail = queue_match.groups()
    with database() as db:
        kind = None
        endpoint = "event"
        delivery = re.match(r"to=<[^>]*>, (?:orig_to=<[^>]*>, )?relay=[^,]*, (?:conn_use=\d+, )?delay=[0-9.]+, delays=[0-9./]+, dsn=([245]\.\d{1,3}\.\d{1,3}), status=(sent|deferred|bounced)(?: |$)", detail)
        rejection = re.match(r"milter-reject: END-OF-MESSAGE from [^\s\[\]]+\[[0-9a-fA-F:.]+\]: ([45])\.\d{1,3}\.\d{1,3} [^\r\n]*; from=<", detail) if process == "cleanup" else None
        if process == "qmgr" and re.fullmatch(r"from=<[^>]*>, size=\d+, nrcpt=1 \(queue active\)", detail):
            kind, endpoint = "accepted_local", "commit"
        elif rejection:
            kind, endpoint = "rejected_prequeue", "release-by-queue"
        elif process in {"smtp", "relay"} and delivery:
            kind = {"sent": "accepted_remote", "deferred": "deferred", "bounced": "failed_permanent"}[delivery.group(2)]
        if not kind:
            return
        identity = "|".join((INSTANCE, queue, kind, delivery.group(1) if delivery else rejection.group(1) if rejection else ""))
        event_id = hashlib.sha256(identity.encode()).hexdigest()
        if db.execute("SELECT 1 FROM seen WHERE id=?", (event_id,)).fetchone():
            return
        payload = {"eventId": event_id, "instanceId": INSTANCE, "queueId": queue, "type": kind}
        if rejection:
            # cleanup logs the enhanced status, omitting the SMTP reply code (resp + 4).
            # This normalized code carries only the observed temporary/permanent class.
            payload.pop("type")
            payload.update(reason="milter_rejected", provenNotAccepted=True,
                           responseCode=451 if rejection.group(1) == "4" else 550)
        if delivery:
            payload["enhancedStatus"] = delivery.group(1)
        db.execute("INSERT OR IGNORE INTO events VALUES (?,?,?,?)",
                   (event_id, endpoint, json.dumps(payload), time.time()))
        db.execute("INSERT OR IGNORE INTO seen VALUES (?,?)", (event_id, time.time()))

def forward():
    while not STOP.wait(1):
        try:
            with database() as db:
                records = db.execute("SELECT id,endpoint,payload FROM events ORDER BY created LIMIT 100").fetchall()
            for event_id, endpoint, payload in records:
                try:
                    call(endpoint, json.loads(payload))
                    with database() as db:
                        db.execute("DELETE FROM events WHERE id=?", (event_id,))
                except Exception:
                    continue
            with database() as db:
                prune_journal(db, time.time() - 30 * 86400)
        except Exception:
            # Preserve evidence and retry independently. Never resubmit mail.
            pass

def valid_arrival(entry, now):
    arrival = entry.get("arrival_time")
    return type(arrival) in (int, float) and 0 < arrival <= now


def locally_expired(entry, now):
    return valid_arrival(entry, now) and now - entry["arrival_time"] >= LOCAL_CONTENT_LIFETIME


def queue_policy(queues):
    """Validate every bounded control response before any held queue can be released."""
    released, removed = {}, set()
    # Include deadline objects and maximum-length queue IDs below the 64 KiB reader cap.
    for offset in range(0, len(queues), 250):
        batch = queues[offset:offset + 250]
        allowed = set(batch)
        result = call("queue-check", {"instanceId": INSTANCE, "queueIds": batch})
        if not isinstance(result, dict) or result.get("ok") is not True:
            raise ValueError("invalid_queue_policy")
        if not isinstance(result.get("release"), list) or not isinstance(result.get("remove"), list):
            raise ValueError("invalid_queue_policy")
        for item in result["release"]:
            if not isinstance(item, dict):
                raise ValueError("invalid_queue_policy")
            queue, deadline = item.get("queueId"), item.get("expiresAt")
            if not isinstance(queue, str) or queue not in allowed:
                raise ValueError("invalid_queue_policy")
            if not isinstance(deadline, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z", deadline):
                raise ValueError("invalid_queue_deadline")
            expiry = datetime.fromisoformat(deadline[:-1] + "+00:00").timestamp()
            if not math.isfinite(expiry) or (queue in released and released[queue] != expiry):
                raise ValueError("invalid_queue_deadline")
            released[queue] = expiry
        for item in result["remove"]:
            if not isinstance(item, dict) or item.get("reason") != "expired":
                raise ValueError("invalid_queue_policy")
            queue = item.get("queueId")
            if not isinstance(queue, str) or queue not in allowed:
                raise ValueError("invalid_queue_policy")
            removed.add(queue)
    if released.keys() & removed:
        raise ValueError("conflicting_queue_policy")
    return released, removed


def held_dsn_action(entry, bounce_domain, now, authorize):
    """Only issued null-envelope DSNs may leave hold; unknown queues remain quarantined."""
    if entry.get("queue_name") != "hold" or entry.get("sender") != "":
        return None
    if not valid_arrival(entry, now):
        return None
    if locally_expired(entry, now):
        return "delete"
    recipients = entry.get("recipients", [])
    if len(recipients) != 1:
        return None
    recipient = recipients[0].get("address", "")
    pattern = r"b\+[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}@" + re.escape(bounce_domain)
    if not re.fullmatch(pattern, recipient):
        return None
    try:
        authorize(recipient)
    except PermissionError:
        return None
    except urllib.error.HTTPError as error:
        if error.code in (400, 403, 404):
            return None
        raise
    return "release"


def reconcile_queue_snapshot(entries, now):
    """Local spool time bounds content; only authoritative policy changes known states."""
    by_id = {}
    for entry in entries:
        queue = entry.get("queue_id")
        if not isinstance(queue, str) or not re.fullmatch(r"[A-Za-z0-9]{1,80}", queue) or queue in by_id:
            raise ValueError("invalid_local_queue")
        by_id[queue] = entry
    deleted = set()

    def operate(queue, operation):
        subprocess.run(["postsuper", operation, queue], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=10, check=True)

    # Expunge even orphaned content before contacting the control plane. No state event
    # is inferred from this age-only deletion, and authority failure still halts delivery.
    for queue, entry in by_id.items():
        if locally_expired(entry, now):
            operate(queue, "-d")
            deleted.add(queue)
    releases, expired = queue_policy(list(by_id))
    for queue in expired:
        if not valid_arrival(by_id[queue], now):
            continue
        if queue not in deleted:
            operate(queue, "-d")
            deleted.add(queue)
        payload = {"instanceId": INSTANCE, "queueId": queue, "type": "expired",
                   "eventId": hashlib.sha256((INSTANCE + "|" + queue + "|expired").encode()).hexdigest()}
        with database() as db:
            db.execute("INSERT OR IGNORE INTO events VALUES (?,?,?,?)",
                       (payload["eventId"], "event", json.dumps(payload), time.time()))
    approved_releases = {}
    for queue, entry in by_id.items():
        if queue in deleted or not valid_arrival(entry, now) or entry.get("queue_name") != "hold":
            continue
        action = held_dsn_action(entry, os.environ["BOUNCE_DOMAIN"], now,
                                 lambda recipient: call("dsn-address", {"recipient": recipient}))
        if action == "release" or queue in releases:
            approved_releases[queue] = min(entry["arrival_time"] + LOCAL_CONTENT_LIFETIME,
                                           releases.get(queue, math.inf))
    for queue, deadline in approved_releases.items():
        # Re-read immediately before each command: batches, authorizations, and prior
        # postsuper operations may have consumed the persisted validity interval.
        current = time.time()
        if not math.isfinite(current):
            raise ValueError("invalid_current_time")
        if not valid_arrival(by_id[queue], current) or current + RELEASE_MARGIN >= deadline:
            continue
        operate(queue, "-H")

def expire_queues():
    while not STOP.wait(1):
        try:
            result = subprocess.run(["postqueue", "-j"], capture_output=True, timeout=10, check=True)
            entries = [json.loads(line) for line in result.stdout.splitlines()]
            if not entries:
                continue
            reconcile_queue_snapshot(entries, time.time())
        except Exception:
            # Loss of the authoritative expiry control stops queue delivery until recovery.
            STOP.set()

def main():
    call("readiness", {"instanceId": INSTANCE})
    if os.path.exists("/dev/log"):
        os.unlink("/dev/log")
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    sock.bind("/dev/log")
    os.chmod("/dev/log", 0o666)
    sock.settimeout(1)
    with database():
        pass
    threading.Thread(target=forward, daemon=True).start()
    sasl = subprocess.Popen(["python3", "/opt/verde2/sasl_bridge.py"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["postsuper", "-h", "ALL"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
    smtp = subprocess.Popen(["postfix", "start-fg"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        ready = subprocess.run(["postfix", "status"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        if ready:
            break
        if smtp.poll() is not None:
            raise RuntimeError("mta_start_failed")
        time.sleep(0.1)
    else:
        raise RuntimeError("mta_start_timeout")
    threading.Thread(target=expire_queues, daemon=True).start()
    def stop(*_):
        STOP.set()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(json.dumps({"event": "mta_started", "instanceId": INSTANCE}), flush=True)
    while not STOP.is_set():
        if sasl.poll() is not None or smtp.poll() is not None:
            STOP.set()
            break
        try:
            ingest(sock.recv(65536).decode("utf-8", "replace"))
        except socket.timeout:
            pass
        except Exception:
            # Evidence failure halts admissions/delivery for reconciliation.
            STOP.set()
    subprocess.run(["postfix", "stop"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    sasl.terminate()
    smtp.terminate()
    return 1

def cli():
    try:
        return main()
    except Exception:
        print('{"event":"mta_startup_failed"}', file=sys.stderr, flush=True)
        return 1

if __name__ == "__main__":
    raise SystemExit(cli())
