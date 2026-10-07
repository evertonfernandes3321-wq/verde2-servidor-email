#!/bin/sh
set -eu
: "${MAIL_HOSTNAME:?}" "${EMAIL_DOMAIN:?}" "${BOUNCE_DOMAIN:?}" "${MAIL_INSTANCE_ID:?}"
: "${INTERNAL_URL:?}" "${INTERNAL_TOKEN:?}" "${INTERNAL_CA_FILE:?}"
if [ "${QUALIFICATION_MODE:-}" = synthetic ]; then
  [ "$(findmnt -n -o FSTYPE -T /var/spool/postfix)" = tmpfs ] || { echo 'Synthetic qualification requires tmpfs spool' >&2; exit 1; }
  case "$EMAIL_DOMAIN" in *.test) ;; *) exit 1;; esac
else
  test -s /run/storage-evidence || { echo 'Encrypted storage evidence required' >&2; exit 1; }
  test "$(cat /run/restore-release)" = "$MAIL_INSTANCE_ID" || { echo 'Reconciled instance release required' >&2; exit 1; }
fi
for name in "$MAIL_HOSTNAME" "$EMAIL_DOMAIN" "$BOUNCE_DOMAIN" "$MAIL_INSTANCE_ID"; do
  case "$name" in *[!a-zA-Z0-9.-]*|'') echo 'Invalid deployment identifier' >&2; exit 1;; esac
done
test -s /run/secrets/submission.crt && test -s /run/secrets/submission.key
openssl x509 -in /run/secrets/submission.crt -noout -checkend 86400 >/dev/null
# Set only deployment parameters; environment allowlists contain the same variable names.
postconf -e "myhostname = $MAIL_HOSTNAME" "mydomain = $EMAIL_DOMAIN" "relay_domains = $BOUNCE_DOMAIN"
escaped_bounce=$(printf '%s' "$BOUNCE_DOMAIN" | sed 's/\./\\./g')
printf '/^b\\+[a-f0-9-]{36}@%s$/ OK\n' "$escaped_bounce" > /etc/postfix/bounce_recipients
printf '/@%s$/ dsn:\n' "$escaped_bounce" > /etc/postfix/transports
printf '/^<>$/ OK\n/.*/ REJECT 5.7.1 only delivery status notifications accepted\n' > /etc/postfix/dsn_senders
printf '/^X-Verde2-/ IGNORE\n' > /etc/postfix/outbound_headers
mkdir -p /var/spool/postfix/evidence /run/saslauthd
chown root:postfix /run/saslauthd
chmod 0750 /run/saslauthd
chmod 0700 /var/spool/postfix/evidence
postfix check
if [ "${QUALIFICATION_MODE:-}" = synthetic ]; then
  postconf -e 'relayhost = [sink]:2525'
fi
exec python3 /opt/verde2/supervisor.py
