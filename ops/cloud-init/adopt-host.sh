#!/bin/bash
# Repair the inspected Ubuntu host without recreating users or resetting UFW.
set -euo pipefail
umask 077
source /etc/os-release
[[ $EUID == 0 && $ID == ubuntu && $VERSION_ID == 24.04 ]] || exit 1
[[ ${SSH_CONNECTION:-} == '170.238.162.239 '* ]] || {
  echo 'Run through the verified administrator SSH connection.' >&2; exit 1;
}
stage=$(cd -- "$(dirname -- "$0")" && pwd -P)
[[ -f "$stage/docker-network-guard.sh" && -f "$stage/bootstrap-host.sh" ]] || exit 1
id verde2admin >/dev/null
/usr/sbin/sshd -t
! command -v docker >/dev/null || { echo 'Docker already installed; inspect before adoption.' >&2; exit 1; }
for directory in /opt/verde2 /srv/verde2; do
  [[ ! -e $directory ]] || [[ -d $directory && -z $(find "$directory" -mindepth 1 -maxdepth 1 -print -quit) ]] || {
    echo 'Existing application data requires a separate adoption.' >&2; exit 1;
  }
done
[[ $(cat /etc/verde2-bootstrap/ssh-cidrs) == 170.238.162.239/32 ]] || exit 1
ufw status | head -n 1 | grep -Fxq 'Status: active'
[[ $(ufw show added | grep '^ufw ' | sort) == $'ufw allow 443/tcp\nufw allow 80/tcp\nufw allow OpenSSH' ]] || {
  echo 'UFW changed since inspection; preserve it and inspect again.' >&2; exit 1;
}
backup=/root/verde2-ops-backup/$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 0700 "$backup"
for item in /etc/ufw /etc/default/ufw /etc/caddy/Caddyfile \
  /etc/docker/daemon.json /usr/local/sbin/verde2-bootstrap-host \
  /usr/local/sbin/verde2-network-guard /etc/systemd/system/verde2-network-guard.service \
  /etc/systemd/system/docker.service.d/verde2-guard.conf; do
  [[ ! -e $item ]] || cp -a --parents -- "$item" "$backup/"
done
# A pending timer restores the exact previous firewall if the new SSH test fails.
cat > "$backup/rollback-firewall.sh" <<EOF
#!/bin/bash
set -euo pipefail
cp -a -- '$backup/etc/ufw/.' /etc/ufw/
cp -a -- '$backup/etc/default/ufw' /etc/default/ufw
ufw reload
EOF
chmod 0700 "$backup/rollback-firewall.sh"
systemd-run --quiet --unit=verde2-adoption-rollback --on-active=180s \
  /bin/bash "$backup/rollback-firewall.sh"
install -d -m 0700 /var/lib/verde2-bootstrap
printf '%s\n' "$backup" > /var/lib/verde2-bootstrap/adoption-backup
ufw insert 1 limit from 170.238.162.239/32 to any port 22 proto tcp
ufw default deny incoming
ufw default allow outgoing
ufw default deny routed
ufw delete allow OpenSSH
ufw delete allow 80/tcp
ufw delete allow 443/tcp
# Host processes never submit externally during base preparation.
for port in 25 465 587 2525; do ufw deny out "$port"/tcp; done
ufw logging off
ufw reload
install -m 0700 "$stage/bootstrap-host.sh" /usr/local/sbin/verde2-bootstrap-host
install -m 0700 "$stage/docker-network-guard.sh" /usr/local/sbin/verde2-network-guard
install -d -m 0755 /etc/systemd/system/docker.service.d /etc/docker
cat > /etc/docker/daemon.json <<'EOF'
{"firewall-backend":"iptables","iptables":true,"ip6tables":true,"userland-proxy":false,"log-driver":"local","log-opts":{"max-size":"10m","max-file":"3"}}
EOF
cat > /etc/systemd/system/verde2-network-guard.service <<'EOF'
[Unit]
Description=Verde2 initial Docker network restrictions
Wants=network-online.target
After=network-online.target ufw.service
Before=docker.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/verde2-network-guard
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/docker.service.d/verde2-guard.conf <<'EOF'
[Unit]
Requires=verde2-network-guard.service
After=verde2-network-guard.service
[Service]
ExecStartPre=/usr/local/sbin/verde2-network-guard
EOF
systemctl daemon-reload
systemctl enable --now verde2-network-guard.service
printf '%s\n' FIREWALL_REPAIRED_SSH_VERIFICATION_PENDING > /var/lib/verde2-bootstrap/status
echo 'Firewall repaired. Verify a NEW SSH session before cancelling rollback.'
