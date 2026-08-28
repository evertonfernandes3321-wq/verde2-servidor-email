#!/bin/bash
# Script para gerar chaves DKIM

set -e

DOMAIN=${1:-example.com}
SELECTOR=${2:-mail}
KEYS_DIR="./opendkim/keys"

echo "Gerando chaves DKIM para $DOMAIN com selector $SELECTOR..."

mkdir -p "$KEYS_DIR/$DOMAIN"

# Gerar chave privada
openssl genrsa -out "$KEYS_DIR/$DOMAIN/$SELECTOR.private" 2048

# Gerar chave pública
openssl rsa -in "$KEYS_DIR/$DOMAIN/$SELECTOR.private" -pubout -out "$KEYS_DIR/$DOMAIN/$SELECTOR.public" 2>/dev/null

# Mostrar chave pública no formato DNS
echo ""
echo "=== Registro DKIM para adicionar no DNS ==="
echo "Nome: $SELECTOR._domainkey.$DOMAIN"
echo "Tipo: TXT"
echo "Valor:"
echo "v=DKIM1; k=rsa; p=$(cat "$KEYS_DIR/$DOMAIN/$SELECTOR.public" | grep -v "BEGIN\|END" | tr -d '\n')"
echo ""

# Criar arquivo de configuração do domínio
cat > "$KEYS_DIR/$DOMAIN/KeyTable" <<EOF
$SELECTOR._domainkey.$DOMAIN $DOMAIN:$SELECTOR:$KEYS_DIR/$DOMAIN/$SELECTOR.private
EOF

cat > "$KEYS_DIR/$DOMAIN/SigningTable" <<EOF
*@$DOMAIN $SELECTOR._domainkey.$DOMAIN
EOF

echo "Chaves geradas em $KEYS_DIR/$DOMAIN/"
