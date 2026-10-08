#!/usr/bin/env python3
"""Render self-contained Ubuntu user-data; never accepts private key material."""
import argparse
import base64
import ipaddress
import json
from pathlib import Path, PurePosixPath
import re
import shlex
import struct


def read_public_key(path):
    fields = path.read_text(encoding="utf-8").strip().split()
    if len(fields) < 2 or fields[0] != "ssh-ed25519":
        raise ValueError("An OpenSSH Ed25519 public key is required")
    blob = base64.b64decode(fields[1], validate=True)
    if len(blob) != 51 or struct.unpack(">I", blob[:4])[0] != 11:
        raise ValueError("Invalid Ed25519 public key structure")
    if blob[4:15] != b"ssh-ed25519" or struct.unpack(">I", blob[15:19])[0] != 32:
        raise ValueError("Invalid Ed25519 public key structure")
    return fields[0] + " " + fields[1]


def entry(path, content, permissions):
    return (
        f"  - path: {path}\n    owner: root:root\n"
        f"    permissions: '{permissions}'\n    content: |\n"
        + "".join(f"      {line}\n" for line in content.splitlines())
    )


def shell_script(config, key):
    # Parse only the project's fixed write_files layout, not arbitrary YAML.
    pattern = re.compile(
        r"  - path: (/[^\s]+)\n    owner: root:root\n"
        r"    permissions: '([0-7]{4})'\n    content: \|\n"
        r"((?:      [^\n]*\n)+)"
    )
    matches = list(pattern.finditer(config))
    if len(matches) != config.count("  - path: "):
        raise ValueError("Unsupported write_files layout: refusing partial shell output")
    parts = [
        "#!/bin/bash\nset -euo pipefail\numask 077\n"
        "export DEBIAN_FRONTEND=noninteractive\n"
        "[[ $(id -u) == 0 ]] || { echo 'Run as root during first boot.' >&2; exit 1; }\n"
        "source /etc/os-release\n"
        "[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || { echo 'Ubuntu 24.04 required.' >&2; exit 1; }\n"
        "# Protect existing installations; this is a fresh-host script.\n"
        "if command -v docker >/dev/null 2>&1 || id verde2admin >/dev/null 2>&1 || "
        "getent group verde2admin >/dev/null 2>&1; then\n"
        "  echo 'Existing Docker/user detected. Refusing to change this host.' >&2\n"
        "  exit 1\nfi\n"
        "groupadd --force adm\ngroupadd --force sudo\n"
        "useradd --create-home --user-group --shell /bin/bash --groups adm,sudo verde2admin\n"
        "passwd --lock verde2admin\n"
        "install -d -m 0700 -o verde2admin -g verde2admin /home/verde2admin/.ssh\n"
        "cat > /home/verde2admin/.ssh/authorized_keys <<'VERDE2_PUBLIC_KEY'\n"
        + key + "\nVERDE2_PUBLIC_KEY\n"
        "chown verde2admin:verde2admin /home/verde2admin/.ssh/authorized_keys\n"
        "chmod 0600 /home/verde2admin/.ssh/authorized_keys\n"
        "install -d -m 0750 /etc/sudoers.d\n"
        "printf '%s\\n' 'verde2admin ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-verde2-admin\n"
        "chmod 0440 /etc/sudoers.d/90-verde2-admin\n"
    ]
    for index, match in enumerate(matches):
        path, mode, indented = match.groups()
        content = "".join(line[6:] for line in indented.splitlines(keepends=True))
        delimiter = f"VERDE2_FILE_{index:02d}"
        if delimiter in content.splitlines():
            raise ValueError("Unexpected heredoc delimiter collision")
        parts.append(
            f"install -d -m 0755 {shlex.quote(str(PurePosixPath(path).parent))}\n"
            f"cat > {shlex.quote(path)} <<'{delimiter}'\n{content}{delimiter}\n"
            f"chmod {mode} {shlex.quote(path)}\n"
        )
    packages = ["ca-certificates", "curl", "gnupg", "ufw", "iptables", "iproute2",
                "openssh-server", "sudo", "git", "openssl", "unattended-upgrades"]
    parts.append(
        "apt-get update\napt-get install --yes " + " ".join(packages) + "\n"
        "visudo --check --file=/etc/sudoers.d/90-verde2-admin\n"
        "apt-get upgrade --yes\n"
        "timedatectl set-timezone Etc/UTC\n"
        "bash /usr/local/sbin/verde2-bootstrap-host\n"
    )
    return "".join(parts)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--public-key", type=Path, required=True)
    parser.add_argument("--ssh-cidr", action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--format", choices=("cloud-config", "shell"), default="cloud-config")
    args = parser.parse_args()
    key = read_public_key(args.public_key)
    cidrs = sorted({str(ipaddress.ip_network(cidr, strict=True)) for cidr in args.ssh_cidr})
    for cidr in cidrs:
        network = ipaddress.ip_network(cidr)
        if network.prefixlen == 0 or not network.network_address.is_global:
            raise ValueError("SSH requires explicit public IP addresses or public CIDRs")
    # Key-level restrictions also apply while first-boot package installation runs.
    key = (f'from="{",".join(cidrs)}",no-agent-forwarding,no-X11-forwarding,'
           f'no-port-forwarding,no-user-rc {key}')
    root = Path(__file__).resolve().parent
    files = entry("/etc/verde2-bootstrap/ssh-cidrs", "\n".join(cidrs), "0600")
    files += entry("/usr/local/sbin/verde2-network-guard",
                   (root / "docker-network-guard.sh").read_text(), "0700")
    files += entry("/usr/local/sbin/verde2-bootstrap-host",
                   (root / "bootstrap-host.sh").read_text(), "0700")
    rendered = (root / "ubuntu24-base.yaml.in").read_text().replace(
        "@@SSH_PUBLIC_KEY@@", json.dumps(key)
    ).replace("@@GENERATED_FILES@@", files.rstrip())
    if "@@" in rendered:
        raise ValueError("Unresolved template placeholder")
    if args.format == "shell":
        rendered = shell_script(rendered, key)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Never overwrite an existing user-data file implicitly.
    with args.output.open("x", encoding="utf-8", newline="\n") as handle:
        handle.write(rendered)
    print(json.dumps({"output": str(args.output), "bytes": len(rendered.encode()),
                      "ssh_cidrs": cidrs, "mail_deployed": False, "format": args.format}))


if __name__ == "__main__":
    main()
