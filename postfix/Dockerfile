FROM boky/postfix:v4.0.0

# Configurar variáveis de ambiente
ENV HOSTNAME=mail
ENV DOMAIN=example.com

# Copiar configuração personalizada se existir
COPY config/ /tmp/config/

# O postfix será configurado via variáveis de ambiente
# See https://github.com/boky/postfix for configuration options
