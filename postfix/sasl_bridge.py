"""Cyrus saslauthd UNIX framing adapter. Passwords remain in memory only."""
import os
import socketserver
import struct
import urllib.error
from control import call

def exact(stream, count):
    result = b""
    while len(result) < count:
        chunk = stream.recv(count - len(result))
        if not chunk:
            raise EOFError()
        result += chunk
    return result

class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(10)
        response = b"NO"
        try:
            fields = []
            for _ in range(4):
                length = struct.unpack("!H", exact(self.request, 2))[0]
                if length > 4096:
                    raise ValueError()
                fields.append(exact(self.request, length).decode("utf-8"))
            username, password, service, realm = fields
            if service == "smtp":
                call("auth", {"username": username, "password": password})
                response = b"OK"
        except urllib.error.HTTPError as error:
            if error.code != 403:
                self.request.close()
                return  # No SASL credential verdict when the authority is unavailable.
        except Exception:
            self.request.close()
            return
        self.request.sendall(struct.pack("!H", len(response)) + response)

class Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True

if __name__ == "__main__":
    path = "/run/saslauthd/mux"
    if os.path.exists(path):
        os.unlink(path)
    with Server(path, Handler) as server:
        os.chmod(path, 0o660)
        import grp
        os.chown(path, 0, grp.getgrnam("postfix").gr_gid)
        server.serve_forever()
