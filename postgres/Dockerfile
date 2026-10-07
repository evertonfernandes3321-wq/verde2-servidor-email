FROM postgres:16.15-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea
# Preserve the official PostgreSQL entrypoint behavior and privilege drop,
# replacing their Go helper with the official Alpine C implementation.
RUN apk upgrade --no-cache && apk add --no-cache su-exec=0.3-r0 \
    && rm -f /usr/local/bin/gosu /usr/local/bin/su-exec \
    && chown root:root /sbin/su-exec && chmod 0755 /sbin/su-exec \
    && sed -i 's/exec gosu postgres/exec \/sbin\/su-exec postgres/' /usr/local/bin/docker-entrypoint.sh /usr/local/bin/docker-ensure-initdb.sh \
    && ! grep -q 'gosu' /usr/local/bin/docker-entrypoint.sh /usr/local/bin/docker-ensure-initdb.sh \
    && test ! -e /usr/local/bin/gosu \
    && test ! -L /usr/local/bin/gosu \
    && apk info -vv > /usr/share/verde2-package-versions.txt \
    && postgres --version >> /usr/share/verde2-package-versions.txt
