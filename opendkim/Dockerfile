FROM debian:bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        opendkim \
        opendkim-tools \
    && rm -rf /var/lib/apt/lists/*

# Criar diretórios necessários
RUN mkdir -p /etc/opendkim/keys /run/milter /var/lib/opendkim

# Copiar configuração
COPY config/opendkim.conf /etc/opendkim/opendkim.conf
COPY config/TrustedHosts /etc/opendkim/TrustedHosts
COPY config/KeyTable /etc/opendkim/KeyTable 2>/dev/null || true
COPY config/SigningTable /etc/opendkim/SigningTable 2>/dev/null || true

# Criar usuário para o OpenDKIM
RUN useradd -r -s /sbin/nologin opendkim

# Permissões
RUN chown -R opendkim:opendkim /etc/opendkim /run/milter /var/lib/opendkim

# Expor porta do milter
EXPOSE 8891

# Iniciar OpenDKIM
CMD ["opendkim", "-f", "-x", "/etc/opendkim/opendkim.conf", "-u", "opendkim"]
