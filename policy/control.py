"""Authenticated private control channel; no exception messages or payload logging."""
import json
import os
import ssl
import urllib.request

def call(endpoint, payload):
    base = os.environ["INTERNAL_URL"]
    if not base.startswith("https://"):
        raise ValueError("internal TLS required")
    context = ssl.create_default_context(cafile=os.environ["INTERNAL_CA_FILE"])
    data = json.dumps(payload, separators=(",", ":")).encode()
    request = urllib.request.Request(base.rstrip("/") + "/internal/v1/" + endpoint,
        data=data, headers={"Authorization": "Bearer " + os.environ["INTERNAL_TOKEN"],
                            "Content-Type": "application/json"})
    with urllib.request.urlopen(request, context=context, timeout=8) as response:
        result = json.loads(response.read(65536))
    if result.get("ok") is not True:
        raise PermissionError("policy denied")
    return result
