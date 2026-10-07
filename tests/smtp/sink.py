"""Controlled sink: memory only, no message/body/address output; no forwarding."""
import hashlib
import http.server
import json
import re
import socketserver
import threading
import dkim
from pathlib import Path

PUBLIC_KEY = b"v=DKIM1; k=rsa; p=" + Path("/run/public/dkim.txt").read_bytes().strip()

def public_dns(name, timeout=5):
    return PUBLIC_KEY if name.rstrip(b".") == b"qualify._domainkey.example.test" else None

LOCK = threading.Lock()
MESSAGES = {}
class SMTP(socketserver.StreamRequestHandler):
    def handle(self):
        self.request.settimeout(30)
        self.wfile.write(b"220 sink.test ESMTP synthetic\r\n")
        data = False
        parts = []
        while True:
            line = self.rfile.readline(1048577)
            if not line:
                break
            if data:
                if line == b".\r\n":
                    raw = b"".join(parts)
                    identity = re.search(br"(?im)^Message-ID:\s*(<[^\r\n]+>)", raw)
                    signed = bool(re.search(br"(?im)^DKIM-Signature:", raw))
                    try:
                        verified = dkim.verify(raw, dnsfunc=public_dns)
                    except Exception:
                        verified = False
                    with LOCK:
                        digest = hashlib.sha256(identity.group(1) if identity else raw).hexdigest()
                        MESSAGES[digest] = {"signed": signed, "verified": verified, "bytes": len(raw), "count": MESSAGES.get(digest, {}).get("count", 0) + 1}
                    data = False
                    self.wfile.write(b"250 2.0.0 accepted synthetic\r\n")
                else:
                    parts.append(line[1:] if line.startswith(b"..") else line)
                continue
            command = line.split(b" ", 1)[0].upper().strip()
            if command in {b"EHLO", b"HELO"}:
                self.wfile.write(b"250-sink.test\r\n250 SIZE 1048576\r\n")
            elif command in {b"MAIL", b"RCPT", b"RSET", b"NOOP"}:
                self.wfile.write(b"250 2.0.0 OK\r\n")
            elif command == b"DATA":
                data, parts = True, []
                self.wfile.write(b"354 Continue\r\n")
            elif command == b"QUIT":
                self.wfile.write(b"221 Bye\r\n")
                break
            else:
                self.wfile.write(b"502 Unsupported\r\n")
class Stats(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        with LOCK:
            records = list(MESSAGES.values())
            result = {"unique": len(records), "total": sum(r["count"] for r in records),
                      "signed": sum(r["signed"] for r in records),
                      "verified": sum(r["verified"] for r in records),
                      "invalid": sum(not r["verified"] for r in records),
                      "oversized": sum(r["bytes"] > 1048576 for r in records)}
        payload = json.dumps(result).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(payload)
    def log_message(self, *_):
        pass
if __name__ == "__main__":
    threading.Thread(target=lambda: socketserver.ThreadingTCPServer(("0.0.0.0", 2525), SMTP).serve_forever(), daemon=True).start()
    http.server.ThreadingHTTPServer(("0.0.0.0", 8080), Stats).serve_forever()
