#!/bin/bash
# Script para rodar Gitleaks localmente

set -e

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "========================================"
echo "  Gitleaks - Scanning for secrets"
echo "========================================"

# Verificar se gitleaks está instalado
if ! command -v gitleaks &> /dev/null; then
    echo -e "${YELLOW}Gitleaks não encontrado. Instalando...${NC}"

    # Instalar gitleaks
    if [ "$(uname)" = "Darwin" ]; then
        brew install gitleaks
    elif [ "$(uname)" = "Linux" ]; then
        wget https://github.com/gitleaks/gitleaks/releases/download/v8.18.2/gitleaks-v8.18.2-linux-amd64.tar.gz -O /tmp/gitleaks.tar.gz
        tar -xzf /tmp/gitleaks.tar.gz -C /tmp
        sudo mv /tmp/gitleaks /usr/local/bin/
        rm /tmp/gitleaks.tar.gz
    fi
fi

# Verificar se arquivo de config existe
if [ ! -f gitleaks.toml ]; then
    echo -e "${YELLOW}Arquivo gitleaks.toml não encontrado. Usando configuração padrão.${NC}"
    GITLEAKS_CMD="gitleaks detect --source . --verbose"
else
    GITLEAKS_CMD="gitleaks detect --source . --config gitleaks.toml --verbose"
fi

# Rodar gitleaks
echo ""
echo "Escaneando código..."
echo ""

if $GITLEAKS_CMD; then
    echo -e "${GREEN}✓ Nenhum segredo encontrado!${NC}"
    exit 0
else
    echo ""
    echo -e "${RED}✗ Secrets encontrados!${NC}"
    echo ""
    echo "Para corrigir secrets:"
    echo "  1. Remova ou substitua os secrets encontrados"
    echo "  2. Adicione padrões falsos ao allowlist se necessário"
    echo ""
    echo "Para ignorar paths específicos, edite gitleaks.toml"
    exit 1
fi
