#!/bin/bash
set -euo pipefail
umask 077
source /etc/os-release
[[ $EUID == 0 && $ID == ubuntu && $VERSION_ID == 24.04 ]] || exit 1
[[ ${SSH_CONNECTION:-} == '170.238.162.239 '* ]] || exit 1
grep -Fxq FIREWALL_REPAIRED_SSH_VERIFICATION_PENDING /var/lib/verde2-bootstrap/status
systemctl is-active --quiet verde2-network-guard.service
/usr/sbin/sshd -t
# This script must run through the NEW, successfully authenticated SSH session.
systemctl stop verde2-adoption-rollback.timer
systemctl is-active --quiet verde2-adoption-rollback.service && exit 1
install -d -m 0750 -o verde2admin -g verde2admin /opt/verde2
install -d -m 0700 /srv/verde2 /etc/apt/keyrings
chmod 0755 /etc/apt/keyrings
curl --fail --silent --show-error --location --retry 3 \
  https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod 0644 /etc/apt/keyrings/docker.asc
gpg --show-keys --with-colons /etc/apt/keyrings/docker.asc |
  grep -Fxq 'fpr:::::::::9DC858229FC7DD38854AE2D88D81803C0EBFCD88:'
architecture=$(dpkg --print-architecture)
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
docker info >/dev/null
docker compose version >/dev/null
{
  printf 'OS=%s\n' "$PRETTY_NAME"
  docker --version
  docker compose version
  dpkg-query -W docker-ce docker-ce-cli containerd.io docker-compose-plugin
} > /var/lib/verde2-bootstrap/versions.txt
printf '%s\n' BASE_READY_MAIL_NOT_DEPLOYED > /var/lib/verde2-bootstrap/status
echo 'Base repaired; mail remains undeployed and external SMTP blocked.'
