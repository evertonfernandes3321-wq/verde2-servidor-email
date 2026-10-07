"""Minimal untrusted DSN receiver. Never forwards original message or addresses to logs."""
import email.parser
import email.policy
import hashlib
import json
import os
import re
import sys
from control import call

def event_id(raw, target, statuses):
    """Deduplicate transport copies only; this fingerprint never qualifies DSN origin."""
    normalized = re.sub(b"\r?\n", b"\r\n", raw)
    headers, body = normalized.split(b"\r\n\r\n", 1)
    retained = []
    for header in re.split(b"\r\n(?![ \t])", headers):
        name, value = header.split(b":", 1)
        name = name.strip().lower()
        if name in {b"received", b"return-path", b"dkim-signature"}:
            continue
        retained.append(name + b":" + re.sub(b"\r\n[ \t]+", b" ", value).strip())
    digest = hashlib.sha256()
    digest.update(target.lower().encode("utf-8") + b"\0")
    digest.update(json.dumps(statuses, separators=(",", ":")).encode("ascii") + b"\0")
    digest.update(b"\r\n".join(retained) + b"\r\n\r\n" + body)
    return digest.hexdigest()

def main():
    raw = sys.stdin.buffer.read(1048577)
    if len(raw) > 1048576:
        return 65
    target = sys.argv[1]
    match = re.fullmatch(r"b\+([a-f0-9-]{36})@" + re.escape(os.environ["BOUNCE_DOMAIN"]), target)
    if not match:
        return 65
    message = email.parser.BytesParser(policy=email.policy.default).parsebytes(raw)
    if message.get_content_type() != "multipart/report" or any(part.defects for part in message.walk()):
        return 0
    statuses = []
    for part in message.walk():
        if part.get_content_type() == "message/delivery-status":
            for block in part.get_payload():
                status = str(block.get("Status", ""))
                if status and not re.fullmatch(r"[245]\.\d{1,3}\.\d{1,3}", status):
                    return 0
                if re.fullmatch(r"[245]\.\d{1,3}\.\d{1,3}", status):
                    statuses.append(status)
                    if len(statuses) > 20:
                        return 0  # Malformed/unbounded report is discarded, never retried as an outage.
    if not statuses:
        return 0
    try:
        fingerprint = event_id(raw, target, statuses)
    except ValueError:
        return 0  # Invalid header framing is input rejection, not infrastructure unavailability.
    call("dsn", {"eventId": fingerprint,
        "messageId": match.group(1), "statuses": statuses, "qualified": False,
        "instanceId": os.environ["MAIL_INSTANCE_ID"]})
    return 0

if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(75)
