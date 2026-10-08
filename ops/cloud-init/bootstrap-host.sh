#!/bin/bash
set -euo pipefail
umask 077
source /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || {
  echo 'This bootstrap requires Ubuntu 24.04.' >&2; exit 1;
}

install -d -m 0700 /var/lib/verde2-bootstrap /srv/verde2
install -d -m 0750 -o verde2admin -g verde2admin /opt/verde2
/usr/sbin/sshd -t
ufw default deny incoming
ufw default allow outgoing
ufw default deny routed
while IFS= read -r cidr; do
  [[ -n "$cidr" ]] || continue
  ufw limit from "$cidr" to any port 22 proto tcp
done < /etc/verde2-bootstrap/ssh-cidrs
for port in 25 465 587 2525; do
  ufw deny out "$port"/tcp
done
ufw logging off
ufw --force enable
systemctl restart ssh.service

# Install the guard before apt can start Docker. UFW alone does not protect
# Docker's published ports; both IPv4 and IPv6 forwarding require explicit rules.
systemctl daemon-reload
systemctl enable verde2-network-guard.service
systemctl start verde2-network-guard.service
install -d -m 0755 /etc/apt/keyrings
curl --fail --silent --show-error --location --retry 3 \
  https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod 0644 /etc/apt/keyrings/docker.asc
architecture="$(dpkg --print-architecture)"
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: $architecture
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install --yes \
  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker.service
systemctl enable --now apt-daily.timer apt-daily-upgrade.timer
docker info >/dev/null
docker compose version >/dev/null
{
  printf 'OS=%s\n' "$PRETTY_NAME"
  docker --version
  docker compose version
  dpkg-query -W docker-ce docker-ce-cli containerd.io docker-compose-plugin
} > /var/lib/verde2-bootstrap/versions.txt
printf '%s\n' BASE_READY_MAIL_NOT_DEPLOYED > /var/lib/verde2-bootstrap/status
