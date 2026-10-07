"""SMTP admission policy; distinct filename from the pymilter C extension."""
import email.policy
import email.parser
import os
import re
import uuid
import Milter
from canonical import canonical_hash
from control import call

MAX_BYTES = 1048576 - 16384  # reserve bounded space for Received and RSA-2048 DKIM headers

class Policy(Milter.Base):
    def __init__(self):
        self.id = Milter.uniqueID()
        self.connection_id = str(uuid.uuid4())
        self.incoming_dsn = False
        self.reservation = None
        self.reservation_binding = None
        self.eom_returned = False
        self.reset()

    def reset(self):
        self.headers = []
        self.body_bytes = bytearray()
        self.recipients = []
        self.sender = None
        self.username = None
        self.size = 0
        self.reservation = None
        self.reservation_binding = None
        self.eom_returned = False

    def denied(self, temporary=True):
        self.setreply("451" if temporary else "550", "4.7.1" if temporary else "5.7.1",
                      "Submission policy unavailable" if temporary else "Submission rejected by policy")
        return Milter.TEMPFAIL if temporary else Milter.REJECT

    def connect(self, hostname, family, hostaddr):
        try:
            self.incoming_dsn = self.getsymval("{daemon_name}") == "DSN"
            if self.incoming_dsn:
                return Milter.CONTINUE
            call("connections/open", {"connectionId": self.connection_id})
            return Milter.CONTINUE
        except Exception:
            return self.denied()

    def hello(self, name):
        return Milter.CONTINUE

    def envfrom(self, sender, *args):
        self.reset()
        if self.incoming_dsn:
            return Milter.CONTINUE if sender == "<>" else self.denied(False)
        self.username = self.getsymval("{auth_authen}")
        if not self.username:
            return self.denied(False)
        try:
            call("connections/open", {"connectionId": self.connection_id, "username": self.username})
            self.sender = sender.strip("<>")
            if not self.sender or "\r" in self.sender or "\n" in self.sender:
                return self.denied(False)
            return Milter.CONTINUE
        except Exception:
            return self.denied()

    def envrcpt(self, recipient, *args):
        if self.recipients:
            return self.denied(False)
        if self.incoming_dsn:
            try:
                call("dsn-address", {"recipient": recipient.strip("<>")})
            except Exception:
                return self.denied()
        self.recipients.append(recipient.strip("<>"))
        return Milter.CONTINUE

    def header(self, name, value):
        self.size += len(name.encode()) + len(value.encode()) + 4
        if self.size > MAX_BYTES:
            return self.denied(False)
        if not self.incoming_dsn and name.lower() in {"bcc", "resent-from", "resent-to", "sender"}:
            return self.denied(False)
        if name.lower().startswith("x-verde2-") and name.lower() != "x-verde2-lease":
            return self.denied(False)
        self.headers.append((name, value))
        return Milter.CONTINUE

    def eoh(self):
        if self.incoming_dsn:
            return Milter.CONTINUE
        names = [name.lower() for name, _ in self.headers]
        if names.count("from") != 1 or names.count("message-id") != 1:
            return self.denied(False)
        if names.count("reply-to") > 1 or names.count("x-verde2-lease") > 1:
            return self.denied(False)
        return Milter.CONTINUE

    def body(self, chunk):
        self.size += len(chunk)
        if self.size > MAX_BYTES:
            return self.denied(False)
        self.body_bytes.extend(chunk)
        return Milter.CONTINUE

    def eom(self):
        try:
            raw = ("\r\n".join(name + ": " + value for name, value in self.headers) +
                   "\r\n\r\n").encode() + bytes(self.body_bytes)
            parsed = email.parser.BytesParser(policy=email.policy.default).parsebytes(raw)
            if parsed.defects or len(self.recipients) != 1:
                return self.denied(False)
            if self.incoming_dsn:
                valid = parsed.get_content_type() == "multipart/report" and any(part.get_content_type() == "message/delivery-status" for part in parsed.walk())
                return Milter.CONTINUE if valid else self.denied(False)
            sender_header = parsed["From"]
            if sender_header.defects or len(sender_header.addresses) != 1:
                return self.denied(False)
            if sender_header.addresses[0].domain.lower() != os.environ["EMAIL_DOMAIN"].lower():
                return self.denied(False)
            reply = parsed["Reply-To"]
            if reply and (reply.defects or len(reply.addresses) != 1):
                return self.denied(False)
            for part in parsed.walk():
                if part.get_filename() or part.get_content_disposition() == "attachment":
                    return self.denied(False)
                if part.get_content_type() not in {"text/plain", "text/html", "multipart/alternative", "multipart/mixed"}:
                    return self.denied(False)
            message_id = str(parsed["Message-ID"])
            if not re.fullmatch(r"<[^<>\s@]+@[^<>\s@]+>", message_id):
                return self.denied(False)
            payload = {
                "username": self.username, "connectionId": self.connection_id,
                "envelopeFrom": self.sender, "recipient": self.recipients[0],
                "headerFrom": sender_header.addresses[0].addr_spec,
                "replyTo": reply.addresses[0].addr_spec if reply else None,
                "messageId": message_id, "contentHash": canonical_hash(self.headers, bytes(self.body_bytes)),
                "mimeBytes": self.size + 2, "queueId": self.getsymval("i"),
                "instanceId": os.environ["MAIL_INSTANCE_ID"],
                "workerLease": str(parsed["X-Verde2-Lease"]) if parsed["X-Verde2-Lease"] else None,
            }
            result = call("reserve", payload)
            self.reservation = result["reservationId"]
            self.reservation_binding = {key: payload[key] for key in ("instanceId", "queueId", "workerLease")}
            if result.get("smtpMessageId"):
                self.chgheader("Message-ID", 1, result["smtpMessageId"])
            if result.get("envelopeFrom"):
                self.chgfrom(result["envelopeFrom"])
            if parsed["X-Verde2-Lease"]:
                self.chgheader("X-Verde2-Lease", 1, None)
            # EOM is prequeue. Retain reservation until qmgr evidence, rejection reconciliation,
            # or an explicit abort before this callback completed. Never claim local acceptance here.
            self.eom_returned = True
            return Milter.CONTINUE
        except PermissionError:
            return self.denied(False)
        except Exception:
            return self.denied()

    def abort(self):
        if self.reservation and self.reservation_binding and not self.eom_returned:
            try:
                call("release", {"reservationId": self.reservation, **self.reservation_binding,
                                 "reason": "prequeue_abort", "provenNotAccepted": True})
            except Exception:
                pass  # Pending reservations fail closed until reconciliation.
        self.reset()
        return Milter.CONTINUE

    def close(self):
        self.abort()
        try:
            call("connections/close", {"connectionId": self.connection_id})
        except Exception:
            pass
        return Milter.CONTINUE

if __name__ == "__main__":
    Milter.factory = Policy
    Milter.set_flags(Milter.CHGHDRS | Milter.CHGFROM)
    Milter.runmilter("verde2-policy", "inet:8890@0.0.0.0", 60)
