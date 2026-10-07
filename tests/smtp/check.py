"""Black-box SMTP contract checks. Run only on the coordinator's isolated Docker network."""
import os
import smtplib
import ssl
import uuid
import json
import sys
from email.message import EmailMessage
from email.utils import formatdate

def report_failure(error):
    result = {"event": "smtp_checks_failed", "errorClass": type(error).__name__}
    code = getattr(error, "smtp_code", None)
    if isinstance(code, int) and 100 <= code <= 599:
        result["smtpCode"] = code
    print(json.dumps(result), file=sys.stderr)

try:
    HOST = os.environ.get("SMTP_TEST_HOST", "postfix")
    PORT = 587
    CA = os.environ["SMTP_CA_FILE"]
    if os.environ.get("SMTP_FIXTURE_FILE"):
        with open(os.environ["SMTP_FIXTURE_FILE"], encoding="utf-8") as fixture_file:
            fixture = json.load(fixture_file)["tenants"]["a"]
        USER = fixture["smtp"]["username"]
        PASSWORD = fixture["smtp"]["secret"]
        FROM = fixture["from"]
    else:
        USER = os.environ["SMTP_TEST_USERNAME"]
        PASSWORD = os.environ["SMTP_TEST_PASSWORD"]
        FROM = os.environ.get("SMTP_TEST_FROM", "sender@example.test")
    TO = "recipient@sink.test"
    context = ssl.create_default_context(cafile=CA)
except Exception as error:
    report_failure(error)
    raise SystemExit(1)

def connected(auth=True):
    client = smtplib.SMTP(HOST, PORT, timeout=15)
    client.ehlo()
    client.starttls(context=context)
    client.ehlo()
    if auth:
        client.login(USER, PASSWORD)
    return client

def message(sender=FROM, duplicate=False):
    lines = ["From: " + sender, "To: " + TO, "Message-ID: <" + str(uuid.uuid4()) + "@example.test>",
             "Date: " + formatdate(usegmt=True), "MIME-Version: 1.0",
             "Subject: synthetic verification", "Content-Type: text/plain; charset=utf-8"]
    if duplicate:
        lines.append("From: forged@example.test")
    return "\r\n".join(lines) + "\r\n\r\nSynthetic body\r\n"

def rejected(code):
    assert code >= 400, ("expected rejection", code)

def main():
    with smtplib.SMTP(HOST, PORT, timeout=15) as client:
        client.ehlo()
        assert not client.has_extn("auth"), "AUTH advertised before TLS"
        rejected(client.mail(FROM)[0])
    try:
        with smtplib.SMTP(HOST, PORT, timeout=15) as client:
            client.starttls(context=ssl.create_default_context())
        raise AssertionError("untrusted certificate accepted")
    except ssl.SSLCertVerificationError:
        pass
    with connected(False) as client:
        try:
            client.login(USER, PASSWORD + "-invalid")
            raise AssertionError("invalid credential accepted")
        except smtplib.SMTPAuthenticationError:
            pass
        code = client.mail(FROM)[0]
        rejected(code) if code >= 400 else rejected(client.rcpt(TO)[0])
    for sender, duplicate in [("forged@unapproved.test", False), (FROM, True)]:
        with connected() as client:
            try:
                client.sendmail(FROM, TO, message(sender, duplicate))
                raise AssertionError("unauthorized header accepted")
            except (smtplib.SMTPDataError, smtplib.SMTPSenderRefused, smtplib.SMTPRecipientsRefused):
                pass
    with connected() as client:
        assert client.mail(FROM)[0] == 250
        assert client.rcpt(TO)[0] == 250
        rejected(client.rcpt("second@sink.test")[0])
        client.rset()
    with connected() as client:
        assert client.sendmail(FROM, TO, message()) == {}
    print("SMTP checks: TLS, certificate, authentication, From, recipients and admission passed")

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        report_failure(error)
        raise SystemExit(1)
