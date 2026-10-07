#!/bin/sh
# Explicit operator action. Output only DNS/public key, never private key.
set -eu
domain=${1:?usage: generate-dkim.sh DOMAIN SELECTOR ABSOLUTE_SECRET_DIRECTORY}
selector=${2:?selector required}
directory=${3:?secret directory outside repository required}
case "$directory" in /*) ;; *) echo 'Absolute external secret directory required' >&2; exit 1;; esac
repository=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
directory=$(realpath -m -- "$directory")
case "$directory/" in "$repository/"*) echo 'Secret directory must be outside repository' >&2; exit 1;; esac
for value in "$domain" "$selector"; do
  case "$value" in *[!a-zA-Z0-9.-]*|'') exit 1;; esac
done
umask 077
mkdir -p "$directory"
test ! -e "$directory/$selector.private" || { echo 'Existing key preserved' >&2; exit 1; }
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$directory/$selector.private" 2>/dev/null
openssl pkey -in "$directory/$selector.private" -pubout -out "$directory/$selector.public" 2>/dev/null
public=$(sed '/-----/d' "$directory/$selector.public" | tr -d '\n')
printf '%s._domainkey.%s TXT "v=DKIM1; k=rsa; p=%s"\n' "$selector" "$domain" "$public"
