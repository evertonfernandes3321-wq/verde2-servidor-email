#!/bin/bash
set -euo pipefail

# Initial host preparation only. Opening mail/API access requires a reviewed policy.
mapfile -t wan_interfaces < <(
  { ip -4 route show default; ip -6 route show default; } |
    awk '{for (i=1; i<=NF; i++) if ($i == "dev") print $(i+1)}' | sort -u
)
if ((${#wan_interfaces[@]} == 0)); then
  echo 'No default interface: Docker remains blocked.' >&2
  exit 1
fi
for interface in "${wan_interfaces[@]}"; do
  [[ "$interface" =~ ^[a-zA-Z0-9_.:-]+$ ]] || exit 1
done

for firewall in iptables ip6tables; do
  "$firewall" -w -N DOCKER-USER 2>/dev/null || "$firewall" -w -S DOCKER-USER >/dev/null
  "$firewall" -w -N VERDE2-BASE 2>/dev/null || "$firewall" -w -S VERDE2-BASE >/dev/null
  "$firewall" -w -F VERDE2-BASE
  "$firewall" -w -A VERDE2-BASE -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  for interface in "${wan_interfaces[@]}"; do
    "$firewall" -w -A VERDE2-BASE -i "$interface" -j DROP
    "$firewall" -w -A VERDE2-BASE -o "$interface" -p tcp -m multiport \
      --dports 25,465,587,2525 -j REJECT
  done
  "$firewall" -w -A VERDE2-BASE -j RETURN
  "$firewall" -w -C DOCKER-USER -j VERDE2-BASE 2>/dev/null || \
    "$firewall" -w -I DOCKER-USER 1 -j VERDE2-BASE
  "$firewall" -w -C FORWARD -j DOCKER-USER 2>/dev/null || \
    "$firewall" -w -I FORWARD 1 -j DOCKER-USER
done
