#!/bin/sh
set -eu
: "${EMAIL_DOMAIN:?}" "${DKIM_SELECTOR:?}"
for value in "$EMAIL_DOMAIN" "$DKIM_SELECTOR"; do
  case "$value" in *[!a-zA-Z0-9.-]*|'') echo 'Invalid signer identifier' >&2; exit 1;; esac
done
test -s /run/secrets/dkim.private
openssl rsa -in /run/secrets/dkim.private -check -noout >/dev/null 2>&1
bits=$(openssl pkey -in /run/secrets/dkim.private -text -noout 2>/dev/null | head -n 1)
case "$bits" in *2048*) ;; *) echo 'RSA 2048 required' >&2; exit 1;; esac
umask 077
# The daemon runs as root; every writable ancestor of its key must share that owner.
# Normalize again at runtime because a tmpfs mount replaces the image directory.
install -d -m 0700 -o root -g root /run/opendkim
cp /run/secrets/dkim.private /run/opendkim/dkim.private
chown root:root /run/opendkim/dkim.private
chmod 0600 /run/opendkim/dkim.private
printf '%s._domainkey.%s %s:%s:/run/opendkim/dkim.private\n' "$DKIM_SELECTOR" "$EMAIL_DOMAIN" "$EMAIL_DOMAIN" "$DKIM_SELECTOR" > /etc/opendkim/KeyTable
printf '*@%s %s._domainkey.%s\n' "$EMAIL_DOMAIN" "$DKIM_SELECTOR" "$EMAIL_DOMAIN" > /etc/opendkim/SigningTable
printf '127.0.0.1\n' > /etc/opendkim/TrustedHosts
opendkim -n -x /etc/opendkim/opendkim.conf
exec opendkim -f -x /etc/opendkim/opendkim.conf
