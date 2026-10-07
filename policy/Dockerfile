FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-milter ca-certificates && rm -rf /var/lib/apt/lists/* \
 && dpkg-query -W > /usr/share/verde2-package-versions.txt
WORKDIR /opt/verde2
COPY *.py ./
USER nobody
EXPOSE 8890
ENTRYPOINT ["python3", "/opt/verde2/service.py"]
