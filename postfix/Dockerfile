FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends postfix libsasl2-modules sasl2-bin python3 ca-certificates openssl util-linux && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /etc/postfix/sasl /opt/verde2 /run/saslauthd \
 && printf 'pwcheck_method: saslauthd\nmech_list: PLAIN LOGIN\nsaslauthd_path: /run/saslauthd/mux\n' > /etc/postfix/sasl/smtpd.conf \
 && dpkg-query -W > /usr/share/verde2-package-versions.txt
COPY config/ /etc/postfix/
COPY *.py /opt/verde2/
COPY entrypoint.sh /usr/local/bin/verde2-postfix
RUN chmod 0755 /usr/local/bin/verde2-postfix
EXPOSE 25 587
ENTRYPOINT ["/usr/local/bin/verde2-postfix"]
