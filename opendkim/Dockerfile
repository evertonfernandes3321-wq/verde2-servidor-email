FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f
RUN apt-get update && apt-get install -y --no-install-recommends opendkim opendkim-tools openssl && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /etc/opendkim \
 && install -d -m 0700 -o root -g root /run/opendkim \
 && dpkg-query -W > /usr/share/verde2-package-versions.txt
COPY config/opendkim.conf /etc/opendkim/opendkim.conf
COPY entrypoint.sh /usr/local/bin/verde2-opendkim
RUN chmod 0755 /usr/local/bin/verde2-opendkim
EXPOSE 8891
ENTRYPOINT ["/usr/local/bin/verde2-opendkim"]
