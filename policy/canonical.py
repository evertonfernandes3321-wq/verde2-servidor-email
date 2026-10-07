"""Canonical MIME contract mirrored in api: ordered header pairs, unfolded, CRLF body."""
import hashlib
import json
import re

EXCLUDED = {"received", "return-path", "dkim-signature", "x-verde2-lease"}

def canonical_hash(headers, body):
    normalized = [[name.lower(), re.sub(r"\r?\n[ \t]+", " ", value).strip()]
                  for name, value in headers if name.lower() not in EXCLUDED]
    prefix = json.dumps(normalized, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    body = re.sub(b"\r?\n", b"\r\n", body)
    return hashlib.sha256(prefix + b"\r\n\r\n" + body).hexdigest()
